import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  OAuth2Client,
  CodeChallengeMethod,
  type Credentials,
} from 'google-auth-library';
import type { WorkspaceStore } from './workspace.js';
import type { DriveAccount } from './file-store.js';
import type { StorageStatus } from '../shared/storage.js';
import { MAX_FILE_BYTES } from '../shared/storage.js';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER = 'application/vnd.google-apps.folder';
const ID = /^[A-Za-z0-9_-]{1,200}$/;
interface GoogleApp {
  clientId: string;
  clientSecret: string;
  pickerKey: string;
  projectNumber: string;
}
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  trashed?: boolean;
}
export class DriveStorage {
  private static locks = new Map<string, Promise<unknown>>();
  constructor(
    readonly workspace: WorkspaceStore,
    private ownerToken?: string,
    private env: Record<string, string | undefined> = process.env,
  ) {}
  private key() {
    const key = this.env.STORAGE_ENCRYPTION_KEY || this.ownerToken;
    if (!key || key.length < 24)
      throw new Error(
        'Configure STORAGE_ENCRYPTION_KEY (at least 24 characters) before connecting Google Drive.',
      );
    return createHash('sha256')
      .update('OpenDots storage v1\0' + key)
      .digest();
  }
  seal(value: unknown) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key(), iv);
    return Buffer.concat([
      iv,
      c.update(JSON.stringify(value)),
      c.final(),
      c.getAuthTag(),
    ]).toString('base64');
  }
  open<T>(value: string): T {
    const b = Buffer.from(value, 'base64');
    const c = createDecipheriv('aes-256-gcm', this.key(), b.subarray(0, 12));
    c.setAuthTag(b.subarray(-16));
    return JSON.parse(
      Buffer.concat([c.update(b.subarray(12, -16)), c.final()]).toString(),
    );
  }
  private app(): GoogleApp {
    const saved = this.workspace.files.config();
    return saved
      ? this.open<GoogleApp>(saved)
      : {
          clientId: this.env.GOOGLE_CLIENT_ID ?? '',
          clientSecret: this.env.GOOGLE_CLIENT_SECRET ?? '',
          pickerKey: this.env.GOOGLE_PICKER_API_KEY ?? '',
          projectNumber: this.env.GOOGLE_PROJECT_NUMBER ?? '',
        };
  }
  get redirectUri() {
    const value = this.env.APP_ORIGIN?.split(',')[0]?.trim();
    if (!value) return '';
    const u = new URL(value);
    if (
      u.protocol !== 'https:' &&
      !['localhost', '127.0.0.1'].includes(u.hostname)
    )
      return '';
    return u.origin + '/storage/google/callback';
  }
  status(spaceId: string): StorageStatus {
    const a = this.app();
    const account = this.workspace.files.account(spaceId);
    let encryptionReady = true;
    try {
      this.key();
    } catch {
      encryptionReady = false;
    }
    return {
      connected: !!account,
      email: account?.email,
      folderUrl: account?.folderId
        ? `https://drive.google.com/drive/folders/${account.folderId}`
        : undefined,
      configured: !!(
        a.clientId &&
        a.clientSecret &&
        this.redirectUri &&
        encryptionReady
      ),
      pickerReady: !!(a.pickerKey && a.projectNumber),
      encryptionReady,
      redirectUri: this.redirectUri,
      clientId: a.clientId,
      projectNumber: a.projectNumber,
      hasClientSecret: !!a.clientSecret,
      hasPickerKey: !!a.pickerKey,
    };
  }
  saveApp(value: GoogleApp) {
    const old = this.app();
    if (
      old.clientId &&
      value.clientId !== old.clientId &&
      (this.workspace
        .spaces()
        .some((s) => this.workspace.files.account(s.id)) ||
        this.workspace
          .dots()
          .some((dot) =>
            this.workspace.connections
              .list(dot.id)
              .some((c) => c.url === 'gmail://mailbox'),
          ))
    )
      throw new Error(
        'Disconnect Google Drive and agent mailboxes before changing the Google client.',
      );
    this.workspace.files.setConfig(
      this.seal({
        ...value,
        clientSecret: value.clientSecret || old.clientSecret,
        pickerKey: value.pickerKey || old.pickerKey,
      }),
    );
  }
  private client() {
    const app = this.app();
    return new OAuth2Client(app.clientId, app.clientSecret, this.redirectUri);
  }
  googleClient(redirectUri: string) {
    const app = this.app();
    return new OAuth2Client(app.clientId, app.clientSecret, redirectUri);
  }
  begin(spaceId: string) {
    if (!this.status(spaceId).configured)
      throw new Error('Finish Google app setup before connecting this Space.');
    const state = randomBytes(32).toString('hex'),
      browser = randomBytes(32).toString('hex'),
      verifier = randomBytes(32).toString('base64url');
    this.workspace.files.startOAuth(
      spaceId,
      state,
      this.seal(verifier),
      createHash('sha256').update(browser).digest('hex'),
    );
    const url = this.client().generateAuthUrl({
      scope: [SCOPE],
      access_type: 'offline',
      prompt: 'consent select_account',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: CodeChallengeMethod.S256,
    });
    return { url, browser, state };
  }
  async callback(state: string, browser: string, code: string) {
    const pending = this.workspace.files.consumeOAuth(
      state,
      createHash('sha256').update(browser).digest('hex'),
    );
    const { tokens } = await this.client().getToken({
      code,
      codeVerifier: this.open<string>(pending.verifier),
    });
    if (
      !tokens.access_token ||
      !tokens.refresh_token ||
      !tokens.scope?.split(' ').includes(SCOPE)
    )
      throw new Error(
        'Google Drive permission was not granted. Reconnect and allow selected-file access.',
      );
    const account: DriveAccount = {
      id: randomUUID(),
      spaceId: pending.spaceId,
      email: 'Google Drive',
      secret: this.seal(tokens),
      rootId: null,
      folderId: null,
    };
    // Identity is returned by Drive itself, without requesting Gmail access.
    const about = await this.raw<{
      user?: { emailAddress?: string; permissionId?: string };
    }>(tokens.access_token, 'about?fields=user(emailAddress,permissionId)');
    account.email = about.user?.emailAddress ?? 'Google Drive';
    account.googleId = about.user?.permissionId ?? null;
    this.workspace.files.setAccount(account);
    await this.ensureFolders(pending.spaceId);
    return pending.spaceId;
  }
  private current(spaceId: string, accountId?: string) {
    const a = this.workspace.files.account(spaceId);
    if (!a || (accountId && a.id !== accountId))
      throw new Error('Google Drive connection changed. Reconnect or retry.');
    return a;
  }
  private async token(a: DriveAccount) {
    let credentials = this.open<Credentials>(a.secret);
    if (
      !credentials.access_token ||
      (credentials.expiry_date ?? 0) < Date.now() + 60000
    ) {
      const client = this.client();
      client.setCredentials(credentials);
      try {
        const refreshed = await client.refreshAccessToken();
        credentials = { ...credentials, ...refreshed.credentials };
      } catch {
        throw new Error(
          'Google Drive authorization expired. Reconnect this Space.',
        );
      }
      const current = this.current(a.spaceId, a.id);
      this.workspace.files.setAccount({
        ...current,
        secret: this.seal(credentials),
      });
    }
    this.current(a.spaceId, a.id);
    return credentials.access_token!;
  }
  private async raw<T>(
    token: string,
    path: string,
    init: RequestInit = {},
    upload = false,
  ): Promise<T> {
    const response = await fetch(
      `https://www.googleapis.com/${upload ? 'upload/' : ''}drive/v3/${path}`,
      {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60000),
        redirect: 'error',
      },
    );
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? 'Google Drive authorization expired. Reconnect this Space.'
          : `Google Drive could not complete this action (${response.status}). Check its permissions and quota.`,
      );
    return response.json() as Promise<T>;
  }
  private async request<T>(
    a: DriveAccount,
    path: string,
    init: RequestInit = {},
    upload = false,
  ) {
    const token = await this.token(a);
    const r = await this.raw<T>(token, path, init, upload);
    this.current(a.spaceId, a.id);
    return r;
  }
  private async folder(
    a: DriveAccount,
    name: string,
    key: string,
    parent?: string,
  ) {
    const owner = createHash('sha256')
      .update(this.workspace.ownerId)
      .digest('hex')
      .slice(0, 24);
    const q = `trashed=false and mimeType='${FOLDER}' and appProperties has { key='opendotsOwner' and value='${owner}' } and appProperties has { key='opendotsFolder' and value='${key}' }${parent ? ` and '${parent}' in parents` : ''}`;
    const found = await this.request<{ files: DriveFile[] }>(
      a,
      'files?' +
        new URLSearchParams({
          q,
          fields: 'files(id,name,mimeType)',
          pageSize: '2',
        }),
    );
    if (found.files[0]) return found.files[0].id;
    const created = await this.request<DriveFile>(
      a,
      'files?fields=id,name,mimeType',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          mimeType: FOLDER,
          ...(parent ? { parents: [parent] } : {}),
          appProperties: { opendotsOwner: owner, opendotsFolder: key },
        }),
      },
    );
    return created.id;
  }
  async ensureFolders(spaceId: string) {
    const a = this.current(spaceId);
    const lockKey = this.workspace.ownerId;
    const previous = DriveStorage.locks.get(lockKey) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(async () => {
        let current = this.current(spaceId, a.id);
        const space = this.workspace.spaces().find((s) => s.id === spaceId);
        if (!space) throw new Error('Space not found.');
        const rootId =
          current.rootId ?? (await this.folder(current, 'OpenDots', 'root'));
        const folderId =
          current.folderId ??
          (await this.folder(current, space.name, 'space-' + spaceId, rootId));
        current = { ...this.current(spaceId, a.id), rootId, folderId };
        this.workspace.files.setAccount(current);
        for (const dot of this.workspace
          .dots()
          .filter((d) => d.spaceIds.includes(spaceId))) {
          if (!this.workspace.files.folder(a.id, dot.id)) {
            const id = await this.folder(
              current,
              dot.name,
              'dot-' + spaceId + '-' + dot.id,
              folderId,
            );
            this.current(spaceId, a.id);
            this.workspace.files.setFolder(a.id, dot.id, id);
          }
        }
        return this.current(spaceId, a.id);
      });
    DriveStorage.locks.set(lockKey, run);
    try {
      return await run;
    } finally {
      if (DriveStorage.locks.get(lockKey) === run)
        DriveStorage.locks.delete(lockKey);
    }
  }
  private async destination(spaceId: string, dotId: string) {
    if (!this.workspace.canAccessSpace(dotId, spaceId))
      throw new Error('Dot cannot access this Space.');
    const a = await this.ensureFolders(spaceId);
    const folder = this.workspace.files.folder(a.id, dotId);
    if (!folder) throw new Error('Dot folder unavailable.');
    return { a, folder };
  }
  async picker(spaceId: string) {
    const a = this.current(spaceId);
    const app = this.app();
    if (!app.pickerKey || !app.projectNumber)
      throw new Error(
        'Configure the Google Picker API key and project number first.',
      );
    return {
      accessToken: await this.token(a),
      apiKey: app.pickerKey,
      appId: app.projectNumber,
    };
  }
  async upload(
    spaceId: string,
    dotId: string,
    id: string,
    name: string,
    mimeType: string,
    data: Buffer,
  ) {
    const { a, folder } = await this.destination(spaceId, dotId);
    // A stable app property recovers completed uploads if the client loses the response.
    const q = `trashed=false and '${folder}' in parents and appProperties has { key='opendotsFile' and value='${id}' }`;
    const existing = await this.request<{ files: DriveFile[] }>(
      a,
      'files?' +
        new URLSearchParams({ q, fields: 'files(id,name,mimeType,size)' }),
    );
    if (existing.files[0]) return { file: existing.files[0], accountId: a.id };
    const boundary = 'opendots_' + randomBytes(16).toString('hex');
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType, parents: [folder], appProperties: { opendotsFile: id } })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const file = await this.request<DriveFile>(
      a,
      'files?uploadType=multipart&fields=id,name,mimeType,size',
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      },
      true,
    );
    return { file, accountId: a.id };
  }
  async copy(
    spaceId: string,
    dotId: string,
    fileId: string,
    requestId: string,
  ) {
    if (!ID.test(fileId)) throw new Error('Invalid Drive file.');
    const { a, folder } = await this.destination(spaceId, dotId);
    const source = await this.request<DriveFile>(
      a,
      `files/${fileId}?fields=id,name,mimeType,size,trashed`,
    );
    if (
      source.trashed ||
      source.mimeType === FOLDER ||
      source.mimeType === 'application/vnd.google-apps.shortcut'
    )
      throw new Error('Select files, not folders or shortcuts.');
    if (Number(source.size ?? 0) > MAX_FILE_BYTES)
      throw new Error('Maximum file size is 25 MB.');
    const q = `trashed=false and '${folder}' in parents and appProperties has { key='opendotsFile' and value='${requestId}' }`;
    const existing = await this.request<{ files: DriveFile[] }>(
      a,
      'files?' +
        new URLSearchParams({ q, fields: 'files(id,name,mimeType,size)' }),
    );
    const file =
      existing.files[0] ??
      (await this.request<DriveFile>(
        a,
        `files/${fileId}/copy?fields=id,name,mimeType,size`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: source.name,
            parents: [folder],
            appProperties: { opendotsFile: requestId },
          }),
        },
      ));
    const data = await this.download(a, file.id, file.mimeType);
    return { file, accountId: a.id, ...data };
  }
  async download(a: DriveAccount, id: string, mimeType: string) {
    if (!ID.test(id)) throw new Error('Invalid Drive file.');
    const exports: Record<string, string> = {
      'application/vnd.google-apps.document': 'text/plain',
      'application/vnd.google-apps.spreadsheet':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.google-apps.presentation':
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    const exported = exports[mimeType];
    if (mimeType.startsWith('application/vnd.google-apps.') && !exported)
      throw new Error(
        'This Google file type cannot be imported. Export it from Google Drive first.',
      );
    const url = `https://www.googleapis.com/drive/v3/files/${id}${exported ? '/export?mimeType=' + encodeURIComponent(exported) : '?alt=media'}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${await this.token(a)}` },
      signal: AbortSignal.timeout(60000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error(`Google Drive download failed (${response.status}).`);
    if (Number(response.headers.get('content-length') ?? 0) > MAX_FILE_BYTES) {
      await response.body?.cancel();
      throw new Error('Maximum file size is 25 MB.');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of response.body!) {
      size += value.length;
      if (size > MAX_FILE_BYTES) throw new Error('Maximum file size is 25 MB.');
      chunks.push(Buffer.from(value));
    }
    this.current(a.spaceId, a.id);
    return { data: Buffer.concat(chunks), mimeType: exported ?? mimeType };
  }
}
