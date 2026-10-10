import { presentationTools } from './presentation-service.js';
import { templateTools } from './template-service.js';
import type { PlatformConfig } from './platform-config.js';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import {
  documentSchema,
  type DocumentInput,
  type DocumentFormat,
  type DocumentResult,
} from '../shared/documents.js';
import { MAX_FILE_BYTES } from '../shared/storage.js';
import type { FileService } from './file-service.js';
const mime: Record<DocumentFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
};
let activeWorkers = 0;
export function generateBytes(
  input: DocumentInput,
  format: DocumentFormat,
  signal?: AbortSignal,
): Promise<{ data: Buffer; warnings: string[] }> {
  signal?.throwIfAborted();
  if (activeWorkers >= 2)
    return Promise.reject(
      new Error('Document renderer is busy. Retry shortly.'),
    );
  activeWorkers++;
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(
        new URL(
          import.meta.url.endsWith('.ts')
            ? './document-worker.ts'
            : './document-worker.js',
          import.meta.url,
        ),
        {
          workerData: { input, format },
          resourceLimits: { maxOldGenerationSizeMb: 384 },
          execArgv: import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : [],
        },
      );
    } catch (e) {
      activeWorkers--;
      reject(e);
      return;
    }
    let done = false;
    const end = (
      error?: Error,
      result?: { data: Uint8Array; warnings: string[] },
    ) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate().finally(() => {
        activeWorkers--;
      });
      if (error) reject(error);
      else if (result && result.data.length <= MAX_FILE_BYTES)
        resolve({ ...result, data: Buffer.from(result.data) });
      else
        reject(new Error('Generated file exceeds 25 MB. Split the document.'));
    };
    const abort = () => end(new Error('Document generation cancelled.'));
    const timer = setTimeout(
      () =>
        end(new Error('Document generation timed out. Split the document.')),
      45000,
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    worker.once('message', (r) =>
      r.error ? end(new Error(r.error)) : end(undefined, r),
    );
    worker.once('error', (e) =>
      end(e instanceof Error ? e : new Error(String(e))),
    );
    worker.once('exit', () => {
      if (!done) end(new Error('Document renderer stopped unexpectedly.'));
    });
  });
}
const inFlight = new Map<string, Promise<DocumentResult>>();
export function generateFiles(
  service: FileService,
  dotId: string,
  spaceId: string,
  threadId: string | null,
  raw: unknown,
  check: () => void,
  signal?: AbortSignal,
): Promise<DocumentResult> {
  check();
  service.scope(spaceId, dotId, threadId);
  const input = documentSchema.parse(raw);
  if (!input.brand) {
    const name = service.workspace.dot(dotId)?.name ?? '';
    input.brand = /vyanis/i.test(name)
      ? 'VYANIS'
      : /vigon/i.test(name)
        ? 'VIGON SYSTEMS'
        : 'OpenDots';
  }
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        owner: service.workspace.ownerId,
        dotId,
        spaceId,
        threadId,
        input,
        renderer: 1,
      }),
    )
    .digest('hex');
  const existing = inFlight.get(digest);
  if (existing) return existing;
  const run = (async () => {
    const result: DocumentResult = { files: [], warnings: [], errors: [] };
    for (const format of new Set(input.formats)) {
      const id = 'doc-' + digest.slice(0, 40) + '-' + format;
      try {
        check();
        signal?.throwIfAborted();
        service.scope(spaceId, dotId, threadId);
        let stored;
        try {
          stored = service.view(service.workspace.files.get(spaceId, id));
        } catch {
          /* First generation. */
        }
        if (!stored) {
          const rendered = await generateBytes(input, format, signal);
          result.warnings.push(...rendered.warnings);
          check();
          signal?.throwIfAborted();
          service.scope(spaceId, dotId, threadId);
          const stem =
            [...input.title.normalize('NFKC')]
              .map((c) => (c.charCodeAt(0) < 32 ? '-' : c))
              .join('')
              .replace(/[<>:"/\\|?*]/g, '-')
              .replace(/^\.+/, '')
              .slice(0, 140) || 'Document';
          const name = `${stem}.${format}`;
          const drive = service.workspace.files.account(spaceId)
            ? await service.drive.upload(
                spaceId,
                dotId,
                id,
                name,
                mime[format],
                rendered.data,
              )
            : null;
          check();
          signal?.throwIfAborted();
          service.scope(spaceId, dotId, threadId);
          stored = service.workspace.files.add(
            {
              id,
              spaceId,
              dotId,
              threadId,
              name,
              mimeType: mime[format],
              size: rendered.data.length,
              provider: drive ? 'drive' : 'local',
              driveId: drive?.file.id ?? null,
              textStatus: 'Generated document · searchable source text',
              createdAt: Date.now(),
            },
            [input.title, input.subtitle, input.markdown].join('\n\n'),
            drive ? null : rendered.data,
            drive?.accountId ?? null,
          );
        }
        result.files.push({
          id: stored.id,
          spaceId,
          name: stored.name,
          size: stored.size,
          provider: stored.provider,
          downloadUrl: `/api/spaces/${encodeURIComponent(spaceId)}/files/${encodeURIComponent(id)}/download`,
        });
      } catch (e) {
        // Preserve successful formats in the result if a later format needs revision.
        result.errors!.push(
          `${format.toUpperCase()}: ${e instanceof Error ? e.message : 'Generation failed.'}`,
        );
        if (signal?.aborted) break;
      }
    }
    result.warnings = [...new Set(result.warnings)];
    return result;
  })();
  inFlight.set(digest, run);
  void run.finally(() => inFlight.delete(digest)).catch(() => {});
  return run;
}
export function documentTools(
  service: FileService,
  dotId: string,
  defaultSpace: string,
  threadId: string,
  check: () => void,
  signal?: AbortSignal,
  config?: PlatformConfig,
) {
  return [
    ...presentationTools(
      service,
      dotId,
      defaultSpace,
      threadId,
      check,
      signal,
      config,
    ),
    ...templateTools(
      service,
      dotId,
      defaultSpace,
      threadId,
      check,
      signal,
      config,
    ),
    defineTool({
      name: 'generate_document',
      description:
        'Basic text document export only. For branded/client-ready presentations use find_presentation_templates, inspect_presentation_template, create_presentation_from_template and review_presentation; this generic Markdown renderer cannot match premium slides, images or diagrams. PPTX here requires explicit plainSlides=true and is only for a plain text draft requested by the user. For a NEW document design only; when reusing a prior Word file use find_word_templates, inspect_word_template and edit_word_template instead. Create real downloadable PDF, editable DOCX, XLSX, PPTX, Markdown, TXT or CSV files from final Markdown content. Use this tool whenever the user asks for a file; a page or pasted text is not a file. Files are saved in this Dot’s Space storage (Drive when connected) and returned as download links. PDF/Word have branded typography, wrapping tables and page numbers; slides are editable and split into readable sections. XLSX exports tables to sheets, CSV needs exactly one table. Use concise headings and Markdown tables; avoid emoji in PDFs, no HTML or image URLs (images are captions only). Preserve approved facts, sources, amounts and uncertainties. Never invent a logo/signature. Check returned errors/warnings before claiming completion. Request only the formats needed; PDF+DOCX is a useful document pair. Never claim visual inspection unless actually performed.',
      parameters: documentSchema.extend({
        spaceId: z.string().optional(),
        plainSlides: z.boolean().default(false),
      }),
      execute: async ({ spaceId, plainSlides, ...input }) => {
        if (input.formats.includes('pptx') && !plainSlides)
          throw new Error(
            'Branded presentations require the original design workflow: find_presentation_templates → inspect_presentation_template → create_presentation_from_template → review_presentation. Use plainSlides=true only when the user explicitly requests a plain text slide draft.',
          );
        return generateFiles(
          service,
          dotId,
          spaceId ?? defaultSpace,
          threadId,
          input,
          check,
          signal,
        );
      },
    }),
  ];
}
