// Broadcasts: one message to many labelled contacts, sent in small batches so each Worker invocation stays
// inside the Free plan limits (50 subrequests). A cron trigger drains due broadcasts every minute; an open
// report page also nudges sending along. Recipients are fixed when the broadcast is created.
import * as wa from './whatsapp.js';

const WINDOW_MS = 24 * 3600 * 1000;
export const BATCH = 15;            // messages per invocation (each is one Graph API call)
const STALE_CLAIM_MS = 5 * 60e3;    // a batch that never finished (Worker killed) is reported, not resent

// Contact names are filled into {{1}}, {{নাম}} etc. Missing names use the fallback ("অভিভাবক").
export function renderFor(broadcast, recipientName) {
  const name = recipientName || broadcast.name_fallback || '';
  const params = JSON.parse(broadcast.params || '[]').map((p) => (p.type === 'name' ? name : p.value || ''));
  let body = broadcast.body;
  if (broadcast.kind === 'template') params.forEach((v, i) => { body = body.split(`{{${i + 1}}}`).join(v); });
  else body = body.split('{{নাম}}').join(name).split('{{name}}').join(name);
  return { params, body };
}

// Who a broadcast would reach. Skips people who said STOP and, for plain text, anyone outside the 24h window.
export function audienceSql({ workspaceId, numberId, labelIds, kind, now }) {
  const params = [workspaceId, numberId];
  let labelFilter = '';
  if (labelIds.length) {
    labelFilter = `AND EXISTS (SELECT 1 FROM conversation_labels cl WHERE cl.conversation_id = c.id AND cl.label_id IN (${labelIds.map(() => '?').join(',')}))`;
    params.push(...labelIds);
  }
  const windowLimit = now - WINDOW_MS;
  const status = `CASE WHEN ct.opted_out = 1 THEN 'skipped'
    ${kind === 'text' ? `WHEN c.last_inbound_ms IS NULL OR c.last_inbound_ms < ${windowLimit} THEN 'skipped'` : ''}
    ELSE 'pending' END`;
  const reason = `CASE WHEN ct.opted_out = 1 THEN 'ব্রডকাস্ট বন্ধ করেছেন (STOP)'
    ${kind === 'text' ? `WHEN c.last_inbound_ms IS NULL OR c.last_inbound_ms < ${windowLimit} THEN '২৪ ঘণ্টার মধ্যে মেসেজ দেননি — টেমপ্লেট লাগবে'` : ''}
    ELSE NULL END`;
  const from = `FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
    WHERE c.workspace_id = ? AND c.number_id = ? ${labelFilter}`;
  return { from, params, status, reason };
}

export async function previewAudience(db, opts) {
  const { from, params, status } = audienceSql(opts);
  const rows = await db.all(`SELECT ${status} AS st, ct.opted_out AS opted_out, COUNT(*) AS n ${from} GROUP BY st, opted_out`, ...params);
  const out = { total: 0, eligible: 0, opted_out: 0, outside_window: 0 };
  for (const r of rows) {
    out.total += r.n;
    if (r.st === 'pending') out.eligible += r.n;
    else if (r.opted_out) out.opted_out += r.n;
    else out.outside_window += r.n;
  }
  return out;
}

export async function createRecipients(db, broadcastId, opts) {
  const { from, params, status, reason } = audienceSql(opts);
  await db.run(`INSERT INTO broadcast_recipients (broadcast_id, conversation_id, wa_id, name, status, error)
    SELECT ?, c.id, ct.wa_id, ct.name, ${status}, ${reason} ${from}`, broadcastId, ...params);
}

