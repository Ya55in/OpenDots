import { parentPort, workerData } from 'node:worker_threads';
import { documentSchema } from '../shared/documents.js';
import { renderDocument } from './document-render.js';
try {
  const input = documentSchema.parse(workerData.input);
  const format = input.formats.find((f) => f === workerData.format);
  if (!format) throw new Error('Invalid document format.');
  const result = await renderDocument(input, format);
  parentPort?.postMessage(result);
} catch (e) {
  parentPort?.postMessage({
    error: e instanceof Error ? e.message : 'Document generation failed.',
  });
}
