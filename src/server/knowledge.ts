import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
export const knowledgeDocument = z
  .object({
    path: z.string().min(1).max(1000),
    kind: z.enum(['file', 'skill', 'history', 'memory', 'manifest']),
    content: z.string().max(100000),
  })
  .strict();
export const importManifest = z
  .object({
    name: z.string().min(1).max(160),
    documents: z.number().int().min(1).max(50000),
    documentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    archiveName: z.string().min(1).max(160),
    archiveSize: z.number().int().min(1).max(4_000_000_000),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type KnowledgeDocument = z.infer<typeof knowledgeDocument>;
export class KnowledgeStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS knowledge_imports(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, manifest TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS knowledge_documents(id INTEGER PRIMARY KEY, importId TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, digest TEXT NOT NULL, UNIQUE(importId,path));
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(path,content,content='knowledge_documents',content_rowid='id', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS knowledge_insert AFTER INSERT ON knowledge_documents BEGIN INSERT INTO knowledge_fts(rowid,path,content) VALUES(new.id,new.path,new.content); END;
      CREATE TABLE IF NOT EXISTS knowledge_chunks(importId TEXT NOT NULL, offset INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(importId,offset));`);
  }
  imports(spaceId: string) {
    return this.db
      .prepare(
        'SELECT id,manifest,complete FROM knowledge_imports WHERE spaceId=?',
      )
      .all(spaceId)
      .map((r) => ({
        id: String(r.id),
        manifest: importManifest.parse(JSON.parse(String(r.manifest))),
        complete: !!r.complete,
      }));
  }
  require(spaceId: string, id: string) {
    const row = this.imports(spaceId).find((r) => r.id === id);
    if (!row) throw new Error('Import not found in this Space.');
    return row;
  }
  start(spaceId: string, input: z.infer<typeof importManifest>) {
    const manifest = importManifest.parse(input);
    const previous = this.imports(spaceId).find(
      (r) => JSON.stringify(r.manifest) === JSON.stringify(manifest),
    );
    if (previous) return this.status(spaceId, previous.id);
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO knowledge_imports VALUES(?,?,?,0)')
      .run(id, spaceId, JSON.stringify(manifest));
    return this.status(spaceId, id);
  }
  status(spaceId: string, id: string) {
    const row = this.require(spaceId, id);
    const documents = Number(
      this.db
        .prepare(
          'SELECT count(*) AS n FROM knowledge_documents WHERE importId=?',
        )
        .get(id)!.n,
    );
    let bytes = 0;
    for (const chunk of this.db
      .prepare(
        'SELECT offset,length(data) AS size FROM knowledge_chunks WHERE importId=? ORDER BY offset',
      )
      .iterate(id)) {
      if (Number(chunk.offset) !== bytes) break;
      bytes += Number(chunk.size);
    }
    return { ...row, documents, bytes };
  }
  addDocuments(spaceId: string, id: string, inputs: KnowledgeDocument[]) {
    const row = this.require(spaceId, id);
    if (row.complete) throw new Error('Completed imports are immutable.');
    const documents = z.array(knowledgeDocument).min(1).max(50).parse(inputs);
    this.db.exec('BEGIN');
    try {
      for (const doc of documents) {
        const digest = createHash('sha256')
          .update(JSON.stringify(doc))
          .digest('hex');
        const existing = this.db
          .prepare(
            'SELECT digest FROM knowledge_documents WHERE importId=? AND path=?',
          )
          .get(id, doc.path);
        if (existing && existing.digest !== digest)
          throw new Error('Conflicting document. Start a new import.');
        if (!existing)
          this.db
            .prepare(
              'INSERT INTO knowledge_documents(importId,path,kind,content,digest) VALUES(?,?,?,?,?)',
            )
            .run(id, doc.path, doc.kind, doc.content, digest);
      }
      if (this.status(spaceId, id).documents > row.manifest.documents)
        throw new Error('Too many documents.');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  addChunk(spaceId: string, id: string, offset: number, base64: string) {
    const state = this.require(spaceId, id);
    if (state.complete) throw new Error('Completed imports are immutable.');
    const data = Buffer.from(base64, 'base64');
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset % 524288 !== 0 ||
      !data.length ||
      data.length !== Math.min(524288, state.manifest.archiveSize - offset) ||
      data.toString('base64') !== base64 ||
      offset + data.length > state.manifest.archiveSize
    )
      throw new Error('Invalid archive chunk.');
    const existing = this.db
      .prepare(
        'SELECT data FROM knowledge_chunks WHERE importId=? AND offset=?',
      )
      .get(id, offset);
    if (existing) {
      if (!Buffer.from(existing.data as Uint8Array).equals(data))
        throw new Error('Conflicting archive chunk.');
      return;
    }
    this.db
      .prepare('INSERT INTO knowledge_chunks VALUES(?,?,?)')
      .run(id, offset, data);
  }
  complete(spaceId: string, id: string) {
    const state = this.status(spaceId, id);
    if (state.complete) return state;
    if (
      state.documents !== state.manifest.documents ||
      state.bytes !== state.manifest.archiveSize
    )
      throw new Error('Import is incomplete.');
    const digest = createHash('sha256');
    for (const r of this.db
      .prepare(
        'SELECT digest FROM knowledge_documents WHERE importId=? ORDER BY path COLLATE BINARY',
      )
      .iterate(id))
      digest.update(String(r.digest) + '\n');
    if (digest.digest('hex') !== state.manifest.documentDigest)
      throw new Error('Document integrity check failed.');
    const archive = createHash('sha256');
    for (const r of this.db
      .prepare(
        'SELECT data FROM knowledge_chunks WHERE importId=? ORDER BY offset',
      )
      .iterate(id))
      archive.update(r.data as Uint8Array);
    if (archive.digest('hex') !== state.manifest.archiveSha256)
      throw new Error('Archive integrity check failed.');
    this.db
      .prepare('UPDATE knowledge_imports SET complete=1 WHERE id=?')
      .run(id);
    return this.status(spaceId, id);
  }
  search(spaceId: string, query: string, kind?: string, offset = 0) {
    const terms = query
      .match(/[\p{L}\p{N}_-]+/gu)
      ?.slice(0, 12)
      .map((s) => '"' + s + '"')
      .join(' OR ');
    const fields = 'd.id,d.path,d.kind,i.id AS importId';
    if (terms)
      return this.db
        .prepare(
          `SELECT ${fields},snippet(knowledge_fts,1,'','', ' … ',32) AS excerpt FROM knowledge_fts JOIN knowledge_documents d ON d.id=knowledge_fts.rowid JOIN knowledge_imports i ON d.importId=i.id WHERE knowledge_fts MATCH ? AND i.spaceId=? AND i.complete=1 AND (? IS NULL OR d.kind=?) ORDER BY rank LIMIT 20 OFFSET ?`,
        )
        .all(terms, spaceId, kind ?? null, kind ?? null, offset);
    return this.db
      .prepare(
        `SELECT ${fields},substr(d.content,1,160) AS excerpt FROM knowledge_documents d JOIN knowledge_imports i ON d.importId=i.id WHERE i.spaceId=? AND i.complete=1 AND (? IS NULL OR d.kind=?) ORDER BY d.path LIMIT 20 OFFSET ?`,
      )
      .all(spaceId, kind ?? null, kind ?? null, offset);
  }
  read(spaceId: string, id: number, offset = 0) {
    const r = this.db
      .prepare(
        'SELECT d.path,d.kind,substr(d.content,?,16000) AS content,length(d.content) AS totalCharacters FROM knowledge_documents d JOIN knowledge_imports i ON d.importId=i.id WHERE i.spaceId=? AND i.complete=1 AND d.id=?',
      )
      .get(offset + 1, spaceId, id);
    if (!r) throw new Error('Document not found in this Space.');
    return {
      path: String(r.path),
      kind: String(r.kind),
      content: String(r.content),
      totalCharacters: Number(r.totalCharacters),
      offset,
      nextOffset:
        offset + 16000 < Number(r.totalCharacters) ? offset + 16000 : null,
    };
  }
  archiveChunk(spaceId: string, id: string, offset: number) {
    if (!this.require(spaceId, id).complete)
      throw new Error('Archive is not verified yet.');
    const r = this.db
      .prepare(
        'SELECT data FROM knowledge_chunks WHERE importId=? AND offset=?',
      )
      .get(id, offset);
    if (!r) throw new Error('Chunk not found.');
    return { data: Buffer.from(r.data as Uint8Array).toString('base64') };
  }
}
