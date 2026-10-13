import { useLayoutEffect, useRef, useState } from 'react';

export const HISTORY_BATCH = 30;
export function historyStart(
  messages: { id: string }[],
  firstId: string | null,
) {
  const found = firstId ? messages.findIndex((m) => m.id === firstId) : -1;
  return found >= 0 ? found : Math.max(0, messages.length - HISTORY_BATCH);
}

// Window only the rendered transcript. Never trim the agent's messages:
// tool results, pending approvals and model context still use full history.
export function useChatHistory<T extends { id: string }>(
  messages: T[],
  loaded: boolean,
) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const pinned = useRef(true);
  const previousTop = useRef(0);
  const prepend = useRef<{ height: number; top: number } | null>(null);
  const [firstId, setFirstId] = useState<string | null>(null);
  const start = historyStart(messages, firstId);
  const ready = loaded || initialized.current;
  const visible = ready ? messages.slice(start) : [];

  const older = () => {
    const element = viewport.current;
    if (!element || !ready || start === 0 || prepend.current) return;
    pinned.current = false;
    prepend.current = { height: element.scrollHeight, top: element.scrollTop };
    setFirstId(messages[Math.max(0, start - HISTORY_BATCH)].id);
  };
  const latest = () => {
    pinned.current = true;
    const element = viewport.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
      previousTop.current = element.scrollTop;
    }
  };
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!ready || !element) return;
    if (!initialized.current) {
      initialized.current = true;
      latest();
    } else if (prepend.current) {
      element.scrollTop =
        prepend.current.top + element.scrollHeight - prepend.current.height;
      prepend.current = null;
      previousTop.current = element.scrollTop;
    } else if (pinned.current) latest();
    if (firstId === null && visible.length) setFirstId(visible[0].id);
  });
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !content.current) return;
    const observer = new ResizeObserver(() => {
      if (initialized.current && pinned.current && !prepend.current) latest();
    });
    observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  const onScroll = () => {
    const element = viewport.current;
    if (!element || !initialized.current || prepend.current) return;
    const upwards = element.scrollTop < previousTop.current;
    previousTop.current = element.scrollTop;
    pinned.current =
      element.scrollHeight - element.clientHeight - element.scrollTop < 80;
    if (upwards && element.scrollTop < 100) older();
  };
  return {
    viewport,
    content,
    visible,
    ready,
    hasOlder: ready && start > 0,
    older,
    latest,
    onScroll,
  };
}
