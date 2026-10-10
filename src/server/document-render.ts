import type { DocumentInput, DocumentFormat } from '../shared/documents.js';
import { documentModel, blockText } from './document-model.js';
import { renderPdf } from './document-pdf.js';
import { renderDocx, renderXlsx, renderPptx } from './document-office.js';
export const documentMime: Record<DocumentFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
};
export async function renderDocument(
  input: DocumentInput,
  format: DocumentFormat,
) {
  const { blocks, warnings } = documentModel(input);
  let data: Buffer;
  if (format === 'pdf') data = await renderPdf(input);
  else if (format === 'docx') data = await renderDocx(input);
  else if (format === 'xlsx') data = await renderXlsx(input);
  else if (format === 'pptx') data = await renderPptx(input);
  else if (format === 'md')
    data = Buffer.from(
      `# ${input.title}\n\n${input.subtitle}\n\n${input.markdown}\n`,
    );
  else if (format === 'txt')
    data = Buffer.from(
      [input.title, input.subtitle, ...blocks.map(blockText)]
        .filter(Boolean)
        .join('\n\n'),
    );
  else {
    const tables = blocks.filter((b) => b.kind === 'table');
    if (tables.length !== 1)
      throw new Error(
        'CSV needs exactly one Markdown table. Use XLSX for multiple tables.',
      );
    const cell = (v: string) =>
      '"' + (/^[\s]*[=+@-]/.test(v) ? "'" + v : v).replace(/"/g, '""') + '"';
    data = Buffer.from(
      '\uFEFF' + tables[0].rows.map((r) => r.map(cell).join(',')).join('\r\n'),
    );
    warnings.push(
      'CSV contains the table only; narrative text is available in the document formats.',
    );
  }
  return { data, warnings };
}
