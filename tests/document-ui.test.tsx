import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../src/client/api', () => ({ api: vi.fn(), authHeaders: () => ({}) }));
import { DocumentCard } from '../src/client/DocumentCard';
import { ChatTranscript } from '../src/client/ChatTranscript';
it('renders downloads from validated tool results, including after conversation reload', () => {
  const result = {
    files: [
      {
        id: 'doc-id',
        spaceId: 'space-id',
        name: 'Proposal.pdf',
        size: 2048,
        provider: 'local',
        downloadUrl: '/api/spaces/space-id/files/doc-id/download',
      },
    ],
    warnings: [
      'Images are captions only.',
      'Template formatting preserved. Visual review is pending: call review_document before delivery.',
    ],
    errors: ['PPTX: Shorten the table.'],
  };
  const html = renderToStaticMarkup(
    <DocumentCard result={JSON.stringify(result)} status="complete" />,
  );
  expect(html).toContain('Proposal.pdf');
  expect(html).toContain('2 KB');
  expect(html).toContain('Preview Proposal.pdf');
  expect(html).toContain('Images are captions only.');
  expect(html).toContain('Shorten the table.');
  expect(html).not.toContain('Designing');
  expect(html).not.toContain('Visual review is pending:');
});
it('does not report success for an empty or malformed generation result', () => {
  const html = renderToStaticMarkup(
    <DocumentCard result="Server error" status="complete" />,
  );
  expect(html).toContain('needs attention');
  expect(html).not.toContain('Your files');
});
it('renders readable Markdown tables, scoped file links, and an export action only on assistant messages', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      calls={[]}
      messages={[
        { id: 'u', role: 'user', content: 'Generate a file' },
        {
          id: 'a',
          role: 'assistant',
          content:
            '| Item | Value |\n|---|---|\n| Test | 10 |\n\n[Download PDF](/api/spaces/space-id/files/doc-id/download)',
        },
      ]}
      renderExport={() => <button>Export file</button>}
    />,
  );
  expect(html).toContain('<table>');
  expect(html).toContain('Download PDF');
  expect(html.match(/Export file/g)).toHaveLength(1);
});
