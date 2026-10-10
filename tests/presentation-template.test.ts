import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import {
  editPresentation,
  inspectPresentation,
} from '../src/server/presentation-template.js';
import { reviewPreview } from '../src/server/document-preview.js';
import { presentationTools } from '../src/server/presentation-service.js';
import { documentTools } from '../src/server/document-service.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { FileService } from '../src/server/file-service.js';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main',
  A = 'http://schemas.openxmlformats.org/drawingml/2006/main',
  R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const relationships = (entries: string) =>
  `<Relationships xmlns="${PKG}">${entries}</Relationships>`;
const rel = (id: string, type: string, target: string) =>
  `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`;
export async function deckFixture() {
  const z = new JSZip();
  z.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
  );
  z.file(
    '_rels/.rels',
    relationships(
      rel('main', 'officeDocument', 'ppt/presentation.xml') +
        rel('core', 'metadata/core-properties', 'docProps/core.xml'),
    ),
  );
  z.file('docProps/core.xml', '<old>PRIVATE OLD CLIENT</old>');
  z.file(
    'ppt/presentation.xml',
    `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="r1"/><p:sldId id="257" r:id="r2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
  );
  z.file(
    'ppt/_rels/presentation.xml.rels',
    relationships(
      rel('r1', 'slide', 'slides/slide1.xml') +
        rel('r2', 'slide', 'slides/slide2.xml'),
    ),
  );
  for (let i = 1; i <= 2; i++) {
    z.file(
      `ppt/slides/slide${i}.xml`,
      `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="4000" cy="600"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr sz="3200" b="1"><a:solidFill><a:srgbClr val="123456"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>Old </a:t></a:r><a:r><a:t>Client ${i}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );
    z.file(
      `ppt/slides/_rels/slide${i}.xml.rels`,
      relationships(
        rel('image', 'image', `../media/picture${i}.png`) +
          rel('layout', 'slideLayout', '../slideLayouts/slideLayout1.xml') +
          rel('notes', 'notesSlide', `../notesSlides/notesSlide${i}.xml`),
      ),
    );
    z.file(`ppt/media/picture${i}.png`, `ORIGINAL-ARTWORK-${i}`);
    z.file(
      `ppt/notesSlides/notesSlide${i}.xml`,
      `<notes>PRIVATE OLD NOTES ${i}</notes>`,
    );
  }
  z.file(
    'ppt/slideLayouts/slideLayout1.xml',
    '\uFEFF<layout>ORIGINAL-LAYOUT</layout>',
  );
  return z.generateAsync({ type: 'nodebuffer' });
}
describe('original presentation design workflow', () => {
  it('duplicates a source layout, preserves design resources and split-run styling, removes omitted private content, and supports another revision', async () => {
    const original = await deckFixture();
    const plan = ['Royal Mirage', 'Second output'].map((replace) => ({
      sourceSlide: 1,
      edits: [{ shapeId: '2', paragraph: 0, find: 'Old Client 1', replace }],
    }));
    const result = await editPresentation(original, plan);
    expect((await editPresentation(original, plan)).data).toEqual(result.data);
    const info = await inspectPresentation(result.data);
    expect(info.slides.map((s) => s.shapes[0].paragraphs[0].text)).toEqual([
      'Royal Mirage',
      'Second output',
    ]);
    expect(info.width).toBe(12192000);
    expect(info.fonts).toContain('Arial');
    expect(info.slides[0].shapes[0].bounds).toEqual({
      x: 100,
      y: 200,
      width: 4000,
      height: 600,
    });
    const zip = await JSZip.loadAsync(result.data);
    expect(await zip.file('ppt/media/picture1.png')!.async('string')).toBe(
      'ORIGINAL-ARTWORK-1',
    );
    expect(
      await zip.file('ppt/slideLayouts/slideLayout1.xml')!.async('string'),
    ).toBe('\uFEFF<layout>ORIGINAL-LAYOUT</layout>');
    expect(zip.file('ppt/media/picture2.png')).toBeNull();
    expect(
      Object.keys(zip.files).filter(
        (n) =>
          !zip.files[n].dir && /notesSlides|docProps|slide[12]\.xml$/.test(n),
      ),
    ).toEqual([]);
    expect(await zip.file(info.slides[0].part)!.async('string')).toContain(
      'sz="3200" b="1"',
    );
    const revised = await editPresentation(result.data, [
      { sourceSlide: 2, edits: [] },
    ]);
    expect(
      (await inspectPresentation(revised.data)).slides[0].shapes[0]
        .paragraphs[0].text,
    ).toBe('Second output');
  });
  it('rejects stale edits, missing slides, embedded active content and external image resources', async () => {
    const data = await deckFixture();
    await expect(
      editPresentation(data, [{ sourceSlide: 3, edits: [] }]),
    ).rejects.toThrow('Source slide');
    await expect(
      editPresentation(data, [
        {
          sourceSlide: 1,
          edits: [
            { shapeId: '2', paragraph: 0, find: 'wrong text', replace: 'new' },
          ],
        },
      ]),
    ).rejects.toThrow('Expected unique');
    const zip = await JSZip.loadAsync(data);
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      relationships(
        `<Relationship Id="bad" Type="${R}/image" TargetMode="External" Target="http://localhost/private"/>`,
      ),
    );
    await expect(
      inspectPresentation(await zip.generateAsync({ type: 'nodebuffer' })),
    ).rejects.toThrow('External');
    zip.file('ppt/vbaProject.bin', 'bad');
    await expect(
      inspectPresentation(await zip.generateAsync({ type: 'nodebuffer' })),
    ).rejects.toThrow();
  });
  it('supplies each source and output image for real comparison and records reference identity only after success', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  'Compared each slide; preserve the imagery and shorten slide 2 title.',
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    try {
      const p = { digest: 'output', pages: ['out1', 'out2'], warnings: [] };
      const ref = { digest: 'source', pages: ['ref1', 'ref2'], warnings: [] };
      const result = await reviewPreview(
        p,
        {
          apiKey: 'test',
          baseUrl: 'https://provider.example/v1',
          model: 'vision',
        },
        undefined,
        { reference: ref },
      );
      const body = String(fetch.mock.calls[0][1]?.body);
      for (const value of [
        'ref1',
        'ref2',
        'out1',
        'out2',
        'SOURCE for output slide 2',
      ])
        expect(body).toContain(value);
      expect(result.review?.referenceDigest).toBe('source');
      fetch.mockResolvedValue(new Response('error', { status: 503 }));
      const failed = { digest: 'output2', pages: ['out'], warnings: [] };
      await expect(
        reviewPreview(
          failed,
          {
            apiKey: 'test',
            baseUrl: 'https://provider.example/v1',
            model: 'vision',
          },
          undefined,
          { reference: { digest: 's', pages: ['r'], warnings: [] } },
        ),
      ).rejects.toThrow('503');
      expect(failed).not.toHaveProperty('review');
    } finally {
      fetch.mockRestore();
    }
  });
  it('enforces source ownership and revocation, and refuses silent generic PPTX fallback', async () => {
    const workspace = new WorkspaceStore(':memory:', crypto.randomUUID());
    try {
      const dot = workspace.dots()[0],
        service = new FileService(workspace);
      workspace.bindThread('test-presentation', dot.id, 'Test');
      const sibling = workspace.createDot(
          dot.spaceId,
          'Sibling',
          '',
          false,
          false,
        ),
        data = await deckFixture();
      workspace.files.add(
        {
          id: 'private-deck',
          spaceId: dot.spaceId,
          dotId: sibling.id,
          threadId: null,
          name: 'source.pptx',
          mimeType: 'application/octet-stream',
          size: data.length,
          provider: 'local',
          driveId: null,
          textStatus: 'Ready',
          createdAt: Date.now(),
        },
        '',
        data,
        null,
      );
      const tools = presentationTools(
        service,
        dot.id,
        dot.spaceId,
        'test-presentation',
        () => {},
      );
      const call = (name: string) =>
        tools.find((t) => t.name === name) as unknown as {
          execute: (input: unknown) => Promise<unknown>;
        };
      await expect(
        call('inspect_presentation_template').execute({
          source: { fileId: 'private-deck' },
          offset: 0,
          visualSlides: [],
        }),
      ).rejects.toThrow('another Dot');
      const revoked = presentationTools(
        service,
        dot.id,
        dot.spaceId,
        'test-presentation',
        () => {
          throw new Error('Revoked');
        },
      );
      await expect(
        (
          revoked[0] as unknown as { execute: (i: unknown) => Promise<unknown> }
        ).execute({ query: '' }),
      ).rejects.toThrow('Revoked');
      const generic = documentTools(
        service,
        dot.id,
        dot.spaceId,
        'test-presentation',
        () => {},
      ).find((t) => t.name === 'generate_document') as unknown as {
        execute: (i: unknown) => Promise<unknown>;
      };
      await expect(
        generic.execute({
          title: 'Deck',
          markdown: 'Hello',
          formats: ['pptx'],
          plainSlides: false,
        }),
      ).rejects.toThrow('original design workflow');
    } finally {
      workspace.close();
    }
  });
});