// Send the next batch of one broadcast. Returns how many sends were attempted.
export async function processBroadcast(env, db, broadcastId, limit = BATCH) {
  const now = Date.now();
  const bc = await db.first('SELECT * FROM broadcasts WHERE id = ?', broadcastId);
  if (!bc || !['scheduled', 'sending'].includes(bc.status) || bc.scheduled_ms > now) return 0;

  // Atomically claim a batch, so the cron job and an open report page never send the same message twice.
  const claimed = (await db.batch([
    db.prep(`UPDATE broadcast_recipients SET status = 'failed', error = 'পাঠানো নিশ্চিত হয়নি (সময় শেষ)'
      WHERE broadcast_id = ? AND status = 'sending' AND claimed_ms < ?`, bc.id, now - STALE_CLAIM_MS),
    db.prep(`UPDATE broadcast_recipients SET status = 'sending', claimed_ms = ? WHERE id IN
      (SELECT id FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'pending' ORDER BY id LIMIT ?)
      RETURNING id, conversation_id, wa_id, name`, now, bc.id, limit),
    db.prep(`UPDATE broadcasts SET status = 'sending', started_ms = COALESCE(started_ms, ?) WHERE id = ?`, now, bc.id),
  ]))[1].results || [];

  if (claimed.length) {
    const number = await db.first('SELECT * FROM numbers WHERE id = ?', bc.number_id);
    const header = bc.header ? JSON.parse(bc.header) : null;
    const results = [];
    let throttled = false;
    for (const r of claimed) {
      if (throttled) { results.push({ r, retry: true }); continue; }
      const { params, body } = renderFor(bc, r.name);
      try {
        const waMessageId = bc.kind === 'template'
          ? await wa.sendTemplate(env, db, number, r.wa_id, bc.template_name, bc.template_language, params, header)
          : await wa.sendText(env, db, number, r.wa_id, body);
        results.push({ r, waMessageId, body });
      } catch (err) {
        if (err instanceof wa.WhatsAppError && wa.RATE_LIMIT_CODES.has(err.code)) {
          throttled = true; // Meta asked us to slow down: put the rest back for the next run
          results.push({ r, retry: true });
        } else {
          results.push({ r, error: err.message || 'পাঠানো যায়নি' });
        }
      }
    }
    const t = Date.now();
    const stmts = [];
    for (const x of results) {
      if (x.retry) {
        stmts.push(db.prep("UPDATE broadcast_recipients SET status = 'pending', claimed_ms = NULL WHERE id = ?", x.r.id));
      } else if (x.error) {
        stmts.push(db.prep("UPDATE broadcast_recipients SET status = 'failed', error = ? WHERE id = ?", x.error, x.r.id));
      } else {
        stmts.push(
          db.prep("UPDATE broadcast_recipients SET status = 'sent', wa_message_id = ?, sent_ms = ? WHERE id = ?", x.waMessageId, t, x.r.id),
          // Keep a copy in the chat so the team sees what was sent. The chat is not moved to the top of the inbox.
          db.prep(`INSERT INTO messages (workspace_id, conversation_id, direction, type, body, wa_message_id, status, sent_by, created_ms, updated_ms)
            VALUES (?, ?, 'out', ?, ?, ?, 'sent', ?, ?, ?)`, bc.workspace_id, x.r.conversation_id,
          bc.kind === 'template' ? 'template' : 'text', `📢 ${x.body}`, x.waMessageId, bc.created_by, t, t),
          db.prep('UPDATE conversations SET updated_ms = ? WHERE id = ?', t, x.r.conversation_id),
        );
      }
    }
    if (stmts.length) await db.batch(stmts);
  }

  const left = await db.first(`SELECT COUNT(*) AS n FROM broadcast_recipients WHERE broadcast_id = ? AND status IN ('pending','sending')`, bc.id);
  if (!left.n) await db.run(`UPDATE broadcasts SET status = 'done', finished_ms = ? WHERE id = ? AND status = 'sending'`, Date.now(), bc.id);
  return claimed.length;
}

// Cron entry point: work through due broadcasts, oldest first, within one invocation's budget.
export async function processDue(env, db) {
  const due = await db.all(`SELECT id FROM broadcasts WHERE status IN ('scheduled','sending') AND scheduled_ms <= ? ORDER BY scheduled_ms LIMIT 3`, Date.now());
  let budget = BATCH;
  for (const { id } of due) {
    if (budget <= 0) break;
    budget -= await processBroadcast(env, db, id, budget);
  }
}

