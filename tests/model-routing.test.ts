import { afterEach, expect, it, vi } from 'vitest';
import {
  chooseModel,
  routerConfigFromEnv,
  routingPreferenceSchema,
} from '../src/server/model-router.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  businessProfiles,
  prepareBusinessProfiles,
} from '../src/server/business-profiles.js';
import { Store } from '../src/server/store.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { lastValueFrom, toArray } from 'rxjs';
import { completion } from './fixtures/model-stream.js';
const router = routerConfigFromEnv({ MODEL_ROUTER_ENABLED: 'true' })!;
afterEach(() => vi.restoreAllMocks());
it('manual pins override automatic risk classification and never call Jev', async () => {
  const network = vi.spyOn(globalThis, 'fetch');
  const decision = await chooseModel(
    { ...router, jevKey: 'secret' },
    { mode: 'manual', model: router.models.reasoning },
    'Audit CPS pricing',
    'vigon-presales',
    new AbortController().signal,
  );
  expect(decision.model).toBe(router.models.reasoning);
  expect(decision.source).toBe('manual');
  expect(network).not.toHaveBeenCalled();
  await expect(
    chooseModel(
      router,
      { mode: 'manual', model: 'unapproved' },
      '',
      null,
      new AbortController().signal,
    ),
  ).rejects.toThrow('no longer allowed');
  expect(
    routingPreferenceSchema.safeParse({ mode: 'auto', model: 'unapproved' })
      .success,
  ).toBe(false);
});
it('routes technical and pricing work to inexpensive reasoning without sending it to Jev', async () => {
  const network = vi.spyOn(globalThis, 'fetch');
  for (const text of [
    'Vérifier le dimensionnement PoE',
    'Préparer BPU et marge',
    'Audit contract compliance',
  ]) {
    const result = await chooseModel(
      { ...router, jevKey: 'secret' },
      { mode: 'auto' },
      text,
      'vyanis-hiba',
      new AbortController().signal,
    );
    expect(result.tier).toBe('reasoning');
  }
  expect(network).not.toHaveBeenCalled();
});
it('Jev cannot promote to premium; uncertainty stays in the inexpensive tiers', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        answers: {
          tier: { type: 'choice', choice: 'routine', confidence: 0.95 },
        },
      }),
    ),
  );
  expect(
    (
      await chooseModel(
        { ...router, jevKey: 'secret' },
        { mode: 'auto' },
        'Plan the next meeting',
        'vigon-presales',
        new AbortController().signal,
      )
    ).tier,
  ).toBe('routine');
  const body = JSON.parse(String(network.mock.calls[0][1]?.body));
  expect(body.questions.tier.type).toBe('choice');
  expect(String(network.mock.calls[0][0])).toBe(
    'https://api.typesafe.ai/v1/systemone',
  );
  network.mockResolvedValue(
    new Response(
      JSON.stringify({
        answers: {
          tier: { type: 'choice', choice: 'routine', confidence: 0.4 },
        },
      }),
    ),
  );
  expect(
    (
      await chooseModel(
        { ...router, jevKey: 'secret' },
        { mode: 'auto' },
        'Prepare proposal',
        'vyanis-hiba',
        new AbortController().signal,
      )
    ).tier,
  ).toBe('standard');
  network.mockRejectedValue(new Error('provider failure'));
  expect(
    (
      await chooseModel(
        { ...router, jevKey: 'secret' },
        { mode: 'auto' },
        'Prepare solution',
        'vigon-presales',
        new AbortController().signal,
      )
    ).tier,
  ).toBe('standard');
});
it('aborted routing does not fall through into model execution', async () => {
  const controller = new AbortController();
  controller.abort();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('aborted'));
  await expect(
    chooseModel(
      { ...router, jevKey: 'secret' },
      { mode: 'auto' },
      'Prepare proposal',
      null,
      controller.signal,
    ),
  ).rejects.toThrow();
});
it('prepares separate agents once and preserves subsequent owner edits and permissions', () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  try {
    prepareBusinessProfiles(ws);
    const ids = businessProfiles.map((p) => ws.routing.profileDot(p.id)!);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      const dot = ws.dot(id)!;
      expect(dot.memoryAllowed).toBe(false);
      expect(dot.instructions.length).toBeLessThanOrEqual(2000);
      expect(dot.spaceIds).toEqual([dot.spaceId]);
      for (const other of ids.filter((x) => x !== id))
        expect(ws.canAccessSpace(id, ws.dot(other)!.spaceId)).toBe(false);
    }
    ws.updateDot(ids[0], {
      ...ws.dot(ids[0])!,
      instructions: 'Owner customization',
      researchAllowed: false,
    });
    prepareBusinessProfiles(ws);
    expect(ws.dots()).toHaveLength(4);
    expect(ws.dot(ids[0])?.instructions).toBe('Owner customization');
    expect(ws.dot(ids[0])?.researchAllowed).toBe(false);
    ws.routing.reserveTurn(ids[0], 1, '2026-10-10');
    expect(() => ws.routing.reserveTurn(ids[0], 1, '2026-10-10')).toThrow(
      'daily turn limit',
    );
    expect(() => ws.routing.reserveTurn(ids[0], 1, '2026-10-11')).not.toThrow();
  } finally {
    ws.close();
  }
});
it('runs the pinned model through the real adapter and records routing without changing tools', async () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  const store = new Store(':memory:');
  try {
    const dot = ws.dots()[0];
    ws.bindThread('thread', dot.id, 'Test');
    ws.routing.setPreference('thread', {
      mode: 'manual',
      model: router.models.expert,
    });
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        completion({ role: 'assistant', content: 'Verified response.' }),
      );
    const agent = new DotAgent(
      store,
      ws,
      {
        router: { ...router, turnUsd: 0.5 },
        apiKey: 'fixture',
        intelligenceKey: 'fixture',
        model: router.models.reasoning,
        baseUrl: 'https://openrouter.ai/api/v1',
        runtimeUrl: '',
        voiceName: 'marin',
        slackUsers: [],
      },
      dot.id,
    );
    await lastValueFrom(
      agent
        .run({
          threadId: 'thread',
          runId: 'run',
          state: {},
          context: [],
          messages: [{ id: 'user', role: 'user', content: 'Hello' }],
          tools: [],
          forwardedProps: { model: 'unapproved' },
        })
        .pipe(toArray()),
    );
    const body = JSON.parse(String(network.mock.calls[0][1]?.body));
    expect(body.model).toBe(router.models.expert);
    expect(body.max_tokens).toBe(8000);
    expect(body.provider).toEqual(
      expect.objectContaining({
        require_parameters: true,
        data_collection: 'deny',
      }),
    );
    expect(body.models).toBeUndefined();
    expect(JSON.stringify(body.messages[0])).toContain('cache_control');
    expect(JSON.stringify(body.messages[0].content[0])).not.toContain(
      '<opendots_runtime_context>',
    );
    expect(JSON.stringify(body.messages)).toContain(
      '<opendots_runtime_context>',
    );
    expect(ws.routing.lastDecision('thread')?.source).toBe('manual');
  } finally {
    ws.close();
    store.close();
  }
});

