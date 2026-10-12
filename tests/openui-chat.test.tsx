import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => {
  const agent = {
    messages: [],
    addMessage: vi.fn(),
    subscribe: vi.fn(() => ({ unsubscribe() {} })),
  };
  return {
    agent,
    useAgent: vi.fn(() => ({ agent, isReady: true })),
    copilotkit: {
      subscribe: vi.fn(() => ({ unsubscribe() {} })),
      connectAgent: vi.fn(async () => {}),
      runAgent: vi.fn(async () => ({ newMessages: [{ role: 'assistant' }] })),
      stopAgent: vi.fn(),
    },
    api: vi.fn(async (path: string, method?: string, body?: unknown) =>
      path === '/session'
        ? { openui: true }
        : path.endsWith('/chat-preferences')
          ? method === 'PUT'
            ? body
            : { interactive: false }
          : null,
    ),
  };
});
vi.mock('@copilotkit/react-core/v2', () => ({
  useAgent: mocks.useAgent,
  useCopilotKit: () => ({ copilotkit: mocks.copilotkit }),
  useRenderTool() {},
  useHumanInTheLoop() {},
  CopilotChatToolCallsView: () => null,
}));
vi.mock('../src/client/api', () => ({ api: mocks.api }));
vi.mock('../src/client/ModelRouting', () => ({ ModelRouting: () => null }));
vi.mock('../src/client/useVoice', () => ({
  useVoice: () => ({ status: 'idle', error: '', end: vi.fn() }),
}));
vi.mock('../src/client/CallView', () => ({ CallView: () => null }));
import { Chat } from '../src/client/Chat';
import { ChatTranscript } from '../src/client/ChatTranscript';
import type { Conversation, Dot } from '../src/shared/types';
const props = {
  thread: { id: 'original-thread' } as Conversation,
  dot: {
    id: 'original-dot',
    name: 'Test Dot',
    instructions: 'Test',
    spaceId: 'original-space',
  } as Dot,
  onConsumed() {},
  voiceReady: false,
  calls: [],
  paused: false,
  onSaved: vi.fn(),
  onSchedule() {},
};
let root: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

it('keeps the original thread/agent, drafts without sending, and submits once through the existing run path', async () => {
  await act(async () => {
    root = create(<Chat {...props} />);
  });
  expect(mocks.useAgent).toHaveBeenCalledWith({
    agentId: 'chat-original-thread',
    runtimeAgentId: 'original-dot',
    threadId: 'original-thread',
  });
  expect(root!.root.findByType(ChatTranscript).props.openUI).toBe(true);
  await act(async () =>
    root!.root
      .findByProps({ type: 'checkbox' })
      .props.onChange({ target: { checked: true } }),
  );
  await act(async () =>
    root!.root
      .findByType('textarea')
      .props.onChange({ target: { value: 'Existing draft' } }),
  );
  await act(async () =>
    root!.root
      .findByType(ChatTranscript)
      .props.onOpenUIDraft('Selected option B'),
  );
  expect(root!.root.findByType('textarea').props.value).toBe(
    'Existing draft\n\nSelected option B',
  );
  expect(mocks.copilotkit.runAgent).not.toHaveBeenCalled();
  expect(mocks.agent.addMessage).not.toHaveBeenCalled();
  await act(async () => {
    const submit = root!.root.findByType('form').props.onSubmit;
    submit({ preventDefault() {} });
    submit({ preventDefault() {} });
  });
  expect(mocks.agent.addMessage).toHaveBeenCalledTimes(1);
  expect(mocks.agent.addMessage.mock.calls[0][0]).toMatchObject({
    role: 'user',
    content: 'Existing draft\n\nSelected option B',
  });
  expect(mocks.copilotkit.runAgent).toHaveBeenCalledExactlyOnceWith({
    agent: mocks.agent,
    forwardedProps: { openui: 1 },
  });
  expect(props.onSaved).toHaveBeenCalledOnce();
});

it('preserves paused state and a full existing draft', async () => {
  await act(async () => {
    root = create(<Chat {...props} paused={true} />);
  });
  expect(root!.root.findByType(ChatTranscript).props.actionsDisabled).toBe(
    true,
  );
  await act(async () =>
    root!.root.findByType(ChatTranscript).props.onOpenUIDraft('Blocked'),
  );
  expect(root!.root.findByType('textarea').props.value).toBe('');
  await act(async () => root!.update(<Chat {...props} />));
  await act(async () =>
    root!.root
      .findByType('textarea')
      .props.onChange({ target: { value: 'x'.repeat(4000) } }),
  );
  expect(() =>
    root!.root.findByType(ChatTranscript).props.onOpenUIDraft('More'),
  ).toThrow('Message too long');
  expect(root!.root.findByType('textarea').props.value).toHaveLength(4000);
  expect(mocks.copilotkit.runAgent).not.toHaveBeenCalled();
});

it('omits UI capability on ordinary messages', async () => {
  await act(async () => {
    root = create(<Chat {...props} />);
  });
  await act(async () =>
    root!.root
      .findByType('textarea')
      .props.onChange({ target: { value: 'Ordinary message' } }),
  );
  await act(async () =>
    root!.root.findByType('form').props.onSubmit({ preventDefault() {} }),
  );
  expect(mocks.copilotkit.runAgent).toHaveBeenCalledExactlyOnceWith({
    agent: mocks.agent,
  });
});

it('loads the saved agent preference before sending an initial prompt', async () => {
  mocks.api.mockImplementationOnce(async () => null);
  mocks.api.mockImplementationOnce(async () => ({ openui: true }));
  mocks.api.mockImplementationOnce(async () => ({ interactive: true }));
  await act(async () => {
    root = create(<Chat {...props} initialPrompt="Show my dashboard" />);
  });
  expect(mocks.copilotkit.runAgent).toHaveBeenCalledExactlyOnceWith({
    agent: mocks.agent,
    forwardedProps: { openui: 1 },
  });
});
