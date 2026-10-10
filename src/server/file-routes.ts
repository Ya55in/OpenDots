import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import type { FileService } from './file-service.js';
import { MAX_FILE_BYTES } from '../shared/storage.js';
const ident = z.string().min(1).max(200);
const filename = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (s) =>
      !s.includes('/') &&
      !s.includes('\\') &&
      [...s].every((c) => c.charCodeAt(0) >= 32),
    'Invalid filename.',
  );
export function fileRoutes(service: FileService) {
  const app = new Hono();
  const store = service.workspace.files;
  const drive = service.drive;
  app.use('/spaces/:spaceId/*', async (c, next) => {
    if (
      !service.workspace.spaces().some((s) => s.id === c.req.param('spaceId'))
    )
      return c.json({ error: 'Space not found.' }, 404);
    await next();
  });
  app.get('/spaces/:spaceId/storage', (c) =>
    c.json(drive.status(c.req.param('spaceId'))),
  );
  app.put('/storage/google/app', async (c) => {
    const b = z
      .object({
        clientId: z.string().regex(/^[\w.-]+\.apps\.googleusercontent\.com$/),
        clientSecret: z.string().max(500),
        pickerKey: z.string().max(500),
        projectNumber: z.string().regex(/^\d{5,30}$/),
      })
      .strict()
      .parse(await c.req.json());
    drive.saveApp(b);
    return c.json({ ok: true });
  });
  app.post('/spaces/:spaceId/storage/connect', (c) => {
    const b = drive.begin(c.req.param('spaceId'));
    setCookie(c, 'opendots-drive-' + b.state.slice(0, 16), b.browser, {
      httpOnly: true,
      secure: drive.redirectUri.startsWith('https:'),
      sameSite: 'Lax',
      path: '/storage/google/callback',
      maxAge: 600,
    });
    return c.json({ url: b.url });
  });
  app.post('/spaces/:spaceId/storage/folders', async (c) => {
    await drive.ensureFolders(c.req.param('spaceId'));
    return c.json(drive.status(c.req.param('spaceId')));
  });
  app.post('/spaces/:spaceId/storage/disconnect', (c) => {
    store.disconnect(c.req.param('spaceId'));
    return c.json({ ok: true });
  });
  // Picker receives a short-lived drive.file token only after owner authentication.
  // Refresh tokens and the OAuth client secret never leave the server.
  app.post('/spaces/:spaceId/storage/picker', async (c) =>
    c.json(await drive.picker(c.req.param('spaceId'))),
  );
  app.get('/spaces/:spaceId/files', (c) => {
    const dot = c.req.query('dotId');
    if (dot) service.scope(c.req.param('spaceId'), dot);
    return c.json(
      store.list(
        c.req.param('spaceId'),
        dot,
        (c.req.query('q') ?? '').slice(0, 500),
        z.coerce
          .number()
          .int()
          .min(0)
          .max(50000)
          .parse(c.req.query('offset') ?? 0),
      ),
    );
  });
  app.post('/spaces/:spaceId/files/uploads', async (c) => {
    const b = z
      .object({
        dotId: ident,
        threadId: ident.optional(),
        name: filename,
        mimeType: z
          .string()
          .max(200)
          .regex(/^[\w.+-]+\/[\w.+-]+$/),
        size: z.number().int().min(0).max(MAX_FILE_BYTES),
      })
      .strict()
      .parse(await c.req.json());
    service.scope(c.req.param('spaceId'), b.dotId, b.threadId);
    return c.json(
      store.startUpload({
        ...b,
        spaceId: c.req.param('spaceId'),
        threadId: b.threadId ?? null,
      }),
    );
  });
  app.post('/spaces/:spaceId/files/uploads/:id/chunks', async (c) => {
    const b = z
      .object({
        offset: z.number().int().nonnegative(),
        data: z.string().max(699052),
      })
      .strict()
      .parse(await c.req.json());
    const u = store.upload(c.req.param('spaceId'), c.req.param('id'));
    service.scope(u.spaceId, u.dotId, u.threadId);
    store.chunk(u.spaceId, u.id, b.offset, b.data);
    return c.json({ ok: true });
  });
  app.post('/spaces/:spaceId/files/uploads/:id/complete', async (c) =>
    c.json(await service.finish(c.req.param('spaceId'), c.req.param('id'))),
  );
  app.post('/spaces/:spaceId/files/from-drive', async (c) => {
    const b = z
      .object({
        dotId: ident,
        threadId: ident.optional(),
        fileId: z.string().regex(/^[\w-]{1,200}$/),
        requestId: z.uuid(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await service.importDrive(
        c.req.param('spaceId'),
        b.dotId,
        b.fileId,
        b.requestId,
        b.threadId,
      ),
    );
  });
  app.post('/spaces/:spaceId/files/:id/refresh', async (c) =>
    c.json(await service.refresh(c.req.param('spaceId'), c.req.param('id'))),
  );
  app.get('/spaces/:spaceId/files/:id/download', async (c) => {
    const f = await service.download(c.req.param('spaceId'), c.req.param('id'));
    c.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(f.name).replace(/'/g, '%27')}`,
    );
    c.header('Content-Type', 'application/octet-stream');
    return c.body(new Uint8Array(f.data));
  });
  app.onError((e, c) =>
    c.json(
      {
        error:
          e instanceof z.ZodError
            ? 'Invalid file or storage settings.'
            : e.message,
      },
      400,
    ),
  );
  return app;
}
export function driveCallbackRoutes(service: FileService) {
  const app = new Hono();
  app.get('/google/callback', async (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'",
    );
    const state = c.req.query('state') ?? '';
    if (!/^[a-f0-9]{64}$/.test(state))
      return c.text(
        'Invalid Google connection state. Start again in OpenDots Space storage.',
        400,
      );
    const key = 'opendots-drive-' + state.slice(0, 16),
      cookie = getCookie(c, key);
    deleteCookie(c, key, { path: '/storage/google/callback' });
    if (!cookie)
      return c.text(
        'Google connection expired or belongs to another browser. Start again in OpenDots Space storage.',
        400,
      );
    if (c.req.query('error'))
      return c.text(
        'Google connection was not completed. Return to OpenDots Space storage to retry.',
        400,
      );
    try {
      const space = await service.drive.callback(
        state,
        cookie,
        c.req.query('code') ?? '',
      );
      return c.redirect('/#/spaces/' + encodeURIComponent(space));
    } catch {
      return c.text(
        'Google Drive connection could not finish. Return to OpenDots Space storage and retry. Check the Google app credentials, Drive API and requested permission.',
        400,
      );
    }
  });
  return app;
}
