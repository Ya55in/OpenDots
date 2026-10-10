import { createHash } from 'node:crypto';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import type { FileService } from './file-service.js';
import type { PlatformConfig } from './platform-config.js';
import { archiveWordFiles } from './template-archive.js';
import { editWord, inspectWord } from './word-template.js';
import { renderPreview, reviewPreview } from './document-preview.js';
import type { DocumentResult } from '../shared/documents.js';
export const sourceSchema = z.union([
  z.object({ fileId: z.string().min(1).max(200) }).strict(),
  z
    .object({
      importId: z.string().min(1).max(200),
      archivePath: z.string().min(1).max(1500),
    })
    .strict(),
]);
export async function filePreview(
  service: FileService,
  space: string,
  fileId: string,
  signal?: AbortSignal,
  check: () => void = () => {},
) {
  check();
  const file = await service.download(space, fileId);
  if (!/\.(pdf|docx|pptx)$/i.test(file.name))
    throw new Error('Page preview supports PDF, DOCX and PPTX.');
  const digest = createHash('sha256').update(file.data).digest('hex');
  const cached = service.workspace.files.preview(space, fileId);
  if (cached?.digest === digest) return cached;
  const { preview } = await renderPreview(
    file.data,
    /\.pptx$/i.test(file.name) ? 'pptx' : /\.docx$/i.test(file.name),
    signal,
  );
  check();
  service.workspace.files.savePreview(space, fileId, preview);
  return preview;
}
export function templateTools(
  service: FileService,
  dotId: string,
  space: string,
  threadId: string,
  check: () => void,
  signal?: AbortSignal,
  config?: PlatformConfig,
) {
  const guard = () => {
    check();
    signal?.throwIfAborted();
    service.scope(space, dotId, threadId);
  };
  const ownFile = (fileId: string) => {
    guard();
    const file = service.workspace.files.get(space, fileId);
    if (file.dotId !== dotId)
      throw new Error(
        'File belongs to another Dot. Attach a copy to this Dot first.',
      );
    return file;
  };
  const load = async (source: z.infer<typeof sourceSchema>) => {
    guard();
    if ('fileId' in source) {
      const meta = ownFile(source.fileId);
      if (!/\.docx$/i.test(meta.name))
        throw new Error('Choose a DOCX original.');
      const file = await service.download(space, source.fileId);
      guard();
      return file.data;
    }
    const result = await archiveWordFiles(
      service.workspace.knowledge,
      space,
      source.importId,
      '',
      source.archivePath,
    );
    guard();
    if (!result.data) throw new Error('Original Word file not found.');
    return result.data;
  };
  return [
    defineTool({
      name: 'find_word_templates',
      description:
        'Find original editable Word files in this Dot’s file library AND verified migrated archives. Use this before recreating an earlier order, proposal or branded document. Search a distinctive filename fragment; blank query lists available originals. Prefer unsigned draft originals. Returned source objects can be passed directly to inspect_word_template and edit_word_template.',
      parameters: z.object({ query: z.string().max(150).default('') }),
      execute: async ({ query }) => {
        guard();
        const files = service.workspace.files
          .list(space, dotId, query, 0)
          .filter((f) => /\.docx$/i.test(f.name))
          .map((f) => ({ name: f.name, source: { fileId: f.id } }));
        const archives: {
          name: string;
          source: { importId: string; archivePath: string };
        }[] = [];
        const warnings: string[] = [];
        for (const imp of service.workspace.knowledge
          .imports(space)
          .filter((i) => i.complete)
          .slice(0, 10)) {
          try {
            const result = await archiveWordFiles(
              service.workspace.knowledge,
              space,
              imp.id,
              query,
            );
            guard();
            for (const path of result.entries)
              archives.push({
                name: path,
                source: { importId: imp.id, archivePath: path },
              });
          } catch (e) {
            guard();
            warnings.push(
              e instanceof Error ? e.message : 'Archive lookup failed.',
            );
          }
        }
        return { files, archives, warnings };
      },
    }),
    defineTool({
      name: 'inspect_word_template',
      description:
        'Open the ORIGINAL DOCX binary, including originals in migrated archives. Return exact paragraph text, fonts and image inventory with stable editing locators. Read all relevant pages of this inspection before editing. It is no longer necessary to recreate the template from extracted text.',
      parameters: z.object({
        source: sourceSchema,
        offset: z.number().int().min(0).default(0),
      }),
      execute: async ({ source, offset }) => {
        const info = await inspectWord(await load(source));
        guard();
        return {
          ...info,
          paragraphs: info.paragraphs.slice(offset, offset + 150),
          total: info.paragraphs.length,
          nextOffset:
            offset + 150 < info.paragraphs.length ? offset + 150 : null,
        };
      },
    }),
    defineTool({
      name: 'edit_word_template',
      description:
        'Edit an original DOCX without rebuilding its design. Preserves fonts, styles, letterhead, logos, tables, margins, header/footer and all untouched package parts. Provide exact inspected part/paragraph/find/replace operations (including text split across runs). Creates an editable DOCX and a PDF rendered FROM THAT SAME DOCX, plus page previews. A failed PDF render still returns the usable DOCX with an explicit error. Do not reuse signatures/stamps without explicit authorization; prefer unsigned drafts. After editing, call review_document on the PDF and fix visual issues before delivery. For additional table rows or complex structural changes not supported by these text edits, do not falsely claim preservation.',
      parameters: z.object({
        source: sourceSchema,
        title: z.string().min(1).max(140),
        edits: z
          .array(
            z.object({
              part: z.string().max(100),
              paragraph: z.number().int().nonnegative(),
              find: z.string().min(1).max(10000),
              replace: z
                .string()
                .max(10000)
                .refine(
                  (s) => [...s].every((c) => c.charCodeAt(0) >= 32),
                  'Use plain single-paragraph text without control characters.',
                ),
            }),
          )
          .min(1)
          .max(200),
      }),
      execute: async ({ source, title, edits }) => {
        const original = await load(source),
          edited = await editWord(original, edits);
        guard();
        const inspected = await inspectWord(edited.data);
        const result: DocumentResult = { files: [], warnings: [], errors: [] };
        const digest = createHash('sha256')
          .update(dotId + space + threadId + title)
          .update(edited.data)
          .digest('hex')
          .slice(0, 40);
        const save = async (data: Buffer, extension: 'docx' | 'pdf') => {
          guard();
          if (data.length > 25 * 1024 * 1024)
            throw new Error('Edited document exceeds 25 MB.');
          const id = 'template-' + digest + '-' + extension;
          const name =
            [...title]
              .map((c) => (c.charCodeAt(0) < 32 ? '-' : c))
              .join('')
              .replace(/[<>:"/\\|?*]/g, '-')
              .replace(/^\.+/, '') +
            '.' +
            extension;
          const mimeType =
            extension === 'pdf'
              ? 'application/pdf'
              : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          let stored;
          try {
            stored = service.workspace.files.get(space, id);
          } catch {
            /* New revision. */
          }
          if (!stored) {
            const drive = service.workspace.files.account(space)
              ? await service.drive.upload(
                  space,
                  dotId,
                  id,
                  name,
                  mimeType,
                  data,
                )
              : null;
            guard();
            stored = service.workspace.files.add(
              {
                id,
                spaceId: space,
                dotId,
                threadId,
                name,
                mimeType,
                size: data.length,
                provider: drive ? 'drive' : 'local',
                driveId: drive?.file.id ?? null,
                textStatus:
                  'Original Word template preserved · searchable text',
                createdAt: Date.now(),
              },
              inspected.paragraphs.map((p) => p.text).join('\n'),
              drive ? null : data,
              drive?.accountId ?? null,
            );
          }
          result.files.push({
            id,
            spaceId: space,
            name: stored.name,
            size: stored.size,
            provider: stored.provider,
            downloadUrl: `/api/spaces/${space}/files/${id}/download`,
          });
          return id;
        };
        const wordId = await save(edited.data, 'docx');
        try {
          const rendered = await renderPreview(edited.data, true, signal);
          guard();
          const pdfId = await save(rendered.pdf, 'pdf');
          guard();
          service.workspace.files.savePreview(space, wordId, rendered.preview);
          service.workspace.files.savePreview(space, pdfId, {
            ...rendered.preview,
            digest: createHash('sha256').update(rendered.pdf).digest('hex'),
          });
          result.warnings.push(...rendered.preview.warnings);
        } catch (e) {
          guard();
          result.errors!.push(
            `PDF/preview: ${e instanceof Error ? e.message : 'Rendering failed.'}`,
          );
        }
        result.warnings.push('Original Word formatting preserved.');
        return result;
      },
    }),
    defineTool({
      name: 'review_document',
      description:
        'Render every page of a saved PDF, DOCX or PPTX and send the actual page images to the configured visual reviewer. Returns page-by-page observations and rendering/font warnings. Use after generation or template edits; fix reported layout issues before delivery. This checks visual appearance, not commercial accuracy or authenticity. Never claim successful review if the tool returns an error. Up to 30 pages per document.',
      parameters: z.object({ fileId: z.string().min(1).max(200) }),
      execute: async ({ fileId }) => {
        ownFile(fileId);
        const preview = await filePreview(
          service,
          space,
          fileId,
          signal,
          guard,
        );
        guard();
        if (!config)
          throw new Error('Visual review provider is not configured.');
        const reviewed = preview.review
          ? preview
          : await reviewPreview(preview, config, signal);
        guard();
        service.workspace.files.savePreview(space, fileId, reviewed);
        return {
          fileId,
          digest: reviewed.digest,
          pageCount: reviewed.pages.length,
          warnings: reviewed.warnings,
          review: reviewed.review,
          note: 'Read every observation. Revise and review again if issues are reported. This review applies only to this file revision.',
        };
      },
    }),
  ];
}
