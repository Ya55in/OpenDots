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
  monthly?: { month: string; charged: number; reserved: number };
  budgets: {
    monthly?: number;
    daily: number | null;
    dotDaily: number | null;
    request: number | null;
  } | null;
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
