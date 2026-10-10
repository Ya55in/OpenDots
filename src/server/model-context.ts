import type { RunAgentInput } from '@ag-ui/core';
export function routingRequest(messages: RunAgentInput['messages']) {
  const user = messages
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : ''));
  const latest = user.at(-1) ?? '';
  if (
    /^(continue|resume|retry|yes|ok|g[eé]n[eè]re|relance|reprends|oui)[.!\s]*$/i.test(
      latest.trim(),
    )
  ) {
    const prior = user.slice(0, -1).findLast((text) => text.length > 80);
    return `${latest}\nContinuing this task: ${prior?.slice(-6000) ?? ''}`;
  }
  return latest.slice(-12000);
}
// Keep complete user-turn groups so tool results never become detached from
// their calls. Older saved history remains in the conversation and knowledge.
export function boundedMessages(messages: RunAgentInput['messages']) {
  const safe = messages.filter(
    (m) => m.role !== 'system' && m.role !== 'developer',
  );
  const starts = safe.flatMap((m, i) => (m.role === 'user' ? [i] : []));
  let start = starts[Math.max(0, starts.length - 4)] ?? 0;
  while (JSON.stringify(safe.slice(start)).length > 90000) {
    const next = starts.find((i) => i > start);
    if (next === undefined) break;
    start = next;
  }
  return safe.slice(start);
}
