// Only for idempotent reads, preference writes, and history reconnection.
// Never retry generation or external tool actions here.
export async function retryConnection<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (
        attempt >= 2 ||
        signal?.aborted ||
        (status &&
          status >= 400 &&
          status < 500 &&
          status !== 408 &&
          status !== 429)
      )
        throw error;
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        const timer = setTimeout(done, [500, 1500][attempt]);
        const abort = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
  }
}
