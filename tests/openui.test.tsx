import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { createParser } from '@openuidev/react-lang';
import { OpenUIBlock, openUILibrary } from '../src/client/OpenUIBlock';
import { ChatTranscript } from '../src/client/ChatTranscript';
import { OpenUIBoundary } from '../src/client/OpenUIBoundary';
import {
  OPENUI_MAX_LENGTH,
  openUIActionDraft,
  openUIRequested,
  validateOpenUI,
} from '../src/shared/openui';

const source = `root = Panel("Project comparison", [a, b, c, d, e, f, g])
a = Text("Illustrative test values only")
b = Metric("Options", "2")
c = Table(["Option", "Days"], [["A", "3"], ["B", "5"]])
d = BarChart(["A", "B"], [3, 5])
e = Input("notes", "Notes", "")
f = Select("choice", "Option", ["A", "B"])
g = Choice("Compare selected option")`;
const roots: ReactTestRenderer[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
});

describe('OpenUI boundary', () => {
  it('normalizes multiline model-generated tables before invoking the renderer', () => {
    const multiline = `root = Panel("Pipeline snapshot", [note, deals, bars])
note = Text("Illustrative only; actual revenue is not potential revenue.")
deals = Table(["Deal", "Value", "Status"],
[
["Sample A", "60,000 MAD", "Unsigned"],
["Sample B", "100,000 MAD", "Unconfirmed"]
])
bars = BarChart(
  ["A", "B"],
  [60, 100]
)`;
    const safe = validateOpenUI(multiline);
    expect(safe.source.split('\n')).toHaveLength(4);
    const parsed = createParser(
      openUILibrary.toJSONSchema(),
      openUILibrary.root,
    ).parse(safe.source);
    expect(parsed.meta.errors).toEqual([]);
    expect(parsed.meta.unresolved).toEqual([]);
    const html = renderToStaticMarkup(
      <OpenUIBlock source={multiline} disabled={true} />,
    );
    expect(html).toContain('<h3>Pipeline snapshot</h3>');
    expect(html).toContain('<td>Sample A</td>');
    expect(html).not.toContain('Original response:');
  });
  it('preserves form edits across transcript rerenders and updates the action callback', async () => {
    const messages = [
      {
        id: 'ui',
        role: 'assistant' as const,
        content: '```openui\n' + source + '\n```',
      },
    ];
    const before = vi.fn(),
      after = vi.fn();
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(
        <ChatTranscript
          messages={messages}
          calls={[]}
          openUI={true}
          actionsDisabled={false}
          onOpenUIDraft={before}
        />,
      );
    });
    roots.push(root);
    await act(async () => {
      await import('../src/client/OpenUIBlock');
    });
    await act(async () =>
      root.root
        .findByType('input')
        .props.onChange({ target: { value: 'Keep this edit' } }),
    );
    await act(async () =>
      root.update(
        <ChatTranscript
          messages={messages}
          calls={[]}
          openUI={true}
          actionsDisabled={false}
          onOpenUIDraft={after}
        />,
      ),
    );
    expect(root.root.findByType('input').props.value).toBe('Keep this edit');
    await act(async () => root.root.findByType('button').props.onClick());
    expect(after.mock.calls[0][0]).toContain('Keep this edit');
    expect(before).not.toHaveBeenCalled();
  });
  it('keeps original text when loading or rendering the optional view fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken(): never {
      throw new Error('Optional chunk failed');
    }
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(
        <OpenUIBoundary fallback={<pre>Original text</pre>}>
          <Broken />
        </OpenUIBoundary>,
      );
    });
    roots.push(root);
    expect(root.root.findByType('pre').children).toEqual(['Original text']);
  });
  it('rejects combined form data over the composer limit', () => {
    const surface = validateOpenUI(
      'root = Panel("Form", [a, b, c, d, e])\na = Input("a", "A", "")\nb = Input("b", "B", "")\nc = Input("c", "C", "")\nd = Input("d", "D", "")\ne = Choice("Continue")',
    );
    expect(() =>
      openUIActionDraft(
        surface,
        { type: 'continue_conversation', humanFriendlyMessage: 'Continue' },
        {
          a: 'x'.repeat(1000),
          b: 'x'.repeat(1000),
          c: 'x'.repeat(1000),
          d: 'x'.repeat(1000),
        },
      ),
    ).toThrow('message limit');
  });
  it('validates the actual renderer grammar and renders the allowlisted library', () => {
    const safe = validateOpenUI(source);
    const result = createParser(
      openUILibrary.toJSONSchema(),
      openUILibrary.root,
    ).parse(safe.source);
    expect(result.root).toBeTruthy();
    expect(result.meta.errors).toEqual([]);
    expect(result.meta.unresolved).toEqual([]);
    expect(result.queryStatements).toEqual([]);
    expect(result.mutationStatements).toEqual([]);
    const html = renderToStaticMarkup(
      <OpenUIBlock source={source} disabled={false} onDraft={() => {}} />,
    );
    expect(html).toContain('<h3>Project comparison</h3>');
    expect(html).toContain('<th scope="col">Days</th>');
    expect(html).toContain('Compare selected option</button>');
  });
  it.each([
    'root = Query("fetch", {})',
    'root = Panel("X", [a])\na = Mutation("delete", {})',
    'root = Panel("X", [a])\na = Text(fetch("https://evil.test"))',
    'root = Panel("X", [a])\na = Text(\nfetch("https://evil.test")\n)',
    'root = Panel("X", [a])\na = Table(["A"], [\n["x"]\n]); fetch("https://evil.test")',
    'root = Panel("X", [a])\na = Text("literal\nroot = Panel("injected", [a])")',
    'root = Panel("X", [a])\na = Table(["A"], [\n' +
      Array.from({ length: 31 }, () => '["x"]').join(',\n') +
      '\n])',
    'root = Panel("X", [a])\na = Text(@OpenUrl("javascript:alert(1)"))',
    'root = Panel("X", [root])',
    'root = Panel("X", [a, a])\na = Text("x")',
    'root = Panel("X", [a])\na = Text("x")\nb = Text("orphan")',
    'root = Panel("X", [a])\na = Text("x")\na = Text("duplicate")',
    'root = Panel("X", [a])\na = Input("constructor", "X", "")',
    'root = Panel("X", [a])\na = Text("x", "extra")',
    'root = Panel("X", [a])\na = Text("unfinished',
    'root = Panel("X", [a])\na = Table(["A"], [["x", "y"]])',
    'root = Panel("X", [a])\na = BarChart(["A"], [-1])',
    'root = Panel("X", [a])\na = BarChart(["A", "B"], [1])',
    'x'.repeat(OPENUI_MAX_LENGTH + 1),
  ])('rejects malformed, recursive, oversized and executable input', (bad) => {
    expect(() => validateOpenUI(bad)).toThrow();
  });
  it('escapes HTML as text without creating executable elements', () => {
    const html = renderToStaticMarkup(
      <OpenUIBlock
        source={
          'root = Panel("X", [a])\na = Text("<img src=x onerror=alert(1)><script>alert(1)</script>")'
        }
        disabled={true}
      />,
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });
  it('keeps original invalid content readable', () => {
    expect(
      renderToStaticMarkup(<OpenUIBlock source="malformed" disabled={false} />),
    ).toContain('Original response:');
  });
  it('accepts only known choices and bounded form values, ignoring hidden parameters', () => {
    const surface = validateOpenUI(source);
    const action = {
      type: 'continue_conversation',
      humanFriendlyMessage: 'Compare selected option',
      params: { command: 'secret hidden command', threadId: 'other' },
    };
    const draft = openUIActionDraft(surface, action, {
      notes: 'User note',
      choice: 'B',
      unrecognized: 'secret',
    });
    expect(draft).toContain('User note');
    expect(draft).toContain('"value":"B"');
    expect(draft).not.toContain('secret');
    expect(() =>
      openUIActionDraft(surface, { ...action, type: 'open_url' }, {}),
    ).toThrow();
    expect(() =>
      openUIActionDraft(
        surface,
        { ...action, humanFriendlyMessage: 'Delete everything' },
        {},
      ),
    ).toThrow();
    expect(() => openUIActionDraft(surface, action, { choice: 'C' })).toThrow();
    expect(() =>
      openUIActionDraft(surface, action, { notes: 'x'.repeat(1001) }),
    ).toThrow();
  });
  it('requires an explicit versioned web capability and honors the kill switch', () => {
    expect(openUIRequested(true, false, { openui: 1 })).toBe(true);
    for (const value of [
      undefined,
      {},
      { openui: true },
      { openui: 2 },
      { openui: '1' },
    ])
      expect(openUIRequested(true, false, value)).toBe(false);
    expect(openUIRequested(false, false, { openui: 1 })).toBe(false);
    expect(openUIRequested(true, true, { openui: 1 })).toBe(false);
  });
  it('renders legacy Markdown and user-supplied OpenUI as ordinary text', () => {
    const html = renderToStaticMarkup(
      <ChatTranscript
        messages={[
          { id: 'old', role: 'assistant', content: '**Existing history**' },
          {
            id: 'user',
            role: 'user',
            content: '```openui\n' + source + '\n```',
          },
        ]}
        calls={[]}
        openUI={true}
      />,
    );
    expect(html).toContain('<strong>Existing history</strong>');
    expect(html).not.toContain('openui-surface');
    const off = renderToStaticMarkup(
      <ChatTranscript
        messages={[
          {
            id: 'assistant',
            role: 'assistant',
            content: '```openui\n' + source + '\n```',
          },
        ]}
        calls={[]}
      />,
    );
    expect(off).toContain('language-openui');
    expect(off).not.toContain('openui-surface');
  });
  it('prepares current form values without network calls and blocks disabled actions', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected network'));
    const onDraft = vi.fn();
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(
        <OpenUIBlock source={source} disabled={false} onDraft={onDraft} />,
      );
    });
    roots.push(root);
    await act(async () => {
      root.root
        .findByType('input')
        .props.onChange({ target: { value: 'Edited note' } });
      root.root.findByType('select').props.onChange({ target: { value: 'B' } });
    });
    await act(async () => root.root.findByType('button').props.onClick());
    expect(onDraft).toHaveBeenCalledTimes(1);
    expect(onDraft.mock.calls[0][0]).toContain('Edited note');
    expect(onDraft.mock.calls[0][0]).toContain('"value":"B"');
    expect(fetch).not.toHaveBeenCalled();
    await act(async () =>
      root.update(
        <OpenUIBlock source={source} disabled={true} onDraft={onDraft} />,
      ),
    );
    await act(async () => root.root.findByType('button').props.onClick());
    expect(onDraft).toHaveBeenCalledTimes(1);
    expect(root.root.findByType('fieldset').props.disabled).toBe(true);
  });
});
