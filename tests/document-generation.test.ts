import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { renderDocument } from '../src/server/document-render.js';
import { documentSchema, documentFormats } from '../src/shared/documents.js';
import {
  generateFiles,
  generateBytes,
} from '../src/server/document-service.js';
import { FileService, extractFile } from '../src/server/file-service.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { fileRoutes } from '../src/server/file-routes.js';
import { fileAccess } from '../src/server/file-tools.js';
import { fileDownloadPath } from '../src/client/document-download.js';
import ExcelJS from 'exceljs';
const input = documentSchema.parse({
  title: 'Une expérience client plus fluide',
  subtitle: 'Document de démonstration · données fictives · 10 octobre 2026',
  brand: 'VYANIS',
  style: 'proposal',
  markdown: `## Une proposition claire\n\nCe document de démonstration présente une méthode structurée, des livrables concrets et une décision simple. Les montants sont fictifs : ils ne constituent pas une offre commerciale.\n\n> Recommandation : commencer par un pilote mesurable, puis ajuster le périmètre avec les équipes.\n\n## Un parcours en trois étapes\n\n1. Comprendre les besoins et les contraintes.\n2. Construire un parcours cohérent et vérifier les données.\n3. Mesurer les résultats avec des indicateurs convenus.\n\n## Investissement illustratif\n\n| Livrable | Quantité | Prix unitaire | Total |\n| :--- | ---: | ---: | ---: |\n| Atelier de cadrage | 1 | 1000 | 1000 |\n| Sessions de formation | 2 | 500 | 1000 |\n| Total HT illustratif | | | 2000 |\n\n## Prochaine décision\n\nValider les objectifs du pilote, le responsable et la date de revue. Aucun engagement n'est pris à ce stade.\n\nSource : données de démonstration créées pour vérifier le moteur de documents.`,
  formats: [...documentFormats],
  footer: 'DÉMONSTRATION · Aucun engagement commercial',
});
const clean: (() => void)[] = [];
afterEach(() => {
  clean.splice(0).forEach((f) => f());
  vi.restoreAllMocks();
});
function setup() {
  const w = new WorkspaceStore(':memory:', crypto.randomUUID());
  clean.push(() => w.close());
  const dot = w.dots()[0];
  const service = new FileService(w);
  w.bindThread('test-thread', dot.id, 'Document test');
  return { w, dot, service };
}
describe('generated documents', () => {
  it('creates valid readable binaries in every advertised format', async () => {
    for (const format of documentFormats) {
      const { data } = await renderDocument(input, format);
      expect(data.length).toBeGreaterThan(100);
      if (format === 'pdf') {
        expect(data.subarray(0, 5).toString()).toBe('%PDF-');
        const pdf = await getDocument({
          data: Uint8Array.from(data),
          useSystemFonts: false,
        }).promise;
        expect(pdf.numPages).toBe(1);
        const page = await pdf.getPage(1);
        const content = await page.getTextContent();
        expect(
          content.items
            .filter((x) => 'str' in x)
            .map((x) => ('str' in x ? x.str : ''))
            .join(' '),
        ).toContain('1 / 1');
        await pdf.cleanup();
      }
      if (['docx', 'xlsx', 'pptx'].includes(format))
        expect(data.subarray(0, 2).toString()).toBe('PK');
      if (['pdf', 'docx', 'xlsx', 'pptx'].includes(format)) {
        const read = await extractFile(
          data,
          'test.' + format,
          'application/octet-stream',
        );
        expect(read.content).toContain('Une expérience client');
        expect(read.content).toContain('2000');
      }
      if (process.env.DOCUMENT_QA_DIR) {
        mkdirSync(process.env.DOCUMENT_QA_DIR, { recursive: true });
        writeFileSync(
          `${process.env.DOCUMENT_QA_DIR}/demonstration.${format}`,
          data,
        );
      }
    }
  }, 60000);
  it('retains long table contents across PDF page breaks with page numbers', async () => {
    const markdown =
      '## Inventaire\n\n| Référence | Description |\n|---|---|\n' +
      Array.from(
        { length: 80 },
        (_, i) =>
          `| ITEM-${i} | ${'Description contrôlée et conservée. '.repeat(i === 30 ? 100 : 3)} |`,
      ).join('\n');
    const { data } = await renderDocument({ ...input, markdown }, 'pdf');
    const read = await extractFile(data, 'long.pdf', 'application/pdf');
    expect(read.content).toContain('ITEM-79');
    expect(read.content).toContain('ITEM-30');
    if (process.env.DOCUMENT_QA_DIR)
      writeFileSync(`${process.env.DOCUMENT_QA_DIR}/long-table.pdf`, data);
  }, 30000);
  it('stores usable artifacts and searchable source once, enforces Dot/Space/thread boundaries', async () => {
    const { w, dot, service } = setup();
    const args = { ...input, formats: ['docx', 'pdf'] };
    const result = await generateFiles(
      service,
      dot.id,
      dot.spaceId,
      'test-thread',
      args,
      () => {},
    );
    expect(result.errors).toEqual([]);
    expect(result.files).toHaveLength(2);
    expect(result.files[0].downloadUrl).toMatch(/^\/api\/spaces\//);
    const again = await generateFiles(
      service,
      dot.id,
      dot.spaceId,
      'test-thread',
      args,
      () => {},
    );
    expect(again.files.map((f) => f.id)).toEqual(result.files.map((f) => f.id));
    expect(w.files.list(dot.spaceId, dot.id)).toHaveLength(2);
    expect(
      (await service.download(dot.spaceId, result.files[0].id)).data
        .subarray(0, 2)
        .toString(),
    ).toBe('PK');
    expect(
      (
        await fileAccess(service, dot.id, dot.spaceId, () => {}).read(
          result.files[0].id,
        )
      ).content,
    ).toContain('2000');
    const other = w.createSpace('Other', '');
    expect(() =>
      generateFiles(service, dot.id, other.id, 'test-thread', args, () => {}),
    ).toThrow();
    expect(() =>
      generateFiles(
        service,
        dot.id,
        dot.spaceId,
        'wrong-thread',
        args,
        () => {},
      ),
    ).toThrow();
    const revoked = () => {
      throw new Error('Access revoked');
    };
    expect(() =>
      generateFiles(service, dot.id, dot.spaceId, 'test-thread', args, revoked),
    ).toThrow('Access revoked');
  }, 30000);
  it('does not save a generated file after access is revoked during rendering', async () => {
    const { w, dot, service } = setup();
    let checks = 0;
    const r = await generateFiles(
      service,
      dot.id,
      dot.spaceId,
      'test-thread',
      { ...input, formats: ['txt'] },
      () => {
        if (++checks > 2) throw new Error('Revoked');
      },
    );
    expect(r.files).toHaveLength(0);
    expect(w.files.list(dot.spaceId)).toHaveLength(0);
  }, 20000);
  it('returns partial successes honestly, rejects invalid raw HTML, keeps CSV safe for spreadsheets', async () => {
    const { dot, service } = setup();
    const r = await generateFiles(
      service,
      dot.id,
      dot.spaceId,
      null,
      { ...input, markdown: 'No table', formats: ['txt', 'csv'] },
      () => {},
    );
    expect(r.files).toHaveLength(1);
    expect(r.errors?.[0]).toContain('CSV needs exactly one');
    await expect(
      renderDocument(
        {
          ...input,
          markdown: '<script>fetch("https://example.test")</script>',
        },
        'pdf',
      ),
    ).rejects.toThrow('raw HTML');
    const { data } = await renderDocument(
      {
        ...input,
        markdown:
          '| Formula |\n|---|\n| =HYPERLINK("https://example.test") |\n| @SUM(1) |',
      },
      'csv',
    );
    expect(data.toString()).toContain("'=HYPERLINK");
    expect(data.toString()).toContain("'@SUM");
  }, 20000);
  it('writes numeric worksheet cells, editable values, and freezes table headers without executing formulas', async () => {
    const { data } = await renderDocument(
      {
        ...input,
        markdown:
          '| Item | Cost |\n|---|---|\n| =SUM(1) | 1250.5 |\n| 0012 | 0 |',
      },
      'xlsx',
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(data as never);
    const sheet = workbook.getWorksheet('Table 1')!;
    expect(sheet.getCell('A2').value).toBe('=SUM(1)');
    expect(sheet.getCell('B2').value).toBe(1250.5);
    expect(sheet.getCell('A3').value).toBe('0012');
    expect(sheet.views[0].state).toBe('frozen');
  });
  it('supports owner API export and download without unauthenticated external links', async () => {
    const { dot, service } = setup();
    const app = fileRoutes(service);
    const response = await app.request(`/spaces/${dot.spaceId}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...input,
        dotId: dot.id,
        threadId: 'test-thread',
        formats: ['txt'],
      }),
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    const path = result.files[0].downloadUrl;
    expect(fileDownloadPath(path)).toBe(path);
    expect(fileDownloadPath('https://evil.test' + path)).toBeNull();
    const downloaded = await app.request(path.slice(4));
    expect(downloaded.headers.get('Content-Disposition')).toContain(
      'attachment;',
    );
    expect(await downloaded.text()).toContain('Une expérience');
  }, 20000);
  it('cancels worker execution and validates limits before rendering', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => generateBytes(input, 'pdf', controller.signal)).toThrow();
    expect(() =>
      documentSchema.parse({ ...input, markdown: 'a'.repeat(100001) }),
    ).toThrow();
    expect(() =>
      documentSchema.parse({ ...input, formats: ['exe'] }),
    ).toThrow();
  });
  it('saves generated originals to connected Drive and caches searchable source without duplicating binaries', async () => {
    const { w, dot, service } = setup();
    w.files.setAccount({
      id: 'drive-account',
      spaceId: dot.spaceId,
      email: 'test@example.test',
      secret: 'not-used',
      rootId: null,
      folderId: null,
    });
    const upload = vi.spyOn(service.drive, 'upload').mockResolvedValue({
      accountId: 'drive-account',
      file: {
        id: 'drive-file',
        name: 'Document.txt',
        mimeType: 'text/plain',
      },
    });
    const r = await generateFiles(
      service,
      dot.id,
      dot.spaceId,
      'test-thread',
      { ...input, formats: ['txt'] },
      () => {},
    );
    expect(r.errors).toEqual([]);
    expect(upload).toHaveBeenCalledOnce();
    expect(r.files[0].provider).toBe('drive');
    const stored = w.files.get(dot.spaceId, r.files[0].id);
    expect(stored.original).toBeNull();
    expect(stored.content).toContain('2000');
    expect(stored.accountId).toBe('drive-account');
  }, 20000);
  it('rejects unsupported PDF glyphs and oversized slide tables honestly', async () => {
    await expect(
      renderDocument({ ...input, title: 'Hello 🦄' }, 'pdf'),
    ).rejects.toThrow('cannot render');
    await expect(
      renderDocument(
        {
          ...input,
          markdown: '| Header |\n|---|\n| ' + 'a'.repeat(181) + ' |',
        },
        'pptx',
      ),
    ).rejects.toThrow('180 characters');
  });
});
