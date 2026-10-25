import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { WorkspaceStore } from '../src/server/workspace.js';
import { FileService, extractFile } from '../src/server/file-service.js';
import { fileAccess } from '../src/server/file-tools.js';
import { MAX_FILE_BYTES, FILE_CHUNK_BYTES } from '../src/shared/storage.js';
import { fileRoutes, driveCallbackRoutes } from '../src/server/file-routes.js';
import { createApp } from '../src/server/app.js';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  cleanup.splice(0).forEach((fn) => fn());
});
const env = {
  APP_ORIGIN: 'https://opendots.example',
  GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_PICKER_API_KEY: 'picker-key',
  GOOGLE_PROJECT_NUMBER: '123456789',
};
const token = 'owner-token-that-is-at-least-24-characters';
function setup() {
  const w = new WorkspaceStore(':memory:', crypto.randomUUID());
  cleanup.push(() => w.close());
  const service = new FileService(w, token, env);
  const dot = w.dots()[0];
  return { w, service, dot, space: dot.spaceId };
}
function upload(
  w: WorkspaceStore,
  spaceId: string,
  dotId: string,
  content: string,
  name = 'evidence.md',
) {
  const data = Buffer.from(content);
  const { id } = w.files.startUpload({
    spaceId,
    dotId,
    threadId: null,
    name,
    mimeType: 'text/markdown',
    size: data.length,
  });
  for (let offset = 0; offset < data.length; offset += FILE_CHUNK_BYTES)
    w.files.chunk(
      spaceId,
      id,
      offset,
      data.subarray(offset, offset + FILE_CHUNK_BYTES).toString('base64'),
    );
  return id;
}
function connect(service: FileService, space: string) {
  service.workspace.files.setAccount({
    id: crypto.randomUUID(),
    spaceId: space,
    email: 'owner@example.test',
    secret: service.drive.seal({
      access_token: 'private-access',
      refresh_token: 'private-refresh',
      expiry_date: Date.now() + 3600000,
      scope: 'https://www.googleapis.com/auth/drive.file',
    }),
    rootId: null,
    folderId: null,
  });
}
function fakeGoogle() {
  type File = {
    id: string;
    name: string;
    mimeType: string;
    parents?: string[];
    appProperties?: Record<string, string>;
    size?: string;
  };
  const files: File[] = [];
  let next = 1;
  const fetcher = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path.endsWith('/about'))
        return Response.json({ user: { emailAddress: 'owner@example.test' } });
      if (path.endsWith('/files') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        const f = { ...body, id: 'drive-' + next++ };
        files.push(f);
        return Response.json(f);
      }
      if (path.endsWith('/files')) {
        const q = url.searchParams.get('q') ?? '';
        const prop = q.match(
          /key='(opendotsFolder|opendotsFile)' and value='([^']+)'/,
        );
        const parent = q.match(/'([^']+)' in parents/);
        return Response.json({
          files: files.filter(
            (f) =>
              (!prop || f.appProperties?.[prop[1]] === prop[2]) &&
              (!parent || f.parents?.includes(parent[1])),
          ),
        });
      }
      throw new Error('Unexpected Google request: ' + path);
    },
  );
  vi.stubGlobal('fetch', fetcher);
  return { files, fetcher };
}
describe('Space file storage', () => {
  it('stores local originals, indexes text, resumes identical chunks and completes once', async () => {
    const { w, service, dot, space } = setup();
    const id = upload(w, space, dot.id, 'Approved launch: Monday.');
    const result = await service.finish(space, id);
    expect(result.provider).toBe('local');
    expect(result.textStatus).toContain('Searchable');
    expect(await service.finish(space, id)).toEqual(result);
    expect(w.files.list(space, dot.id, 'launch')).toHaveLength(1);
    expect((await service.download(space, id)).data.toString()).toBe(
      'Approved launch: Monday.',
    );
    const read = await fileAccess(service, dot.id, space, () => {}).read(id);
    expect(read.content).toContain('Monday');
    expect(read).not.toHaveProperty('original');
  });
  it('rejects missing, conflicting, oversized and foreign-Space chunks', () => {
    const { w, dot, space } = setup();
    const { id } = w.files.startUpload({
      spaceId: space,
      dotId: dot.id,
      threadId: null,
      name: 'test',
      mimeType: 'text/plain',
      size: 3,
    });
    expect(() => w.files.uploadBytes(space, id)).toThrow('incomplete');
    expect(() => w.files.chunk('other', id, 0, 'YWJj')).toThrow('not found');
    expect(() => w.files.chunk(space, id, 1, 'YWJj')).toThrow('Invalid');
    expect(() => w.files.chunk(space, id, 0, 'YWJj!')).toThrow('Invalid');
    w.files.chunk(space, id, 0, 'YWJj');
    w.files.chunk(space, id, 0, 'YWJj');
    expect(() => w.files.chunk(space, id, 0, 'eHl6')).toThrow('Conflicting');
    expect(() =>
      w.files.startUpload({
        spaceId: space,
        dotId: dot.id,
        threadId: null,
        name: 'huge',
        mimeType: 'text/plain',
        size: MAX_FILE_BYTES + 1,
      }),
    ).toThrow('25 MB');
  });
  it('keeps incomplete files invisible and protects both Space and Dot boundaries', async () => {
    const { w, service, dot, space } = setup();
    const id = upload(w, space, dot.id, 'private evidence');
    expect(w.files.list(space)).toHaveLength(0);
    const other = w.createSpace('Other', '');
    const otherDot = w.createDot(other.id, 'Other', '', false, false);
    const pending = service.finish(space, id);
    await expect(service.finish(other.id, id)).rejects.toThrow('not found');
    await pending;
    const access = fileAccess(service, otherDot.id, other.id, () => {});
    expect(access.search('')).toEqual([]);
    await expect(access.read(id, space)).rejects.toThrow('cannot access');
    const sibling = w.createDot(space, 'Sibling', '', false, false);
    const siblingAccess = fileAccess(service, sibling.id, space, () => {});
    expect(siblingAccess.search('')).toEqual([]);
    await expect(siblingAccess.read(id)).rejects.toThrow('another Dot');
    w.updateDot(dot.id, { ...dot, spaceId: other.id, spaceIds: [other.id] });
    await expect(
      fileAccess(service, dot.id, space, () => {}).read(id),
    ).rejects.toThrow('cannot access');
  });
  it('checks cancellation and persists bounded memory without leaking originals or credentials', async () => {
    const { w, service, dot, space } = setup();
    const access = fileAccess(service, dot.id, space, () => {});
    const f = await access.save(
      'decision.md',
      'Decision: retain source evidence.',
    );
    expect((await access.read(f.id)).content).toContain('retain source');
    expect(access.search('source')).toHaveLength(1);
    expect(() =>
      fileAccess(service, dot.id, space, () => {
        throw new Error('cancelled');
      }).search(''),
    ).toThrow('cancelled');
    const secret = service.drive.seal({ refresh_token: 'highly-secret' });
    expect(secret).not.toContain('highly-secret');
    expect(service.drive.open(secret)).toEqual({
      refresh_token: 'highly-secret',
    });
    const b = Buffer.from(secret, 'base64');
    b[15] ^= 1;
    expect(() => service.drive.open(b.toString('base64'))).toThrow();
    expect(JSON.stringify(service.drive.status(space))).not.toContain(
      'client-secret',
    );
    expect(w.files.get(space, f.id).content).toContain('source');
  });
  it('extracts Office text and preserves unsupported originals with an honest status', async () => {
    const doc = Buffer.from(
      'UEsDBBQAAAAIAMiYSl1D6U8JUQAAAGYAAAARAAAAd29yZC9kb2N1bWVudC54bWyzKbdKyU8uzU3NK1GoyM3JK7Yqt1UqSS0uUbKzKbcqABFFIKLELizS0c8zWCElNSezLLWoUiElsSRVAcjKTMtMTbHRBykBkUVgsgBMwky2AwBQSwECFAMUAAAACADImEpdQ+lPCVEAAABmAAAAEQAAAAAAAAAAAAAAgAEAAAAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAEAAQA/AAAAgAAAAAAA',
      'base64',
    );
    expect(
      (await extractFile(doc, 'test.docx', 'application/octet-stream')).content,
    ).toContain('VYANIS delivery date verified');
    expect(
      await extractFile(Buffer.from([0, 1, 2]), 'photo.png', 'image/png'),
    ).toMatchObject({
      content: '',
      textStatus: expect.stringContaining('no readable text'),
    });
  });
  it('creates and reuses OpenDots/Space/Dot folders, including new Dots and other Spaces', async () => {
    const { w, service, dot, space } = setup();
    const google = fakeGoogle();
    connect(service, space);
    await Promise.all([
      service.drive.ensureFolders(space),
      service.drive.ensureFolders(space),
    ]);
    expect(google.files.map((f) => f.name)).toEqual([
      'OpenDots',
      'Everyday',
      'Dot',
    ]);
    const later = w.createDot(space, 'Later', '', false, false);
    await service.drive.ensureFolders(space);
    expect(google.files.filter((f) => f.name === 'Later')).toHaveLength(1);
    const other = w.createSpace('Clients', '');
    w.createDot(other.id, 'Client assistant', '', false, false);
    connect(service, other.id);
    await service.drive.ensureFolders(other.id);
    expect(google.files.filter((f) => f.name === 'OpenDots')).toHaveLength(1);
    expect(w.files.folder(w.files.account(space)!.id, dot.id)).toBeDefined();
    expect(w.files.folder(w.files.account(space)!.id, later.id)).toBeDefined();
    expect(service.drive.status(space).folderUrl).toContain(
      'drive.google.com/drive/folders/',
    );
  });
  it('binds OAuth to the initiating browser, requires the scope, and prevents state reuse', async () => {
    const { w, service, space } = setup();
    fakeGoogle();
    const getToken = vi
      .spyOn(OAuth2Client.prototype, 'getToken')
      .mockResolvedValue({
        tokens: {
          access_token: 'a',
          refresh_token: 'r',
          expiry_date: Date.now() + 3600000,
          scope: 'https://www.googleapis.com/auth/drive.file',
        },
      } as never);
    const start = service.drive.begin(space);
    const url = new URL(start.url);
    expect(url.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/drive.file',
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    await expect(
      service.drive.callback(start.state, 'different-browser', 'code'),
    ).rejects.toThrow('another browser');
    expect(getToken).not.toHaveBeenCalled();
    expect(
      await service.drive.callback(start.state, start.browser, 'code'),
    ).toBe(space);
    expect(w.files.account(space)?.email).toBe('owner@example.test');
    await expect(
      service.drive.callback(start.state, start.browser, 'code'),
    ).rejects.toThrow();
    const denied = service.drive.begin(space);
    getToken.mockResolvedValue({
      tokens: { access_token: 'a', refresh_token: 'r', scope: 'unrelated' },
    } as never);
    await expect(
      service.drive.callback(denied.state, denied.browser, 'code'),
    ).rejects.toThrow('not granted');
  });
  it('does not restore a disconnected account after an in-flight Drive response', async () => {
    const { w, service, space } = setup();
    connect(service, space);
    let resolve!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((r) => {
            resolve = r;
          }),
      ),
    );
    const pending = service.drive.ensureFolders(space);
    await vi.waitFor(() => expect(resolve).toBeDefined());
    w.files.disconnect(space);
    resolve(Response.json({ files: [] }));
    await expect(pending).rejects.toThrow('connection changed');
    expect(w.files.account(space)).toBeUndefined();
  });
  it('protects file routes with owner auth, origin checks, and current Dot access', async () => {
    const { w, dot, space } = setup();
    const store = new Store(':memory:');
    cleanup.push(() => store.close());
    const config = { mode: 'sample' as const, baseUrl: 'https://example.com' };
    const platform = new Platform(store, w, {
      baseUrl: config.baseUrl,
      voiceName: 'marin',
      slackUsers: [],
      runtimeUrl: '',
      ownerToken: token,
    });
    const app = createApp({
      store,
      runner: new Runner(store, config),
      config,
      platform,
      ownerToken: token,
    });
    expect((await app.request(`/api/spaces/${space}/files`)).status).toBe(401);
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    expect(
      (
        await app.request(`/api/spaces/${space}/storage/connect`, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://evil.example' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`/api/spaces/${space}/documents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(`/api/spaces/${space}/documents`, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://evil.example' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    const documentResponse = await app.request(
      `/api/spaces/${space}/documents`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          dotId: dot.id,
          title: 'Owner document',
          markdown: 'Authenticated content',
          formats: ['txt'],
        }),
      },
    );
    expect(documentResponse.status).toBe(200);
    const documentResult = await documentResponse.json();
    expect(documentResult.files).toHaveLength(1);
    expect(
      (await app.request(documentResult.files[0].downloadUrl)).status,
    ).toBe(401);
    const response = await app.request(`/api/spaces/${space}/files/uploads`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        dotId: dot.id,
        name: 'report.md',
        mimeType: 'text/plain',
        size: 5,
      }),
    });
    expect(response.status).toBe(200);
    const { id } = await response.json();
    expect(
      (
        await app.request(`/api/spaces/${space}/files/uploads/${id}/complete`, {
          method: 'POST',
          headers,
          body: '{}',
        })
      ).status,
    ).toBe(400);
    expect(
      (await app.request('/storage/google/callback?state=wrong')).status,
    ).toBe(400);
  });
  it('does not expose secrets in setup responses and rejects stale or foreign callback cookies', async () => {
    const { service, space } = setup();
    const app = fileRoutes(service);
    const status = await (await app.request(`/spaces/${space}/storage`)).text();
    expect(status).not.toContain('client-secret');
    expect(status).not.toContain('picker-key');
    const start = await app.request(`/spaces/${space}/storage/connect`, {
      method: 'POST',
    });
    const cookie = start.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    const { url } = await start.json();
    const state = new URL(url).searchParams.get('state');
    const callbacks = driveCallbackRoutes(service);
    expect(
      (await callbacks.request(`/google/callback?state=${state}&code=test`))
        .status,
    ).toBe(400);
  });
});

