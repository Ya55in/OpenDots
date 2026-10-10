import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import ExcelJS from 'exceljs';
import type PptxType from 'pptxgenjs' with { 'resolution-mode': 'require' };
import { createRequire } from 'node:module';
type PptxConstructor = typeof PptxType extends { default: infer C }
  ? C
  : typeof PptxType;
const PptxGenJS = createRequire(import.meta.url)(
  'pptxgenjs',
) as PptxConstructor;
import type { DocumentInput } from '../shared/documents.js';
import { blockText, documentModel } from './document-model.js';
export async function renderDocx(input: DocumentInput) {
  const { blocks, accent } = documentModel(input);
  if (blocks.some((b) => b.kind === 'table' && b.rows[0].length > 8))
    throw new Error(
      'Word tables support up to 8 columns. Split the table or request XLSX.',
    );
  const wide = blocks.some((b) => b.kind === 'table' && b.rows[0].length > 4);
  const children: (Paragraph | Table)[] = [
    new Paragraph({
      children: [
        new TextRun({
          text: input.brand.toUpperCase(),
          bold: true,
          color: accent,
          size: 20,
        }),
      ],
      spacing: { after: 240 },
    }),
    new Paragraph({
      text: input.title,
      heading: HeadingLevel.TITLE,
      spacing: { after: 180 },
    }),
  ];
  if (input.subtitle)
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: input.subtitle, color: '617186', size: 25 }),
        ],
        spacing: { after: 360 },
      }),
    );
  for (const b of blocks) {
    if (b.kind === 'rule')
      children.push(
        new Paragraph({
          border: {
            bottom: { style: BorderStyle.SINGLE, color: accent, size: 8 },
          },
          spacing: { after: 160 },
        }),
      );
    else if (b.kind === 'table')
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: b.rows.map(
            (r, i) =>
              new TableRow({
                tableHeader: i === 0,
                children: r.map(
                  (value, col) =>
                    new TableCell({
                      width: {
                        size: 100 / r.length,
                        type: WidthType.PERCENTAGE,
                      },
                      borders: {
                        top: {
                          style: BorderStyle.SINGLE,
                          size: 1,
                          color: 'DCE4EC',
                        },
                        bottom: {
                          style: BorderStyle.SINGLE,
                          size: 1,
                          color: 'DCE4EC',
                        },
                        left: { style: BorderStyle.NONE },
                        right: { style: BorderStyle.NONE },
                      },
                      margins: { top: 110, bottom: 110, left: 110, right: 110 },
                      shading: {
                        type: ShadingType.CLEAR,
                        fill: i === 0 ? accent : i % 2 ? 'F1F5F9' : 'FFFFFF',
                      },
                      children: [
                        new Paragraph({
                          alignment:
                            b.align?.[col] === 'right'
                              ? AlignmentType.RIGHT
                              : b.align?.[col] === 'center'
                                ? AlignmentType.CENTER
                                : AlignmentType.LEFT,
                          children: [
                            new TextRun({
                              text: value,
                              bold: i === 0,
                              color: i === 0 ? 'FFFFFF' : '243449',
                              size: r.length > 5 ? 18 : 20,
                            }),
                          ],
                          spacing: { after: 0 },
                          keepNext: i === 0,
                        }),
                      ],
                    }),
                ),
              }),
          ),
        }),
      );
    else
      children.push(
        new Paragraph({
          ...(b.kind === 'heading'
            ? {
                heading:
                  b.level === 1
                    ? HeadingLevel.HEADING_1
                    : b.level === 2
                      ? HeadingLevel.HEADING_2
                      : HeadingLevel.HEADING_3,
                keepNext: true,
              }
            : {}),
          children: [
            new TextRun({
              text: b.text,
              ...(b.kind === 'quote' ? { italics: true, color: accent } : {}),
              ...(b.kind === 'code' ? { font: 'Courier New', size: 18 } : {}),
            }),
          ],
          spacing: {
            before: b.kind === 'heading' ? 240 : 60,
            after: 140,
            line: 300,
          },
          widowControl: true,
          ...(b.kind === 'quote'
            ? {
                indent: { left: 220 },
                border: {
                  left: {
                    color: accent,
                    style: BorderStyle.SINGLE,
                    size: 16,
                    space: 10,
                  },
                },
              }
            : {}),
        }),
      );
  }
  const doc = new Document({
    title: input.title,
    creator: input.brand || 'OpenDots',
    styles: {
      default: {
        document: { run: { font: 'Arial', size: 22, color: '243449' } },
        title: {
          run: {
            font: 'Arial',
            size: input.style === 'proposal' ? 60 : 52,
            bold: true,
            color: '14263D',
          },
        },
        heading1: { run: { color: accent, size: 36, bold: true } },
        heading2: { run: { color: accent, size: 30, bold: true } },
        heading3: { run: { color: accent, size: 25, bold: true } },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: wide ? 16838 : 11906, height: wide ? 11906 : 16838 },
            margin: { top: 1000, bottom: 1000, left: 950, right: 950 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: input.brand, color: accent, size: 17 }),
                ],
                border: {
                  bottom: { color: accent, style: BorderStyle.SINGLE, size: 8 },
                },
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    text: (input.footer || input.brand || 'OpenDots') + '  ·  ',
                    size: 16,
                    color: '64748B',
                  }),
                  new TextRun({
                    children: [
                      PageNumber.CURRENT,
                      ' / ',
                      PageNumber.TOTAL_PAGES,
                    ],
                    size: 16,
                    color: '64748B',
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}
export async function renderXlsx(input: DocumentInput) {
  const { blocks, accent } = documentModel(input);
  const book = new ExcelJS.Workbook();
  book.creator = input.brand || 'OpenDots';
  book.title = input.title;
  const overview = book.addWorksheet('Overview');
  overview.columns = [{ width: 30 }, { width: 100 }];
  overview.addRow([input.brand, input.title]);
  if (input.subtitle) overview.addRow(['', input.subtitle]);
  for (const b of blocks)
    if (b.kind !== 'table' && b.kind !== 'rule')
      for (const part of b.text.match(/[\s\S]{1,1200}/g) ?? [])
        overview.addRow([b.kind === 'heading' ? 'Section' : '', part]);
  for (const [i, block] of blocks.filter((b) => b.kind === 'table').entries()) {
    const sheet = book.addWorksheet(`Table ${i + 1}`, {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    const rows = block.rows;
    rows.forEach((row) =>
      sheet.addRow(
        row.map((v) =>
          /^-?(0|[1-9]\d*)(\.\d+)?$/.test(v) &&
          v.replace(/\D/g, '').length <= 15
            ? Number(v)
            : v,
        ),
      ),
    );
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: rows.length, column: rows[0].length },
    };
    sheet.columns.forEach((c, j) => {
      c.width = Math.min(
        55,
        Math.max(15, ...rows.map((r) => (r[j]?.length ?? 0) + 3)),
      );
    });
  }
  for (const sheet of book.worksheets) {
    sheet.pageSetup = {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: '1:1',
    };
    sheet.eachRow((row, rowIndex) => {
      row.eachCell((cell) => {
        cell.font = {
          name: 'Arial',
          size: 11,
          color: { argb: rowIndex === 1 ? 'FFFFFFFF' : 'FF243449' },
          bold: rowIndex === 1,
        };
        cell.alignment = { vertical: 'top', wrapText: true };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: {
            argb:
              rowIndex === 1
                ? 'FF' + accent
                : rowIndex % 2
                  ? 'FFF1F5F9'
                  : 'FFFFFFFF',
          },
        };
        cell.border = {
          bottom: { style: 'hair', color: { argb: 'FFDCE4EC' } },
        };
      });
      let height = 30;
      row.eachCell((cell, col) => {
        const value = String(cell.value ?? '');
        const width = (sheet.getColumn(col).width ?? 15) - 2;
        const lines = value
          .split('\n')
          .reduce(
            (n, line) => n + Math.max(1, Math.ceil(line.length / width)),
            0,
          );
        height = Math.max(height, lines * 16 + 12);
        if (value.length > 32767 || height > 400)
          throw new Error(
            'An Excel cell is too long to display readably. Split its content into shorter rows or use DOCX.',
          );
      });
      row.height = height;
    });
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}
export async function renderPptx(input: DocumentInput) {
  const { blocks, accent } = documentModel(input);
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = input.title;
  pptx.author = input.brand || 'OpenDots';
  pptx.subject = input.subtitle;
  pptx.theme = { headFontFace: 'Arial', bodyFontFace: 'Arial' };
  let count = 0;
  const slide = (title: string) => {
    if (++count > 100)
      throw new Error('Presentation exceeds 100 slides; split the content.');
    const s = pptx.addSlide();
    s.background = { color: 'F7F9FC' };
    s.addShape(pptx.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 0.16,
      h: 7.5,
      fill: { color: accent },
      line: { color: accent },
    });
    s.addText(input.brand.toUpperCase() || 'DOCUMENT', {
      x: 0.6,
      y: 0.28,
      w: 11.9,
      h: 0.3,
      fontSize: 10,
      bold: true,
      color: accent,
      margin: 0,
    });
    s.addText(title, {
      x: 0.6,
      y: 0.95,
      w: 11.9,
      h: 1.15,
      fontSize: 30,
      bold: true,
      color: '14263D',
      margin: 0,
      breakLine: false,
      fit: 'shrink',
    });
    s.addText(input.footer || input.brand || 'OpenDots', {
      x: 0.6,
      y: 7.04,
      w: 10.5,
      h: 0.22,
      fontSize: 9,
      color: '64748B',
      margin: 0,
    });
    s.addText(String(count), {
      x: 12,
      y: 7.04,
      w: 0.7,
      h: 0.22,
      fontSize: 9,
      color: '64748B',
      align: 'right',
      margin: 0,
    });
    return s;
  };
  const cover = slide(input.title);
  cover.addShape(pptx.ShapeType.rect, {
    x: 0.6,
    y: 2.35,
    w: 1,
    h: 0.05,
    fill: { color: accent },
    line: { color: accent },
  });
  if (input.subtitle)
    cover.addText(input.subtitle, {
      x: 0.6,
      y: 2.7,
      w: 10.8,
      h: 2,
      fontSize: 23,
      color: '52647B',
      margin: 0,
      fit: 'shrink',
    });
  let heading = input.title,
    body: string[] = [];
  const flush = () => {
    if (!body.length) return;
    const s = slide(heading);
    s.addText(body.join('\n\n'), {
      x: 0.6,
      y: 2.3,
      w: 11.9,
      h: 4.35,
      fontSize: 22,
      color: '243449',
      valign: 'top',
      margin: 0,
      breakLine: false,
      fit: 'shrink',
      paraSpaceAfter: 12,
    });
    body = [];
  };
  for (const b of blocks) {
    if (b.kind === 'heading') {
      flush();
      heading = b.text;
    } else if (b.kind === 'table') {
      flush();
      if (
        b.rows[0].length > 6 ||
        b.rows.some((r) => r.some((c) => c.length > 180))
      )
        throw new Error(
          'Slide tables need at most 6 columns and 180 characters per cell. Summarize the table or request XLSX.',
        );
      const rowHeight = (row: string[]) =>
        Math.max(
          0.5,
          ...row.map((value) => {
            const chars = Math.floor(
              ((11.9 / row.length - 0.2) * 72) / (14 * 0.65),
            );
            const lineCount = value
              .split('\n')
              .reduce(
                (n, line) => n + Math.max(1, Math.ceil(line.length / chars)),
                0,
              );
            return ((lineCount * 14) / 72) * 1.4 + 0.2;
          }),
        );
      const headH = rowHeight(b.rows[0]);
      if (headH > 1.3)
        throw new Error(
          'Slide table headers are too long. Shorten the column names.',
        );
      let group: string[][] = [],
        heights: number[] = [],
        totalH = headH;
      const drawTable = () => {
        const s = slide(heading);
        s.addTable(
          [
            b.rows[0].map((text) => ({
              text,
              options: { bold: true, color: 'FFFFFF', fill: { color: accent } },
            })),
            ...group.map((row) => row.map((text) => ({ text }))),
          ],
          {
            x: 0.6,
            y: 2.3,
            w: 11.9,
            fontSize: 14,
            color: '243449',
            fill: { color: 'FFFFFF' },
            border: { type: 'solid', color: 'DFE6EE', pt: 0.5 },
            margin: 5.7,
            rowH: [headH, ...heights],
            valign: 'top',
            autoPage: false,
          },
        );
        group = [];
        heights = [];
        totalH = headH;
      };
      for (const row of b.rows.slice(1)) {
        const height = rowHeight(row);
        if (headH + height > 4.25)
          throw new Error(
            'A slide table row is too tall. Shorten its cells or request XLSX.',
          );
        if (totalH + height > 4.25) drawTable();
        group.push(row);
        heights.push(height);
        totalH += height;
      }
      if (group.length || b.rows.length === 1) drawTable();
    } else if (b.kind !== 'rule') {
      // Deliberately small text budgets; preserve everything across continuation slides.
      for (const part of blockText(b).match(/.{1,500}(?:\s|$)|\S{1,500}/gs) ??
        []) {
        if (body.join('\n\n').length + part.length > 620 || body.length >= 4)
          flush();
        body.push(part.trim());
      }
    }
  }
  flush();
  return Buffer.from(
    (await pptx.write({
      outputType: 'nodebuffer',
      compression: true,
    })) as Buffer,
  );
}
