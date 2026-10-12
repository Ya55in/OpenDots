import { DocumentCard } from './DocumentCard';
import { DocumentExport } from './DocumentExport';
import { fileMessage } from './file-message';
import { AttachmentDialog } from './FileBrowser';
import type { StoredFile } from '../shared/storage';
import { ModelRouting } from './ModelRouting';
import { PageReviewCard } from './PageReviewCard';
import { pageReviewSchema, pageReviewTool } from '../shared/page-review';
import {
  connectionActionSchema,
  connectionActionTool,
} from '../shared/connection-types';
import { ConnectionActionCard } from './ConnectionActionCard';
import { contextualMessage, type PageContext } from './page-context';
import { api } from './api';
import type { Page } from '../server/pages';
import { useEffect, useRef, useState } from 'react';
import {
  CopilotChatToolCallsView,
  useRenderTool,
  useHumanInTheLoop,
  useAgent,
  useCopilotKit,
} from '@copilotkit/react-core/v2';
import {
  FilePlus,
  Paperclip,
  ArrowUp,
  Clock3,
  Link2,
  Phone,
  PhoneOff,
  Square,
  X,
} from 'lucide-react';
import {
  ComputerToolCard,
  type ComputerToolRenderProps,
} from './ComputerToolCard';
import { ChatTranscript, isInternalVoiceReceipt } from './ChatTranscript';
import type { CallReceipt, Conversation, Dot } from '../shared/types';
import { Mascot } from './Mascot';
import { useVoice } from './useVoice';
import { CallView } from './CallView';
import { shouldSubmitComposerOnKeyDown } from './chat-composer';
import { OPENUI_VERSION } from '../shared/openui';
import './openui.css';

