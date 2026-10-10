import { WorkspaceStore } from '../src/server/workspace.js';
import { FileService } from '../src/server/file-service.js';
import { templateTools } from '../src/server/template-service.js';
import { fileRoutes } from '../src/server/file-routes.js';
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import {
  editWord,
  inspectWord,
  openWord,
} from '../src/server/word-template.js';
import { archiveWordFiles } from '../src/server/template-archive.js';
import { KnowledgeStore } from '../src/server/knowledge.js';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { reviewPreview } from '../src/server/document-preview.js';
const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
async function fixture() {
  const zip = new JSZip();
  zip.file(
    'word/document.xml',
    `<w:document xmlns:w="${ns}"><w:body><w:p><w:pPr><w:spacing w:after="80"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="123456"/></w:rPr><w:t>Order OLD</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>-REFERENCE due now</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>100,00</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
  );
  zip.file(
    'word/styles.xml',
    `<w:styles xmlns:w="${ns}"><w:style w:styleId="Title"><w:rPr><w:rFonts w:ascii="Calibri"/></w:rPr></w:style></w:styles>`,
  );
  zip.file(
    'word/header1.xml',
    `<w:hdr xmlns:w="${ns}"><w:p><w:r><w:t>Our Company</w:t></w:r></w:p></w:hdr>`,
  );
  zip.file('word/media/logo.png', Buffer.from('original-logo-bytes'));
  zip.file(
    'word/_rels/document.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}
describe('original Word templates', () => {
  it('edits split runs and table text while preserving run formatting and every untouched package part byte-for-byte', async () => {
    const data = await fixture();
    const inspected = await inspectWord(data);
    expect(inspected.fonts).toContain('Calibri');
    expect(inspected.images).toEqual(['word/media/logo.png']);
    const result = await editWord(data, [
      {
        part: 'word/document.xml',
        paragraph: 0,
        find: 'OLD-REFERENCE',
        replace: 'NEW-REFERENCE',
      },
      {
        part: 'word/document.xml',
        paragraph: 1,
        find: '100,00',
        replace: '200,00',
      },
    ]);
    const before = await JSZip.loadAsync(data),
      after = await JSZip.loadAsync(result.data);
    expect(Object.keys(after.files)).toEqual(Object.keys(before.files));
    for (const name of Object.keys(before.files).filter(
      (n) => n !== 'word/document.xml',
    ))
      expect(await after.files[name].async('nodebuffer')).toEqual(
        await before.files[name].async('nodebuffer'),
      );
    const xml = await after.file('word/document.xml')!.async('string');
    expect(xml).toContain('<w:b/>');
    expect(xml).toContain('w:val="123456"');
    expect(xml).toContain('w:after="80"');
    expect(xml).toContain('w:w="11906"');
    expect(
      (await inspectWord(result.data)).paragraphs.map((p) => p.text),
    ).toEqual(['Order NEW-REFERENCE due now', '200,00', 'Our Company']);
  });
  it('rejects stale, ambiguous edits and unsafe resources', async () => {
    const data = await fixture();
    await expect(
      editWord(data, [
        {
          part: 'word/document.xml',
          paragraph: 0,
          find: 'wrong',
          replace: 'new',
        },
      ]),
    ).rejects.toThrow('Expected unique');
    await expect(
      editWord(data, [
        {
          part: 'word/styles.xml',
          paragraph: 0,
          find: 'Calibri',
          replace: 'Arial',
        },
      ]),
    ).rejects.toThrow('Invalid Word');
    const zip = await JSZip.loadAsync(data);
    zip.file(
      'word/_rels/document.xml.rels',
      '<Relationships><Relationship Type="image" TargetMode="External" Target="http://localhost/private"/></Relationships>',
    );
    await expect(
      openWord(await zip.generateAsync({ type: 'nodebuffer' })),
    ).rejects.toThrow('External');
    zip.file('word/vbaProject.bin', 'bad');
    await expect(
      openWord(await zip.generateAsync({ type: 'nodebuffer' })),
    ).rejects.toThrow();
  });
  it('retrieves original DOCX bytes from scoped verified chunked archives without unpacking other files', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new KnowledgeStore(db);
    try {
      const original = await fixture();
      const zip = new JSZip();
      zip.file('files/orders/draft.docx', original);
      zip.file('notes.txt', 'not a template');
      const archive = await zip.generateAsync({ type: 'nodebuffer' }),
        doc = {
          path: 'draft.docx',
          kind: 'file' as const,
          content: 'Original draft',
        };
      const hash = (v: string | Buffer) =>
        createHash('sha256').update(v).digest('hex');
      const imp = store.start('space', {
        name: 'Import',
        documents: 1,
        documentDigest: hash(hash(JSON.stringify(doc)) + '\n'),
        archiveName: 'archive.zip',
        archiveSize: archive.length,
        archiveSha256: hash(archive),
      });
      store.addDocuments('space', imp.id, [doc]);
      for (let i = 0; i < archive.length; i += 524288)
        store.addChunk(
          'space',
          imp.id,
          i,
          archive.subarray(i, i + 524288).toString('base64'),
        );
      await expect(
        archiveWordFiles(store, 'space', imp.id, 'draft'),
      ).rejects.toThrow('verified');
      store.complete('space', imp.id);
      expect(
        (await archiveWordFiles(store, 'space', imp.id, 'draft')).entries,
      ).toEqual(['files/orders/draft.docx']);
      expect(
        (
          await archiveWordFiles(
            store,
            'space',
            imp.id,
            '',
            'files/orders/draft.docx',
          )
        ).data,
      ).toEqual(original);
      await expect(
        archiveWordFiles(store, 'other-space', imp.id),
      ).rejects.toThrow('not found');
    } finally {
      db.close();
    }
  });
  it('reviews every page with actual images and never records completion after a provider failure', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'Pages inspected; no visible layout issues.',
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    try {
      const preview = {
        digest: 'abc',
        pages: ['image1', 'image2', 'image3', 'image4'],
        warnings: [],
      };
      const result = await reviewPreview(preview, {
        apiKey: 'test',
        baseUrl: 'https://example.com/v1',
        model: 'vision',
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result.review?.pages).toBe(4);
      expect(String(fetch.mock.calls[0][1]?.body)).toContain(
        'data:image/png;base64,image1',
      );
      fetch.mockResolvedValue(new Response('failure', { status: 503 }));
      const failed = { digest: 'xyz', pages: ['image'], warnings: [] };
      await expect(
        reviewPreview(failed, {
          apiKey: 'test',
          baseUrl: 'https://example.com/v1',
          model: 'vision',
        }),
      ).rejects.toThrow('503');
      expect(failed).not.toHaveProperty('review');
    } finally {
      fetch.mockRestore();
    }
  });
});

it('keeps template inspection and stored previews scoped to their Dot and Space', async () => {
  const w = new WorkspaceStore(':memory:', crypto.randomUUID());
  try {
    const dot = w.dots()[0],
      service = new FileService(w);
    w.bindThread('test-template-thread', dot.id, 'Template test');
    const sibling = w.createDot(dot.spaceId, 'Sibling', '', false, false);
    const data = await fixture();
    w.files.add(
      {
        id: 'other-template',
        spaceId: dot.spaceId,
        dotId: sibling.id,
        threadId: null,
        name: 'draft.docx',
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
    const tools = templateTools(
      service,
      dot.id,
      dot.spaceId,
      'test-template-thread',
      () => {},
    );
    const inspect = tools.find(
      (t) => t.name === 'inspect_word_template',
    ) as unknown as { execute: (input: unknown) => Promise<unknown> };
    await expect(
      inspect.execute({ source: { fileId: 'other-template' }, offset: 0 }),
    ).rejects.toThrow('another Dot');
    w.files.savePreview(dot.spaceId, 'other-template', {
      digest: 'digest',
      pages: [Buffer.from('test-image').toString('base64')],
      warnings: [],
    });
    const routes = fileRoutes(service);
    const response = await routes.request(
      `/spaces/${dot.spaceId}/files/other-template/preview/1`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    const otherSpace = w.createSpace('Unrelated', '');
    expect(
      (
        await routes.request(
          `/spaces/${otherSpace.id}/files/other-template/preview/1`,
        )
      ).status,
    ).toBe(400);
    const revoked = templateTools(
      service,
      dot.id,
      dot.spaceId,
      'test-template-thread',
      () => {
        throw new Error('Revoked');
      },
    );
    const search = revoked.find(
      (t) => t.name === 'find_word_templates',
    ) as unknown as { execute: (input: unknown) => Promise<unknown> };
    await expect(search.execute({ query: '' })).rejects.toThrow('Revoked');
  } finally {
    w.close();
  }
});