export async function report(db, broadcastId) {
  const counts = await db.first(`
    SELECT COUNT(*) AS total,
      SUM(r.status = 'pending' OR r.status = 'sending') AS pending,
      SUM(r.status = 'sent') AS sent,
      SUM(r.status = 'failed') AS failed,
      SUM(r.status = 'skipped') AS skipped,
      SUM(m.status IN ('delivered','read')) AS delivered,
      SUM(m.status = 'read') AS read,
      SUM(r.status = 'sent' AND c.last_inbound_ms > r.sent_ms) AS replied
    FROM broadcast_recipients r
    LEFT JOIN messages m ON m.wa_message_id = r.wa_message_id
    LEFT JOIN conversations c ON c.id = r.conversation_id
    WHERE r.broadcast_id = ?`, broadcastId);
  for (const k of Object.keys(counts)) counts[k] = counts[k] || 0;
  return counts;
}

// ---- STOP / START keywords from customers ----
const STOP = /^\s*(stop|unsubscribe|বন্ধ|বন্ধ করুন|আর পাঠাবেন না)\s*[.!।]?\s*$/i;
const START = /^\s*(start|subscribe|চালু|চালু করুন)\s*[.!।]?\s*$/i;

export async function handleOptKeywords(env, db, numberRow, waId, text) {
  if (!text) return;
  const stop = STOP.test(text);
  if (!stop && !START.test(text)) return;
  await db.run('UPDATE contacts SET opted_out = ? WHERE workspace_id = ? AND wa_id = ?', stop ? 1 : 0, numberRow.workspace_id, waId);
  const reply = stop
    ? 'আপনাকে আর ব্রডকাস্ট মেসেজ পাঠানো হবে না। আবার পেতে চাইলে START লিখুন।'
    : 'আপনাকে আবার ব্রডকাস্ট মেসেজ পাঠানো হবে। বন্ধ করতে STOP লিখুন।';
  await wa.sendText(env, db, numberRow, waId, reply).catch(() => {});
}

// ---- Import contacts (phone numbers) ----
// Accepts Bangladeshi local formats: 01712345678 -> 8801712345678, 1712345678 -> 8801712345678.
export function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('01')) d = '88' + d;
  else if (d.length === 10 && d.startsWith('1')) d = '880' + d;
  return d.length >= 8 && d.length <= 15 ? d : null;
}

export const IMPORT_CHUNK = 90; // stays under D1's 100 bound parameters per statement

export async function importContacts(db, { workspaceId, numberId, labelIds, contacts }) {
  const seen = new Map();
  const invalid = [];
  for (const c of contacts.slice(0, IMPORT_CHUNK)) {
    const phone = normalizePhone(c.phone);
    if (!phone) { invalid.push(String(c.phone || '').slice(0, 30)); continue; }
    seen.set(phone, (typeof c.name === 'string' ? c.name.trim().slice(0, 120) : '') || seen.get(phone) || null);
  }
  const phones = [...seen.keys()];
  if (!phones.length) return { imported: 0, invalid };
  const now = Date.now();
  const marks = phones.map(() => '?').join(',');
  await db.batch([
    ...phones.map((p) => db.prep(`INSERT INTO contacts (workspace_id, wa_id, name, created_ms) VALUES (?, ?, ?, ?)
      ON CONFLICT (workspace_id, wa_id) DO UPDATE SET name = COALESCE(excluded.name, contacts.name)`, workspaceId, p, seen.get(p), now)),
    db.prep(`INSERT INTO conversations (workspace_id, number_id, contact_id, created_ms, updated_ms)
      SELECT ?, ?, id, ?, ? FROM contacts WHERE workspace_id = ? AND wa_id IN (${marks})
      ON CONFLICT (number_id, contact_id) DO NOTHING`, workspaceId, numberId, now, now, workspaceId, ...phones),
    ...labelIds.map((labelId) => db.prep(`INSERT OR IGNORE INTO conversation_labels (conversation_id, label_id)
      SELECT c.id, ? FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.number_id = ? AND ct.workspace_id = ? AND ct.wa_id IN (${marks})`, labelId, numberId, workspaceId, ...phones)),
  ]);
  return { imported: phones.length, invalid };
}
