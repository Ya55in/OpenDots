import { expect, it } from 'vitest';
import { chatError } from '../src/client/chat-error';
it('explains provider availability without dumping raw diagnostics', () => {
  const result = chatError(
    '404 No endpoints found that satisfy the max price for this request',
  );
  expect(result.title).toBe('The AI provider is unavailable');
  expect(result.text).toContain('economical alternative');
  expect(result.retry).toBe(true);
});
it.each([
  '402 insufficient credits',
  'Workspace daily budget exceeded',
  '401 unauthorized',
])('does not offer futile generation retries for %s', (message) => {
  expect(chatError(message).retry).toBe(false);
});
it('does not expose unknown provider payloads', () => {
  expect(
    JSON.stringify(chatError('internal token=secret stack trace')),
  ).not.toContain('secret');
});
it('distinguishes slow, empty and truncated responses', () => {
  expect(chatError('time limit exceeded').title).toBe(
    'The AI took too long to respond',
  );
  expect(chatError('No readable answer').title).toBe(
    'The model returned no usable answer',
  );
  expect(chatError('output limit reached').title).toBe(
    'The answer reached its length limit',
  );
});
