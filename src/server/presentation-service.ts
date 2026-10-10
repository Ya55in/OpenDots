import { createHash } from 'node:crypto';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import type { FileService } from './file-service.js';
import type { PlatformConfig } from './platform-config.js';
import type { DocumentResult } from '../shared/documents.js';
import { sourceSchema, filePreview } from './template-service.js';
import { archiveWordFiles } from './template-archive.js';
import {
  editPresentation,
  inspectPresentation,
} from './presentation-template.js';
import { renderPreview, reviewPreview } from './document-preview.js';
const editSchema = z
  .object({
    shapeId: z.string().min(1).max(100),
    paragraph: z.number().int().nonnegative(),
    find: z.string().min(1).max(10000),
    replace: z.string().max(10000),
  })
  .strict();
export function presentationTools(
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
  const own = (id: string) => {
    guard();
    const f = service.workspace.files.get(space, id);
    if (f.dotId !== dotId)
      throw new Error('File belongs to another Dot. Attach a copy first.');
    return f;
  };
  const load = async (source: z.infer<typeof sourceSchema>) => {
    guard();
    if ('fileId' in source) {
      if (!/\.pptx$/i.test(own(source.fileId).name))
        throw new Error('Choose an original PPTX.');
      const file = await service.download(space, source.fileId);
      guard();
      return file.data;
    }
    const archive = await archiveWordFiles(
      service.workspace.knowledge,
      space,
      source.importId,
      '',
      source.archivePath,
      'pptx',
    );
    guard();
    if (!archive.data) throw new Error('Original presentation not found.');
    return archive.data;
  };
  const renderSource = async (
    source: z.infer<typeof sourceSchema>,
    slides: number[],
  ) => {
    const data = await load(source);
    const info = await inspectPresentation(data);
    const selected = slides.length ? slides : info.slides.map((s) => s.slide);
    const edited = await editPresentation(
      data,
      selected.map((sourceSlide) => ({ sourceSlide, edits: [] })),
    );
    const rendered = await renderPreview(edited.data, 'pptx', signal);
    guard();
    return rendered.preview;
  };
  return [
    defineTool({
      name: 'find_presentation_templates',
      description:
        'Find ORIGINAL PPTX designs in this Dot’s files and verified migrated archives, including skill assets. Use for branded/client-ready decks and when matching HIBA/VYANIS presentations. Search relevant industry or project names (e.g. limoune for hospitality), or premium-design for the approved premium reference. Use the actual binary template, never rebuild its extracted text as generic Markdown slides. These are design references; old client facts, prices, dates and imagery are not automatically valid for the new client.',
      parameters: z.object({ query: z.string().max(150).default('') }),
      execute: async ({ query }) => {
        guard();
        const files = service.workspace.files
          .list(space, dotId, query, 0)
          .filter((f) => /\.pptx$/i.test(f.name))
          .map((f) => ({ name: f.name, source: { fileId: f.id } }));
        const archives: {
            name: string;
            source: { importId: string; archivePath: string };
          }[] = [],
          warnings: string[] = [];
        for (const imp of service.workspace.knowledge
          .imports(space)
          .filter((i) => i.complete)
          .slice(0, 10)) {
          try {
            const r = await archiveWordFiles(
              service.workspace.knowledge,
              space,
              imp.id,
              query,
              undefined,
              'pptx',
            );
            guard();
            archives.push(
              ...r.entries.map((path) => ({
                name: path,
                source: { importId: imp.id, archivePath: path },
              })),
            );
          } catch (e) {
            guard();
            warnings.push(
              e instanceof Error ? e.message : 'Template lookup failed.',
            );
          }
        }
        return { files, archives, warnings };
      },
    }),
    defineTool({
      name: 'inspect_presentation_template',
      description:
        'Open the original PPTX and return slide dimensions, images, fonts, exact editable text, shape IDs, paragraph indexes and bounds. Read every slide you intend to reuse. Supply visualSlides to have a vision model inspect actual rendered source slides and describe their design/imagery before planning the deck. The same layout can be duplicated. Do not carry old client facts or client-specific artwork into unrelated proposals.',
      parameters: z.object({
        source: sourceSchema,
        offset: z.number().int().min(0).default(0),
        visualSlides: z.array(z.number().int().min(1)).max(6).default([]),
      }),
      execute: async ({ source, offset, visualSlides }) => {
        const info = await inspectPresentation(await load(source));
        guard();
        let visualReview;
        if (visualSlides.length) {
          if (!config)
            throw new Error('Visual review provider is not configured.');
          const preview = await renderSource(source, visualSlides);
          visualReview = (
            await reviewPreview(preview, config, signal, {
              purpose: 'reference',
            })
          ).review;
          guard();
        }
        return {
          ...info,
          slides: info.slides.slice(offset, offset + 3),
          total: info.slides.length,
          nextOffset: offset + 3 < info.slides.length ? offset + 3 : null,
          visualSourceSlides: visualSlides,
          visualReview,
        };
      },
    }),
    defineTool({
      name: 'create_presentation_from_template',
      description:
        'Create a polished editable PPTX and its matching PDF by reusing actual slides from an original PPTX. Provide the complete ordered output plan: choose source slide numbers (repeat to duplicate layouts) and exact shapeId/paragraph/find/replace text edits from inspection. Retains original images, masters, theme, positions, colors, typography, diagrams and editable objects. No generic slide redesign or automatic content splitting. Fit concise content into the selected layout; preserve approved facts and replace old client names/dates/prices. Embedded image text cannot be changed this way. Source notes/comments and excluded slides are removed. After creation call review_presentation with the same source and ordered sourceSlides to compare every rendered output against its original layout, and revise concrete problems before delivery. Never claim pixel-identical PDF rendering when font substitutions or other rendering differences are reported.',
      parameters: z.object({
        source: sourceSchema,
        title: z.string().min(1).max(140),
        slides: z
          .array(
            z
              .object({
                sourceSlide: z.number().int().min(1),
                edits: z.array(editSchema).max(150),
              })
              .strict(),
          )
          .min(1)
          .max(30),
      }),
      execute: async ({ source, title, slides }) => {
        const edited = await editPresentation(await load(source), slides);
        guard();
        const info = await inspectPresentation(edited.data);
        const result: DocumentResult = {
          files: [],
          warnings: [...edited.warnings],
          errors: [],
        };
        const digest = createHash('sha256')
          .update(dotId + space + threadId + title)
          .update(edited.data)
          .digest('hex')
          .slice(0, 40);
        const text = info.slides
          .flatMap((s) =>
            s.shapes.flatMap((sh) => sh.paragraphs.map((p) => p.text)),
          )
          .join('\n');
        const save = async (data: Buffer, extension: 'pptx' | 'pdf') => {
          guard();
          if (data.length > 25 * 1024 * 1024)
            throw new Error('Presentation exceeds 25 MB.');
          const id = 'slides-' + digest + '-' + extension;
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
              : 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
          let stored;
          try {
            stored = service.workspace.files.get(space, id);
          } catch {
            /* New output. */
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
                  'Original presentation design retained · searchable text',
                createdAt: Date.now(),
              },
              text,
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
        const deckId = await save(edited.data, 'pptx');
        try {
          const rendered = await renderPreview(edited.data, 'pptx', signal);
          guard();
          if (rendered.preview.pages.length !== slides.length)
            throw new Error(
              'Rendered page count differs from the output plan.',
            );
          const pdfId = await save(rendered.pdf, 'pdf');
          guard();
          service.workspace.files.savePreview(space, deckId, rendered.preview);
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
        return result;
      },
    }),
    defineTool({
      name: 'review_presentation',
      description:
        'Compare EVERY rendered output slide against the corresponding ORIGINAL template slide with real vision. Use the PPTX file ID and exactly the ordered sourceSlide numbers from create_presentation_from_template. Checks preservation of composition, images, colors and typography as well as clipping, text density, old client content and readability. Review findings are saved in the file preview. This is a real comparison, not a promise of identical rendering or verification of commercial facts. Fix reported problems before final delivery.',
      parameters: z.object({
        fileId: z.string().min(1).max(200),
        source: sourceSchema,
        sourceSlides: z.array(z.number().int().min(1)).min(1).max(30),
      }),
      execute: async ({ fileId, source, sourceSlides }) => {
        if (!/\.pptx$/i.test(own(fileId).name))
          throw new Error(
            'Select the generated PPTX so the review covers its actual rendering.',
          );
        if (!config)
          throw new Error('Visual review provider is not configured.');
        const preview = await filePreview(
          service,
          space,
          fileId,
          signal,
          guard,
        );
        if (preview.pages.length !== sourceSlides.length)
          throw new Error(
            'Reference slide mapping must cover every output slide.',
          );
        const reference = await renderSource(source, sourceSlides);
        const reviewed = await reviewPreview(preview, config, signal, {
          reference,
        });
        guard();
        service.workspace.files.savePreview(space, fileId, reviewed);
        const pdfId = fileId.endsWith('-pptx')
          ? fileId.slice(0, -5) + '-pdf'
          : '';
        if (pdfId) {
          const pdfPreview = service.workspace.files.preview(space, pdfId);
          if (
            pdfPreview &&
            pdfPreview.pages.length === reviewed.pages.length &&
            pdfPreview.pages.every((page, i) => page === reviewed.pages[i])
          ) {
            own(pdfId);
            service.workspace.files.savePreview(space, pdfId, {
              ...pdfPreview,
              review: reviewed.review,
            });
          }
        }
        return {
          fileId,
          pageCount: reviewed.pages.length,
          warnings: [...reviewed.warnings, ...reference.warnings],
          review: reviewed.review,
          note: 'Template comparison completed. Read observations and repair flagged issues; completion is not an automatic design approval.',
        };
      },
    }),
  ];
}
