import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
export const memberContext = new AsyncLocalStorage<string>();
export const memberInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    email: z.email().optional().or(z.literal('')),
    dotIds: z.array(z.string().min(1)).max(100),
    spaceIds: z.array(z.string().min(1)).max(100),
    active: z.boolean().default(true),
  })
  .strict();
export type Member = z.infer<typeof memberInput> & {
  id: string;
  createdAt: number;
};
const digest = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export class MemberStore {
  constructor(private db: DatabaseSync) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,tokenHash TEXT UNIQUE NOT NULL,dotIds TEXT NOT NULL,spaceIds TEXT NOT NULL,active INTEGER NOT NULL,createdAt INTEGER NOT NULL);',
    );
  }
  list(): Member[] {
    return this.db
      .prepare(
        'SELECT id,name,email,dotIds,spaceIds,active,createdAt FROM members ORDER BY createdAt',
      )
      .all()
      .map((r) => ({
        id: String(r.id),
        name: String(r.name),
        email: String(r.email),
        dotIds: JSON.parse(String(r.dotIds)),
        spaceIds: JSON.parse(String(r.spaceIds)),
        active: !!r.active,
        createdAt: Number(r.createdAt),
      }));
  }
  get(id: string) {
    return this.list().find((member) => member.id === id);
  }
  authenticate(token: string) {
    if (!token) return undefined;
    const row = this.db
      .prepare('SELECT id FROM members WHERE tokenHash=? AND active=1')
      .get(digest(token));
    return row ? this.get(String(row.id)) : undefined;
  }
  create(input: z.input<typeof memberInput>) {
    const value = memberInput.parse(input),
      id = randomUUID(),
      token = 'odm_' + randomBytes(32).toString('base64url');
    this.db
      .prepare('INSERT INTO members VALUES(?,?,?,?,?,?,?,?)')
      .run(
        id,
        value.name,
        value.email ?? '',
        digest(token),
        JSON.stringify([...new Set(value.dotIds)]),
        JSON.stringify([...new Set(value.spaceIds)]),
        +value.active,
        Date.now(),
      );
    return { member: this.get(id)!, token };
  }
  update(id: string, input: z.input<typeof memberInput>) {
    if (!this.get(id)) throw new Error('Member not found.');
    const value = memberInput.parse(input);
    this.db
      .prepare(
        'UPDATE members SET name=?,email=?,dotIds=?,spaceIds=?,active=? WHERE id=?',
      )
      .run(
        value.name,
        value.email ?? '',
        JSON.stringify([...new Set(value.dotIds)]),
        JSON.stringify([...new Set(value.spaceIds)]),
        +value.active,
        id,
      );
    return this.get(id)!;
  }
  rotate(id: string) {
    if (!this.get(id)) throw new Error('Member not found.');
    const token = 'odm_' + randomBytes(32).toString('base64url');
    this.db
      .prepare('UPDATE members SET tokenHash=? WHERE id=?')
      .run(digest(token), id);
    return { token };
  }
}
