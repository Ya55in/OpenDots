import { useEffect, useRef, useState } from 'react';
import { api } from './api';
type Manifest = {
  name: string;
  documents: number;
  documentDigest: string;
  archiveName: string;
  archiveSize: number;
  archiveSha256: string;
};
type ImportStatus = {
  id: string;
  manifest: Manifest;
  complete: boolean;
  documents: number;
  bytes: number;
};
type Doc = { path: string; kind: string; content: string };
export function KnowledgeSection({ spaceId }: { spaceId: string }) {
  const [imports, setImports] = useState<ImportStatus[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<
    Array<{ id: number; path: string; kind: string; excerpt: string }>
  >([]);
  const [selected, setSelected] = useState<{
    id: number;
    path: string;
    content: string;
    nextOffset: number | null;
  } | null>(null);
  const bundle = useRef<HTMLInputElement>(null),
    archive = useRef<HTMLInputElement>(null);
  const root = `/spaces/${spaceId}/knowledge`;
  const refresh = () => api<ImportStatus[]>(`${root}/imports`).then(setImports);
  useEffect(() => {
    void api<ImportStatus[]>(`${root}/imports`)
      .then(setImports)
      .catch((e) => setMessage(String(e)));
  }, [root]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function read(id: number, offset = 0) {
    const r = await api<{
      path: string;
      content: string;
      nextOffset: number | null;
    }>(`${root}/documents/${id}?offset=${offset}`);
    setSelected({ id, ...r });
  }
  return (
    <fieldset className="space-access-fields">
      <legend>Private knowledge & migration</legend>
      <p className="muted">
        Import skills, history, memory and searchable files into this Space.
        Original ZIP archives stay private and are verified before activation.
        Re-select the same files to resume an interrupted upload.
      </p>
      <label className="field-label">
        Knowledge index (.json)
        <input ref={bundle} type="file" accept=".json" disabled={busy} />
      </label>
      <label className="field-label">
        Original files (.zip)
        <input ref={archive} type="file" accept=".zip" disabled={busy} />
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const index = bundle.current?.files?.[0],
              file = archive.current?.files?.[0];
            if (!index || !file)
              throw new Error('Select the index and its original ZIP archive.');
            if (index.size > 100_000_000)
              throw new Error('Index exceeds 100 MB.');
            const input = JSON.parse(await index.text()) as {
              manifest: Manifest;
              documents: Doc[];
            };
            if (
              !Array.isArray(input.documents) ||
              file.name !== input.manifest.archiveName ||
              file.size !== input.manifest.archiveSize
            )
              throw new Error('Archive does not match the index.');
            const status = await api<ImportStatus>(
              `${root}/imports`,
              'POST',
              input.manifest,
            );
            if (status.complete) {
              setMessage('This migration is already verified and active.');
              await refresh();
              return;
            }
            let batch: Doc[] = [],
              size = 0,
              processed = 0;
            const send = async () => {
              if (batch.length) {
                await api(
                  `${root}/imports/${status.id}/documents`,
                  'POST',
                  batch,
                );
                processed += batch.length;
                setMessage(
                  `Indexing ${processed} / ${input.documents.length} documents`,
                );
                batch = [];
                size = 0;
              }
            };
            for (const doc of input.documents) {
              const bytes = new TextEncoder().encode(
                JSON.stringify(doc),
              ).length;
              if (size + bytes > 750000 || batch.length >= 40) await send();
              batch.push(doc);
              size += bytes;
            }
            await send();
            for (let offset = status.bytes; offset < file.size;) {
              const bytes = new Uint8Array(
                await file.slice(offset, offset + 524288).arrayBuffer(),
              );
              let binary = '';
              for (let j = 0; j < bytes.length; j += 8192)
                binary += String.fromCharCode(...bytes.subarray(j, j + 8192));
              const response = await api<{ bytes: number }>(
                `${root}/imports/${status.id}/chunks`,
                'POST',
                { offset, data: btoa(binary) },
              );
              offset = response.bytes;
              setMessage(
                `Uploading originals: ${((100 * offset) / file.size).toFixed(1)}% (${Math.round(offset / 1e6)} / ${Math.round(file.size / 1e6)} MB)`,
              );
            }
            setMessage('Verifying archive and document checksums…');
            await api(`${root}/imports/${status.id}/complete`, 'POST', {});
            await refresh();
            setMessage(
              'Migration verified and active. HIBA can search and read the imported knowledge.',
            );
          })
        }
      >
        {busy ? 'Working…' : 'Import or resume migration'}
      </button>
      <p role="status">{message}</p>
      {imports.map((item) => (
        <div key={item.id}>
          <strong>{item.manifest.name}</strong>
          <p>
            {item.complete
              ? 'Verified and active'
              : 'Incomplete — resume upload'}{' '}
            · {item.documents} documents · {Math.round(item.bytes / 1e6)} MB
            original archive
          </p>
          {item.complete && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const parts: Uint8Array<ArrayBuffer>[] = [];
                  for (let offset = 0; offset < item.bytes;) {
                    const chunk = await api<{ data: string }>(
                      `${root}/imports/${item.id}/chunks?offset=${offset}`,
                    );
                    const bytes = Uint8Array.from(atob(chunk.data), (c) =>
                      c.charCodeAt(0),
                    );
                    parts.push(bytes);
                    offset += bytes.length;
                    setMessage(
                      `Downloading originals: ${((100 * offset) / item.bytes).toFixed(1)}%`,
                    );
                  }
                  const url = URL.createObjectURL(
                    new Blob(parts, { type: 'application/zip' }),
                  );
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = item.manifest.archiveName;
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 60000);
                  setMessage('Archive downloaded.');
                })
              }
            >
              Download original archive
            </button>
          )}
        </div>
      ))}
      <label className="field-label">
        Search imported knowledge
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            setResults(
              await api(`${root}/search?q=${encodeURIComponent(query)}`),
            );
          })
        }
      >
        Search knowledge
      </button>
      {results.map((r) => (
        <div key={r.id}>
          <button type="button" onClick={() => void run(() => read(r.id))}>
            {r.path}
          </button>
          <small>{r.kind}</small>
          <p>{r.excerpt}</p>
        </div>
      ))}
      {selected && (
        <div>
          <strong>{selected.path}</strong>
          <pre
            style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto' }}
          >
            {selected.content}
          </pre>
          {selected.nextOffset !== null && (
            <button
              type="button"
              onClick={() =>
                void run(() => read(selected.id, selected.nextOffset!))
              }
            >
              Read next section
            </button>
          )}
        </div>
      )}
    </fieldset>
  );
}
