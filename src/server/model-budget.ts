import { FREE_ROUTER_MODEL } from '../shared/routing.js';
import { createHash } from 'node:crypto';
import type { RoutingStore } from './routing-store.js';
import { modelRates, type RouterConfig } from './model-router.js';

export class CostControlError extends Error {}

// Missing/aborted usage keeps the reservation. It is never treated as free.
export function budgetFetch(
  store: RoutingStore,
  config: RouterConfig,
  scope: { runId: string; dotId: string; threadId: string; freeOnly?: boolean },
  transport: typeof fetch = fetch,
): typeof fetch {
  return async (url, init) => {
    const address = new URL(String(url));
    const jev =
      address.origin === 'https://api.typesafe.ai' &&
      address.pathname === '/v1/systemone';
    const router =
      address.origin === 'https://openrouter.ai' &&
      address.pathname === '/api/v1/chat/completions';
    if (!jev && !router)
      throw new Error(
        'Cost-controlled model transport only supports configured OpenRouter and Jev endpoints.',
      );
    if (typeof init?.body !== 'string')
      throw new Error('Model request must have a JSON body.');
    const body = JSON.parse(init.body);
    if (scope.freeOnly && (jev || body.model !== FREE_ROUTER_MODEL))
      throw new CostControlError(
        'This conversation is free-only; paid model and Jev calls are disabled.',
      );
    let estimate: number;
    if (jev) {
      // Vendor rate is $0.042/M input, no output charge. Reserve above that rate.
      estimate = ((Buffer.byteLength(init.body) + 2048) * 0.05) / 1e6;
    } else {
      body.session_id = createHash('sha256')
        .update(`${scope.dotId}:${scope.threadId}`)
        .digest('hex');
      const firstSystem = body.messages?.find(
        (message: { role: string }) => message.role === 'system',
      );
      if (
        firstSystem &&
        typeof firstSystem.content === 'string' &&
        firstSystem.content.length >= 2048 &&
        String(body.model).startsWith('anthropic/')
      ) {
        // The SDK joins systemPrompts into one message. Split at our runtime
        // boundary so the cache breakpoint excludes timestamps and task state.
        const text = firstSystem.content as string;
        const boundary = text.indexOf('<opendots_runtime_context>');
        const prefix = boundary < 0 ? text : text.slice(0, boundary);
        firstSystem.content = [
          { type: 'text', text: prefix, cache_control: { type: 'ephemeral' } },
          ...(boundary < 0
            ? []
            : [{ type: 'text', text: text.slice(boundary) }]),
        ];
      }
      const rate = modelRates[body.model];
      if (!rate) throw new Error('This model has no approved price ceiling.');
      let imageCount = 0;
      const text = JSON.stringify(
        { messages: body.messages, tools: body.tools },
        (key, value) => {
          if (key === 'image_url') {
            imageCount++;
            return '[image]';
          }
          return value;
        },
      );
      if (imageCount && !rate.vision)
        throw new Error(
          'Selected model does not support images. Choose a vision-capable model.',
        );
      if (imageCount > 6 || Buffer.byteLength(text) > 200000)
        throw new Error(
          'Model context is too large for economical execution. Start a focused chat or retrieve fewer source sections.',
        );
      const output = Number(body.max_tokens ?? body.max_completion_tokens);
      if (!Number.isInteger(output) || output < 1 || output > 24000)
        throw new Error('A bounded model output allowance is required.');
      // UTF-8 bytes conservatively bound ordinary text tokens; reserve extra
      // framing/schema overhead and 32k tokens for each bounded preview image.
      const input = Buffer.byteLength(text) + 8192 + imageCount * 32768;
      // Allow a 25% cache-write premium without assuming future cache hits.
      estimate = (input * rate.input * 1.25 + output * rate.output) / 1e6;
      body.provider = {
        ...body.provider,
        sort: body.model === FREE_ROUTER_MODEL ? undefined : 'price',
        require_parameters: true,
        data_collection: 'deny',
        max_price: { prompt: rate.input, completion: rate.output, request: 0 },
      };
      if (body.model === FREE_ROUTER_MODEL) {
        // Never let client fallbacks or paid server plugins escape the preset.
        delete body.models;
        body.plugins = [];
      }
      if (body.stream)
        body.stream_options = { ...body.stream_options, include_usage: true };
      body.usage = { include: true };
    }
    let id: string;
    try {
      id = store.reserveSpend(
        scope,
        jev ? config.jevModel : body.model,
        estimate,
        config,
      );
    } catch (error) {
      throw new CostControlError(
        error instanceof Error ? error.message : 'AI budget unavailable.',
      );
    }
    const headers = new Headers(init.headers);
    if (router) {
      headers.set('HTTP-Referer', 'https://opendots.vyanis.tech');
      headers.set('X-OpenRouter-Title', 'OpenDots');
    }
    const finish = (outcome: 'complete' | 'failed' | 'cancelled') => {
      store.finishUsage(id, outcome);
      init.signal?.removeEventListener('abort', aborted);
    };
    const aborted = () => finish('cancelled');
    init.signal?.addEventListener('abort', aborted, { once: true });
    let response: Response;
    try {
      response = await transport(url, {
        ...init,
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      finish(init.signal?.aborted ? 'cancelled' : 'failed');
      throw error;
    }
    if (!response.ok) {
      finish('failed');
      return response;
    } // Retain unconfirmed charges.
    const settle = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const usage = (
        value as { usage?: Parameters<RoutingStore['recordUsage']>[1] }
      ).usage;
      if (usage && typeof usage === 'object') store.recordUsage(id, usage);
    };
    if (!body.stream) {
      const value = await response
        .clone()
        .json()
        .catch(() => null);
      settle(value);
      finish('complete');
      return response;
    }
    if (!response.body) {
      finish('complete');
      return response;
    }
    let pending = '';
    const decoder = new TextDecoder();
    const stream = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          if (pending.length > 2000000)
            throw new Error('Provider stream line exceeds the allowed size.');
          for (const line of lines)
            if (line.startsWith('data: ')) {
              try {
                settle(JSON.parse(line.slice(6)));
              } catch {
                /* Non-JSON SSE terminator. */
              }
            }
          controller.enqueue(chunk);
        },
        flush() {
          if (pending.startsWith('data: ')) {
            try {
              settle(JSON.parse(pending.slice(6)));
            } catch {
              /* terminator */
            }
          }
        },
      }),
    );
    const reader = stream.getReader();
    const monitored = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            finish('complete');
            controller.close();
          } else controller.enqueue(value);
        } catch (error) {
          finish(init.signal?.aborted ? 'cancelled' : 'failed');
          controller.error(error);
        }
      },
      async cancel(reason) {
        finish('cancelled');
        await reader.cancel(reason);
      },
    });
    return new Response(monitored, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
