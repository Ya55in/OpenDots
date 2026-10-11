export const FREE_ROUTER_MODEL = '@preset/opendots-free';
export const FREE_ROUTER_LABEL = 'OpenDots Free — Best First';
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
  models: { id: string; tier: RoutingTier; label?: string }[];
  dailyTurnLimit: number;
  dailyUsd?: number;
  turnUsd?: number;
  dotDailyUsd?: number;
  preference?: RoutingPreference;
  lastDecision?: RoutingDecision | null;
}
