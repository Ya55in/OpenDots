import type { DatabaseSync } from 'node:sqlite';
import type { RoutingDecision, RoutingPreference } from '../shared/routing.js';
import { randomUUID } from 'node:crypto';
import type { RouterConfig } from './model-router.js';
export class RoutingStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS routing_preferences(threadId TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS routing_decisions(threadId TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS routing_daily(dotId TEXT NOT NULL, day TEXT NOT NULL, turns INTEGER NOT NULL, PRIMARY KEY(dotId,day));
      CREATE TABLE IF NOT EXISTS agent_profiles(dotId TEXT PRIMARY KEY, profile TEXT NOT NULL UNIQUE);`);
    db.exec(
      `CREATE TABLE IF NOT EXISTS model_usage(id TEXT PRIMARY KEY,inputTokens INTEGER,outputTokens INTEGER,cachedTokens INTEGER,cacheWriteTokens INTEGER,finishedAt INTEGER,outcome TEXT);`,
    );
    db.exec(`CREATE TABLE IF NOT EXISTS model_spend(id TEXT PRIMARY KEY,runId TEXT NOT NULL,dotId TEXT NOT NULL,threadId TEXT NOT NULL,day TEXT NOT NULL,model TEXT NOT NULL,reserved INTEGER NOT NULL,charged INTEGER,status TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS model_spend_day ON model_spend(day);`);
  }
  usageSnapshot(dotId?: string) {
    const day = new Date().toISOString().slice(0, 10);
    const rows = this.db
      .prepare(
        `SELECT s.*,u.inputTokens,u.outputTokens,u.cachedTokens,u.cacheWriteTokens,u.finishedAt,u.outcome FROM model_spend s LEFT JOIN model_usage u ON u.id=s.id WHERE s.day=? AND (? IS NULL OR s.dotId=?) ORDER BY s.createdAt DESC LIMIT 200`,
      )
      .all(day, dotId ?? null, dotId ?? null);
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) calls,COALESCE(SUM(s.charged),0) charged,COALESCE(SUM(CASE WHEN s.charged IS NULL THEN s.reserved ELSE 0 END),0) reserved,SUM(u.inputTokens) inputTokens,SUM(u.outputTokens) outputTokens,SUM(u.cachedTokens) cachedTokens,SUM(u.cacheWriteTokens) cacheWriteTokens FROM model_spend s LEFT JOIN model_usage u ON u.id=s.id WHERE s.day=? AND (? IS NULL OR s.dotId=?)`,
      )
      .get(day, dotId ?? null, dotId ?? null)!;
    const nullable = (v: unknown) => (v == null ? null : Number(v));
    return {
      day,
      updatedAt: Date.now(),
      totals: {
        calls: Number(totals.calls),
        charged: Number(totals.charged) / 1e6,
        reserved: Number(totals.reserved) / 1e6,
        inputTokens: nullable(totals.inputTokens),
        outputTokens: nullable(totals.outputTokens),
        cachedTokens: nullable(totals.cachedTokens),
        cacheWriteTokens: nullable(totals.cacheWriteTokens),
      },
      calls: rows.map((row) => ({
        id: String(row.id),
        dotId: String(row.dotId),
        threadId: String(row.threadId),
        runId: String(row.runId),
        model: String(row.model),
        reserved: Number(row.reserved) / 1e6,
        charged: row.charged == null ? null : Number(row.charged) / 1e6,
        status: String(row.status),
        outcome: row.outcome == null ? 'pending' : String(row.outcome),
        createdAt: Number(row.createdAt),
        finishedAt: nullable(row.finishedAt),
        inputTokens: nullable(row.inputTokens),
        outputTokens: nullable(row.outputTokens),
        cachedTokens: nullable(row.cachedTokens),
        cacheWriteTokens: nullable(row.cacheWriteTokens),
      })),
    };
  }
  recordUsage(
    id: string,
    usage: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      prompt_tokens_details?: {
        cached_tokens?: unknown;
        cache_write_tokens?: unknown;
      };
      cost?: unknown;
    },
  ) {
    const n = (value: unknown) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
    this.db
      .prepare(
        `INSERT INTO model_usage(id,inputTokens,outputTokens,cachedTokens,cacheWriteTokens) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET inputTokens=COALESCE(excluded.inputTokens,model_usage.inputTokens),outputTokens=COALESCE(excluded.outputTokens,model_usage.outputTokens),cachedTokens=COALESCE(excluded.cachedTokens,model_usage.cachedTokens),cacheWriteTokens=COALESCE(excluded.cacheWriteTokens,model_usage.cacheWriteTokens)`,
      )
      .run(
        id,
        n(usage.prompt_tokens),
        n(usage.completion_tokens),
        n(usage.prompt_tokens_details?.cached_tokens),
        n(usage.prompt_tokens_details?.cache_write_tokens),
      );
    if (typeof usage.cost === 'number') this.settleSpend(id, usage.cost);
  }
  finishUsage(id: string, outcome: 'complete' | 'failed' | 'cancelled') {
    this.db
      .prepare(
        `INSERT INTO model_usage(id,finishedAt,outcome) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET finishedAt=COALESCE(model_usage.finishedAt,excluded.finishedAt),outcome=COALESCE(model_usage.outcome,excluded.outcome)`,
      )
      .run(id, Date.now(), outcome);
  }
  preference(threadId: string): RoutingPreference {
    const row = this.db
      .prepare('SELECT value FROM routing_preferences WHERE threadId=?')
      .get(threadId);
    return row ? JSON.parse(String(row.value)) : { mode: 'auto' };
  }
  setPreference(threadId: string, preference: RoutingPreference) {
    this.db
      .prepare('INSERT OR REPLACE INTO routing_preferences VALUES (?,?)')
      .run(threadId, JSON.stringify(preference));
  }
  lastDecision(threadId: string): RoutingDecision | null {
    const row = this.db
      .prepare('SELECT value FROM routing_decisions WHERE threadId=?')
      .get(threadId);
    return row ? JSON.parse(String(row.value)) : null;
  }
  record(threadId: string, decision: RoutingDecision) {
    this.db
      .prepare('INSERT OR REPLACE INTO routing_decisions VALUES (?,?)')
      .run(threadId, JSON.stringify(decision));
  }
  reserveTurn(
    dotId: string,
    limit: number,
    day = new Date().toISOString().slice(0, 10),
  ) {
    // Atomic across processes; failed attempts count to prevent retry storms.
    const row = this.db
      .prepare(
        `INSERT INTO routing_daily VALUES (?,?,1)
      ON CONFLICT(dotId,day) DO UPDATE SET turns=turns+1 WHERE turns < ? RETURNING turns`,
      )
      .get(dotId, day, limit);
    if (!row)
      throw new Error(
        'This agent reached its daily turn limit. Try again tomorrow or adjust the server limit.',
      );
  }
  profile(dotId: string): string | null {
    return (
      (this.db
        .prepare('SELECT profile FROM agent_profiles WHERE dotId=?')
        .get(dotId)?.profile as string) ?? null
    );
  }
  profileDot(profile: string): string | undefined {
    return this.db
      .prepare('SELECT dotId FROM agent_profiles WHERE profile=?')
      .get(profile)?.dotId as string | undefined;
  }
  assignProfile(dotId: string, profile: string) {
    this.db
      .prepare('INSERT INTO agent_profiles VALUES (?,?)')
      .run(dotId, profile);
  }
  spending(day = new Date().toISOString().slice(0, 10)) {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(charged),0) charged, COALESCE(SUM(CASE WHEN charged IS NULL THEN reserved ELSE 0 END),0) reserved, COUNT(*) calls FROM model_spend WHERE day=?`,
      )
      .get(day)!;
    return {
      charged: Number(row.charged) / 1e6,
      reserved: Number(row.reserved) / 1e6,
      calls: Number(row.calls),
    };
  }
  reserveSpend(
    scope: { runId: string; dotId: string; threadId: string },
    model: string,
    usd: number,
    config: RouterConfig,
  ) {
    const amount = Math.ceil(usd * 1e6),
      day = new Date().toISOString().slice(0, 10),
      id = randomUUID();
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new Error('Invalid model cost estimate.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const totals = this.db
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN day=? THEN COALESCE(charged,reserved) ELSE 0 END),0) total, COALESCE(SUM(CASE WHEN dotId=? AND day=? THEN COALESCE(charged,reserved) ELSE 0 END),0) dot, COALESCE(SUM(CASE WHEN runId=? THEN COALESCE(charged,reserved) ELSE 0 END),0) run, SUM(CASE WHEN runId=? THEN 1 ELSE 0 END) calls FROM model_spend WHERE day=? OR runId=?`,
        )
        .get(
          day,
          scope.dotId,
          day,
          scope.runId,
          scope.runId,
          day,
          scope.runId,
        )!;
      if (Number(totals.calls) >= config.maxCalls)
        throw new Error(
          'Model call limit reached for this request. Saved files remain available.',
        );
      if (Number(totals.total) + amount > Math.floor(config.dailyUsd * 1e6))
        throw new Error(
          'Workspace daily AI budget reached. No further provider request was sent.',
        );
      if (Number(totals.dot) + amount > Math.floor(config.dotDailyUsd * 1e6))
        throw new Error(
          'This Dot reached its daily AI budget. No further provider request was sent.',
        );
      if (Number(totals.run) + amount > Math.floor(config.turnUsd * 1e6))
        throw new Error(
          'This request would exceed its AI budget. Use a cheaper model or a shorter context.',
        );
      this.db
        .prepare('INSERT INTO model_spend VALUES (?,?,?,?,?,?,?,NULL,?,?)')
        .run(
          id,
          scope.runId,
          scope.dotId,
          scope.threadId,
          day,
          model,
          amount,
          'reserved',
          Date.now(),
        );
      this.db.exec('COMMIT');
      return id;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  settleSpend(id: string, usd: number) {
    if (!Number.isFinite(usd) || usd < 0) return;
    this.db
      .prepare(
        "UPDATE model_spend SET charged=?,status='reported' WHERE id=? AND charged IS NULL",
      )
      .run(Math.ceil(usd * 1e6), id);
  }
}
