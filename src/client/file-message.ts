import type { StoredFile } from '../shared/storage';
const marker = '\n\nAttached files (use read_file with these IDs):\n';
export function fileMessage(text: string, files: StoredFile[]) {
  return (
    (text.trim() || 'Please read the attached files.') +
    (files.length
      ? marker +
        files
          .map(({ name, id, spaceId }) => JSON.stringify({ name, id, spaceId }))
          .join('\n')
      : '')
  );
}
// Presentation only. File permissions are always checked by the server tools.
export function displayFileMessage(content: string) {
  const at = content.lastIndexOf(marker);
  if (at < 0) return content;
  try {
    const files = content
      .slice(at + marker.length)
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            name?: unknown;
            id?: unknown;
            spaceId?: unknown;
          },
      );
    if (
      !files.length ||
      files.some(
        (f) =>
          typeof f.name !== 'string' ||
          typeof f.id !== 'string' ||
          typeof f.spaceId !== 'string',
      )
    )
      return content;
    return (
      content.slice(0, at) +
      '\n\n' +
      files
        .map(
          (f) =>
            '📎 ' + String(f.name).replace(/[\\`*_{}[\]()#+.!<>|~-]/g, '\\$&'),
        )
        .join('\n\n')
    );
  } catch {
    return content;
  }
}