export function Chat({
  thread,
  dot,
  initialPrompt,
  onConsumed,
  voiceReady,
  calls,
  paused,
  onSaved,
  onSchedule,
  onComputer,
}: {
  thread: Conversation;
  dot: Dot;
  initialPrompt?: string;
  onConsumed: () => void;
  voiceReady: boolean;
  calls: CallReceipt[];
  paused: boolean;
  onSaved: () => void;
  onSchedule: () => void;
  onComputer?: () => void;
}) {
  const { agent, isReady } = useAgent({
    agentId: `chat-${thread.id}`,
    runtimeAgentId: dot.id,
    threadId: thread.id,
  });
  const { copilotkit } = useCopilotKit();
  const [pageContext, setPageContext] = useState<PageContext | null>();
  const [contextError, setContextError] = useState('');
  const [contextAttempt, setContextAttempt] = useState(0);
  const contextReady = pageContext !== undefined;
  useEffect(() => {
    let active = true;
    setPageContext(undefined);
    setContextError('');
    void api<PageContext | null>(
      `/conversations/${thread.id}/page-context`,
      'GET',
      undefined,
      AbortSignal.timeout(10000),
    )
      .then((page) => {
        if (active) setPageContext(page);
      })
      .catch(() => {
        if (active)
          setContextError(
            'Conversation context could not load. Retry before sending your message.',
          );
      });
    return () => {
      active = false;
    };
  }, [thread.id, contextAttempt]);
  const [draft, setDraft] = useState('');
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [attachments, setAttachments] = useState<StoredFile[]>([]);
  const [source, setSource] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const runError = useRef('');
  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    setElapsed(0);
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [running]);
  const sending = useRef(false);
  const [openUI, setOpenUI] = useState(false);
  const [openUIAvailable, setOpenUIAvailable] = useState(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [preferencesSaving, setPreferencesSaving] = useState(false);
  useEffect(() => {
    let active = true;
    setOpenUI(false);
    setPreferencesReady(false);
    void Promise.all([
      api<{ openui?: boolean }>(
        '/session',
        'GET',
        undefined,
        AbortSignal.timeout(8000),
      ),
      api<{ interactive: boolean }>(
        `/dots/${dot.id}/chat-preferences`,
        'GET',
        undefined,
        AbortSignal.timeout(8000),
      ),
    ])
      .then(([session, preference]) => {
        if (active) {
          setOpenUIAvailable(session.openui === true);
          setOpenUI(preference.interactive);
          setPreferencesReady(true);
        }
      })
      .catch(() => {
        if (active) {
          setOpenUIAvailable(false);
          setPreferencesReady(true);
          setError(
            'Response preferences could not load. Reload to restore interactive mode.',
          );
        }
      });
    return () => {
      active = false;
    };
  }, [dot.id]);
  const voice = useVoice(thread.id, onSaved, agent.messages.at(-1)?.id);
  const sent = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const subscription = copilotkit.subscribe({
      onError: ({ error }) => setError(error.message),
    });
    const events = agent.subscribe({
      onRunErrorEvent: ({ event }) => {
        runError.current = event.message;
        setError(event.message);
      },
    });
    return () => {
      subscription.unsubscribe();
      events.unsubscribe();
    };
  }, [agent, copilotkit]);
  useEffect(() => {
    if (!isReady) return;
    let active = true;
    void copilotkit
      .connectAgent({ agent })
      .then(() => {
        if (active) setLoaded(true);
      })
      .catch((e) => {
        if (active)
          setError(
            e instanceof Error ? e.message : 'Conversation could not connect.',
          );
      });
    return () => {
      active = false;
    };
  }, [agent, copilotkit, isReady]);
  const send = async (text: string) => {
    if (
      (!text.trim() && !attachments.length) ||
      running ||
      sending.current ||
      !loaded ||
      !contextReady ||
      !preferencesReady ||
      preferencesSaving ||
      paused
    )
      return;
    setError('');
    runError.current = '';
    sending.current = true;
    setRunning(true);
    try {
      agent.addMessage({
        id: crypto.randomUUID(),
        role: 'user',
        content: contextualMessage(fileMessage(text, attachments), pageContext),
      });
      setDraft('');
      setAttachments([]);
      setSource('');
      setSourceOpen(false);
      const result = await copilotkit.runAgent({
        agent,
        ...(openUI && openUIAvailable
          ? { forwardedProps: { openui: OPENUI_VERSION } }
          : {}),
      });
      if (runError.current) throw new Error(runError.current);
      if (
        !result.newMessages.some(
          (message) =>
            message.role === 'assistant' &&
            ((typeof message.content === 'string' && message.content.trim()) ||
              message.toolCalls?.some((call) =>
                [pageReviewTool.name, connectionActionTool.name].includes(
                  call.function.name,
                ),
              )),
        )
      )
        throw new Error(
          'The model finished without a readable answer. Your request is saved. Ask it to continue, or change the model in Chat options.',
        );
      onSaved();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'The turn failed. Your conversation remains saved.',
      );
    } finally {
      sending.current = false;
      setRunning(false);
    }
  };
  useEffect(() => {
    if (
      loaded &&
      contextReady &&
      preferencesReady &&
      !paused &&
      initialPrompt &&
      !sent.current
    ) {
      sent.current = true;
      onConsumed();
      void send(initialPrompt);
    }
  }, [loaded, contextReady, preferencesReady, paused, initialPrompt]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [agent.messages.length, running]);
  useEffect(() => {
    if (paused && voice.status !== 'idle') void voice.end();
  }, [paused]);
  useHumanInTheLoop(
    {
      name: pageReviewTool.name,
      description: pageReviewTool.description,
      parameters: pageReviewSchema,
      render: (props) => (
        <PageReviewCard {...props} threadId={thread.id} onSaved={onSaved} />
      ),
    },
    [thread.id, onSaved],
  );
  useHumanInTheLoop(
    {
      name: connectionActionTool.name,
      description: connectionActionTool.description,
      parameters: connectionActionSchema,
      render: (props) => (
        <ConnectionActionCard {...props} threadId={thread.id} />
      ),
    },
    [thread.id],
  );
  const computerCalls = agent.messages.flatMap((message) =>
    message.role === 'assistant' ? (message.toolCalls ?? []) : [],
  );
  const latestBrowserCall = computerCalls.findLast((call) =>
    [
      'navigate',
      'snapshot',
      'read',
      'screenshot',
      'click',
      'type',
      'key',
      'scroll',
    ].some((action) => call.function.name === `computer_${action}`),
  );
  useRenderTool(
    {
      name: '*',
      render: (props: ComputerToolRenderProps) =>
        [
          'generate_document',
          'edit_word_template',
          'create_presentation_from_template',
        ].includes(props.name) ? (
          <DocumentCard result={props.result} status={props.status} />
        ) : props.name.startsWith('computer_') ? (
          <ComputerToolCard
            {...props}
            dotId={dot.id}
            dotName={dot.name}
            running={running}
            showScreen={props.toolCallId === latestBrowserCall?.id}
            onExpand={onComputer}
          />
        ) : null,
    },
    [dot.id, dot.name, running, latestBrowserCall?.id, onComputer],
  );
  const visible = agent.messages.filter(
    (message) =>
      !isInternalVoiceReceipt(message) &&
      ['user', 'assistant'].includes(message.role) &&
      ((typeof message.content === 'string' && message.content.trim()) ||
        (message.role === 'assistant' &&
          message.toolCalls?.some(
            (call) =>
              call.function.name.startsWith('computer_') ||
              [
                'generate_document',
                'edit_word_template',
                'create_presentation_from_template',
              ].includes(call.function.name) ||
              call.function.name === pageReviewTool.name ||
              call.function.name === connectionActionTool.name,
          ))),
  );
  return (
    <div className="live-chat">
      <header className="chat-persona">
        <Mascot
          identity={dot.id}
          name={dot.name}
          small
          state={running ? 'working' : paused ? 'paused' : 'idle'}
        />
        <div>
          <strong>{dot.name}</strong>
          <span>
            {paused
              ? 'Paused'
              : running
                ? 'Thinking…'
                : loaded && contextReady
                  ? 'Here with you'
                  : 'Connecting to your conversation…'}
          </span>
        </div>
        <div className="chat-persona-actions">
          <button
            className="icon-button"
            aria-label="Save conversation as page"
            disabled={running}
            onClick={async () => {
              const title = window.prompt('Page title', thread.title);
              if (!title) return;
              try {
                const page = await api<Page>(
                  `/conversations/${thread.id}/page`,
                  'POST',
                  { title },
                );
                location.hash = `/spaces/${page.spaceId}/pages/${page.id}`;
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : 'Could not save conversation.',
                );
              }
            }}
          >
            <FilePlus size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="Schedule a task in this conversation"
            onClick={onSchedule}
          >
            <Clock3 size={18} />
          </button>
          <button
            className={`icon-button ${voice.status === 'active' ? 'on-call' : ''}`}
            aria-label={
              voice.status === 'idle' ? 'Start voice call' : 'End voice call'
            }
            title={
              voiceReady
                ? 'Talk with your Dot'
                : 'Voice setup requires VOICE_API_KEY and VOICE_MODEL'
            }
            disabled={!voiceReady || paused || !loaded || !contextReady}
            onClick={() =>
              voice.status === 'idle' ? void voice.start() : void voice.end()
            }
          >
            {voice.status === 'idle' ? (
              <Phone size={18} />
            ) : (
              <PhoneOff size={18} />
            )}
          </button>
        </div>
      </header>
      <details className="chat-options">
        <summary>
          Chat options{' '}
          <span>{openUI ? 'Interactive' : 'Text'} · model & agent</span>
        </summary>
        <div className="chat-options-body">
          <ModelRouting threadId={thread.id} running={running} />
          {openUIAvailable && (
            <label className="openui-option">
              <input
                type="checkbox"
                checked={openUI}
                disabled={running || preferencesSaving || !preferencesReady}
                onChange={async (event) => {
                  const interactive = event.target.checked;
                  setPreferencesSaving(true);
                  try {
                    const saved = await api<{ interactive: boolean }>(
                      `/dots/${dot.id}/chat-preferences`,
                      'PUT',
                      { interactive },
                      AbortSignal.timeout(8000),
                    );
                    setOpenUI(saved.interactive);
                  } catch {
                    setError('Could not save interactive mode. Please retry.');
                  } finally {
                    setPreferencesSaving(false);
                  }
                }}
              />
              Interactive responses · saved for you on this agent
            </label>
          )}
          <details className="agent-context">
            <summary>Agent instructions & learning</summary>
            <p>{dot.instructions}</p>
            <p>
              Conversation Learning ID:{' '}
              <code>{thread.learningContainerId || 'Not enrolled'}</code>
            </p>
            <p>
              New conversations:{' '}
              <code>{dot.learningContainerId || 'Learning off'}</code>.{' '}
              {dot.skillDeliveryEnabled
                ? 'Published skills enabled.'
                : 'Published skills off.'}
            </p>
          </details>
        </div>
      </details>
      {pageContext && (
        <div className="page-chat-context">
          Working on{' '}
          <a href={`/#/spaces/${pageContext.spaceId}/pages/${pageContext.id}`}>
            {pageContext.title}
          </a>
        </div>
      )}
      <div className="chat-transcript">
        {!visible.length && (
          <div className="chat-welcome">
            <span className="eyebrow">A LITTLE SPACE TO THINK</span>
            <h1>What’s on your mind?</h1>
            <p className="muted">
              Your conversation stays with this Dot, across text and calls.
            </p>
          </div>
        )}
        <ChatTranscript
          openUI={openUIAvailable}
          actionsDisabled={
            running ||
            !loaded ||
            !contextReady ||
            paused ||
            voice.status !== 'idle'
          }
          onOpenUIDraft={(text) => {
            if (
              running ||
              sending.current ||
              !loaded ||
              !contextReady ||
              paused ||
              voice.status !== 'idle'
            )
              return;
            // Preserve text already typed and any pending attachments/source.
            const next = draft.trim() ? `${draft}\n\n${text}` : text;
            if (next.length > 4000) {
              setError(
                'The combined message is too long. Shorten your draft or form values and try again.',
              );
              throw new Error('Message too long.');
            }
            setDraft(next);
          }}
          renderExport={(message) => (
            <DocumentExport
              markdown={String(message.content)}
              dotId={dot.id}
              spaceId={dot.spaceId}
              threadId={thread.id}
            />
          )}
          messages={visible}
          calls={calls}
          renderTools={(message) => (
            <CopilotChatToolCallsView
              message={message}
              messages={agent.messages}
            />
          )}
        />
        {running && (
          <div className="thinking">
            <span />
            <span />
            <span />
            <span>
              {dot.name} is working · {elapsed}s
              {elapsed >= 30 ? ' · You can stop this response below.' : ''}
            </span>
          </div>
        )}
        <div ref={bottom} />
      </div>
      {!running && loaded && !error && visible.at(-1)?.role === 'user' && (
        <div className="chat-error" role="status">
          No completed answer follows your last message. Your request is saved.
          You can ask the agent to continue or change its model in Chat options.
        </div>
      )}
      {contextError && (
        <div className="chat-error" role="alert">
          {contextError}
          <button onClick={() => setContextAttempt((value) => value + 1)}>
            Retry context
          </button>
        </div>
      )}
      {(error || voice.error) && (
        <div className="chat-error" role="alert">
          {error || voice.error}
          {error && (
            <button
              onClick={() => {
                setError('');
                void copilotkit
                  .connectAgent({ agent })
                  .then(() => setLoaded(true))
                  .catch((e) => setError(e.message));
              }}
            >
              Reconnect
            </button>
          )}
        </div>
      )}
      <CallView
        key={voice.status === 'idle' ? 'idle' : 'call'}
        dot={dot}
        voice={voice}
      />
      {attachmentsOpen && (
        <AttachmentDialog
          spaceId={dot.spaceId}
          dotId={dot.id}
          threadId={thread.id}
          onClose={() => setAttachmentsOpen(false)}
          onAttached={(file) =>
            setAttachments((current) =>
              current.some((f) => f.id === file.id)
                ? current
                : [...current, file],
            )
          }
        />
      )}
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(`${source ? `From ${source}:\n\n` : ''}${draft}`);
        }}
      >
        {!!attachments.length && (
          <div className="attachment-chips">
            {attachments.map((file) => (
              <span key={file.id}>
                <Paperclip size={14} />
                {file.name}
                <button
                  type="button"
                  aria-label={`Remove ${file.name} from message`}
                  onClick={() =>
                    setAttachments((current) =>
                      current.filter((f) => f.id !== file.id),
                    )
                  }
                >
                  <X size={14} />
                </button>
              </span>
            ))}
          </div>
        )}
        {sourceOpen && (
          <div className="source-input">
            <Link2 size={15} />
            <input
              aria-label="Source page URL"
              type="url"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://example.com/page"
            />
            <button
              type="button"
              className="icon-button"
              aria-label="Remove source"
              onClick={() => {
                setSourceOpen(false);
                setSource('');
              }}
            >
              <X size={14} />
            </button>
          </div>
        )}
        <div className="chat-compose-row">
          <button
            type="button"
            className="icon-button"
            aria-label="Attach files"
            disabled={running || paused}
            onClick={() => setAttachmentsOpen(true)}
          >
            <Paperclip size={19} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Add source page link"
            onClick={() => setSourceOpen(!sourceOpen)}
          >
            <Link2 size={19} />
          </button>
          <textarea
            aria-label="Message your Dot"
            placeholder={`Message ${dot.name}…`}
            rows={1}
            value={draft}
            maxLength={4000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (shouldSubmitComposerOnKeyDown(e)) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {running ? (
            <button
              type="button"
              className="send-button"
              aria-label="Stop response"
              onClick={() => copilotkit.stopAgent({ agent })}
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              className="send-button"
              aria-label="Send message"
              disabled={
                (!draft.trim() && !attachments.length) ||
                !loaded ||
                !contextReady ||
                !preferencesReady ||
                preferencesSaving ||
                paused
              }
            >
              <ArrowUp size={19} />
            </button>
          )}
        </div>
        <div className="chat-compose-note">
          Check important details. Your conversation is saved automatically.
        </div>
      </form>
    </div>
  );
}