it('validates owner conversation routes and keeps provider secrets out of status', async () => {
  const { Platform } = await import('../src/server/platform.js');
  const { VoiceService } = await import('../src/server/voice.js');
  const { workspaceRoutes } = await import('../src/server/workspace-routes.js');
  const ws = new WorkspaceStore(':memory:', 'owner');
  const store = new Store(':memory:');
  try {
    ws.bindThread('owned', ws.dots()[0].id, 'Owned');
    const platform = new Platform(store, ws, {
      router: { ...router, jevKey: 'never-return-this' },
      apiKey: 'openrouter-secret',
      baseUrl: 'https://openrouter.ai/api/v1',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    });
    const app = workspaceRoutes(platform, new VoiceService(platform));
    const update = (thread: string, body: unknown) =>
      app.request(`/conversations/${thread}/routing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await update('other', { mode: 'auto' })).status).toBe(404);
    expect(
      (await update('owned', { mode: 'manual', model: 'forged' })).status,
    ).toBe(400);
    expect(
      (await update('owned', { mode: 'auto', apiKey: 'forged' })).status,
    ).toBe(400);
    expect(
      (
        await update('owned', {
          mode: 'manual',
          model: router.models.reasoning,
        })
      ).status,
    ).toBe(200);
    const data = await (
      await app.request('/conversations/owned/routing')
    ).json();
    expect(data.preference).toEqual({
      mode: 'manual',
      model: router.models.reasoning,
    });
    expect(JSON.stringify(data)).not.toMatch(
      /never-return-this|openrouter-secret/,
    );
  } finally {
    ws.close();
    store.close();
  }
});
