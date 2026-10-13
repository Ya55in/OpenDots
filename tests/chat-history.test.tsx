import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatHistory } from '../src/client/useChatHistory';
const messages = Array.from({ length: 90 }, (_, i) => ({ id: String(i) }));
let history: ReturnType<typeof useChatHistory<{ id: string }>>;
let root: ReactTestRenderer;
let top = 0;
let resized: () => void;
const viewport = {
  clientHeight: 300,
  get scrollHeight() {
    return history.visible.length * 100;
  },
  get scrollTop() {
    return top;
  },
  set scrollTop(value: number) {
    top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
  },
};
function Harness({
  items = messages,
  loaded = true,
}: {
  items?: { id: string }[];
  loaded?: boolean;
}) {
  history = useChatHistory(items, loaded);
  return (
    <div ref={history.viewport}>
      <div ref={history.content} />
    </div>
  );
}
beforeEach(() => {
  top = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
async function mount(loaded = true) {
  await act(async () => {
    root = create(<Harness loaded={loaded} />, {
      createNodeMock: () => viewport,
    });
  });
}
it('hides replay and opens directly at the latest 30 messages', async () => {
  await mount(false);
  expect(history.visible).toEqual([]);
  await act(async () => root.update(<Harness />));
  expect(history.visible.map((m) => m.id)).toEqual(
    messages.slice(-30).map((m) => m.id),
  );
  expect(top).toBe(2700);
});
it('prepends older messages on upward scroll without moving the reading position', async () => {
  await mount();
  await act(async () => {
    viewport.scrollTop = 10;
    history.onScroll();
  });
  expect(history.visible[0].id).toBe('30');
  expect(top).toBe(3010);
  await act(async () =>
    root.update(<Harness items={[...messages, { id: '90' }]} />),
  );
  expect(history.visible[0].id).toBe('30');
  expect(top).toBe(3010);
  resized();
  expect(top).toBe(3010);
});
it('keeps live replies at the bottom only while following latest messages', async () => {
  await mount();
  await act(async () =>
    root.update(<Harness items={[...messages, { id: '90' }]} />),
  );
  expect(top).toBe(2800);
  await act(async () => {
    viewport.scrollTop = 800;
    history.onScroll();
  });
  resized();
  expect(top).toBe(800);
  history.latest();
  expect(top).toBe(2800);
});
it('does not replay or collapse expanded history when reconnecting', async () => {
  await mount();
  await act(async () => history.older());
  await act(async () => root.update(<Harness loaded={false} />));
  expect(history.ready).toBe(true);
  expect(history.visible).toHaveLength(60);
  await act(async () => history.older());
  expect(history.visible).toHaveLength(90);
  expect(history.hasOlder).toBe(false);
});
