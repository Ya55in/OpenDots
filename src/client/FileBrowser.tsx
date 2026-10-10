import { StorageDialog } from './StorageDialog';
import { useEffect, useRef, useState } from 'react';
import { Cloud, Download, FileText, Upload, X } from 'lucide-react';
import { api, authHeaders } from './api';
import { pickDriveFiles } from './drive-picker';
import {
  FILE_CHUNK_BYTES,
  MAX_FILE_BYTES,
  type StoredFile,
  type StorageStatus,
} from '../shared/storage';
export function FileBrowser({
  spaceId,
  dotId,
  threadId,
  onAttached,
  onBusyChange,
}: {
  spaceId: string;
  dotId: string;
  threadId?: string;
  onAttached?: (f: StoredFile) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [files, setFiles] = useState<StoredFile[]>([]),
    [status, setStatus] = useState<StorageStatus>(),
    [query, setQuery] = useState(''),
    [error, setError] = useState(''),
    [progress, setProgress] = useState(''),
    [busy, setBusy] = useState(false),
    [more, setMore] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const scope = `/spaces/${spaceId}`;
  const load = async (offset = 0) => {
    const next = await api<StoredFile[]>(
      `${scope}/files?dotId=${encodeURIComponent(dotId)}&q=${encodeURIComponent(query)}&offset=${offset}`,
    );
    setFiles((previous) => (offset ? [...previous, ...next] : next));
    setMore(next.length === 30);
  };
  useEffect(() => {
    let active = true;
    setFiles([]);
    setError('');
    void Promise.all([
      api<StorageStatus>(`${scope}/storage`),
      api<StoredFile[]>(`${scope}/files?dotId=${encodeURIComponent(dotId)}`),
    ])
      .then(([s, f]) => {
        if (active) {
          setStatus(s);
          setFiles(f);
          setMore(f.length === 30);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [spaceId, dotId]);
  const operation = async (run: () => Promise<void>) => {
    setBusy(true);
    onBusyChange?.(true);
    setError('');
    try {
      await run();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'File action failed.');
    } finally {
      setBusy(false);
      onBusyChange?.(false);
      setProgress('');
    }
  };
  const upload = async (selected: File[]) => {
    if (selected.length > 10)
      throw new Error('Choose up to 10 files at a time.');
    for (const file of selected) {
      if (file.size > MAX_FILE_BYTES)
        throw new Error(`${file.name}: maximum size is 25 MB.`);
      const { id } = await api<{ id: string }>(
        `${scope}/files/uploads`,
        'POST',
        {
          dotId,
          threadId,
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
        },
      );
      for (let offset = 0; offset < file.size; offset += FILE_CHUNK_BYTES) {
        const bytes = new Uint8Array(
          await file.slice(offset, offset + FILE_CHUNK_BYTES).arrayBuffer(),
        );
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        setProgress(
          `Uploading ${file.name} · ${Math.round((offset / file.size) * 100)}%`,
        );
        // A chunk retry is safe: the server rejects conflicting bytes.
        const body = { offset, data: btoa(binary) };
        try {
          await api(`${scope}/files/uploads/${id}/chunks`, 'POST', body);
        } catch {
          await api(`${scope}/files/uploads/${id}/chunks`, 'POST', body);
        }
      }
      setProgress(`Saving and reading ${file.name}…`);
      const saved = await api<StoredFile>(
        `${scope}/files/uploads/${id}/complete`,
        'POST',
        {},
      );
      onAttached?.(saved);
    }
    await load();
  };
  const download = async (file: StoredFile) => {
    const response = await fetch(`/api${scope}/files/${file.id}/download`, {
      headers: authHeaders(),
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error ?? 'Download failed.');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const header = response.headers.get('content-disposition') ?? '';
    const encoded = header.split("filename*=UTF-8''")[1];
    a.download = encoded ? decodeURIComponent(encoded) : file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  return (
    <section className="file-browser" aria-label="Dot files">
      <p className="muted">
        {status?.connected
          ? 'Files are saved in this Dot’s Google Drive folder.'
          : 'Files are saved privately in OpenDots. Connect Drive in Space storage to save future uploads there.'}{' '}
        Attached files stay searchable in this Dot’s memory. Up to 25 MB each.
      </p>
      <div className="storage-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          <Upload size={16} /> My computer
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="Choose computer files"
          onChange={(e) => {
            const selected = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (selected.length) void operation(() => upload(selected));
          }}
        />
        <button
          type="button"
          disabled={busy || !status?.connected || !status.pickerReady}
          title={
            !status?.connected
              ? 'Connect Google Drive in Space storage'
              : !status.pickerReady
                ? 'Finish Google Picker setup in Space storage'
                : undefined
          }
          onClick={() =>
            void operation(async () => {
              const ids = await pickDriveFiles(spaceId);
              if (ids.length > 10)
                throw new Error('Choose up to 10 files at a time.');
              for (const fileId of ids) {
                setProgress(
                  'Copying selected Drive file and reading its text…',
                );
                const f = await api<StoredFile>(
                  `${scope}/files/from-drive`,
                  'POST',
                  { dotId, threadId, fileId, requestId: crypto.randomUUID() },
                );
                onAttached?.(f);
              }
              await load();
            })
          }
        >
          <Cloud size={16} /> Google Drive
        </button>
      </div>
      {error && (
        <p role="alert" className="chat-error">
          {error}
        </p>
      )}
      {progress && <p role="status">{progress}</p>}
      <div className="storage-search">
        <input
          aria-label="Search Dot files"
          placeholder="Search filenames and contents"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void operation(() => load());
            }
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void operation(() => load())}
        >
          Search files
        </button>
      </div>
      <ul className="storage-files">
        {files.map((f) => (
          <li key={f.id}>
            <FileText size={18} />
            <div>
              <strong>{f.name}</strong>
              <small>
                {f.provider === 'drive' ? 'Google Drive' : 'OpenDots'} ·{' '}
                {f.size < 1024
                  ? `${f.size} B`
                  : `${(f.size / 1024).toFixed(0)} KB`}
              </small>
              <small>{f.textStatus}</small>
            </div>
            {onAttached && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onAttached(f)}
              >
                Attach
              </button>
            )}
            {f.provider === 'drive' && (
              <button
                type="button"
                disabled={busy}
                aria-label={`Refresh ${f.name} from Drive`}
                onClick={() =>
                  void operation(async () => {
                    setProgress(`Refreshing ${f.name}…`);
                    await api(`${scope}/files/${f.id}/refresh`, 'POST', {});
                    await load();
                  })
                }
              >
                Refresh
              </button>
            )}
            <button
              type="button"
              aria-label={`Download ${f.name}`}
              disabled={busy}
              onClick={() => void operation(() => download(f))}
            >
              <Download size={16} />
            </button>
          </li>
        ))}
      </ul>
      {!files.length && (
        <p className="muted">
          No files yet. Upload or choose a Drive file to give this Dot lasting
          context.
        </p>
      )}
      {more && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void operation(() => load(files.length))}
        >
          More files
        </button>
      )}
    </section>
  );
}
export function AttachmentDialog({
  spaceId,
  dotId,
  threadId,
  onAttached,
  onClose,
}: {
  spaceId: string;
  dotId: string;
  threadId: string;
  onAttached: (file: StoredFile) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <StorageDialog label="Attach files" onClose={onClose} busy={busy}>
      <header>
        <h2>Attach files</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close attachments"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      <FileBrowser
        spaceId={spaceId}
        dotId={dotId}
        threadId={threadId}
        onAttached={onAttached}
        onBusyChange={setBusy}
      />
      <button
        type="button"
        className="document-primary"
        disabled={busy}
        onClick={onClose}
      >
        Done
      </button>
    </StorageDialog>
  );
}
