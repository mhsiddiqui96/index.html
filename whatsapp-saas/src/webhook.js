'use strict';
// Meta WhatsApp Cloud API webhook. One URL serves every workspace; messages are routed by phone_number_id.
const express = require('express');
const { get } = require('./db');
const { verifyMetaSignature } = require('./security');
const inbox = require('./inbox');

const router = express.Router();

// Verification handshake when you save the webhook URL in the Meta App Dashboard.
router.get('/', (req, res) => {
  const expected = process.env.WEBHOOK_VERIFY_TOKEN;
  if (req.query['hub.mode'] === 'subscribe' && expected && req.query['hub.verify_token'] === expected) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

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

function processPayload(payload) {
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id;
      const workspace = phoneNumberId && get('SELECT id FROM workspaces WHERE wa_phone_number_id = ?', phoneNumberId);
      if (!workspace) {
        console.warn(`[webhook] no workspace for phone_number_id ${phoneNumberId}`);
        continue;
      }
      const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const msg of value.messages || []) {
        const { body, mediaId } = extractBody(msg);
        inbox.storeInbound(workspace.id, {
          waId: msg.from, name: names[msg.from], waMessageId: msg.id,
          type: msg.type, body, mediaId, timestamp: Number(msg.timestamp),
        });
      }
      for (const st of value.statuses || []) {
        const err = st.errors?.[0];
        inbox.updateStatus(workspace.id, st.id, st.status, err ? `${err.code}: ${err.title || err.message}` : null);
      }
    }
  }
}

router.post('/', (req, res) => {
  const appSecret = process.env.META_APP_SECRET;
  if (appSecret && !verifyMetaSignature(req.rawBody || Buffer.alloc(0), req.get('x-hub-signature-256'), appSecret)) {
    return res.sendStatus(401);
  }
  // Acknowledge fast; Meta retries if we take too long.
  res.sendStatus(200);
  try {
    processPayload(req.body || {});
  } catch (err) {
    console.error('[webhook] processing failed', err);
  }
});

module.exports = { router, processPayload };
