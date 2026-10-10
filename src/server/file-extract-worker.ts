import { fileURLToPath } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import { fromBuffer } from 'yauzl';
const LIMIT = 200000;
const data = Buffer.from(workerData.data as Uint8Array);
const mime = String(workerData.mimeType);
const name = String(workerData.name).toLowerCase();
function officeText(): Promise<string> {
  return new Promise((resolve, reject) =>
    fromBuffer(
      data,
      { lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip)
          return reject(error ?? new Error('Invalid document'));
        let total = 0,
          count = 0;
        const parts: string[] = [];
        const fail = (e: Error) => {
          zip.close();
          reject(e);
        };
        zip.on('error', fail);
        zip.on('entry', (entry) => {
          if (
            ++count > 5000 ||
            entry.uncompressedSize > 8 * 1024 * 1024 ||
            (total += entry.uncompressedSize) > 30 * 1024 * 1024
          )
            return fail(new Error('Document expansion limit exceeded'));
          if (
            !/^(word\/(document|header\d+|footer\d+)|ppt\/slides\/slide\d+|xl\/(sharedStrings|worksheets\/sheet\d+))\.xml$/.test(
              entry.fileName,
            )
          ) {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (err, stream) => {
            if (err || !stream)
              return fail(err ?? new Error('Invalid document'));
            const chunks: Buffer[] = [];
            let bytes = 0;
            stream.on('data', (chunk) => {
              bytes += chunk.length;
              if (bytes > 8 * 1024 * 1024) {
                stream.destroy();
                fail(new Error('Document expansion limit exceeded'));
              } else chunks.push(chunk);
            });
            stream.on('error', fail);
            stream.on('end', () => {
              const xml = Buffer.concat(chunks).toString('utf8');
              // Plain text only: never resolve entities, execute macros or fetch links.
              parts.push(
                xml
                  .replace(/<\/(?:w:p|a:p|row)>/g, '\n')
                  .replace(/<[^>]*>/g, ' ')
                  .replace(/&lt;/g, '<')
                  .replace(/&gt;/g, '>')
                  .replace(/&quot;/g, '"')
                  .replace(/&apos;/g, "'")
                  .replace(/&amp;/g, '&'),
              );
              zip.readEntry();
            });
          });
        });
        zip.on('end', () => resolve(parts.join('\n').slice(0, LIMIT)));
        zip.readEntry();
      },
    ),
  );
}
async function extract() {
  if (mime === 'application/pdf' || name.endsWith('.pdf')) {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({
      data: new Uint8Array(data),
      standardFontDataUrl: fileURLToPath(
        new URL(
          'standard_fonts/',
          import.meta.resolve('pdfjs-dist/package.json'),
        ),
      ),
      useSystemFonts: false,
      disableFontFace: true,
    });
    try {
      const pdf = await task.promise;
      let text = '';
      for (
        let i = 1;
        i <= Math.min(pdf.numPages, 200) && text.length < LIMIT;
        i++
      ) {
        const page = await pdf.getPage(i);
        const c = await page.getTextContent();
        const pageText = c.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .trim();
        if (pageText) text += `\nPage ${i}\n` + pageText;
        page.cleanup();
      }
      return text.slice(0, LIMIT);
    } finally {
      await task.destroy();
    }
  }
  if (
    /\.(docx|pptx|xlsx)$/.test(name) ||
    mime.includes('openxmlformats-officedocument')
  )
    return officeText();
  if (
    mime.startsWith('text/') ||
    /\.(txt|md|csv|tsv|json|xml|html|log|yaml|yml)$/.test(name)
  ) {
    if (data.includes(0)) return '';
    return data.toString('utf8').slice(0, LIMIT);
  }
  return '';
}
try {
  const content = (await extract()).trim();
  parentPort?.postMessage({
    content,
    textStatus: content
      ? 'Searchable text (up to 200,000 characters; PDF up to 200 pages)'
      : 'Original saved; no readable text. Scans and media may need OCR or transcription.',
  });
} catch {
  parentPort?.postMessage({
    content: '',
    textStatus: 'Original saved; text extraction unavailable for this file.',
  });
}
