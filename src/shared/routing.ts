export type RoutingMode = 'auto' | 'economy' | 'quality' | 'manual';
export type RoutingTier =
  'routine' | 'standard' | 'reasoning' | 'complex' | 'expert';
export interface RoutingPreference {
  mode: RoutingMode;
  model?: string;
}
export interface RoutingDecision {
  model: string;
  tier: RoutingTier;
  reason: string;
  source: 'manual' | 'policy' | 'jev' | 'default';
  selectedAt: number;
}
export interface RoutingStatus {
  enabled: boolean;
  jevConfigured: boolean;
  models: { id: string; tier: RoutingTier }[];
  dailyTurnLimit: number;
  dailyUsd?: number;
  turnUsd?: number;
  dotDailyUsd?: number;
  spending?: { charged: number; reserved: number; calls: number };
  preference?: RoutingPreference;
  lastDecision?: RoutingDecision | null;
}
