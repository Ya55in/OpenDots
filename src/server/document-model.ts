import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { RootContent, PhrasingContent } from 'mdast';
import type { DocumentInput } from '../shared/documents.js';
export type Block =
  | {
      kind: 'heading' | 'paragraph' | 'quote' | 'code' | 'bullet';
      text: string;
      level?: number;
    }
  | {
      kind: 'table';
      rows: string[][];
      align?: ('left' | 'right' | 'center' | null)[];
    }
  | { kind: 'rule' };
export function documentModel(input: DocumentInput) {
  const warnings = new Set<string>();
  const text = (node: RootContent | PhrasingContent): string => {
    if (node.type === 'image' || node.type === 'imageReference') {
      warnings.add(
        'Images were retained as captions; this renderer does not fetch remote images.',
      );
      return `[${node.alt || 'Image'}]`;
    }
    if (node.type === 'html')
      throw new Error(
        'Use Markdown instead of raw HTML in generated documents.',
      );
    if (node.type === 'break') return '\n';
    if (node.type === 'link')
      return node.children.map(text).join('') + ` (${node.url})`;
    if ('value' in node) return String(node.value);
    if ('children' in node)
      return node.children.map((n) => text(n as RootContent)).join('');
    return '';
  };
  const blocks: Block[] = [];
  const walk = (nodes: RootContent[], depth = 0) => {
    if (depth > 12) throw new Error('Document nesting is too deep.');
    for (const n of nodes) {
      if (n.type === 'heading')
        blocks.push({ kind: 'heading', text: text(n), level: n.depth });
      else if (n.type === 'table')
        blocks.push({
          kind: 'table',
          align: n.align ?? undefined,
          rows: n.children.map((r) => r.children.map(text)),
        });
      else if (n.type === 'list') {
        n.children.forEach((item, i) => {
          const prefix = n.ordered ? `${(n.start ?? 1) + i}. ` : '• ';
          item.children.forEach((child, j) => {
            if (child.type === 'list' || child.type === 'table')
              walk([child], depth + 1);
            else
              blocks.push({
                kind: 'bullet',
                text: (j ? '  ' : prefix) + text(child),
              });
          });
        });
      } else if (n.type === 'blockquote') {
        n.children.forEach((child) => {
          if (child.type === 'paragraph')
            blocks.push({ kind: 'quote', text: text(child) });
          else walk([child], depth + 1);
        });
      } else if (n.type === 'thematicBreak') blocks.push({ kind: 'rule' });
      else if (n.type === 'code') blocks.push({ kind: 'code', text: n.value });
      else if (n.type === 'definition') {
        /* Link definitions have no body. */
      } else blocks.push({ kind: 'paragraph', text: text(n) });
    }
  };
  walk(
    unified().use(remarkParse).use(remarkGfm).parse(input.markdown).children,
  );
  if (!blocks.length)
    throw new Error('Document contains no printable content.');
  // A repeated H1 is common when exporting a page. The cover already carries it.
  if (blocks[0]?.kind === 'heading' && blocks[0].text === input.title)
    blocks.shift();
  let accent =
    input.accent?.slice(1) ??
    (/vyanis/i.test(input.brand)
      ? '6842C2'
      : /vigon/i.test(input.brand)
        ? '116A96'
        : '225E68');
  const originalAccent = accent;
  const luminance = (hex: string) => {
    const rgb = [0, 2, 4]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  while (1.05 / (luminance(accent) + 0.05) < 4.5)
    accent = [0, 2, 4]
      .map((i) =>
        Math.floor(parseInt(accent.slice(i, i + 2), 16) * 0.9)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('');
  if (originalAccent !== accent)
    warnings.add(
      'The accent color was darkened for readable text and table headers.',
    );
  return { blocks, warnings: [...warnings], accent };
}
export function blockText(block: Block): string {
  return block.kind === 'table'
    ? block.rows.map((r) => r.join(' | ')).join('\n')
    : block.kind === 'rule'
      ? ''
      : block.text;
}
