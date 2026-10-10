import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  FILE_CHUNK_BYTES,
  MAX_FILE_BYTES,
  type StoredFile,
} from '../shared/storage.js';
export interface DriveAccount {
  id: string;
  spaceId: string;
  email: string;
  googleId?: string | null;
  secret: string;
  rootId: string | null;
  folderId: string | null;
}
export class FileStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS storage_config(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drive_accounts(spaceId TEXT PRIMARY KEY, id TEXT NOT NULL, email TEXT NOT NULL, secret TEXT NOT NULL, rootId TEXT, folderId TEXT, googleId TEXT);
      CREATE TABLE IF NOT EXISTS drive_identities(accountId TEXT PRIMARY KEY, spaceId TEXT NOT NULL, googleId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drive_folders(accountId TEXT NOT NULL, dotId TEXT NOT NULL, folderId TEXT NOT NULL, PRIMARY KEY(accountId,dotId));
      CREATE TABLE IF NOT EXISTS drive_oauth(state TEXT PRIMARY KEY, spaceId TEXT NOT NULL, verifier TEXT NOT NULL, browser TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS stored_files(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, dotId TEXT NOT NULL, threadId TEXT, name TEXT NOT NULL, mimeType TEXT NOT NULL, size INTEGER NOT NULL, provider TEXT NOT NULL, driveId TEXT, accountId TEXT, textStatus TEXT NOT NULL, content TEXT NOT NULL, original BLOB, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS stored_files_scope ON stored_files(spaceId,dotId);
      CREATE VIRTUAL TABLE IF NOT EXISTS stored_files_fts USING fts5(id UNINDEXED,name,content);
      CREATE TABLE IF NOT EXISTS file_uploads(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL,dotId TEXT NOT NULL,threadId TEXT,name TEXT NOT NULL,mimeType TEXT NOT NULL,size INTEGER NOT NULL,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS file_upload_chunks(id TEXT NOT NULL,offset INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(id,offset));`);
    if (
      !db
        .prepare('PRAGMA table_info(drive_accounts)')
        .all()
        .some((c) => c.name === 'googleId')
    )
      db.exec('ALTER TABLE drive_accounts ADD COLUMN googleId TEXT');
  }
  canReadOriginal(spaceId: string, accountId: string | null) {
    const current = this.account(spaceId);
    if (!current) return false;
    if (current.id === accountId) return true;
    const prior = this.db
      .prepare(
        'SELECT googleId FROM drive_identities WHERE accountId=? AND spaceId=?',
      )
      .get(accountId, spaceId);
    return !!current.googleId && prior?.googleId === current.googleId;
  }
  config() {
    const row = this.db
      .prepare('SELECT value FROM storage_config WHERE id=1')
      .get();
    return row ? String(row.value) : undefined;
  }
  setConfig(value: string) {
    this.db
      .prepare(
        'INSERT INTO storage_config VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      )
      .run(value);
  }
  account(spaceId: string) {
    return this.db
      .prepare('SELECT * FROM drive_accounts WHERE spaceId=?')
      .get(spaceId) as unknown as DriveAccount | undefined;
  }
  setAccount(a: DriveAccount) {
    this.db
      .prepare(
        'INSERT INTO drive_accounts VALUES(?,?,?,?,?,?,?) ON CONFLICT(spaceId) DO UPDATE SET id=excluded.id,email=excluded.email,secret=excluded.secret,rootId=excluded.rootId,folderId=excluded.folderId,googleId=excluded.googleId',
      )
      .run(
        a.spaceId,
        a.id,
        a.email,
        a.secret,
        a.rootId,
        a.folderId,
        a.googleId ?? null,
      );
    if (a.googleId)
      this.db
        .prepare('INSERT OR IGNORE INTO drive_identities VALUES(?,?,?)')
        .run(a.id, a.spaceId, a.googleId);
  }
  disconnect(spaceId: string) {
    this.db.prepare('DELETE FROM drive_accounts WHERE spaceId=?').run(spaceId);
    this.db.prepare('DELETE FROM drive_oauth WHERE spaceId=?').run(spaceId);
  }
  folder(accountId: string, dotId: string) {
    const r = this.db
      .prepare(
        'SELECT folderId FROM drive_folders WHERE accountId=? AND dotId=?',
      )
      .get(accountId, dotId);
    return r && String(r.folderId);
  }
  setFolder(accountId: string, dotId: string, folderId: string) {
    this.db
      .prepare('INSERT OR REPLACE INTO drive_folders VALUES(?,?,?)')
      .run(accountId, dotId, folderId);
  }
  startOAuth(
    spaceId: string,
    state: string,
    verifier: string,
    browser: string,
  ) {
    this.db
      .prepare('DELETE FROM drive_oauth WHERE expires<? OR spaceId=?')
      .run(Date.now(), spaceId);
    this.db
      .prepare('INSERT INTO drive_oauth VALUES(?,?,?,?,?)')
      .run(state, spaceId, verifier, browser, Date.now() + 600000);
  }
  consumeOAuth(state: string, browser: string) {
    const r = this.db
      .prepare(
        'DELETE FROM drive_oauth WHERE state=? AND browser=? AND expires>? RETURNING *',
      )
      .get(state, browser, Date.now());
    if (!r)
      throw new Error(
        'Google connection expired or belongs to another browser. Start again from Space storage.',
      );
    return { spaceId: String(r.spaceId), verifier: String(r.verifier) };
  }
  startUpload(
    input: Omit<
      StoredFile,
      'id' | 'createdAt' | 'provider' | 'driveId' | 'textStatus'
    >,
  ) {
    const expired = this.db
      .prepare('SELECT id FROM file_uploads WHERE createdAt<?')
      .all(Date.now() - 86400000);
    for (const r of expired) this.removeUpload(String(r.id));
    if (
      Number(
        this.db.prepare('SELECT COUNT(*) AS n FROM file_uploads').get()!.n,
      ) >= 20
    )
      throw new Error(
        'Too many unfinished uploads. Finish existing uploads first.',
      );
    if (input.size < 0 || input.size > MAX_FILE_BYTES)
      throw new Error('Maximum file size is 25 MB.');
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO file_uploads VALUES(?,?,?,?,?,?,?,?)')
      .run(
        id,
        input.spaceId,
        input.dotId,
        input.threadId,
        input.name,
        input.mimeType,
        input.size,
        Date.now(),
      );
    return { id };
  }
  upload(spaceId: string, id: string) {
    const row = this.db
      .prepare('SELECT * FROM file_uploads WHERE spaceId=? AND id=?')
      .get(spaceId, id);
    if (!row) throw new Error('Upload not found.');
    return row as unknown as {
      id: string;
      spaceId: string;
      dotId: string;
      threadId: string | null;
      name: string;
      mimeType: string;
      size: number;
    };
  }
  chunk(spaceId: string, id: string, offset: number, encoded: string) {
    const u = this.upload(spaceId, id);
    const data = Buffer.from(encoded, 'base64');
    if (
      encoded !== data.toString('base64') ||
      offset % FILE_CHUNK_BYTES ||
      offset < 0 ||
      data.length !== Math.min(FILE_CHUNK_BYTES, u.size - offset) ||
      !data.length
    )
      throw new Error('Invalid file chunk.');
    const prior = this.db
      .prepare('SELECT data FROM file_upload_chunks WHERE id=? AND offset=?')
      .get(id, offset);
    if (prior && !Buffer.from(prior.data as Uint8Array).equals(data))
      throw new Error('Conflicting upload chunk.');
    this.db
      .prepare('INSERT OR IGNORE INTO file_upload_chunks VALUES(?,?,?)')
      .run(id, offset, data);
  }
  uploadBytes(spaceId: string, id: string) {
    const u = this.upload(spaceId, id);
    const chunks = this.db
      .prepare(
        'SELECT offset,data FROM file_upload_chunks WHERE id=? ORDER BY offset',
      )
      .all(id);
    let bytes = 0;
    const buffers: Buffer[] = [];
    for (const c of chunks) {
      if (Number(c.offset) !== bytes) throw new Error('Upload is incomplete.');
      const b = Buffer.from(c.data as Uint8Array);
      bytes += b.length;
      buffers.push(b);
    }
    if (bytes !== u.size) throw new Error('Upload is incomplete.');
    return Buffer.concat(buffers);
  }
  removeUpload(id: string) {
    this.db.prepare('DELETE FROM file_upload_chunks WHERE id=?').run(id);
    this.db.prepare('DELETE FROM file_uploads WHERE id=?').run(id);
  }
  add(
    file: StoredFile,
    content: string,
    original: Buffer | null,
    accountId: string | null,
  ) {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('INSERT INTO stored_files VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(
          file.id,
          file.spaceId,
          file.dotId,
          file.threadId,
          file.name,
          file.mimeType,
          file.size,
          file.provider,
          file.driveId,
          accountId,
          file.textStatus,
          content,
          original,
          file.createdAt,
        );
      this.db
        .prepare('INSERT INTO stored_files_fts VALUES(?,?,?)')
        .run(file.id, file.name, content);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return file;
  }
  get(spaceId: string, id: string) {
    const row = this.db
      .prepare('SELECT * FROM stored_files WHERE spaceId=? AND id=?')
      .get(spaceId, id);
    if (!row) throw new Error('File not found in this Space.');
    return row as unknown as StoredFile & {
      content: string;
      original: Uint8Array | null;
      accountId: string | null;
    };
  }
  updateText(
    spaceId: string,
    id: string,
    content: string,
    textStatus: string,
    size: number,
  ) {
    const f = this.get(spaceId, id);
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'UPDATE stored_files SET content=?,textStatus=?,size=? WHERE spaceId=? AND id=?',
        )
        .run(content, textStatus, size, spaceId, id);
      this.db.prepare('DELETE FROM stored_files_fts WHERE id=?').run(id);
      this.db
        .prepare('INSERT INTO stored_files_fts VALUES(?,?,?)')
        .run(id, f.name, content);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  list(spaceId: string, dotId?: string, query = '', offset = 0): StoredFile[] {
    const terms = query
      .match(/[\p{L}\p{N}_]+/gu)
      ?.slice(0, 12)
      .map((t) => '"' + t + '"*')
      .join(' AND ');
    const sql = `SELECT f.id,f.spaceId,f.dotId,f.threadId,f.name,f.mimeType,f.size,f.provider,f.driveId,f.textStatus,f.createdAt FROM stored_files f ${terms ? 'JOIN stored_files_fts ON stored_files_fts.id=f.id' : ''} WHERE f.spaceId=? ${dotId ? 'AND f.dotId=?' : ''} ${terms ? 'AND stored_files_fts MATCH ?' : ''} ORDER BY f.createdAt DESC LIMIT 30 OFFSET ?`;
    return this.db
      .prepare(sql)
      .all(
        spaceId,
        ...(dotId ? [dotId] : []),
        ...(terms ? [terms] : []),
        offset,
      ) as unknown as StoredFile[];
  }
}
