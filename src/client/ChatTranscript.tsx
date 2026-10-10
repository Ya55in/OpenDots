import { useState } from 'react';
import { downloadDocument, fileDownloadPath } from './document-download';
import remarkGfm from 'remark-gfm';
import { displayFileMessage } from './file-message';
import { openPageLink } from './page-navigation';
import { Fragment, type ReactNode } from 'react';
import { PhoneOff } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { AssistantMessage, Message } from '@ag-ui/core';
import type { CallReceipt } from '../shared/types';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt';
import { isScheduledTaskMessage } from '../shared/scheduled-message';
// These markers only control rendering; they do not confer trust or permissions.
export function isInternalVoiceReceipt(message: Message): boolean {
  const metadata = message.metadata;
  return (
    message.role === 'user' &&
    (message.id.startsWith(voiceReceiptMessagePrefix) ||
      (!!metadata &&
        typeof metadata === 'object' &&
        'opendotsSource' in metadata &&
        metadata.opendotsSource === 'voice_receipt'))
  );
}
function Receipt({ call }: { call: CallReceipt }) {
  return (
    <div className="call-receipt">
      <PhoneOff size={13} />
      <span>
        {call.status === 'failed'
          ? 'Call failed'
          : call.endedAt
            ? `${Math.round((call.endedAt - call.startedAt) / 1000)}s · Call ended`
            : 'Call in progress'}
      </span>
      {call.error && <small>{call.error}</small>}
    </div>
  );
}
export function ChatTranscript({
  messages,
  calls,
  renderTools,
  renderExport,
}: {
  messages: Message[];
  calls: CallReceipt[];
  renderTools?: (message: AssistantMessage) => ReactNode;
  renderExport?: (message: AssistantMessage) => ReactNode;
}) {
  const [downloadError, setDownloadError] = useState('');
  const ids = new Set(messages.map((message) => message.id));
  return (
    <>
      {downloadError && (
        <p className="chat-error" role="alert">
          {downloadError}
        </p>
      )}
      {calls
        .filter(
          (call) => !call.anchorMessageId || !ids.has(call.anchorMessageId),
        )
        .map((call) => (
          <Receipt key={call.id} call={call} />
        ))}
      {messages.map((message) => (
        <Fragment key={message.id}>
          {typeof message.content === 'string' && message.content.trim() && (
            <div
              className={`chat-bubble ${message.role}${isScheduledTaskMessage(message) ? ' scheduled' : ''}`}
            >
              {isScheduledTaskMessage(message) && (
                <span className="scheduled-message-label">Scheduled</span>
              )}
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  img: ({ alt }) => <span>{alt}</span>,
                  a: ({ href, children }) => (
                    <a
                      onClick={(event) => {
                        const file = fileDownloadPath(href);
                        if (file) {
                          event.preventDefault();
                          setDownloadError('');
                          void downloadDocument(file, 'Document').catch((e) =>
                            setDownloadError(e.message),
                          );
                        } else if (href?.startsWith('/#/spaces/')) {
                          event.preventDefault();
                          openPageLink(href);
                        }
                      }}
                      href={href}
                      target={
                        href?.startsWith('/#/spaces/') ? undefined : '_blank'
                      }
                      rel="noreferrer"
                    >
                      {children}
                    </a>
                  ),
                }}
              >
                {message.role === 'user'
                  ? displayFileMessage(message.content)
                  : message.content}
              </ReactMarkdown>
              {message.role === 'assistant' && renderExport?.(message)}
            </div>
          )}
          {message.role === 'assistant' && renderTools?.(message)}
          {calls
            .filter((call) => call.anchorMessageId === message.id)
            .map((call) => (
              <Receipt key={call.id} call={call} />
            ))}
        </Fragment>
      ))}
    </>
  );
}
