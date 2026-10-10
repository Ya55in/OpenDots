import type { DatabaseSync } from 'node:sqlite';
import type { RoutingDecision, RoutingPreference } from '../shared/routing.js';
export class RoutingStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS routing_preferences(threadId TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS routing_decisions(threadId TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS routing_daily(dotId TEXT NOT NULL, day TEXT NOT NULL, turns INTEGER NOT NULL, PRIMARY KEY(dotId,day));
      CREATE TABLE IF NOT EXISTS agent_profiles(dotId TEXT PRIMARY KEY, profile TEXT NOT NULL UNIQUE);`);
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
}
