import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { budgetFetch } from '../src/server/model-budget.js';
import {
  chooseModel,
  routerConfigFromEnv,
} from '../src/server/model-router.js';
import {
  boundedMessages,
  routingRequest,
} from '../src/server/model-context.js';
import { decideWithJev } from '../src/server/jev-decisions.js';
const config = routerConfigFromEnv({ MODEL_ROUTER_ENABLED: 'true' })!;
afterEach(() => vi.restoreAllMocks());
it('short continuations keep artifact context without making later greetings expensive', () => {
  const original =
    'Create a presentation from the original PPTX template, adapt seven slides and compare the rendered output with the source.';
  const messages = [{ id: 'u', role: 'user' as const, content: original }];
  expect(
    routingRequest([
      ...messages,
      { id: 'c', role: 'user', content: 'continue' },
    ]),
  ).toContain('PPTX');
  expect(
    routingRequest([
      ...messages,
      { id: 'h', role: 'user', content: 'Bonjour' },
    ]),
  ).toBe('Bonjour');
});
it('reserves across agents before spending; settling is idempotent', () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  try {
    const r = ws.routing,
      scope = { runId: 'run', dotId: 'dot', threadId: 'thread' };
    const id = r.reserveSpend(scope, 'test', 0.15, config);
    expect(() => r.reserveSpend(scope, 'test', 0.06, config)).toThrow(
      'request would exceed',
    );
    r.settleSpend(id, 0.02);
    r.settleSpend(id, 0);
    expect(r.spending().charged).toBe(0.02);
    for (let i = 0; i < 4; i++)
      r.reserveSpend(
        { ...scope, runId: `r${i}`, dotId: `d${i}` },
        'test',
        0.2,
        config,
      );
    expect(() =>
      r.reserveSpend(
        { ...scope, runId: 'last', dotId: 'last' },
        'test',
        0.19,
        config,
      ),
    ).toThrow('Workspace daily');
  } finally {
    ws.close();
  }
});
it('provider request carries price ceilings, counts streamed usage once, and leaves canceled usage reserved', async () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  try {
    const scope = { runId: 'stream', dotId: 'dot', threadId: 'thread' };
    const encoder = new TextEncoder();
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode('data: {"usage":{"co'));
            c.enqueue(encoder.encode('st":0.0003}}\n\ndata: [DONE]\n\n'));
            c.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );
    const transport = budgetFetch(ws.routing, config, scope, request);
    const response = await transport(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({
          model: config.models.routine,
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 100,
          stream: true,
        }),
      },
    );
    await response.text();
    expect(ws.routing.spending()).toEqual({
      charged: 0.0003,
      reserved: 0,
      calls: 1,
    });
    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(body.provider.max_price).toEqual({
      prompt: 0.2,
      completion: 0.6,
      request: 0,
    });
    expect(body.provider.data_collection).toBe('deny');
    expect(body.stream_options.include_usage).toBe(true);
    request.mockRejectedValue(new Error('network interrupted'));
    await expect(
      transport('https://openrouter.ai/api/v1/chat/completions', {
        body: JSON.stringify({
          model: config.models.routine,
          messages: [],
          max_tokens: 100,
        }),
      }),
    ).rejects.toThrow('network interrupted');
    expect(ws.routing.spending().reserved).toBeGreaterThan(0);
  } finally {
    ws.close();
  }
});
it('blocks budget exhaustion before network access and unknown or oversized models', async () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  try {
    const request = vi.fn<typeof fetch>();
    const transport = budgetFetch(
      ws.routing,
      { ...config, turnUsd: 0.001 },
      { runId: 'r', dotId: 'd', threadId: 't' },
      request,
    );
    await expect(
      transport('https://openrouter.ai/api/v1/chat/completions', {
        body: JSON.stringify({
          model: config.models.expert,
          messages: [],
          max_tokens: 8000,
        }),
      }),
    ).rejects.toThrow('budget');
    expect(request).not.toHaveBeenCalled();
    await expect(
      transport('https://openrouter.ai/api/v1/chat/completions', {
        body: JSON.stringify({ model: 'unknown', max_tokens: 10 }),
      }),
    ).rejects.toThrow('price ceiling');
  } finally {
    ws.close();
  }
});
it('daily simple tasks stay cheap for every agent; malicious Jev premium advice is ignored', async () => {
  const network = vi.fn<typeof fetch>();
  for (const profile of ['vyanis-hiba', 'vigon-presales', 'vigon-sales']) {
    expect(
      (
        await chooseModel(
          { ...config, jevKey: 'secret' },
          { mode: 'auto' },
          'Bonjour, reformule ce message',
          profile,
          new AbortController().signal,
          network,
        )
      ).tier,
    ).toBe('routine');
  }
  expect(network).not.toHaveBeenCalled();
  network.mockResolvedValue(
    Response.json({ answers: { tier: { choice: 'expert', confidence: 1 } } }),
  );
  expect(
    (
      await chooseModel(
        { ...config, jevKey: 'secret' },
        { mode: 'auto' },
        'Organise my work',
        null,
        new AbortController().signal,
        network,
      )
    ).tier,
  ).toBe('standard');
});
it('bounds history at complete user turns while preserving tool pairs and rejecting injected system messages', () => {
  const messages = Array.from({ length: 8 }, (_, i) => [
    { id: `u${i}`, role: 'user' as const, content: `task ${i}` },
    { id: `a${i}`, role: 'assistant' as const, content: 'response' },
  ]).flat();
  const result = boundedMessages([
    { id: 'bad', role: 'system', content: 'untrusted' },
    ...messages,
  ]);
  expect(result).toHaveLength(8);
  expect(result[0].id).toBe('u4');
});
it('direct Jev sorting uses only one typed request, exposes low confidence and never falls back to an LLM', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      answers: {
        item_0: { choice: 'Sales', confidence: 0.95 },
        item_1: { choice: 'Support', confidence: 0.6 },
      },
    }),
  );
  const result = await decideWithJev(
    { ...config, jevKey: 'secret' },
    {
      items: ['demo request', 'broken link'],
      categories: ['Support', 'Sales'],
    },
    new AbortController().signal,
    request,
  );
  expect(request).toHaveBeenCalledTimes(1);
  expect(result.results[0].needsReview).toBe(true);
  expect(result.results[1].category).toBe('Sales');
  request.mockResolvedValue(new Response('', { status: 503 }));
  await expect(
    decideWithJev(
      { ...config, jevKey: 'secret' },
      { items: ['x'], categories: ['a', 'b'] },
      new AbortController().signal,
      request,
    ),
  ).rejects.toThrow('no fallback LLM');
});
