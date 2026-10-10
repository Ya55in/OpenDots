import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import type { UsageSnapshot } from '../shared/usage';
const money = (value: number | null) =>
  value === null ? 'Unreported' : `$${value.toFixed(4)}`;
const count = (value: number | null) =>
  value === null ? '—' : value.toLocaleString();
export function UsagePanel({ threadId }: { threadId?: string }) {
  const [admin, setAdmin] = useState(false);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<UsageSnapshot>();
  const [error, setError] = useState('');
  const [scope, setScope] = useState<'workspace' | 'conversation'>('workspace');
  useEffect(() => {
    let active = true;
    void api<{ isAdmin: boolean }>('/session')
      .then((value) => {
        if (active) setAdmin(value.isAdmin);
      })
      .catch(() => {
        if (active) setAdmin(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!admin || !open) return;
    let active = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (document.visibilityState !== 'hidden') {
        try {
          const next = await api<UsageSnapshot>(
            '/admin/usage',
            'GET',
            undefined,
            controller.signal,
          );
          if (active) {
            setData(next);
            setError('');
          }
        } catch (e) {
          if (active) {
            setError('Usage could not refresh. Values may be out of date.');
            if (e instanceof ApiError && [401, 403].includes(e.status)) {
              setAdmin(false);
              setData(undefined);
            }
          }
        }
      }
      if (active) timer = setTimeout(() => void refresh(), 2000);
    };
    void refresh();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [admin, open]);
  if (!admin) return null;
  const calls =
    data?.calls.filter(
      (call) => scope === 'workspace' || call.threadId === threadId,
    ) ?? [];
  return (
    <section className="usage-panel">
      <button
        type="button"
        className="usage-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        AI consumption <span>Admin only</span>
      </button>
      {open && (
        <div className="usage-content">
          <p className="muted">
            Updates every 2 seconds while visible. Tokens and actual charges
            arrive when the provider reports them; reservations are estimates,
            not billed costs.
          </p>
          {error && <p role="alert">{error}</p>}
          {!data ? (
            <p>Loading usage…</p>
          ) : (
            <>
              <div className="usage-metrics">
                <div>
                  <small>Reported today · workspace</small>
                  <strong>{money(data.totals.charged)}</strong>
                </div>
                <div>
                  <small>Reserved / unconfirmed</small>
                  <strong>{money(data.totals.reserved)}</strong>
                </div>
                <div>
                  <small>Input / output tokens</small>
                  <strong>
                    {count(data.totals.inputTokens)} /{' '}
                    {count(data.totals.outputTokens)}
                  </strong>
                </div>
                <div>
                  <small>Cached input / cache writes</small>
                  <strong>
                    {count(data.totals.cachedTokens)} /{' '}
                    {count(data.totals.cacheWriteTokens)}
                  </strong>
                </div>
              </div>
              <p>
                {data.totals.calls} calls today (UTC) · Daily limit{' '}
                {money(data.budgets?.daily ?? null)} · Per agent{' '}
                {money(data.budgets?.dotDaily ?? null)} · Per request{' '}
                {money(data.budgets?.request ?? null)}
              </p>
              {threadId && (
                <label>
                  Activity{' '}
                  <select
                    aria-label="Usage activity scope"
                    value={scope}
                    onChange={(event) =>
                      setScope(event.target.value as typeof scope)
                    }
                  >
                    <option value="workspace">All agents</option>
                    <option value="conversation">This conversation</option>
                  </select>
                </label>
              )}
              <div className="usage-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Model</th>
                      <th>Status</th>
                      <th>Input / output</th>
                      <th>Cached</th>
                      <th>Reported</th>
                      <th>Reserved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calls.map((call) => (
                      <tr key={call.id}>
                        <td>{new Date(call.createdAt).toLocaleTimeString()}</td>
                        <td>
                          {call.model}
                          <small>{call.dotName ?? call.dotId}</small>
                        </td>
                        <td>
                          {call.outcome === 'pending'
                            ? 'Pending / unconfirmed'
                            : call.outcome}
                        </td>
                        <td>
                          {count(call.inputTokens)} / {count(call.outputTokens)}
                        </td>
                        <td>{count(call.cachedTokens)}</td>
                        <td>{money(call.charged)}</td>
                        <td>
                          {call.charged === null ? money(call.reserved) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!calls.length && <p>No recorded calls in this view today.</p>}
              </div>
              <small>
                Last refreshed {new Date(data.updatedAt).toLocaleTimeString()}.
                Latest 200 calls shown; totals include all of today’s tracked
                calls. Tracking starts with the cost-control deployment.
                External service and voice-audio fees are excluded. Missing
                token data is shown as —, never zero.
              </small>
            </>
          )}
        </div>
      )}
    </section>
  );
}
