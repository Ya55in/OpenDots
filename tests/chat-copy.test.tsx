import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatTranscript } from '../src/client/ChatTranscript';
let root: ReactTestRenderer;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
it('copies user and assistant content and reports clipboard failures without changing the transcript', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  await act(async () => {
    root = create(
      <ChatTranscript
        messages={[
          { id: 'u', role: 'user', content: 'My question' },
          { id: 'a', role: 'assistant', content: '**The answer**' },
        ]}
        calls={[]}
      />,
    );
  });
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Copy your message' })
      .props.onClick(),
  );
  expect(writeText).toHaveBeenLastCalledWith('My question');
  await act(async () =>
    root.root.findByProps({ 'aria-label': 'Copy response' }).props.onClick(),
  );
  expect(writeText).toHaveBeenLastCalledWith('**The answer**');
  writeText.mockRejectedValueOnce(new Error('denied'));
  await act(async () =>
    root.root.findByProps({ 'aria-label': 'Copy response' }).props.onClick(),
  );
  expect(JSON.stringify(root.toJSON())).toContain('Copy failed');
  expect(JSON.stringify(root.toJSON())).toContain('The answer');
});
