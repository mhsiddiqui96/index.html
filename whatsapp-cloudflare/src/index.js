// WA Business SaaS on Cloudflare Workers: API + Meta webhook; everything else is served from ./public.
import { ensureSchema, makeDb } from './db.js';
import { handleApi } from './api.js';
import { handleWebhook } from './webhook.js';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    let response;
    if (pathname.startsWith('/api/') || pathname === '/webhook' || pathname.startsWith('/webhook/')) {
      await ensureSchema(env);
      const db = makeDb(env);
      response = pathname.startsWith('/api/')
        ? await handleApi(request, env, ctx, db)
        : await handleWebhook(request, env, ctx, db);
    } else {
      response = await env.ASSETS.fetch(request);
    }
    response = new Response(response.body, response);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) response.headers.set(k, v);
    return response;
  },
};
