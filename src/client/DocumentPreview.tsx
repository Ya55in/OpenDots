import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Eye, X } from 'lucide-react';
import { api, authHeaders } from './api';
import { StorageDialog } from './StorageDialog';
interface PreviewInfo {
  pageCount: number;
  warnings: string[];
  review?: { pages: number; observations: string[]; referenceDigest?: string };
}
export function DocumentPreviewButton({
  spaceId,
  fileId,
  name,
}: {
  spaceId: string;
  fileId: string;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Preview ${name}`}
      >
        <Eye size={16} /> Preview
      </button>
      {open && (
        <Preview
          spaceId={spaceId}
          fileId={fileId}
          name={name}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
function Preview({
  spaceId,
  fileId,
  name,
  onClose,
}: {
  spaceId: string;
  fileId: string;
  name: string;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<PreviewInfo>(),
    [page, setPage] = useState(1),
    [image, setImage] = useState(''),
    [error, setError] = useState('');
  const base = `/spaces/${spaceId}/files/${fileId}/preview`;
  useEffect(() => {
    const controller = new AbortController();
    void api<PreviewInfo>(base, 'POST', {}, controller.signal)
      .then(setInfo)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [base]);
  useEffect(() => {
    if (!info) return;
    const controller = new AbortController();
    setImage('');
    setError('');
    void fetch(`/api${base}/${page}`, {
      headers: authHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load this preview page.');
        const blob = await response.blob();
        const reader = new FileReader();
        reader.onload = () => {
          if (!controller.signal.aborted) setImage(String(reader.result));
        };
        reader.readAsDataURL(blob);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [base, page, info]);
  return (
    <StorageDialog label={`Document preview: ${name}`} onClose={onClose}>
      <div className="storage-actions">
        <h2>{name}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close document preview"
        >
          <X size={18} />
        </button>
      </div>
      {error && (
        <p role="alert" className="chat-error">
          {error}
        </p>
      )}
      {!info && !error && <p role="status">Rendering your document pages…</p>}
      {info && (
        <>
          <div className="document-preview-controls">
            <button
              type="button"
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft size={18} />
            </button>
            <span>
              Page {page} of {info.pageCount}
            </span>
            <button
              type="button"
              disabled={page === info.pageCount}
              onClick={() => setPage((p) => p + 1)}
              aria-label="Next page"
            >
              <ChevronRight size={18} />
            </button>
          </div>
          <div className="document-preview-page">
            {image ? (
              <img src={image} alt={`${name}, page ${page}`} />
            ) : (
              !error && <p role="status">Loading page…</p>
            )}
          </div>
          <details className="document-preview-review">
            <summary>
              {info.review
                ? `${info.review.referenceDigest ? 'Template comparison' : 'Visual review'} · ${info.review.pages} pages inspected`
                : 'Visual review pending'}
            </summary>
            {info.review ? (
              info.review.observations.map((text, i) => <p key={i}>{text}</p>)
            ) : (
              <p>
                Ask your Dot to review this document’s appearance before
                delivery.
              </p>
            )}
            {info.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </details>
        </>
      )}
    </StorageDialog>
  );
}
