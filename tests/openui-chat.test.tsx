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
      runAgent: vi.fn(async () => ({
        newMessages: [{ role: 'assistant', content: 'Ready' }],
      })),
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

it('reports empty assistant messages as failed instead of silently completing', async () => {
  mocks.copilotkit.runAgent.mockResolvedValueOnce({
    newMessages: [{ role: 'assistant', content: '' }],
  });
  await act(async () => {
    root = create(<Chat {...props} />);
  });
  await act(async () =>
    root!.root
      .findByType('textarea')
      .props.onChange({ target: { value: 'Draft my order' } }),
  );
  await act(async () =>
    root!.root.findByType('form').props.onSubmit({ preventDefault() {} }),
  );
  expect(JSON.stringify(root!.toJSON())).toContain(
    'The model returned no usable answer',
  );
  expect(props.onSaved).not.toHaveBeenCalled();
});

it('continues a saved failed request without duplicating the user message', async () => {
  mocks.copilotkit.runAgent.mockRejectedValueOnce(
    new Error('404 No endpoints found'),
  );
  await act(async () => {
    root = create(<Chat {...props} initialPrompt="Make a PDF" />);
  });
  expect(mocks.agent.addMessage).toHaveBeenCalledTimes(1);
  const button = root!.root
    .findAllByType('button')
    .find((b) => b.children.includes('Continue saved request'))!;
  await act(async () => {
    await button.props.onClick();
  });
  expect(mocks.agent.addMessage).toHaveBeenCalledTimes(1);
  expect(mocks.copilotkit.runAgent).toHaveBeenCalledTimes(2);
});

it('ignores historical run errors replayed while restoring the conversation', async () => {
  mocks.copilotkit.connectAgent.mockImplementationOnce(async () => {
    const handlers = (
      mocks.agent.subscribe.mock.calls as unknown as unknown[][]
    ).at(-1)?.[0] as unknown as { onRunErrorEvent: (event: unknown) => void };
    handlers.onRunErrorEvent({ event: { message: '402 old credit failure' } });
  });
  await act(async () => {
    root = create(<Chat {...props} />);
  });
  expect(JSON.stringify(root!.toJSON())).not.toContain(
    'provider could not authorize',
  );
  expect(JSON.stringify(root!.toJSON())).not.toContain('402');
});

it('restores the saved interactive mode after the chat is remounted', async () => {
  const original = mocks.api.getMockImplementation()!;
  let saved = false;
  mocks.api.mockImplementation(async (path, method, body) => {
    if (path === '/session') return { openui: true };
    if (path.endsWith('/chat-preferences')) {
      if (method === 'PUT')
        saved = (body as { interactive: boolean }).interactive;
      return { interactive: saved };
    }
    return null;
  });
  try {
    await act(async () => {
      root = create(<Chat {...props} />);
    });
    await act(async () => {
      await root!.root
        .findByProps({ type: 'checkbox' })
        .props.onChange({ target: { checked: true } });
    });
    await act(async () => {
      root!.unmount();
    });
    await act(async () => {
      root = create(<Chat {...props} />);
    });
    expect(root!.root.findByProps({ type: 'checkbox' }).props.checked).toBe(
      true,
    );
  } finally {
    mocks.api.mockImplementation(original);
  }
});
