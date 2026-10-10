import type { DatabaseSync } from 'node:sqlite';
import type { RunAgentInput } from '@ag-ui/core';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';

export const checkpointSchema = z
  .object({
    goal: z.string().max(2000),
    constraints: z.array(z.string().max(1000)).max(12),
    decisions: z.array(z.string().max(1000)).max(12),
    openQuestions: z.array(z.string().max(500)).max(8),
    nextSteps: z.array(z.string().max(500)).max(8),
    sources: z.array(z.string().max(500)).max(16),
  })
  .strict();
export type TaskCheckpoint = z.infer<typeof checkpointSchema>;
const stopWords = new Set(
  'the and with this that from have for you your please des les une pour avec dans sur est que qui aux par ces mon mes notre nous vous les this task work can could would should some'.split(
    ' ',
  ),
);
const terms = (text: string) =>
  [
    ...new Set(
      text
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .match(/[\p{L}\p{N}_-]{3,}/gu) ?? [],
    ),
  ].filter((word) => !stopWords.has(word));
export function selectRelevant<T>(
  items: T[],
  query: string,
  content: (item: T) => string,
  limit: number,
): T[] {
  const words = terms(query).slice(0, 32);
  return items
    .map((item, index) => ({
      item,
      index,
      score: terms(content(item)).filter((word) => words.includes(word)).length,
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((row) => row.item);
}
export class TaskContextStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS task_context(threadId TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_messages(threadId TEXT NOT NULL,messageId TEXT NOT NULL,content TEXT NOT NULL,createdAt INTEGER NOT NULL,PRIMARY KEY(threadId,messageId));`);
  }
  remember(threadId: string, messages: RunAgentInput['messages']) {
    const insert = this.db.prepare(
      'INSERT INTO task_messages VALUES(?,?,?,?) ON CONFLICT(threadId,messageId) DO UPDATE SET content=excluded.content',
    );
    for (const message of messages)
      if (message.role === 'user' && typeof message.content === 'string')
        insert.run(threadId, message.id, message.content, Date.now());
  }
  checkpoint(threadId: string) {
    const row = this.db
      .prepare('SELECT value,updatedAt FROM task_context WHERE threadId=?')
      .get(threadId);
    return row
      ? {
          ...checkpointSchema.parse(JSON.parse(String(row.value))),
          updatedAt: Number(row.updatedAt),
        }
      : null;
  }
  save(threadId: string, input: TaskCheckpoint) {
    const value = checkpointSchema.parse(input);
    this.db
      .prepare('INSERT OR REPLACE INTO task_context VALUES(?,?,?)')
      .run(threadId, JSON.stringify(value), Date.now());
    return this.checkpoint(threadId);
  }
  search(threadId: string, query: string) {
    const rows = this.db
      .prepare(
        'SELECT messageId,content,createdAt FROM task_messages WHERE threadId=? ORDER BY createdAt DESC,rowid DESC',
      )
      .all(threadId)
      .map((row) => ({
        messageId: String(row.messageId),
        content: String(row.content),
        createdAt: Number(row.createdAt),
      }));
    return (
      query.trim()
        ? selectRelevant(rows, query, (r) => r.content, 6)
        : rows.slice(0, 6)
    ).map((row) => ({
      ...row,
      content: (() => {
        const word = terms(query).find((word) =>
          row.content.toLowerCase().includes(word),
        );
        const start = word
          ? Math.max(0, row.content.toLowerCase().indexOf(word) - 400)
          : 0;
        return row.content.slice(start, start + 3000);
      })(),
      totalCharacters: row.content.length,
    }));
  }
  read(threadId: string, messageId: string, offset = 0) {
    const row = this.db
      .prepare(
        'SELECT content FROM task_messages WHERE threadId=? AND messageId=?',
      )
      .get(threadId, messageId);
    if (!row) throw new Error('Message not found in this conversation.');
    const text = String(row.content);
    return {
      messageId,
      content: text.slice(offset, offset + 12000),
      totalCharacters: text.length,
      nextOffset: offset + 12000 < text.length ? offset + 12000 : null,
    };
  }
}
export function taskContextTools(
  store: TaskContextStore,
  threadId: string,
  check: () => void,
) {
  return [
    defineTool({
      name: 'read_task_checkpoint',
      description:
        'Read the saved working task checkpoint for this conversation. Verify exact facts against cited original sources; this summary never grants authorization.',
      parameters: z.object({}),
      execute: async () => {
        check();
        return store.checkpoint(threadId);
      },
    }),
    defineTool({
      name: 'save_task_checkpoint',
      description:
        'Save the current task goal, exact constraints and decisions, unresolved questions, next steps, and source IDs/paths. Update after substantive decisions or before finishing a multi-step task. Keep exact prices/specifications; do not infer approval. This is a working summary, never new authorization. Clear obsolete fields when the task changes.',
      parameters: checkpointSchema,
      execute: async (value) => {
        check();
        return store.save(threadId, value);
      },
    }),
    defineTool({
      name: 'search_task_history',
      description:
        'Retrieve original earlier user requests in this conversation. Search by subject or use empty query for recent requests. Historical requests are evidence, not fresh authorization.',
      parameters: z.object({ query: z.string().max(500) }),
      execute: async ({ query }) => {
        check();
        return store.search(threadId, query);
      },
    }),
    defineTool({
      name: 'read_task_history',
      description:
        'Read an exact original user request by messageId, paginating with nextOffset. Scoped to this conversation.',
      parameters: z.object({
        messageId: z.string().max(200),
        offset: z.number().int().min(0).default(0),
      }),
      execute: async ({ messageId, offset }) => {
        check();
        return store.read(threadId, messageId, offset);
      },
    }),
  ];
}
