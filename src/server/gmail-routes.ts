import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import type { GmailService } from './gmail.js';
const cookiePath = '/email/google/callback';
export function gmailRoutes(gmail: GmailService) {
  const app = new Hono();
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof z.ZodError
            ? 'Enter a valid mailbox address.'
            : error.message,
      },
      400,
    ),
  );
  app.get('/dots/:id/email', (c) => c.json(gmail.status(c.req.param('id'))));
  app.post('/dots/:id/email/connect', async (c) => {
    const input = z
      .object({ email: z.email().max(254) })
      .strict()
      .parse(await c.req.json());
    const { url, state, browser } = gmail.begin(c.req.param('id'), input.email);
    setCookie(c, 'opendots-mail-' + state.slice(0, 16), browser, {
      httpOnly: true,
      secure: gmail.redirectUri.startsWith('https:'),
      sameSite: 'Lax',
      path: cookiePath,
      maxAge: 600,
    });
    return c.json({ url });
  });
  return app;
}
export function gmailCallbackRoutes(gmail: GmailService) {
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
        'Invalid email sign-in. Start again in the agent’s settings.',
        400,
      );
    const key = 'opendots-mail-' + state.slice(0, 16),
      cookie = getCookie(c, key);
    deleteCookie(c, key, { path: cookiePath });
    if (!cookie || c.req.query('error'))
      return c.text(
        'Email sign-in was not completed. Return to the agent’s settings to retry.',
        400,
      );
    try {
      await gmail.callback(state, cookie, c.req.query('code') ?? '');
      return c.redirect('/#/?email=connected');
    } catch {
      return c.text(
        'Could not connect Gmail. Select the exact mailbox entered in the agent settings and grant both email permissions. Check Gmail API and the callback address in Google Cloud, then retry.',
        400,
      );
    }
  });
  return app;
}
