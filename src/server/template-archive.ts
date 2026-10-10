import { Readable } from 'node:stream';
import yauzl from 'yauzl';
import type { KnowledgeStore } from './knowledge.js';
export async function archiveWordFiles(
  store: KnowledgeStore,
  space: string,
  id: string,
  query = '',
  selected?: string,
): Promise<{ entries: string[]; data?: Buffer }> {
  const record = store.require(space, id);
  if (!record.complete) throw new Error('Archive is not verified.');
  const chunks = new Map<number, Buffer>();
  const readChunk = (offset: number) => {
    let chunk = chunks.get(offset);
    if (!chunk) {
      chunk = Buffer.from(store.archiveChunk(space, id, offset).data, 'base64');
      if (chunks.size >= 4) chunks.delete(chunks.keys().next().value!);
      chunks.set(offset, chunk);
    }
    return chunk;
  };
  class Reader extends yauzl.RandomAccessReader {
    _readStreamForRange(start: number, end: number) {
      return Readable.from(
        (function* () {
          for (let offset = start; offset < end;) {
            const chunk = readChunk(Math.floor(offset / 524288) * 524288);
            const slice = chunk.subarray(
              offset % 524288,
              Math.min(
                chunk.length,
                end - Math.floor(offset / 524288) * 524288,
              ),
            );
            if (!slice.length) throw new Error('Invalid archive range.');
            offset += slice.length;
            yield slice;
          }
        })(),
      );
    }
  }
  return new Promise((resolve, reject) => {
    yauzl.fromRandomAccessReader(
      new Reader(),
      record.manifest.archiveSize,
      { lazyEntries: true },
      (err, zip) => {
        if (err) return reject(err);
        const entries: string[] = [];
        let count = 0,
          settled = false;
        const done = (error?: Error, data?: Buffer) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          zip.close();
          if (error) reject(error);
          else resolve({ entries, data });
        };
        const timer = setTimeout(
          () => done(new Error('Archive lookup timed out.')),
          20000,
        );
        zip.on('error', done);
        zip.on('entry', (entry) => {
          if (++count > 50000)
            return done(new Error('Archive contains too many files.'));
          if (
            /\.docx$/i.test(entry.fileName) &&
            entry.fileName.toLowerCase().includes(query.toLowerCase()) &&
            entries.length < 100
          )
            entries.push(entry.fileName);
          if (selected && selected === entry.fileName) {
            if (
              !/\.docx$/i.test(selected) ||
              entry.uncompressedSize > 25 * 1024 * 1024
            )
              return done(new Error('Select a DOCX template under 25 MB.'));
            zip.openReadStream(entry, (error, stream) => {
              if (error) return done(error);
              const buffers: Buffer[] = [];
              let size = 0;
              stream.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > 25 * 1024 * 1024) {
                  stream.destroy();
                  done(new Error('Template too large.'));
                } else buffers.push(chunk);
              });
              stream.on('error', done);
              stream.on('end', () => done(undefined, Buffer.concat(buffers)));
            });
          } else zip.readEntry();
        });
        zip.on('end', () =>
          done(
            selected
              ? new Error('Original template not found in this archive.')
              : undefined,
          ),
        );
        zip.readEntry();
      },
    );
  });
}
