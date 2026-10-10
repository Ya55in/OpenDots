import JSZip from 'jszip';
import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import yauzl from 'yauzl';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export interface WordEdit {
  part: string;
  paragraph: number;
  find: string;
  replace: string;
}
function parse(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error('XML entities are not supported.');
  return new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') throw new Error(message);
    },
  }).parseFromString(xml, 'application/xml');
}
const nodes = (el: Element, name: string) =>
  Array.from(el.getElementsByTagNameNS(W, name));
export async function openWord(data: Buffer) {
  if (data.length > 25 * 1024 * 1024)
    throw new Error('Word template exceeds 25 MB.');
  // Check advertised sizes before inflating to protect the process from ZIP bombs.
  await new Promise<void>((resolve, reject) =>
    yauzl.fromBuffer(data, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      let total = 0,
        count = 0;
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        total += entry.uncompressedSize;
        if (
          ++count > 2000 ||
          total > 80 * 1024 * 1024 ||
          entry.uncompressedSize > 25 * 1024 * 1024
        ) {
          zip.close();
          reject(new Error('Word package is too large to edit safely.'));
          return;
        }
        zip.readEntry();
      });
      zip.on('end', resolve);
      zip.readEntry();
    }),
  );
  const zip = await JSZip.loadAsync(data, { checkCRC32: true });
  if (!zip.file('word/document.xml'))
    throw new Error('An original .docx Word file is required.');
  for (const f of Object.values(zip.files)) {
    if (
      /vbaProject|embeddings\/|_xmlsignatures|activeX\/|altChunk/i.test(f.name)
    )
      throw new Error(
        'Use an unsigned DOCX without macros or embedded objects.',
      );
    if (f.name.endsWith('.xml') || f.name.endsWith('.rels')) {
      const xml = await f.async('string');
      if (
        /<!DOCTYPE|<!ENTITY|\bDDE(?:AUTO)?\b|INCLUDETEXT|INCLUDEPICTURE|attachedTemplate|altChunk/i.test(
          xml,
        )
      )
        throw new Error(
          'This template contains active or externally linked content.',
        );
      if (f.name.endsWith('.rels')) {
        const rels = parse(xml).getElementsByTagName('Relationship');
        for (const r of Array.from(rels))
          if (
            r.getAttribute('TargetMode') === 'External' &&
            !(
              r.getAttribute('Type')?.endsWith('/hyperlink') &&
              /^https?:\/\//i.test(r.getAttribute('Target') ?? '')
            )
          )
            throw new Error(
              'External template resources are not supported. Embed them in Word first.',
            );
      }
    }
  }
  return zip;
}
export async function inspectWord(data: Buffer) {
  const zip = await openWord(data);
  const paragraphs: { part: string; paragraph: number; text: string }[] = [];
  const fonts = new Set<string>();
  for (const f of Object.values(zip.files)) {
    if (
      /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(
        f.name,
      )
    ) {
      const doc = parse(await f.async('string'));
      Array.from(doc.getElementsByTagNameNS(W, 'p')).forEach((p, paragraph) => {
        const text = nodes(p, 't')
          .map((t) => t.textContent ?? '')
          .join('');
        if (text.trim()) paragraphs.push({ part: f.name, paragraph, text });
      });
    }
    if (/^word\/.*\.xml$/.test(f.name)) {
      const doc = parse(await f.async('string'));
      for (const font of Array.from(doc.getElementsByTagNameNS(W, 'rFonts')))
        for (const attr of ['ascii', 'hAnsi', 'eastAsia', 'cs']) {
          const name = font.getAttributeNS(W, attr);
          if (name) fonts.add(name);
        }
    }
  }
  return {
    paragraphs,
    fonts: [...fonts],
    images: Object.keys(zip.files).filter(
      (n) => n.startsWith('word/media/') && !zip.files[n].dir,
    ),
    note: 'Paragraph numbers are stable within each XML part. Replace only the intended text. Styles, letterhead, images, tables and page setup are preserved. Prefer an unsigned draft; existing signatures and stamps are not authorization to reuse them.',
  };
}
export async function editWord(data: Buffer, edits: WordEdit[]) {
  const zip = await openWord(data);
  const changed = new Set<string>();
  for (const part of new Set(edits.map((e) => e.part))) {
    if (
      !/^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(
        part,
      )
    )
      throw new Error('Invalid Word text part.');
    const file = zip.file(part);
    if (!file) throw new Error('Template part not found.');
    const doc = parse(await file.async('string'));
    const paragraphs = Array.from(doc.getElementsByTagNameNS(W, 'p'));
    for (const edit of edits.filter((e) => e.part === part)) {
      const p = paragraphs[edit.paragraph];
      if (!p)
        throw new Error(
          'Template paragraph not found. Inspect the template first.',
        );
      // Fields, tracked changes and text boxes need explicit editing in Word.
      if (
        nodes(p, 'fldChar').length ||
        nodes(p, 'instrText').length ||
        nodes(p, 'del').length ||
        nodes(p, 'ins').length ||
        nodes(p, 'txbxContent').length
      )
        throw new Error(
          'This paragraph contains a field, tracked change or text box. Choose a plain text paragraph.',
        );
      const texts = nodes(p, 't'),
        text = texts.map((t) => t.textContent ?? '').join('');
      const start = text.indexOf(edit.find),
        end = start + edit.find.length;
      if (!edit.find || start < 0 || text.indexOf(edit.find, start + 1) >= 0)
        throw new Error(
          `Expected unique text not found in ${part} paragraph ${edit.paragraph}. Inspect it again.`,
        );
      let offset = 0,
        inserted = false;
      for (const t of texts) {
        const value = t.textContent ?? '',
          stop = offset + value.length;
        if (stop > start && offset < end) {
          t.textContent =
            value.slice(0, Math.max(0, start - offset)) +
            (!inserted ? edit.replace : '') +
            value.slice(Math.max(0, end - offset));
          t.setAttribute('xml:space', 'preserve');
          inserted = true;
        }
        offset = stop;
      }
    }
    zip.file(part, new XMLSerializer().serializeToString(doc));
    changed.add(part);
  }
  return {
    data: await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    }),
    changedParts: [...changed],
  };
}
