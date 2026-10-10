import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { WorkspaceStore } from './workspace.js';
import { DriveStorage } from './drive-storage.js';
import type { StoredFile } from '../shared/storage.js';
export function extractFile(
  data: Buffer,
  name: string,
  mimeType: string,
): Promise<{ content: string; textStatus: string }> {
  return new Promise((resolve) => {
    const worker = new Worker(
      new URL(
        import.meta.url.endsWith('.ts')
          ? './file-extract-worker.ts'
          : './file-extract-worker.js',
        import.meta.url,
      ),
      {
        workerData: { data, name, mimeType },
        resourceLimits: { maxOldGenerationSizeMb: 192 },
        execArgv: [],
      },
    );
    let done = false;
    const finish = (value: { content: string; textStatus: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(value);
    };
    const fail = () =>
      finish({
        content: '',
        textStatus:
          'Original saved; text extraction unavailable for this file.',
      });
    const timer = setTimeout(fail, 20000);
    worker.once('message', finish);
    worker.once('error', fail);
    worker.once('exit', () => {
      if (!done) fail();
    });
  });
}
export class FileService {
  private static inFlight = new Map<string, Promise<StoredFile>>();
  private static imports = new Map<
    string,
    { source: string; promise: Promise<StoredFile> }
  >();
  readonly drive: DriveStorage;
  constructor(
    readonly workspace: WorkspaceStore,
    ownerToken?: string,
    env?: Record<string, string | undefined>,
  ) {
    this.drive = new DriveStorage(workspace, ownerToken, env);
  }
  scope(spaceId: string, dotId: string, threadId?: string | null) {
    if (
      !this.workspace.spaces().some((s) => s.id === spaceId) ||
      !this.workspace.canAccessSpace(dotId, spaceId)
    )
      throw new Error('Dot cannot access this Space.');
    if (threadId) this.workspace.requireThread(threadId, dotId);
  }
  finish(spaceId: string, id: string) {
    try {
      const existing = this.workspace.files.get(spaceId, id);
      return Promise.resolve(this.view(existing));
    } catch {
      /* Still pending. */
    }
    const key = this.workspace.ownerId + ':' + spaceId + ':' + id;
    const pending = FileService.inFlight.get(key);
    if (pending) return pending;
    const run = (async () => {
      const u = this.workspace.files.upload(spaceId, id);
      this.scope(spaceId, u.dotId, u.threadId);
      const data = this.workspace.files.uploadBytes(spaceId, id);
      const extracted = await extractFile(data, u.name, u.mimeType);
      this.scope(spaceId, u.dotId, u.threadId);
      const drive = this.workspace.files.account(spaceId)
        ? await this.drive.upload(
            spaceId,
            u.dotId,
            id,
            u.name,
            u.mimeType,
            data,
          )
        : null;
      this.scope(spaceId, u.dotId, u.threadId);
      const result = this.workspace.files.add(
        {
          ...u,
          provider: drive ? 'drive' : 'local',
          driveId: drive?.file.id ?? null,
          textStatus: extracted.textStatus,
          createdAt: Date.now(),
        },
        extracted.content,
        drive ? null : data,
        drive?.accountId ?? null,
      );
      this.workspace.files.removeUpload(id);
      return result;
    })();
    FileService.inFlight.set(key, run);
    void run
      .finally(() => {
        if (FileService.inFlight.get(key) === run)
          FileService.inFlight.delete(key);
      })
      .catch(() => {});
    return run;
  }
  async importDrive(
    spaceId: string,
    dotId: string,
    fileId: string,
    requestId: string,
    threadId?: string,
  ) {
    this.scope(spaceId, dotId, threadId);
    try {
      const existing = this.workspace.files.get(spaceId, requestId);
      if (existing.dotId !== dotId)
        throw new Error('File belongs to another Dot.');
      return this.view(existing);
    } catch (e) {
      if (e instanceof Error && !e.message.startsWith('File not found'))
        throw e;
    }
    const key = this.workspace.ownerId + ':' + spaceId + ':' + requestId;
    const source = dotId + ':' + fileId;
    const pending = FileService.imports.get(key);
    if (pending) {
      if (pending.source !== source)
        throw new Error('Conflicting import request.');
      return pending.promise;
    }
    const run = (async () => {
      const result = await this.drive.copy(spaceId, dotId, fileId, requestId);
      const extracted = await extractFile(
        result.data,
        result.file.name,
        result.mimeType,
      );
      this.scope(spaceId, dotId, threadId);
      return this.workspace.files.add(
        {
          id: requestId,
          spaceId,
          dotId,
          threadId: threadId ?? null,
          name: result.file.name,
          mimeType: result.file.mimeType,
          size: result.data.length,
          provider: 'drive',
          driveId: result.file.id,
          textStatus: extracted.textStatus,
          createdAt: Date.now(),
        },
        extracted.content,
        null,
        result.accountId,
      );
    })();
    FileService.imports.set(key, { source, promise: run });
    try {
      return await run;
    } finally {
      FileService.imports.delete(key);
    }
  }

  async download(spaceId: string, id: string) {
    const f = this.workspace.files.get(spaceId, id);
    if (f.original !== null)
      return {
        data: Buffer.from(f.original),
        mimeType: f.mimeType,
        name: f.name,
      };
    const a = this.workspace.files.account(spaceId);
    if (!a || !this.workspace.files.canReadOriginal(spaceId, f.accountId))
      throw new Error(
        'The original Google Drive connection is not active for this file.',
      );
    const r = await this.drive.download(a, f.driveId!, f.mimeType);
    const suffix: Record<string, string> = {
      'application/vnd.google-apps.document': '.txt',
      'application/vnd.google-apps.spreadsheet': '.xlsx',
      'application/vnd.google-apps.presentation': '.pptx',
    };
    return { ...r, name: f.name + (suffix[f.mimeType] ?? '') };
  }
  async refresh(spaceId: string, id: string) {
    const before = this.workspace.files.get(spaceId, id);
    const connectionId = this.workspace.files.account(spaceId)?.id;
    this.scope(spaceId, before.dotId);
    const { data, mimeType } = await this.download(spaceId, id);
    const extracted = await extractFile(data, before.name, mimeType);
    this.scope(spaceId, before.dotId);
    if (
      before.provider === 'drive' &&
      this.workspace.files.account(spaceId)?.id !== connectionId
    )
      throw new Error('Drive connection changed. Retry after reconnecting.');
    this.workspace.files.updateText(
      spaceId,
      id,
      extracted.content,
      extracted.textStatus,
      data.length,
    );
    return this.view(this.workspace.files.get(spaceId, id));
  }
  async saveMemory(
    spaceId: string,
    dotId: string,
    name: string,
    content: string,
    check: () => void,
  ) {
    check();
    this.scope(spaceId, dotId);
    const id = randomUUID();
    const data = Buffer.from(content);
    const a = this.workspace.files.account(spaceId);
    const drive = a
      ? await this.drive.upload(spaceId, dotId, id, name, 'text/markdown', data)
      : null;
    check();
    this.scope(spaceId, dotId);
    return this.workspace.files.add(
      {
        id,
        spaceId,
        dotId,
        threadId: null,
        name,
        mimeType: 'text/markdown',
        size: data.length,
        provider: drive ? 'drive' : 'local',
        driveId: drive?.file.id ?? null,
        textStatus: 'Searchable memory',
        createdAt: Date.now(),
      },
      content,
      drive ? null : data,
      drive?.accountId ?? null,
    );
  }
  view(f: StoredFile): StoredFile {
    const {
      id,
      spaceId,
      dotId,
      threadId,
      name,
      mimeType,
      size,
      provider,
      driveId,
      textStatus,
      createdAt,
    } = f;
    return {
      id,
      spaceId,
      dotId,
      threadId,
      name,
      mimeType,
      size,
      provider,
      driveId,
      textStatus,
      createdAt,
    };
  }
}
