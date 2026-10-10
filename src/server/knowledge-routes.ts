import { Hono } from 'hono';
import { z } from 'zod';
import { importManifest, knowledgeDocument } from './knowledge.js';
import type { Platform } from './platform.js';
export function knowledgeRoutes(platform: Platform) {
  const app = new Hono();
  const store = platform.workspace.knowledge;
  app.use('/spaces/:spaceId/knowledge/*', async (c, next) => {
    if (
      !platform.workspace.spaces().some((s) => s.id === c.req.param('spaceId'))
    )
      return c.json({ error: 'Space not found.' }, 404);
    await next();
  });
  app.get('/spaces/:spaceId/knowledge/imports', (c) =>
    c.json(
      store
        .imports(c.req.param('spaceId'))
        .map((r) => store.status(c.req.param('spaceId'), r.id)),
    ),
  );
  app.post('/spaces/:spaceId/knowledge/imports', async (c) =>
    c.json(
      store.start(
        c.req.param('spaceId'),
        importManifest.parse(await c.req.json()),
      ),
    ),
  );
  app.post('/spaces/:spaceId/knowledge/imports/:id/documents', async (c) => {
    store.addDocuments(
      c.req.param('spaceId'),
      c.req.param('id'),
      z.array(knowledgeDocument).parse(await c.req.json()),
    );
    return c.json({ ok: true });
  });
  app.post('/spaces/:spaceId/knowledge/imports/:id/chunks', async (c) => {
    const b = z
      .object({
        offset: z.number().int().nonnegative(),
        data: z.string().max(699052),
      })
      .strict()
      .parse(await c.req.json());
    store.addChunk(c.req.param('spaceId'), c.req.param('id'), b.offset, b.data);
    return c.json({ bytes: b.offset + Buffer.from(b.data, 'base64').length });
  });
  app.post('/spaces/:spaceId/knowledge/imports/:id/complete', (c) =>
    c.json(store.complete(c.req.param('spaceId'), c.req.param('id'))),
  );
  app.get('/spaces/:spaceId/knowledge/imports/:id/chunks', (c) =>
    c.json(
      store.archiveChunk(
        c.req.param('spaceId'),
        c.req.param('id'),
        z.coerce.number().int().nonnegative().parse(c.req.query('offset')),
      ),
    ),
  );
  app.get('/spaces/:spaceId/knowledge/search', (c) =>
    c.json(
      store.search(
        c.req.param('spaceId'),
        (c.req.query('q') ?? '').slice(0, 500),
        c.req.query('kind'),
        z.coerce
          .number()
          .int()
          .min(0)
          .max(50000)
          .parse(c.req.query('offset') ?? 0),
      ),
    ),
  );
  app.get('/spaces/:spaceId/knowledge/documents/:id', (c) =>
    c.json(
      store.read(
        c.req.param('spaceId'),
        Number(c.req.param('id')),
        z.coerce
          .number()
          .int()
          .min(0)
          .max(100000)
          .parse(c.req.query('offset') ?? 0),
      ),
    ),
  );
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof z.ZodError
            ? 'Invalid migration data.'
            : error.message,
      },
      400,
    ),
  );
  return app;
}
