import { FREE_ROUTER_MODEL } from '../shared/routing';
import { UsagePanel } from './UsagePanel';
import { JevDecisions } from './JevDecisions';
import { useEffect, useState } from 'react';
import { api } from './api';
import type {
  RoutingMode,
  RoutingPreference,
  RoutingStatus,
} from '../shared/routing';
export function ModelRouting({
  threadId,
  running = false,
}: {
  threadId?: string;
  running?: boolean;
}) {
  const [status, setStatus] = useState<RoutingStatus>();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const path = threadId ? `/conversations/${threadId}/routing` : '/routing';
  useEffect(() => {
    let active = true;
    void api<RoutingStatus>(path)
      .then((value) => {
        if (active) {
          setStatus(value);
          setError('');
        }
      })
      .catch(() => {
        if (active) setError('Model settings could not load.');
      });
    return () => {
      active = false;
    };
  }, [path, running]);
  const save = async (preference: RoutingPreference) => {
    setSaving(true);
    setError('');
    try {
      setStatus(await api<RoutingStatus>(path, 'PUT', preference));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save model choice.');
    } finally {
      setSaving(false);
    }
  };
  if (!status) return error ? <p role="alert">{error}</p> : null;
  if (!status.enabled)
    return threadId ? null : (
      <div className="config-note">
        <strong>Model routing</strong>
        <p>
          Enable MODEL_ROUTER_ENABLED and add OPENROUTER_API_KEY on the server.
          Jev uses TYPESAFE_API_KEY. Keys stay on the server.
        </p>
      </div>
    );
  const preference = status.preference ?? { mode: 'auto' };
  return (
    <div className="model-routing">
      <strong>Model routing</strong>
      {threadId ? (
        <div className="model-routing-controls">
          <label>
            Mode
            <select
              aria-label="Model routing mode"
              value={preference.mode}
              disabled={running || saving}
              onChange={(event) => {
                const mode = event.target.value as RoutingMode;
                void save(
                  mode === 'manual'
                    ? { mode, model: status.models[0].id }
                    : { mode },
                );
              }}
            >
              <option value="auto">Auto · cheaper first</option>
              <option value="economy">Economical</option>
              <option value="quality">Premium · explicit choice</option>
              <option value="manual">Specific model</option>
            </select>
          </label>
          {preference.mode === 'manual' && (
            <label>
              Model
              <select
                aria-label="Specific model"
                value={preference.model}
                disabled={running || saving}
                onChange={(event) =>
                  void save({ mode: 'manual', model: event.target.value })
                }
              >
                {status.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label ?? `${model.tier}: ${model.id}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <small>
            {preference.mode === 'auto'
              ? 'Local rules → Jev → Qwen → GLM → DeepSeek. Premium models require your explicit choice.'
              : preference.model === FREE_ROUTER_MODEL
                ? 'Free models only, including document reviews. No Jev or paid model fallback. Free-provider availability and rate limits apply; external services may still charge.'
                : 'Your choice stays saved for this conversation. Change it to retry with a different model.'}
          </small>
          {status.lastDecision && (
            <p>
              Last selected: <strong>{status.lastDecision.model}</strong>
              <br />
              {status.lastDecision.reason}
            </p>
          )}
        </div>
      ) : (
        <ul>
          {status.models.map((model) => (
            <li key={model.id}>
              {model.label ?? `${model.tier}: ${model.id}`}
            </li>
          ))}
        </ul>
      )}
      <small>
        Jev:{' '}
        {status.jevConfigured
          ? 'configured'
          : 'not configured · agent rules active'}
        .{' '}
        {status.monthlyUsd ? (
          <>
            Shared budget: ${status.monthlyUsd}/calendar month (UTC), across all
            users and agents. Free models first, then inexpensive paid fallback
            in automatic mode.
          </>
        ) : (
          <>
            {status.dailyTurnLimit} turn attempts per agent/day (UTC). AI
            budget: ${status.dailyUsd}/day workspace · ${status.dotDailyUsd}/day
            per Dot · ${status.turnUsd}/request.
          </>
        )}{' '}
        Includes model calls, Jev and document visual review; external service
        fees are separate.
      </small>
      <UsagePanel threadId={threadId} />
      {threadId &&
        status.jevConfigured &&
        preference.model !== FREE_ROUTER_MODEL && (
          <JevDecisions threadId={threadId} disabled={running || saving} />
        )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
