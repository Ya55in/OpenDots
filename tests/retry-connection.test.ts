import { afterEach, expect, it, vi } from 'vitest';
import { retryConnection } from '../src/client/retry-connection';
afterEach(() => vi.useRealTimers());
it('restores a saved preference after a temporary network failure', async () => {
  vi.useFakeTimers();
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ interactive: true });
  const result = retryConnection(read);
  await vi.runAllTimersAsync();
  expect(await result).toEqual({ interactive: true });
  expect(read).toHaveBeenCalledTimes(2);
});
it('does not retry revoked access', async () => {
  const read = vi.fn().mockRejectedValue({ status: 403 });
  await expect(retryConnection(read)).rejects.toEqual({ status: 403 });
  expect(read).toHaveBeenCalledTimes(1);
});
it('cancels reconnect backoff when leaving the chat', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const read = vi.fn().mockRejectedValue(new Error('offline'));
  const result = retryConnection(read, controller.signal);
  const rejected = expect(result).rejects.toBeDefined();
  await Promise.resolve();
  controller.abort();
  await rejected;
  await vi.runAllTimersAsync();
  expect(read).toHaveBeenCalledTimes(1);
});
