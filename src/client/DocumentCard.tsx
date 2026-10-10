import { DocumentPreviewButton } from './DocumentPreview';
import { useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { documentResultSchema, type DocumentResult } from '../shared/documents';
import { downloadDocument } from './document-download';
export function DocumentFiles({ result }: { result: DocumentResult }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState('');
  return (
    <div className="document-artifacts">
      {result.files.map((f) => (
        <div key={f.id} className="document-file-row">
          <button
            type="button"
            className="artifact-download"
            key={f.id}
            disabled={!!busy}
            onClick={async () => {
              setBusy(f.id);
              setError('');
              try {
                await downloadDocument(
                  `/api/spaces/${f.spaceId}/files/${f.id}/download`,
                  f.name,
                );
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Download failed.');
              } finally {
                setBusy('');
              }
            }}
          >
            <FileText size={22} />
            <span>
              <strong>{f.name}</strong>
              <small>
                {(f.size / 1024).toFixed(0)} KB ·{' '}
                {f.provider === 'drive' ? 'Google Drive' : 'Saved in OpenDots'}
                {busy === f.id ? ' · Downloading…' : ''}
              </small>
            </span>
            <Download size={18} />
          </button>
          {/\.(pdf|docx)$/i.test(f.name) && (
            <DocumentPreviewButton
              spaceId={f.spaceId}
              fileId={f.id}
              name={f.name}
            />
          )}
        </div>
      ))}
      {result.warnings
        .filter(
          (w) =>
            !w.startsWith(
              'Template formatting preserved. Visual review is pending:',
            ),
        )
        .map((w) => (
          <p className="muted" key={w}>
            {w}
          </p>
        ))}
      {result.errors?.map((e) => (
        <p className="chat-error" role="alert" key={e}>
          {e}
        </p>
      ))}
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function DocumentCard({
  result,
  status,
}: {
  result?: unknown;
  status: string;
}) {
  let value = result;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      /* Report failed tool response below. */
    }
  }
  const parsed = documentResultSchema.safeParse(value);
  return (
    <section className="document-generation-card" aria-label="Generated files">
      <strong>
        {parsed.success
          ? 'Your files'
          : status === 'complete'
            ? 'File generation needs attention'
            : 'Designing your files…'}
      </strong>
      {parsed.success ? (
        <DocumentFiles result={parsed.data} />
      ) : status === 'complete' ? (
        <p>
          Generation did not return a downloadable file. Ask your Dot to retry.
        </p>
      ) : (
        <p className="muted">Creating the layout and saving your downloads.</p>
      )}
    </section>
  );
}
