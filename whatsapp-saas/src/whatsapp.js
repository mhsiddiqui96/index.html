'use strict';
// Thin client for the official WhatsApp Business Cloud API (Meta Graph API).
const { decrypt } = require('./security');

const GRAPH_VERSION = process.env.GRAPH_API_VERSION || 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

class WhatsAppError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function credentials(workspace) {
  const token = decrypt(workspace.wa_access_token);
  if (!token || !workspace.wa_phone_number_id) {
    throw new WhatsAppError('WhatsApp এখনো কানেক্ট করা হয়নি। Settings থেকে Phone Number ID ও Access Token দিন।', 400);
  }
  return { token, phoneNumberId: workspace.wa_phone_number_id };
}

async function graph(token, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${GRAPH_BASE}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.error_user_msg || data?.error?.message || `Graph API error (${res.status})`;
    throw new WhatsAppError(msg, res.status, data?.error);
  }
  return data;
}

async function sendMessage(workspace, payload) {
  const { token, phoneNumberId } = credentials(workspace);
  const data = await graph(token, `${phoneNumberId}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', ...payload },
  });
  return data?.messages?.[0]?.id || null;
}

function sendText(workspace, to, text) {
  return sendMessage(workspace, { to, type: 'text', text: { preview_url: true, body: text } });
}

function sendTemplate(workspace, to, name, language, bodyParams = []) {
  const template = { name, language: { code: language } };
  if (bodyParams.length) {
    template.components = [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text: String(text) })) }];
  }
  return sendMessage(workspace, { to, type: 'template', template });
}

async function markRead(workspace, waMessageId) {
  const { token, phoneNumberId } = credentials(workspace);
  await graph(token, `${phoneNumberId}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', status: 'read', message_id: waMessageId },
  });
}

async function listTemplates(workspace) {
  const { token } = credentials(workspace);
  if (!workspace.wa_business_account_id) {
    throw new WhatsAppError('টেমপ্লেট দেখতে Settings এ WhatsApp Business Account ID দিন।', 400);
  }
  const data = await graph(token,
    `${workspace.wa_business_account_id}/message_templates?limit=200&fields=name,language,status,category,components`);
  return data.data || [];
}

async function getPhoneInfo(workspace) {
  const { token, phoneNumberId } = credentials(workspace);
  return graph(token, `${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`);
}

// Returns a fetch Response streaming the media binary.
async function downloadMedia(workspace, mediaId) {
  const { token } = credentials(workspace);
  const meta = await graph(token, encodeURIComponent(mediaId));
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new WhatsAppError('মিডিয়া ডাউনলোড করা যায়নি', res.status);
  return { res, mimeType: meta.mime_type };
}

module.exports = { sendText, sendTemplate, markRead, listTemplates, getPhoneInfo, downloadMedia, WhatsAppError };