it('extracts readable PDF text inside the bounded parser worker', async () => {
  const stream = 'BT /F1 12 Tf 20 70 Td (Drive memory PDF evidence) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, '0') + ' 00000 n ')
    .join(
      '\n',
    )}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const result = await extractFile(
    Buffer.from(pdf),
    'evidence.pdf',
    'application/pdf',
  );
  expect(result.content).toContain('Drive memory PDF evidence');
});
it('copies selected Drive files into the correct Dot folder and refreshes edited text', async () => {
  const { w, service, dot, space } = setup();
  connect(service, space);
  const a = w.files.account(space)!;
  w.files.setAccount({ ...a, rootId: 'root', folderId: 'space' });
  w.files.setFolder(a.id, dot.id, 'dot-folder');
  let text = 'Original selected evidence';
  let copies = 0;
  const fetcher = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer private-access',
      );
      if (url.searchParams.has('alt')) return new Response(text);
      if (url.pathname.endsWith('/copy')) {
        copies++;
        expect(JSON.parse(String(init?.body)).parents).toEqual(['dot-folder']);
        return Response.json({
          id: 'copy-1',
          name: 'evidence.txt',
          mimeType: 'text/plain',
          size: '26',
        });
      }
      if (url.pathname.endsWith('/files')) return Response.json({ files: [] });
      return Response.json({
        id: 'source',
        name: 'evidence.txt',
        mimeType: 'text/plain',
        size: '26',
      });
    },
  );
  vi.stubGlobal('fetch', fetcher);
  const id = crypto.randomUUID();
  const [f, again] = await Promise.all([
    service.importDrive(space, dot.id, 'source', id),
    service.importDrive(space, dot.id, 'source', id),
  ]);
  expect(copies).toBe(1);
  expect(again).toEqual(f);
  expect(w.files.get(space, f.id).original).toBeNull();
  expect(await service.importDrive(space, dot.id, 'source', id)).toEqual(f);
  expect(copies).toBe(1);
  text = 'Updated decision after edit';
  const read = await fileAccess(service, dot.id, space, () => {}).read(
    f.id,
    space,
    0,
    true,
  );
  expect(read.content).toBe(text);
  expect(w.files.list(space, dot.id, 'Updated')).toHaveLength(1);
  expect(w.files.list(space, dot.id, 'Original')).toHaveLength(0);
  w.files.disconnect(space);
  await expect(service.download(space, f.id)).rejects.toThrow('not active');
  expect(
    (await fileAccess(service, dot.id, space, () => {}).read(f.id)).content,
  ).toBe(text);
});
it('uploads originals to Drive once and retains only extracted text locally', async () => {
  const { w, service, dot, space } = setup();
  connect(service, space);
  const a = w.files.account(space)!;
  w.files.setAccount({ ...a, rootId: 'root', folderId: 'space' });
  w.files.setFolder(a.id, dot.id, 'dot-folder');
  let uploads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith('/upload/')) {
        uploads++;
        const body = Buffer.from(init?.body as Uint8Array).toString();
        expect(body).toContain('"parents":["dot-folder"]');
        expect(body).toContain('Original payload');
        return Response.json({
          id: 'uploaded',
          name: 'evidence.md',
          mimeType: 'text/markdown',
        });
      }
      return Response.json({ files: [] });
    }),
  );
  const id = upload(w, space, dot.id, 'Original payload');
  const f = await service.finish(space, id);
  expect(f.provider).toBe('drive');
  expect(f.driveId).toBe('uploaded');
  expect(w.files.get(space, id).original).toBeNull();
  expect(w.files.get(space, id).content).toBe('Original payload');
  await service.finish(space, id);
  expect(uploads).toBe(1);
});
it('exports Google Docs as readable text and rejects oversized media downloads', async () => {
  const { w, service, space } = setup();
  connect(service, space);
  const a = w.files.account(space)!;
  const f = vi.fn(async (input: string | URL | Request) => {
    const u = new URL(String(input));
    expect(u.pathname).toContain('/export');
    expect(u.searchParams.get('mimeType')).toBe('text/plain');
    return new Response('Native document text');
  });
  vi.stubGlobal('fetch', f);
  expect(
    (
      await service.drive.download(
        a,
        'native-doc',
        'application/vnd.google-apps.document',
      )
    ).data.toString(),
  ).toBe('Native document text');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('x', {
          headers: { 'Content-Length': String(MAX_FILE_BYTES + 1) },
        }),
    ),
  );
  await expect(
    service.drive.download(a, 'large', 'application/pdf'),
  ).rejects.toThrow('25 MB');
});
it('restores access to originals on reconnect only for the same Google identity', () => {
  const { w, service, space } = setup();
  connect(service, space);
  const first = { ...w.files.account(space)!, googleId: 'google-person-1' };
  w.files.setAccount(first);
  w.files.disconnect(space);
  expect(w.files.canReadOriginal(space, first.id)).toBe(false);
  w.files.setAccount({ ...first, id: crypto.randomUUID() });
  expect(w.files.canReadOriginal(space, first.id)).toBe(true);
  w.files.setAccount({
    ...first,
    id: crypto.randomUUID(),
    googleId: 'google-person-2',
  });
  expect(w.files.canReadOriginal(space, first.id)).toBe(false);
  const another = w.createSpace('Other', '');
  w.files.setAccount({
    ...first,
    id: crypto.randomUUID(),
    spaceId: another.id,
  });
  expect(w.files.canReadOriginal(another.id, first.id)).toBe(false);
});

it('keeps computer uploads usable when Drive authorization expires', async () => {
  const { w, service, dot, space } = setup();
  connect(service, space);
  vi.spyOn(service.drive, 'upload').mockRejectedValue(
    new Error('Google Drive authorization expired. Reconnect this Space.'),
  );
  const id = upload(w, space, dot.id, 'Important knowledge');
  const saved = await service.finish(space, id);
  expect(saved.provider).toBe('local');
  expect(saved.textStatus).toContain('not synced to Drive');
  expect((await service.download(space, id)).data.toString()).toBe(
    'Important knowledge',
  );
  expect((await service.finish(space, id)).id).toBe(id);
});
