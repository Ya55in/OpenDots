import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Store } from '../src/server/store.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { memberContext } from '../src/server/members.js';
import { validateRuntimeScope } from '../src/server/runtime-scope.js';
import { pageAccess } from '../src/server/page-tools.js';
import { knowledgeAccess } from '../src/server/knowledge-tools.js';
const databases: Array<{ close(): void }> = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
});
function fixture() {
  const ws = new WorkspaceStore(':memory:', 'owner'),
    store = new Store(':memory:');
  databases.push(ws, store);
  const a = ws.spaces()[0],
    b = ws.createSpace('Private', ''),
    dot = ws.dots()[0];
  ws.updateDot(dot.id, { ...dot, spaceIds: [a.id, b.id] });
  const privateDot = ws.createDot(
    b.id,
    'Private agent',
    'Private agent rules',
    true,
    true,
  );
  ws.bindThread('owner-thread', dot.id, 'Owner secret');
  store.saveMemory('Owner private preference');
  const m = ws.members.create({
      name: 'Member A',
      dotIds: [dot.id],
      spaceIds: [a.id],
      active: true,
    }),
    other = ws.members.create({
      name: 'Member B',
      dotIds: [dot.id],
      spaceIds: [a.id],
      active: true,
    });
  const config = {
    mode: 'sample' as const,
    baseUrl: 'https://api.openai.com/v1',
  };
  const platform = new Platform(store, ws, {
    baseUrl: config.baseUrl,
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
  });
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
    ownerToken: 'owner-token',
  });
  const req = (path: string, token = m.token, method = 'GET', body?: unknown) =>
    app.request('/api' + path, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { ws, store, app, a, b, dot, privateDot, m, other, req, platform };
}
it('filters members to intersected agents and Spaces, excludes owner data, and denies every admin route', async () => {
  const f = fixture();
  const state = await (await f.req('/workspace')).json();
  expect(state.isAdmin).toBe(false);
  expect(state.spaces.map((s: { id: string }) => s.id)).toEqual([f.a.id]);
  expect(state.dots.map((d: { id: string }) => d.id)).toEqual([f.dot.id]);
  expect(state.dots[0].spaceIds).toEqual([f.a.id]);
  expect(state.conversations).toEqual([]);
  expect(state.calls).toEqual([]);
  expect((await (await f.req('/state')).json()).memories).toEqual([]);
  expect(await (await f.req('/session')).json()).toEqual({
    isAdmin: false,
    openui: true,
  });
  for (const [path, method, body] of [
    ['/admin/usage', 'GET', undefined],
    ['/admin/members', 'GET', undefined],
    ['/admin/members', 'POST', {}],
    ['/settings', 'PATCH', { paused: true }],
    ['/dots/' + f.dot.id, 'PUT', {}],
    ['/spaces', 'POST', { name: 'escape' }],
    ['/storage/google/app', 'PUT', {}],
    ['/dots/' + f.dot.id + '/computer/start', 'POST', {}],
    ['/voice/calls', 'POST', {}],
    ['/tasks', 'POST', {}],
    ['/memories', 'POST', { text: 'x' }],
  ] as const)
    expect((await f.req(path, f.m.token, method, body)).status).toBe(403);
  expect((await f.req(`/spaces/${f.b.id}/pages`)).status).toBe(403);
  expect((await f.req('/conversations/owner-thread/routing')).status).toBe(403);
  expect(
    (
      await f.req('/conversations', f.m.token, 'POST', {
        dotId: f.privateDot.id,
      })
    ).status,
  ).toBe(403);
});
it('keeps concurrent member threads, agent tools and knowledge isolated and revokes active scopes immediately', async () => {
  const f = fixture();
  await Promise.all([
    memberContext.run(f.m.member.id, async () => {
      await Promise.resolve();
      f.ws.bindThread('a-thread', f.dot.id, 'A');
      expect(f.ws.currentUserId).toBe(f.m.member.id);
    }),
    memberContext.run(f.other.member.id, async () => {
      f.ws.bindThread('b-thread', f.dot.id, 'B');
      await Promise.resolve();
      expect(f.ws.currentUserId).toBe(f.other.member.id);
    }),
  ]);
  memberContext.run(f.m.member.id, () => {
    expect(f.ws.conversations().map((t) => t.id)).toEqual(['a-thread']);
    expect(() => f.ws.requireThread('b-thread')).toThrow();
    expect(() => f.ws.requireThread('owner-thread')).toThrow();
    expect(() =>
      validateRuntimeScope(
        new Request(`http://localhost/api/copilotkit/agent/${f.dot.id}/run`, {
          method: 'POST',
        }),
        f.ws,
        { threadId: 'b-thread' },
      ),
    ).toThrow();
    const pages = pageAccess(f.ws, f.a.id, 'a-thread', () => {});
    expect(() => pages.list(f.b.id)).toThrow();
    expect(pages.spaces().map((s) => s.id)).toEqual([f.a.id]);
    expect(() =>
      knowledgeAccess(f.ws, f.dot.id, f.b.id, () => {}).search('secret'),
    ).toThrow();
  });
  f.ws.members.update(f.m.member.id, {
    name: f.m.member.name,
    dotIds: [f.dot.id],
    spaceIds: [f.a.id],
    active: false,
  });
  expect(() =>
    memberContext.run(f.m.member.id, () => f.ws.requireThread('a-thread')),
  ).toThrow('revoked');
});
it('stores hashed codes, supports replacement/revocation, validates grants, and never returns secrets in member lists', async () => {
  const f = fixture();
  const list = await (await f.req('/admin/members', 'owner-token')).json();
  expect(JSON.stringify(list)).not.toContain(f.m.token);
  expect(JSON.stringify(list)).not.toContain('tokenHash');
  const bad = await f.req('/admin/members', 'owner-token', 'POST', {
    name: 'Bad',
    dotIds: [f.privateDot.id],
    spaceIds: [f.a.id],
  });
  expect(bad.status).toBe(400);
  const rotated = await (
    await f.req(
      '/admin/members/' + f.m.member.id + '/rotate',
      'owner-token',
      'POST',
      {},
    )
  ).json();
  expect((await f.req('/workspace')).status).toBe(401);
  expect((await f.req('/workspace', rotated.token)).status).toBe(200);
  const edit = {
    name: f.m.member.name,
    email: '',
    dotIds: [f.dot.id],
    spaceIds: [f.a.id],
    active: false,
  };
  expect(
    (await f.req('/admin/members/' + f.m.member.id, 'owner-token', 'PUT', edit))
      .status,
  ).toBe(200);
  expect((await f.req('/workspace', rotated.token)).status).toBe(401);
  expect(() =>
    memberContext.run(f.m.member.id, () => f.ws.dot(f.dot.id)),
  ).toThrow('revoked');
});
it('runs a member agent with its own identity, scoped context and no owner memory or privileged tools', async () => {
  const { DotAgent } = await import('../src/server/dot-agent.js');
  const { lastValueFrom, toArray } = await import('rxjs');
  const { completion } = await import('./fixtures/model-stream.js');
  const { routerConfigFromEnv } = await import('../src/server/model-router.js');
  const f = fixture(),
    router = routerConfigFromEnv({ MODEL_ROUTER_ENABLED: 'true' })!;
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      completion({ role: 'assistant', content: 'Member response' }),
    );
  await memberContext.run(f.m.member.id, async () => {
    f.ws.bindThread('member-run', f.dot.id, 'Member');
    const agent = new DotAgent(
      f.store,
      f.ws,
      {
        router,
        apiKey: 'fixture',
        intelligenceKey: 'fixture',
        model: router.models.routine,
        baseUrl: 'https://openrouter.ai/api/v1',
        runtimeUrl: '',
        voiceName: 'marin',
        slackUsers: [],
      },
      f.dot.id,
    );
    await lastValueFrom(
      agent
        .run({
          threadId: 'member-run',
          runId: 'r',
          state: {},
          context: [],
          messages: [{ id: 'm', role: 'user', content: 'Bonjour' }],
          tools: [],
          forwardedProps: {},
        })
        .pipe(toArray()),
    );
  });
  const body = JSON.parse(String(network.mock.calls[0][1]?.body));
  expect(JSON.stringify(body)).not.toContain('Owner private preference');
  const names = body.tools.map(
    (t: { function: { name: string } }) => t.function.name,
  );
  expect(names).toContain('save_task_checkpoint');
  expect(names.some((name: string) => name.startsWith('computer_'))).toBe(
    false,
  );
  expect(f.ws.context.search('member-run', 'Bonjour')).toHaveLength(1);
  expect(f.ws.conversations().map((t) => t.id)).not.toContain('member-run');
});
