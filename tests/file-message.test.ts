import { expect, it } from 'vitest';
import { displayFileMessage, fileMessage } from '../src/client/file-message';
import type { StoredFile } from '../src/shared/storage';
it('keeps file references available to the model while showing readable filenames', () => {
  const f = {
    id: 'private-id',
    spaceId: 'private-space',
    name: 'Offer [draft].pdf',
  } as StoredFile;
  const raw = fileMessage('Review this', [f]);
  expect(raw).toContain('private-id');
  const visible = displayFileMessage(raw);
  expect(visible).toContain('Review this');
  expect(visible).toContain('Offer \\[draft\\]');
  expect(visible).not.toContain('private-id');
  expect(visible).not.toContain('private-space');
});
it('preserves ordinary user messages and invalid marker lookalikes', () => {
  const text = 'Attached files (use read_file with these IDs):\nnot JSON';
  expect(displayFileMessage(text)).toBe(text);
  expect(fileMessage('', [])).toBe('Please read the attached files.');
});
