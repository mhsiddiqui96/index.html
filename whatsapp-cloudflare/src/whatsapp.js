// Thin client for the official WhatsApp Business Cloud API (Meta Graph API).
import { decrypt } from './crypto.js';

export class WhatsAppError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code; // Meta error code, e.g. 130429 = too many messages right now
  }
}

// Meta is asking us to slow down: try again later instead of marking the message failed.
export const RATE_LIMIT_CODES = new Set([130429, 131048, 131056, 80007]);

const base = (env) => env.GRAPH_BASE_URL || `https://graph.facebook.com/${env.GRAPH_API_VERSION || 'v21.0'}`;

async function credentials(env, db, ws) {
  const token = await decrypt(db, ws.wa_access_token);
  if (!token || !ws.wa_phone_number_id) {
    throw new WhatsAppError('WhatsApp এখনো কানেক্ট করা হয়নি। সেটিংস থেকে Phone Number ID ও Access Token দিন।', 400);
  }
  return { token, phoneNumberId: ws.wa_phone_number_id };
}

async function graph(env, token, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${base(env)}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data?.error || {};
    let msg = err.error_user_msg || err.message || `Graph API error (${res.status})`;
    if (err.code === 190) msg = 'Access Token-এর মেয়াদ শেষ বা ভুল। সেটিংস থেকে নতুন টোকেন দিন।';
    if (err.code === 131030) msg = 'এই নাম্বারে পাঠানো যাবে না: টেস্ট নাম্বার ব্যবহার করলে Meta-তে প্রাপকের নাম্বারটি যোগ (allowed list) করুন।';
    if (err.code === 131047) msg = '২৪ ঘণ্টার বেশি আগে কথা হয়েছে — শুধু টেমপ্লেট পাঠানো যাবে।';
    if (RATE_LIMIT_CODES.has(err.code)) msg = 'Meta-র পাঠানোর সীমা ছুঁয়েছে — একটু পরে আবার চেষ্টা হবে।';
    throw new WhatsAppError(msg, res.status, err.code);
  }
  return data;
}

async function send(env, db, ws, payload) {
  const { token, phoneNumberId } = await credentials(env, db, ws);
  const data = await graph(env, token, `${phoneNumberId}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', ...payload },
  });
  return data?.messages?.[0]?.id || null;
}

export const sendText = (env, db, ws, to, text) =>
  send(env, db, ws, { to, type: 'text', text: { preview_url: true, body: text } });

// header: optional { type: 'image' | 'document' | 'video', link } for templates whose header is media.
export function sendTemplate(env, db, ws, to, name, language, params = [], header = null) {
  const template = { name, language: { code: language } };
  const components = [];
  if (header?.link) components.push({ type: 'header', parameters: [{ type: header.type, [header.type]: { link: header.link } }] });
  if (params.length) components.push({ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t) })) });
  if (components.length) template.components = components;
  return send(env, db, ws, { to, type: 'template', template });
}

export async function markRead(env, db, ws, waMessageId) {
  const { token, phoneNumberId } = await credentials(env, db, ws);
  await graph(env, token, `${phoneNumberId}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', status: 'read', message_id: waMessageId },
  });
}

export async function listTemplates(env, db, ws) {
  const { token } = await credentials(env, db, ws);
  if (!ws.wa_business_account_id) throw new WhatsAppError('টেমপ্লেট দেখতে সেটিংসে WhatsApp Business Account ID দিন।', 400);
  const data = await graph(env, token, `${ws.wa_business_account_id}/message_templates?limit=200&fields=name,language,status,category,components`);
  return data.data || [];
}

export async function getPhoneInfo(env, db, ws) {
  const { token, phoneNumberId } = await credentials(env, db, ws);
  return graph(env, token, `${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`);
}

export async function downloadMedia(env, db, ws, mediaId) {
  const { token } = await credentials(env, db, ws);
  const meta = await graph(env, token, encodeURIComponent(mediaId));
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new WhatsAppError('মিডিয়া ডাউনলোড করা যায়নি', res.status);
  return { body: res.body, mimeType: meta.mime_type };
}
