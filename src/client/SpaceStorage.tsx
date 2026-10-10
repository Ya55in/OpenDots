import { StorageDialog } from './StorageDialog';
import { useEffect, useState } from 'react';
import { Cloud, FolderOpen, X } from 'lucide-react';
import { api } from './api';
import type { Dot, Space } from '../shared/types';
import type { StorageStatus } from '../shared/storage';
import { FileBrowser } from './FileBrowser';
export function SpaceStorage({ space, dots }: { space: Space; dots: Dot[] }) {
  const [open, setOpen] = useState(false),
    [status, setStatus] = useState<StorageStatus>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [clientId, setClientId] = useState(''),
    [secret, setSecret] = useState(''),
    [pickerKey, setPickerKey] = useState(''),
    [project, setProject] = useState(''),
    [dotId, setDotId] = useState(dots[0]?.id ?? ''),
    [version, setVersion] = useState(0);
  const load = async () => {
    const s = await api<StorageStatus>(`/spaces/${space.id}/storage`);
    setStatus(s);
    setClientId(s.clientId);
    setProject(s.projectNumber);
  };
  useEffect(() => {
    if (open) void load().catch((e) => setError(e.message));
  }, [open, space.id]);
  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await run();
      await load();
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Storage settings failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="storage-open"
        onClick={() => setOpen(true)}
      >
        <FolderOpen size={17} /> Files & storage
      </button>
      {open && (
        <StorageDialog
          label={`${space.name} file storage`}
          onClose={() => setOpen(false)}
          busy={busy}
        >
          <header>
            <div>
              <span className="library-eyebrow">SPACE STORAGE</span>
              <h2>{space.name}</h2>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="Close storage"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              <X size={20} />
            </button>
          </header>
          {error && (
            <p role="alert" className="chat-error">
              {error}
            </p>
          )}
          <div className="drive-connection">
            <Cloud size={24} />
            <div>
              <strong>
                {status?.connected
                  ? `Connected · ${status.email}`
                  : 'Google Drive'}
              </strong>
              <p>OpenDots → {space.name} → one folder per Dot</p>
              <p className="muted">
                Only files created here or selected through the Drive picker are
                accessible. Selected Drive files are copied into the Dot’s
                folder; the source stays in place.
              </p>
            </div>
          </div>
          <div className="storage-actions">
            {status?.connected ? (
              <>
                <a href={status.folderUrl} target="_blank" rel="noreferrer">
                  Open Space folder ↗
                </a>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api(
                        `/spaces/${space.id}/storage/folders`,
                        'POST',
                        {},
                      );
                    })
                  }
                >
                  Ensure Dot folders
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api(
                        `/spaces/${space.id}/storage/disconnect`,
                        'POST',
                        {},
                      );
                    })
                  }
                >
                  Disconnect Drive
                </button>
              </>
            ) : (
              <button
                type="button"
                className="document-primary"
                disabled={busy || !status?.configured}
                onClick={() =>
                  void act(async () => {
                    const { url } = await api<{ url: string }>(
                      `/spaces/${space.id}/storage/connect`,
                      'POST',
                      {},
                    );
                    location.assign(url);
                  })
                }
              >
                Connect Google Drive
              </button>
            )}
          </div>
          {status?.connected && (
            <p className="muted">
              Disconnecting stops Drive access. Existing files and extracted
              memory are kept. Revoke OpenDots in your Google account to remove
              its Google authorization.
            </p>
          )}
          {status && !status.configured && (
            <p role="status">
              Complete Google app setup below to enable connection. Local
              attachments work now.
            </p>
          )}
          <details className="google-app-setup">
            <summary>Google app setup</summary>
            <p>
              One setup for this OpenDots server; each Space can connect its own
              Google account. Enable Drive API and Google Picker API in the same
              Google Cloud project, create a Web application OAuth client, and
              restrict the Picker key to this website.
            </p>
            <p>
              Authorized origin: <code>{location.origin}</code>
            </p>
            <p>
              Redirect URI:{' '}
              <code>
                {status?.redirectUri || 'Set APP_ORIGIN on the server first'}
              </code>
            </p>
            <p>
              <a
                href="https://developers.google.com/workspace/drive/picker/guides/web-picker"
                target="_blank"
                rel="noreferrer"
              >
                Google setup instructions ↗
              </a>
            </p>
            <label>
              OAuth client ID
              <input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label>
              OAuth client secret
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={
                  status?.hasClientSecret
                    ? 'Saved; leave blank to keep'
                    : 'Google client secret'
                }
                autoComplete="new-password"
              />
            </label>
            <label>
              Picker API key
              <input
                type="password"
                value={pickerKey}
                onChange={(e) => setPickerKey(e.target.value)}
                placeholder={
                  status?.hasPickerKey
                    ? 'Saved; leave blank to keep'
                    : 'API key restricted to this website'
                }
                autoComplete="new-password"
              />
            </label>
            <label>
              Google Cloud project number
              <input
                value={project}
                onChange={(e) => setProject(e.target.value)}
                inputMode="numeric"
                autoComplete="off"
              />
            </label>
            {!status?.encryptionReady && (
              <p role="alert">
                Configure STORAGE_ENCRYPTION_KEY on the server before saving
                Google credentials.
              </p>
            )}
            <button
              type="button"
              disabled={
                busy ||
                !status?.encryptionReady ||
                !clientId ||
                !project ||
                (!secret && !status.hasClientSecret) ||
                (!pickerKey && !status.hasPickerKey)
              }
              onClick={() =>
                void act(async () => {
                  await api('/storage/google/app', 'PUT', {
                    clientId,
                    clientSecret: secret,
                    pickerKey,
                    projectNumber: project,
                  });
                  setSecret('');
                  setPickerKey('');
                })
              }
            >
              Save Google app settings
            </button>
          </details>
          <hr />
          <label className="storage-dot-select">
            Files for Dot
            <select
              disabled={busy}
              value={dotId}
              onChange={(e) => setDotId(e.target.value)}
            >
              {dots.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          {dotId ? (
            <FileBrowser
              key={`${dotId}-${version}`}
              spaceId={space.id}
              dotId={dotId}
              onBusyChange={setBusy}
            />
          ) : (
            <p>Add a Dot with access to this Space to start storing files.</p>
          )}
        </StorageDialog>
      )}
    </>
  );
}
