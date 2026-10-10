import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { WorkspaceStore } from '../src/server/workspace.js';
import { knowledgeAccess } from '../src/server/knowledge-tools.js';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const doc = {
  path: 'skills/guide.md',
  kind: 'skill' as const,
  content: 'Verified hospitality proposal instructions.',
};
const manifest = {
  name: 'Migration',
  documents: 1,
  documentDigest: sha(sha(JSON.stringify(doc)) + '\n'),
  archiveName: 'original.zip',
  archiveSize: 3,
  archiveSha256: sha('zip'),
};
function setup() {
  const w = new WorkspaceStore(':memory:', 'owner');
  const s = w.spaces()[0].id;
  const k = w.knowledge;
  const i = k.start(s, manifest);
  return { w, s, k, i };
}
describe('Private knowledge migrations', () => {
  it('keeps incomplete data unavailable, verifies integrity and resumes idempotently', () => {
    const { w, s, k, i } = setup();
    try {
      k.addDocuments(s, i.id, [doc]);
      k.addDocuments(s, i.id, [doc]);
      expect(k.search(s, 'hospitality')).toEqual([]);
      expect(k.start(s, manifest).id).toBe(i.id);
      expect(() => k.complete(s, i.id)).toThrow('incomplete');
      k.addChunk(s, i.id, 0, Buffer.from('zip').toString('base64'));
      k.addChunk(s, i.id, 0, Buffer.from('zip').toString('base64'));
      expect(k.complete(s, i.id).complete).toBe(true);
      expect(k.complete(s, i.id).complete).toBe(true);
      const result = k.search(s, 'hospitality');
      expect(result).toHaveLength(1);
      expect(k.read(s, Number(result[0].id)).content).toBe(doc.content);
      expect(() => k.addDocuments(s, i.id, [doc])).toThrow('immutable');
    } finally {
      w.close();
    }
  });
  it('enforces Space boundaries and checks current tool access', () => {
    const { w, s, k, i } = setup();
    try {
      k.addDocuments(s, i.id, [doc]);
      k.addChunk(s, i.id, 0, Buffer.from('zip').toString('base64'));
      k.complete(s, i.id);
      const other = w.createSpace('Other', '').id;
      expect(k.search(other, 'hospitality')).toEqual([]);
      const id = Number(k.search(s, 'hospitality')[0].id);
      expect(() => k.read(other, id)).toThrow();
      expect(() => k.archiveChunk(other, i.id, 0)).toThrow();
      const dot = w.createDot(other, 'Other', 'hello', false, false);
      expect(() => knowledgeAccess(w, dot.id, s, () => {}).search('')).toThrow(
        'revoked',
      );
      expect(() =>
        knowledgeAccess(w, w.dots()[0].id, s, () => {
          throw new Error('cancelled');
        }).read(id),
      ).toThrow('cancelled');
    } finally {
      w.close();
    }
  });
  it('rejects corrupted, conflicting, oversized and out-of-order data', () => {
    const { w, s, k, i } = setup();
    try {
      k.addDocuments(s, i.id, [doc]);
      expect(() =>
        k.addDocuments(s, i.id, [{ ...doc, content: 'changed' }]),
      ).toThrow('Conflicting');
      expect(() =>
        k.addChunk(s, i.id, 1, Buffer.from('z').toString('base64')),
      ).toThrow('Invalid');
      expect(() => k.addChunk(s, i.id, 0, 'not-base64')).toThrow('Invalid');
      expect(() =>
        k.addChunk(s, i.id, 0, Buffer.from('long').toString('base64')),
      ).toThrow('Invalid');
      k.addChunk(s, i.id, 0, Buffer.from('bad').toString('base64'));
      expect(() => k.complete(s, i.id)).toThrow('integrity');
      expect(k.search(s, '')).toEqual([]);
    } finally {
      w.close();
    }
  });
  it('checks the document digest independently of archive integrity', () => {
    const { w, s, k, i } = setup();
    try {
      k.addDocuments(s, i.id, [{ ...doc, content: 'corrupt' }]);
      k.addChunk(s, i.id, 0, Buffer.from('zip').toString('base64'));
      expect(() => k.complete(s, i.id)).toThrow('Document integrity');
    } finally {
      w.close();
    }
  });
  it('treats paths and FTS syntax as data and paginates content', () => {
    const { w, s, k } = setup();
    try {
      const long = {
        ...doc,
        path: '../../untrusted.md',
        content: 'a'.repeat(17000),
      };
      const m = {
        ...manifest,
        documentDigest: sha(sha(JSON.stringify(long)) + '\n'),
      };
      const i = k.start(s, m);
      k.addDocuments(s, i.id, [long]);
      k.addChunk(s, i.id, 0, Buffer.from('zip').toString('base64'));
      k.complete(s, i.id);
      const r = k.search(s, '')[0];
      expect(k.read(s, Number(r.id)).nextOffset).toBe(16000);
      expect(k.read(s, Number(r.id), 16000).content).toHaveLength(1000);
      expect(() => k.search(s, '" OR * NEAR()')).not.toThrow();
    } finally {
      w.close();
    }
  });
});

it('resumes at the first missing chunk and verifies an out-of-order upload', () => {
  const { w, s, k } = setup();
  try {
    const data = Buffer.alloc(524288 * 2 + 7, 42);
    const m = {
      ...manifest,
      archiveSize: data.length,
      archiveSha256: createHash('sha256').update(data).digest('hex'),
    };
    const i = k.start(s, m);
    k.addDocuments(s, i.id, [doc]);
    k.addChunk(
      s,
      i.id,
      524288,
      data.subarray(524288, 524288 * 2).toString('base64'),
    );
    expect(k.status(s, i.id).bytes).toBe(0);
    expect(() => k.complete(s, i.id)).toThrow('incomplete');
    k.addChunk(s, i.id, 0, data.subarray(0, 524288).toString('base64'));
    expect(k.status(s, i.id).bytes).toBe(524288 * 2);
    k.addChunk(
      s,
      i.id,
      524288 * 2,
      data.subarray(524288 * 2).toString('base64'),
    );
    expect(k.complete(s, i.id).complete).toBe(true);
  } finally {
    w.close();
  }
});
