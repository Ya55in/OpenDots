import { useEffect, useState } from 'react';
import { api } from './api';
import type { Connection } from '../shared/connection-types';
interface EmailStatus {
  configured: boolean;
  redirectUri: string;
  connection: Connection | null;
}
export function EmailConnection({ dotId }: { dotId: string }) {
  const [status, setStatus] = useState<EmailStatus>();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<EmailStatus>(`/dots/${dotId}/email`)
      .then((s) => {
        if (active) {
          setStatus(s);
          setEmail(s.connection?.name ?? '');
        }
      })
      .catch(() => {
        if (active)
          setError(
            'Could not load the mailbox connection. Reopen agent settings to retry.',
          );
      });
    return () => {
      active = false;
    };
  }, [dotId]);
  return (
    <fieldset className="space-access-fields connections-fields">
      <legend>Email</legend>
      <p className="muted">
        Connect this agent to its own Gmail or Google Workspace mailbox. Search
        and read email; review each draft or send before it runs. Access renews
        automatically. Only the owner can use email tools.
      </p>
      {status?.connection && (
        <p role="status">
          Connected: <strong>{status.connection.name}</strong>
        </p>
      )}
      {status && !status.configured && (
        <p>Configure the Google app in Space storage first.</p>
      )}
      <label className="field-label" htmlFor="agent-mailbox">
        Mailbox address
      </label>
      <input
        id="agent-mailbox"
        type="email"
        placeholder="name@company.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.preventDefault();
        }}
      />
      <button
        type="button"
        className="connection-connect"
        disabled={!status?.configured || busy || !email.trim()}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            const result = await api<{ url: string }>(
              `/dots/${dotId}/email/connect`,
              'POST',
              { email: email.trim() },
            );
            window.location.assign(result.url);
          } catch (e) {
            setError(
              e instanceof Error
                ? e.message
                : 'Could not start Google sign-in.',
            );
            setBusy(false);
          }
        }}
      >
        {busy
          ? 'Opening Google…'
          : status?.connection
            ? 'Reconnect mailbox'
            : 'Connect Gmail'}
      </button>
      {status?.connection && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            if (
              !window.confirm(
                `Disconnect ${status.connection!.name} from this agent?`,
              )
            )
              return;
            setBusy(true);
            setError('');
            try {
              await api(`/connections/${status.connection!.id}`, 'DELETE');
              setStatus({ ...status, connection: null });
            } catch {
              setError('Could not disconnect this mailbox. Please retry.');
            } finally {
              setBusy(false);
            }
          }}
        >
          Disconnect mailbox
        </button>
      )}
      {status?.redirectUri && (
        <details>
          <summary>Google setup details</summary>
          <p>
            Enable Gmail API and add this authorized redirect URI to the
            existing Google OAuth client:
          </p>
          <code>{status.redirectUri}</code>
          <p>
            Google permissions: read email and manage drafts/send. OpenDots
            always asks for approval before writing or sending.
          </p>
        </details>
      )}
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
