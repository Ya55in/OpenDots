import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  GmailService,
  GMAIL_SCOPES,
  GMAIL_URL,
  gmailTools,
  rawMail,
} from '../src/server/gmail.js';
import { ConnectionService } from '../src/server/connections.js';
import { connectionTools } from '../src/server/connection-tools.js';
import { connectionRoutes } from '../src/server/connection-routes.js';
const stores: WorkspaceStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((w) => w.close());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup() {
  const w = new WorkspaceStore(':memory:', 'owner');
  stores.push(w);
  const dot = w.dots()[0];
  w.bindThread('mail-thread', dot.id, 'Mail');
  const gmail = new GmailService(w, 'test-encryption-owner-token-long', {
    APP_ORIGIN: 'https://dots.example',
    GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-secret',
  });
  const client = {
    generateAuthUrl: vi.fn(() => 'https://accounts.google.com/test'),
    getToken: vi.fn(async () => ({
      tokens: {
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        expiry_date: Date.now() + 3600000,
        scope: GMAIL_SCOPES.join(' '),
      },
    })),
    setCredentials: vi.fn(),
    refreshAccessToken: vi.fn(async () => ({
      credentials: {
        access_token: 'renewed-secret',
        expiry_date: Date.now() + 3600000,
      },
    })),
  };
  vi.spyOn(gmail.drive, 'googleClient').mockReturnValue(client as never);
  const fetcher = vi.fn(async () =>
    Response.json({ emailAddress: 'hello@example.com' }),
  );
  vi.stubGlobal('fetch', fetcher);
  const service = new ConnectionService(
    w.connections,
    undefined,
    undefined,
    gmail,
  );
  const connect = async () => {
    const p = gmail.begin(dot.id, 'hello@example.com');
    return gmail.callback(p.state, p.browser, 'auth-code');
  };
  return { w, dot, gmail, client, fetcher, service, connect };
}
it('binds OAuth to browser and exact mailbox and keeps credentials encrypted', async () => {
  const { gmail, w, dot, client } = setup();
  const p = gmail.begin(dot.id, 'hello@example.com');
  await expect(gmail.callback(p.state, 'wrong', 'code')).rejects.toThrow(
    'another browser',
  );
  expect(client.getToken).not.toHaveBeenCalled();
  const c = await gmail.callback(p.state, p.browser, 'code');
  expect(c.name).toBe('hello@example.com');
  expect(JSON.stringify(c)).not.toContain('secret');
  expect(w.connections.credentials(c.id).token).not.toContain('refresh-secret');
  await expect(gmail.callback(p.state, p.browser, 'code')).rejects.toThrow();
  const bad = gmail.begin(dot.id, 'other@example.com');
  await expect(gmail.callback(bad.state, bad.browser, 'code')).rejects.toThrow(
    'does not match',
  );
  expect(w.connections.list(dot.id)).toHaveLength(1);
});
it('renews expired credentials once and preserves refresh token', async () => {
  const { gmail, w, dot, client } = setup();
  const c = w.connections.create(
    dot.id,
    {
      name: 'hello@example.com',
      url: GMAIL_URL,
      token: gmail.drive.seal({
        access_token: 'old',
        refresh_token: 'refresh-secret',
        expiry_date: 0,
      }),
    },
    gmailTools(),
  );
  await Promise.all([gmail.check(c), gmail.check(c)]);
  expect(client.refreshAccessToken).toHaveBeenCalledTimes(1);
  expect(
    gmail.drive.open<{ refresh_token: string }>(
      w.connections.credentials(c.id).token!,
    ).refresh_token,
  ).toBe('refresh-secret');
});
it('gates mail writes and executes an approval only once even with a different call ID', async () => {
  const { w, dot, service, fetcher, connect } = setup();
  const c = await connect();
  fetcher.mockClear();
  expect(() =>
    service.setTool(c.id, 'send_email', { requiresApproval: false }),
  ).toThrow('always require');
  const tools = connectionTools(
    service,
    dot.id,
    'mail-thread',
    () => {},
    new AbortController().signal,
    true,
  );
  const send = tools.find((t) => t.name.includes('send_email'))!;
  const args = {
    to: ['recipient@example.com'],
    subject: 'Review me',
    body: 'Exact body',
  };
  const pending = (await send.execute!(args, {
    toolCallId: 'model-call',
  } as never)) as { approvalId: string };
  expect(fetcher).not.toHaveBeenCalled();
  const routes = connectionRoutes(w, service);
  const execute = (toolCallId: string) =>
    routes.request('/conversations/mail-thread/connection-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId: pending.approvalId, toolCallId }),
    });
  expect((await execute('one')).status).toBe(200);
  expect((await execute('one')).status).toBe(200);
  expect((await execute('two')).status).toBe(409);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('isolates agent mailboxes and invalidates old approvals on reconnect', async () => {
  const { w, dot, service, connect } = setup();
  const first = await connect();
  expect(service.tools('other-dot')).toEqual([]);
  await connect();
  expect(w.connections.list(dot.id)).toHaveLength(1);
  expect(() => service.bound(dot.id, first.id, 'send_email')).toThrow(
    'no longer enabled',
  );
});
it('rejects header injection and encodes multilingual mail', () => {
  expect(() =>
    rawMail('hello@example.com', {
      to: ['a@example.com\r\nBcc: b@example.com'],
      subject: 'S',
      body: 'B',
    }),
  ).toThrow();
  expect(() =>
    rawMail('hello@example.com', {
      to: ['a@example.com'],
      subject: 'S\r\nBcc: b@example.com',
      body: 'B',
    }),
  ).toThrow();
  const raw = Buffer.from(
    rawMail('hello@example.com', {
      to: ['a@example.com'],
      subject: 'Offre été',
      body: 'Bonjour à vous',
    }),
    'base64url',
  ).toString();
  expect(raw).toContain('From: hello@example.com');
  expect(raw).toContain(Buffer.from('Bonjour à vous').toString('base64'));
});
