// Meta WhatsApp Cloud API webhook. One URL serves every workspace; messages are routed by phone_number_id.
import { decrypt, verifyMetaSignature } from './crypto.js';
import { storeInbound, updateStatus, conversationView } from './inbox.js';
import { notifyInbound } from './push.js';
import { handleOptKeywords } from './broadcast.js';

export async function handleWebhook(request, env, ctx, db) {
  const url = new URL(request.url);
  if (request.method === 'GET') {
    // Verification handshake when the webhook is saved in the Meta App Dashboard.
    const token = url.searchParams.get('hub.verify_token');
    // One verify token per workspace; it is the same for all of the workspace's numbers.
    if (url.searchParams.get('hub.mode') === 'subscribe' && token &&
        await db.first('SELECT 1 FROM workspaces WHERE wa_verify_token = ?', token)) {
      return new Response(url.searchParams.get('hub.challenge') || '', { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const raw = await request.text();
  let payload;
  try { payload = JSON.parse(raw); } catch { return new Response('Bad request', { status: 400 }); }
  const signature = request.headers.get('x-hub-signature-256');
  // Acknowledge immediately (Meta retries slow webhooks); process in the background.
  ctx.waitUntil(processPayload(db, payload, raw, signature, url.origin, env).catch((err) => console.error('webhook failed', err)));
  return new Response('OK', { status: 200 });
}

function extractBody(msg) {
  switch (msg.type) {
    case 'text': return { body: msg.text?.body };
    case 'image': case 'video': case 'document': case 'sticker': case 'audio': {
      const media = msg[msg.type] || {};
      return { body: media.caption || media.filename || null, mediaId: media.id };
    }
    case 'button': return { body: msg.button?.text };
    case 'interactive': {
      const i = msg.interactive || {};
      return { body: i.button_reply?.title || i.list_reply?.title || '[interactive]' };
    }
    case 'location': {
      const l = msg.location || {};
      return { body: `📍 ${l.name || ''} ${l.address || ''} (${l.latitude}, ${l.longitude})`.trim() };
    }
    case 'reaction': return { body: `${msg.reaction?.emoji || ''} (reaction)` };
    case 'contacts': return { body: (msg.contacts || []).map((c) => c.name?.formatted_name).join(', ') };
    default: return { body: `[${msg.type} message]` };
  }
}

export async function processPayload(db, payload, raw, signature, origin, env = {}) {
  const checked = new Map(); // number id -> signature ok (each number may belong to a different Meta app)
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id;
      const num = phoneNumberId && await db.first('SELECT id, workspace_id, wa_app_secret FROM numbers WHERE wa_phone_number_id = ?', phoneNumberId);
      if (!num) { console.warn(`no number for phone_number_id ${phoneNumberId}`); continue; }
      if (!checked.has(num.id)) {
        const secret = await decrypt(db, num.wa_app_secret);
        checked.set(num.id, !secret || await verifyMetaSignature(raw, signature, secret));
      }
      if (!checked.get(num.id)) { console.warn(`bad signature for number ${num.id}`); continue; }

      const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const msg of value.messages || []) {
        const { body, mediaId } = extractBody(msg);
        const stored = await storeInbound(db, num.workspace_id, num.id, {
          waId: msg.from, name: names[msg.from], waMessageId: msg.id,
          type: msg.type, body, mediaId, timestampMs: Number(msg.timestamp) * 1000,
        });
        if (stored) {
          await notifyInbound(db, await conversationView(db, stored.convId), body || `[${msg.type}]`, origin)
            .catch((err) => console.error('push failed', err));
          // "STOP" / "বন্ধ" turns broadcasts off for this contact, "START" back on.
          if (msg.type === 'text') {
            await handleOptKeywords(env, db, await db.first('SELECT * FROM numbers WHERE id = ?', num.id), msg.from, body)
              .catch((err) => console.error('opt-out failed', err));
          }
        }
      }
      for (const st of value.statuses || []) {
        const err = st.errors?.[0];
        await updateStatus(db, num.workspace_id, st.id, st.status, err ? `${err.code}: ${err.title || err.message}` : null);
      }
    }
  }
}
