import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type JSZip from 'jszip';
import { openOffice } from './word-template.js';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const xml = (s: string) =>
  new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') throw new Error(message);
    },
  }).parseFromString(s.replace(/^\uFEFF/, ''), 'application/xml');
const serialize = (node: Parameters<XMLSerializer['serializeToString']>[0]) =>
  new XMLSerializer().serializeToString(node);
const nodes = (e: Element, ns: string, name: string) =>
  Array.from(e.getElementsByTagNameNS(ns, name));
const relPath = (part: string) =>
  posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels');
function target(part: string, value: string) {
  const result = posix.normalize(
    value.startsWith('/')
      ? value.slice(1)
      : posix.join(posix.dirname(part), value),
  );
  if (result.startsWith('../') || result.includes('\\') || /[:#?]/.test(result))
    throw new Error('Invalid internal presentation relationship.');
  return result;
}
async function slideParts(zip: JSZip) {
  const doc = xml(await zip.file('ppt/presentation.xml')!.async('string'));
  const relsFile = zip.file('ppt/_rels/presentation.xml.rels');
  if (!relsFile) throw new Error('Missing presentation relationships.');
  const rels = xml(await relsFile.async('string'));
  return Array.from(doc.getElementsByTagNameNS(P, 'sldId')).map((el) => {
    const rel = Array.from(
      rels.getElementsByTagNameNS(PKG, 'Relationship'),
    ).find((r) => r.getAttribute('Id') === el.getAttributeNS(R, 'id'));
    if (
      !rel ||
      rel.getAttribute('TargetMode') === 'External' ||
      !rel.getAttribute('Type')?.endsWith('/slide')
    )
      throw new Error('Invalid slide reference.');
    const part = target('ppt/presentation.xml', rel.getAttribute('Target')!);
    if (!/^ppt\/slides\/[^/]+\.xml$/.test(part) || !zip.file(part))
      throw new Error('Missing original slide.');
    return part;
  });
}
function shapes(root: Element) {
  return ['sp', 'graphicFrame']
    .flatMap((name) => nodes(root, P, name))
    .map((shape) => ({
      element: shape,
      id: nodes(shape, P, 'cNvPr')[0]?.getAttribute('id') ?? '',
      name: nodes(shape, P, 'cNvPr')[0]?.getAttribute('name') ?? '',
    }));
}
export async function inspectPresentation(data: Buffer) {
  const zip = await openOffice(data, 'presentation');
  const parts = await slideParts(zip);
  if (!parts.length || parts.length > 100)
    throw new Error('Presentation requires 1–100 source slides.');
  const deck = xml(await zip.file('ppt/presentation.xml')!.async('string'));
  const size = deck.getElementsByTagNameNS(P, 'sldSz')[0];
  const fonts = new Set<string>();
  for (const f of Object.values(zip.files).filter((f) =>
    /^ppt\/.*\.xml$/.test(f.name),
  )) {
    const doc = xml(await f.async('string'));
    for (const name of ['latin', 'ea', 'cs'])
      for (const el of Array.from(doc.getElementsByTagNameNS(A, name))) {
        const font = el.getAttribute('typeface');
        if (font && !font.startsWith('+')) fonts.add(font);
      }
  }
  const slides = await Promise.all(
    parts.map(async (part, i) => {
      const doc = xml(await zip.file(part)!.async('string'));
      return {
        slide: i + 1,
        part,
        pictures: Array.from(doc.getElementsByTagNameNS(P, 'pic')).length,
        shapes: shapes(doc.documentElement!).map((s) => {
          const off = nodes(s.element, A, 'off')[0],
            ext = nodes(s.element, A, 'ext')[0];
          return {
            id: s.id,
            name: s.name,
            bounds:
              off && ext
                ? {
                    x: Number(off.getAttribute('x')),
                    y: Number(off.getAttribute('y')),
                    width: Number(ext.getAttribute('cx')),
                    height: Number(ext.getAttribute('cy')),
                  }
                : null,
            paragraphs: nodes(s.element, A, 'p').map((p, paragraph) => ({
              paragraph,
              text: nodes(p, A, 't')
                .map((t) => t.textContent ?? '')
                .join(''),
              fontSizes: [
                ...new Set(
                  nodes(p, A, 'rPr')
                    .map((r) => Number(r.getAttribute('sz')) / 100)
                    .filter(Boolean),
                ),
              ],
            })),
          };
        }),
      };
    }),
  );
  return {
    width: Number(size?.getAttribute('cx')),
    height: Number(size?.getAttribute('cy')),
    fonts: [...fonts],
    slides,
    note: 'Use slide number, shape id and paragraph index. Original images, masters, layouts, positions, colors, typography and editable objects are retained. Text in images is not editable. Match new text to the original available space; never assume it fits. Preview and visually review every output slide.',
  };
}
export interface SlideTextEdit {
  shapeId: string;
  paragraph: number;
  find: string;
  replace: string;
}
export interface TemplateSlide {
  sourceSlide: number;
  edits: SlideTextEdit[];
}
function applyEdits(root: Element, edits: SlideTextEdit[]) {
  for (const edit of edits) {
    const shape = shapes(root).find((s) => s.id === edit.shapeId)?.element;
    const paragraph = shape && nodes(shape, A, 'p')[edit.paragraph];
    if (!paragraph || nodes(paragraph, A, 'fld').length)
      throw new Error(
        'Slide text locator is missing or contains a field. Inspect the template again.',
      );
    if ([...edit.replace].some((c) => c.charCodeAt(0) < 32))
      throw new Error(
        'Replace one paragraph at a time without control characters.',
      );
    const texts = nodes(paragraph, A, 't'),
      full = texts.map((t) => t.textContent ?? '').join('');
    const start = full.indexOf(edit.find),
      end = start + edit.find.length;
    if (!edit.find || start < 0 || full.indexOf(edit.find, start + 1) >= 0)
      throw new Error(
        'Expected unique slide text not found. Inspect the template again.',
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
        inserted = true;
      }
      offset = stop;
    }
  }
}
// Remove excluded slides and their private notes/media instead of leaving hidden source content in the delivered ZIP.
async function prune(zip: JSZip) {
  const reachable = new Set<string>(['[Content_Types].xml', '_rels/.rels']);
  const queue = [''];
  while (queue.length) {
    const part = queue.pop()!,
      rp = part ? relPath(part) : '_rels/.rels',
      file = zip.file(rp);
    if (!file) continue;
    reachable.add(rp);
    const rels = xml(await file.async('string'));
    for (const r of Array.from(
      rels.getElementsByTagNameNS(PKG, 'Relationship'),
    )) {
      if (r.getAttribute('TargetMode') === 'External') continue;
      const path = target(part, r.getAttribute('Target') ?? '');
      if (!zip.file(path)) throw new Error(`Missing package resource: ${path}`);
      if (!reachable.has(path)) {
        reachable.add(path);
        queue.push(path);
      }
    }
  }
  for (const f of Object.values(zip.files))
    if (!f.dir && !reachable.has(f.name)) zip.remove(f.name);
  const typesFile = zip.file('[Content_Types].xml')!;
  const types = xml(await typesFile.async('string'));
  for (const entry of Array.from(types.getElementsByTagNameNS(CT, 'Override')))
    if (!zip.file((entry.getAttribute('PartName') ?? '').replace(/^\//, '')))
      entry.parentNode!.removeChild(entry);
  zip.file('[Content_Types].xml', serialize(types), { date: typesFile.date });
}
export async function editPresentation(data: Buffer, plan: TemplateSlide[]) {
  if (!plan.length || plan.length > 30)
    throw new Error('Choose 1–30 output slides.');
  const zip = await openOffice(data, 'presentation'),
    parts = await slideParts(zip);
  const presentationFile = zip.file('ppt/presentation.xml')!,
    relsFile = zip.file('ppt/_rels/presentation.xml.rels')!,
    typesFile = zip.file('[Content_Types].xml')!;
  const presentation = xml(await presentationFile.async('string')),
    rels = xml(await relsFile.async('string')),
    types = xml(await typesFile.async('string'));
  const list = presentation.getElementsByTagNameNS(P, 'sldIdLst')[0];
  if (!list) throw new Error('Missing slide list.');
  while (list.firstChild) list.removeChild(list.firstChild);
  for (const name of ['custShowLst', 'sectionLst'])
    for (const el of Array.from(presentation.getElementsByTagNameNS(P, name)))
      el.parentNode!.removeChild(el);
  for (const rel of Array.from(
    rels.getElementsByTagNameNS(PKG, 'Relationship'),
  ))
    if (
      /\/(slide|notesMaster|commentAuthors)$/.test(
        rel.getAttribute('Type') ?? '',
      )
    )
      rel.parentNode!.removeChild(rel);
  for (const el of Array.from(
    presentation.getElementsByTagNameNS(P, 'notesMasterIdLst'),
  ))
    el.parentNode!.removeChild(el);
  for (const [i, selection] of plan.entries()) {
    const source = parts[selection.sourceSlide - 1];
    if (!source) throw new Error('Source slide does not exist.');
    const sourceFile = zip.file(source)!;
    const slide = xml(await sourceFile.async('string'));
    applyEdits(slide.documentElement!, selection.edits);
    const basename = `opendots-${createHash('sha256').update(data).digest('hex').slice(0, 16)}-${i + 1}.xml`;
    const part = `ppt/slides/${basename}`,
      id = `opendotsSlide${i + 1}`;
    if (zip.file(part) && !parts.includes(part))
      throw new Error('Reserved slide path already in use.');
    zip.file(part, serialize(slide), { date: sourceFile.date });
    const sourceRels = zip.file(relPath(source));
    if (sourceRels) {
      const doc = xml(await sourceRels.async('string'));
      for (const rel of Array.from(
        doc.getElementsByTagNameNS(PKG, 'Relationship'),
      )) {
        if (
          /\/(notesSlide|comments|tags)$/.test(rel.getAttribute('Type') ?? '')
        )
          rel.parentNode!.removeChild(rel);
        // Internal slide hyperlinks would otherwise resurrect excluded source slides.
        else if (rel.getAttribute('Type')?.endsWith('/slide'))
          throw new Error(
            'This template has internal slide links. Remove those links before reordering or duplicating slides.',
          );
      }
      zip.file(relPath(part), serialize(doc), { date: sourceRels.date });
    }
    const rel = rels.createElementNS(PKG, 'Relationship');
    rel.setAttribute('Id', id);
    rel.setAttribute('Type', R + '/slide');
    rel.setAttribute('Target', `slides/${basename}`);
    rels.documentElement!.appendChild(rel);
    const slideId = presentation.createElementNS(P, 'p:sldId');
    slideId.setAttribute('id', String(256 + i));
    slideId.setAttributeNS(R, 'r:id', id);
    list.appendChild(slideId);
    const content = types.createElementNS(CT, 'Override');
    content.setAttribute('PartName', '/' + part);
    content.setAttribute(
      'ContentType',
      'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
    );
    types.documentElement!.appendChild(content);
  }
  zip.file('ppt/presentation.xml', serialize(presentation), {
    date: presentationFile.date,
  });
  zip.file('ppt/_rels/presentation.xml.rels', serialize(rels), {
    date: relsFile.date,
  });
  zip.file('[Content_Types].xml', serialize(types), { date: typesFile.date });
  // Thumbnail and document properties refer to the old client/title. Do not carry them into a new proposal.
  const rootFile = zip.file('_rels/.rels');
  if (!rootFile) throw new Error('Missing package relationships.');
  const root = xml(await rootFile.async('string'));
  for (const r of Array.from(root.getElementsByTagNameNS(PKG, 'Relationship')))
    if (!r.getAttribute('Type')?.endsWith('/officeDocument'))
      r.parentNode!.removeChild(r);
  zip.file('_rels/.rels', serialize(root), { date: rootFile.date });
  await prune(zip);
  return {
    data: await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    }),
    warnings: [
      'Original slide designs and editable text retained. Source speaker notes, comments, metadata and excluded slides were removed. Review text fit, remaining client-specific artwork and every slide before delivery.',
    ],
  };
}
