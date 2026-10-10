import { openSync } from 'fontkit';
import PDFDocument from 'pdfkit';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { DocumentInput } from '../shared/documents.js';
import { documentModel } from './document-model.js';
export async function renderPdf(input: DocumentInput) {
  const { blocks, accent } = documentModel(input);
  const tables = blocks.filter((b) => b.kind === 'table');
  if (tables.some((b) => b.rows[0].length > 8))
    throw new Error(
      'PDF tables support up to 8 columns. Split the table or request XLSX.',
    );
  const wide = tables.some((b) => b.rows[0].length > 4);
  const doc = new PDFDocument({
    size: 'A4',
    layout: wide ? 'landscape' : 'portrait',
    margins: { top: 66, left: 48, right: 48, bottom: 60 },
    bufferPages: true,
    info: { Title: input.title, Author: input.brand || 'OpenDots' },
  });
  const chunks: Buffer[] = [];
  const ready = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const fonts = join(
    dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    'standard_fonts',
  );
  const font = openSync(join(fonts, 'LiberationSans-Regular.ttf'));
  if (!('hasGlyphForCodePoint' in font))
    throw new Error('PDF font could not load.');
  const visibleText = [
    input.title,
    input.subtitle,
    input.brand,
    input.footer,
    ...blocks.map((b) =>
      b.kind === 'table'
        ? b.rows.flat().join(' ')
        : b.kind === 'rule'
          ? ''
          : b.text,
    ),
  ].join(' ');
  const unsupported = [
    ...new Set(
      [...visibleText].filter(
        (c) => !/\s/.test(c) && !font.hasGlyphForCodePoint(c.codePointAt(0)!),
      ),
    ),
  ];
  if (unsupported.length)
    throw new Error(
      'PDF font cannot render these characters: ' +
        unsupported.slice(0, 12).join(' ') +
        '. Use DOCX or remove unsupported symbols.',
    );
  doc.registerFont('Body', join(fonts, 'LiberationSans-Regular.ttf'));
  doc.registerFont('Bold', join(fonts, 'LiberationSans-Bold.ttf'));
  doc.registerFont('Italic', join(fonts, 'LiberationSans-Italic.ttf'));
  const left = 48,
    width = doc.page.width - 96,
    bottom = doc.page.height - 60;
  let y = 74,
    pages = 1;
  const page = () => {
    if (++pages > 150)
      throw new Error('PDF exceeds 150 pages; split the document.');
    doc.addPage();
    y = 68;
  };
  const ensure = (h: number) => {
    if (y + h > bottom) page();
  };
  const lines = (value: string, max: number, size: number, bold = false) => {
    doc.font(bold ? 'Bold' : 'Body').fontSize(size);
    const out: string[] = [];
    for (const paragraph of value.split('\n')) {
      let line = '';
      // Split long unbroken URLs/words, never clip or silently drop text.
      for (const word of paragraph.split(/\s+/)) {
        if (doc.widthOfString(line + (line ? ' ' : '') + word) <= max)
          line += (line ? ' ' : '') + word;
        else {
          if (line) out.push(line);
          line = '';
          for (const c of word) {
            if (doc.widthOfString(line + c) > max && line) {
              out.push(line);
              line = '';
            }
            line += c;
          }
        }
      }
      out.push(line);
    }
    return out;
  };
  const paragraph = (
    value: string,
    size = 10.5,
    bold = false,
    color = '243449',
    inset = 0,
    quote = false,
  ) => {
    const wrapped = lines(value, width - inset, size, bold),
      leading = size * 1.5;
    for (const line of wrapped) {
      ensure(leading);
      if (quote) doc.rect(left, y, 3, leading).fill('#' + accent);
      doc
        .font(bold ? 'Bold' : 'Body')
        .fontSize(size)
        .fillColor('#' + color)
        .text(line, left + inset, y, { lineBreak: false });
      y += leading;
    }
    y += 7;
  };
  paragraph(input.brand.toUpperCase() || 'DOCUMENT', 9, true, accent);
  y += 7;
  paragraph(input.title, input.style === 'proposal' ? 30 : 26, true, '14263D');
  if (input.subtitle) paragraph(input.subtitle, 12, false, '617186');
  doc
    .rect(left, y + 2, input.style === 'minimal' ? width : 64, 3)
    .fill('#' + accent);
  y += 29;
  for (const block of blocks) {
    if (block.kind === 'heading') {
      const size = block.level === 1 ? 19 : block.level === 2 ? 15 : 12;
      ensure(lines(block.text, width, size, true).length * size * 1.5 + 50);
      y += 10;
      paragraph(block.text, size, true, accent);
    } else if (block.kind === 'rule') {
      ensure(22);
      doc
        .moveTo(left, y + 4)
        .lineTo(left + width, y + 4)
        .strokeColor('#DFE6EE')
        .stroke();
      y += 22;
    } else if (block.kind === 'table') {
      const columns = block.rows[0].length,
        cellW = width / columns,
        size = columns > 5 ? 8 : 9;
      const leading = size * 1.4;
      const prepared = block.rows.map((row, index) =>
        row.map((v) => lines(v, cellW - 16, size, index === 0)),
      );
      const headerHeight =
        Math.max(...prepared[0].map((v) => v.length)) * leading + 16;
      if (headerHeight > (bottom - 68) / 3)
        throw new Error('PDF table header is too tall. Shorten its labels.');
      const draw = (
        row: string[][],
        start: number,
        count: number,
        header: boolean,
        stripe: boolean,
      ) => {
        const h = count * leading + 16;
        doc
          .rect(left, y, width, h)
          .fill(header ? '#' + accent : stripe ? '#F1F5F9' : '#FFFFFF');
        row.forEach((cell, col) =>
          cell.slice(start, start + count).forEach((line, lineIndex) => {
            doc
              .font(header ? 'Bold' : 'Body')
              .fontSize(size)
              .fillColor(header ? '#FFFFFF' : '#243449')
              .text(line, left + col * cellW + 8, y + 8 + lineIndex * leading, {
                lineBreak: false,
                width: cellW - 16,
                align: block.align?.[col] ?? 'left',
              });
          }),
        );
        y += h;
        doc
          .moveTo(left, y)
          .lineTo(left + width, y)
          .strokeColor('#DCE4EC')
          .lineWidth(0.5)
          .stroke();
      };
      const header = () =>
        draw(
          prepared[0],
          0,
          Math.max(...prepared[0].map((v) => v.length)),
          true,
          false,
        );
      ensure(headerHeight + leading + 16);
      header();
      prepared.slice(1).forEach((row, index) => {
        let offset = 0;
        const total = Math.max(...row.map((v) => v.length));
        while (offset < total) {
          let capacity = Math.floor((bottom - y - 16) / leading);
          if (capacity < 1) {
            page();
            header();
            capacity = Math.floor((bottom - y - 16) / leading);
          }
          const count = Math.min(total - offset, capacity);
          draw(row, offset, count, false, index % 2 === 0);
          offset += count;
          if (offset < total) {
            page();
            header();
          }
        }
      });
      y += 18;
    } else
      paragraph(
        block.text,
        block.kind === 'code' ? 9 : 10.5,
        false,
        block.kind === 'quote' ? accent : '243449',
        block.kind === 'quote' ? 14 : 0,
        block.kind === 'quote',
      );
  }
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.rect(0, 0, doc.page.width, 5).fill('#' + accent);
    doc.font('Body').fontSize(8).fillColor('#64748B');
    if (i)
      doc.text(input.brand || input.title, left, 32, {
        width,
        lineBreak: false,
        ellipsis: true,
      });
    doc
      .moveTo(left, doc.page.height - 43)
      .lineTo(left + width, doc.page.height - 43)
      .strokeColor('#DFE6EE')
      .stroke();
    doc.text(
      input.footer || input.brand || 'OpenDots',
      left,
      doc.page.height - 32,
      { width: width - 65, lineBreak: false, ellipsis: true },
    );
    doc.text(
      `${i + 1} / ${range.count}`,
      left + width - 55,
      doc.page.height - 32,
      { width: 55, align: 'right', lineBreak: false },
    );
  }
  doc.end();
  return ready;
}
