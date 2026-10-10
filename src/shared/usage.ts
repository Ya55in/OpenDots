export interface UsageSnapshot {
  day: string;
  updatedAt: number;
  totals: {
    calls: number;
    charged: number;
    reserved: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedTokens: number | null;
    cacheWriteTokens: number | null;
  };
  budgets: { daily: number; dotDaily: number; request: number } | null;
  calls: {
    id: string;
    dotId: string;
    dotName?: string;
    threadId: string;
    runId: string;
    model: string;
    reserved: number;
    charged: number | null;
    status: string;
    outcome: string;
    createdAt: number;
    finishedAt: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedTokens: number | null;
    cacheWriteTokens: number | null;
  }[];
}
