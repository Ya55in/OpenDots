import { useState } from 'react';
import { X, FileDown } from 'lucide-react';
import { api } from './api';
import { StorageDialog } from './StorageDialog';
import { DocumentFiles } from './DocumentCard';
import {
  documentResultSchema,
  type DocumentFormat,
  type DocumentResult,
} from '../shared/documents';
export function DocumentExport({
  markdown,
  title,
  dotId,
  spaceId,
  threadId,
}: {
  markdown: string;
  title?: string;
  dotId: string;
  spaceId: string;
  threadId?: string;
}) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState(title || 'Document'),
    [format, setFormat] = useState<DocumentFormat>('pdf'),
    [style, setStyle] = useState('executive'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [result, setResult] = useState<DocumentResult>();
  return (
    <>
      <button
        className="message-export"
        type="button"
        onClick={() => setOpen(true)}
      >
        <FileDown size={14} /> Export file
      </button>
      {open && (
        <StorageDialog
          label="Export document"
          busy={busy}
          onClose={() => setOpen(false)}
        >
          <header>
            <h2>Export document</h2>
            <button
              type="button"
              aria-label="Close export"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              <X size={18} />
            </button>
          </header>
          <p className="muted">
            Turn this response into a downloadable file, saved in your Dot’s
            storage. Ask your Dot to create a tailored document for more control
            over the content.
          </p>
          <label>
            Document title
            <input
              value={name}
              maxLength={160}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            File format
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as DocumentFormat)}
            >
              <option value="pdf">PDF document</option>
              <option value="docx">Word document (.docx)</option>
              <option value="xlsx">Excel workbook (.xlsx)</option>
              <option value="pptx">PowerPoint (.pptx)</option>
              <option value="md">Markdown (.md)</option>
              <option value="txt">Plain text (.txt)</option>
              <option value="csv">CSV table (.csv)</option>
            </select>
          </label>
          <label>
            Document style
            <select value={style} onChange={(e) => setStyle(e.target.value)}>
              <option value="executive">Executive</option>
              <option value="minimal">Minimal</option>
              <option value="proposal">Proposal</option>
            </select>
          </label>
          <button
            type="button"
            className="document-primary"
            disabled={busy || !name.trim()}
            onClick={async () => {
              setBusy(true);
              setError('');
              setResult(undefined);
              try {
                const r = await api(`/spaces/${spaceId}/documents`, 'POST', {
                  dotId,
                  threadId,
                  title: name,
                  markdown,
                  formats: [format],
                  style,
                });
                setResult(documentResultSchema.parse(r));
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Export failed.');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Creating file…' : 'Create file'}
          </button>
          {error && (
            <p role="alert" className="chat-error">
              {error}
            </p>
          )}
          {result && <DocumentFiles result={result} />}
        </StorageDialog>
      )}
    </>
  );
}
