const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cfg = require('./config');
const { parseEvent, normalizePhone } = require('./detect');
const { sendText, sendTemplate, sendImage, isDryRun } = require('./whatsapp');
const { sendTelegram, sendTelegramPhoto, telegramEnabled } = require('./telegram');

// Owner alerts go to BOTH WhatsApp and Telegram (each independent; one failing doesn't stop the other).
async function sendOwner(text, tpl) {
  const o = process.env.OWNER_WHATSAPP;
  const jobs = [];
  if (o) jobs.push(sendText(o, text, tpl).catch((e) => console.error('owner whatsapp failed:', e.message)));
  if (telegramEnabled()) jobs.push(sendTelegram(text).catch((e) => console.error('telegram failed:', e.message)));
  else console.warn('telegram not configured (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)');
  const r = await Promise.all(jobs);
  return r[0] || {};
}

const app = express();
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

function logLine(file, obj) {
  try {
    fs.appendFileSync(path.join(LOG_DIR, file), JSON.stringify({ at: new Date().toISOString(), ...obj }) + '\n');
  } catch (e) {
    console.error('log write failed', e.message);
  }
}

app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use((err, _req, res, next) => (err ? res.status(200).json({ ok: false, error: 'bad json' }) : next()));

const siteUrl = () => process.env.SITE_URL || 'https://alamcostudio.com';
const cc = () => process.env.DEFAULT_COUNTRY_CODE || '91';
const owner = () => normalizePhone(process.env.OWNER_WHATSAPP, cc());

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

app.get('/', (_req, res) => res.json({ ok: true, service: 'alamco-webhook', dryRun: isDryRun(), telegram: telegramEnabled() }));

// ---------- Platform -> us ----------
app.post('/alamco-webhook', (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const given = req.get('x-webhook-secret') || bearer || req.query.secret || '';
    if (!safeEqual(given, secret)) return res.status(401).json({ ok: false, error: 'bad secret' });
  }
  logLine('payloads.jsonl', { headers: { 'content-type': req.get('content-type') }, body: req.body });
  res.status(200).json({ ok: true }); // respond fast; work continues below
  handlePlatformEvent(req.body).catch((e) => console.error('handler error', e.message));
});

// Internal: lets the bots push a plain WhatsApp message to the owner (e.g. "plan ready").
app.post('/notify-owner', (req, res) => {
  const secret = process.env.NOTIFY_SECRET;
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!secret || !safeEqual(bearer || req.get('x-notify-secret') || '', secret)) return res.status(401).json({ ok: false });
  const text = String((req.body && req.body.text) || '').slice(0, 1500);
  const o = owner();
  if (!text || !o) return res.status(400).json({ ok: false, error: 'missing text or owner' });
  const b = req.body || {};
  const tpl = { name: process.env.WHATSAPP_TEMPLATE_UPDATE || 'brief_owner_update', params: [b.client || 'Client', b.briefId || '-', b.update || text.slice(0, 200), b.url || (b.briefId ? `${siteUrl()}/track/${b.briefId}` : siteUrl())] };
  sendOwner(text, tpl)
    .then((r) => res.json({ ok: true, dryRun: !!(r && r.dryRun) }))
    .catch((e) => res.status(502).json({ ok: false, error: e.message.slice(0, 300) }));
});

function buildOwnerMessage(ev) {
  const lines = [];
  if (ev.type === 'instruction') {
    lines.push('📝 New client instruction');
  } else if (ev.type === 'new_brief') {
    lines.push('🆕 New brief on Alamco Studio');
  } else if (ev.type === 'status' || ev.status) {
    lines.push('🔄 Status update on Alamco Studio');
  } else {
    lines.push('ℹ️ Alamco Studio update (unrecognised format)');
  }
  if (ev.clientName) lines.push(`Client: ${ev.clientName}`);
  if (ev.phone) lines.push(`Phone: +${ev.phone}`);
  if (ev.briefId) lines.push(`Brief ID: ${ev.briefId}`);
  if (ev.type === 'new_brief') {
    if (ev.plot) lines.push(`Plot: ${ev.plot}`);
    if (ev.area) lines.push(`Area: ${ev.area}`);
  }
  if (ev.status && ev.type !== 'instruction') lines.push(`Status: ${String(ev.status).replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase())}`);
  if (ev.type === 'instruction') lines.push(`Instruction: ${ev.instruction}`);
  if (ev.trackUrl) lines.push(`Track: ${ev.trackUrl}`);
  if (ev.type === 'instruction') lines.push('Reply "ok" to accept');
  return lines.join('\n');
}

function ownerTemplate(ev) {
  const e = process.env;
  const track = ev.trackUrl || (ev.briefId ? `${siteUrl()}/track/${ev.briefId}` : siteUrl());
  if (ev.type === 'new_brief') {
    return { name: e.WHATSAPP_TEMPLATE_NEW_BRIEF || 'brief_owner_new_entry', params: [ev.clientName, ev.phone && '+' + ev.phone, ev.briefId, track] };
  }
  const what = ev.type === 'instruction' ? `Client instruction: ${ev.instruction || ''}` : `Status: ${String(ev.status || 'updated').replace(/_/g, ' ')}`;
  return { name: e.WHATSAPP_TEMPLATE_UPDATE || 'brief_owner_update', params: [ev.clientName, ev.briefId, what, track] };
}

// Payment gate: the planner gets a brief only after staff confirm the planning charge in the Studio.
function paymentConfirmed(payload) {
  if (payload && payload.payment && payload.payment.paid_at) return true;
  let found = false;
  const walk = (o, depth, parent) => {
    if (found || !o || typeof o !== 'object' || depth > 6) return;
    for (const [k, v] of Object.entries(o)) {
      const key = String(k).toLowerCase();
      const val = typeof v === 'object' ? '' : String(v).toLowerCase();
      if (/payment|paid|fee|charge/.test(key + ' ' + (parent || '')) && /^(true|paid|received|confirmed|complete|completed|done|yes)$/.test(val)) found = true;
      if (/status|stage|milestone|event|type|state/.test(key) && /(payment|charge|fee).*(received|confirmed|paid|complete)|(received|confirmed|paid).*(payment|charge|fee)|^(work_?started|survey_?verified|draft_?ready)$/.test(val)) found = true;
      if (v && typeof v === 'object') walk(v, depth + 1, key);
    }
  };
  walk(payload, 0, '');
  return found;
}

const STATE_FILE = process.env.STATE_FILE || '/tmp/alamco-state.json';
let persisted = { forwarded: [], notified: [], alerts: {} };
try { persisted = { ...persisted, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch (_) {}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ forwarded: [...forwarded], notified: [...notified], alerts: persisted.alerts })); } catch (_) {}
}
const forwarded = new Set(persisted.forwarded);
async function forwardToPlanner(payload) {
  const url = process.env.FORWARD_WEBHOOK_URL;
  const key = process.env.FORWARD_WEBHOOK_KEY;
  if (!url || !payload || typeof payload !== 'object') return;
  if (process.env.FORWARD_REQUIRE_PAYMENT !== '0') {
    if (!paymentConfirmed(payload)) {
      console.log('[forward] held: planning charge not confirmed yet');
      return;
    }
    const id = String(payload.job_id || payload.jobId || payload.briefId || payload.id || '');
    if (id) {
      if (forwarded.has(id)) { console.log(`[forward] ${id} already forwarded`); return; }
      forwarded.add(id);
      saveState();
    }
  }
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(payload),
    });
    console.log(`[forward] planner routine -> HTTP ${r.status}`);
  } catch (e) {
    console.error('[forward] failed:', e.message);
  }
}

// Which app status sends which client template (only when CLIENT_NOTIFY=1 and templates are approved).
function clientTemplateFor(ev) {
  const st = String(ev.status || '').toLowerCase();
  if (/^work_?started$/.test(st)) return 'brief_work_started';
  if (/senior|plan_?ready|draft_?ready|ready_?for_?client|architect/.test(st)) return 'brief_plan_ready';
  if (/^sent_?to_?client$/.test(st)) return 'brief_sent_to_client';
  if (/^approved$/.test(st)) return 'brief_approved';
  return '';
}

const notified = new Set(persisted.notified);
async function notifyClient(ev, payload) {
  if (process.env.CLIENT_NOTIFY !== '1') return;
  const isTest = (payload && payload.test) || /test/i.test(ev.briefId || '');
  if (isTest || !ev.phone || ev.phone === owner()) return;
  const paidAt = payload && payload.payment && payload.payment.paid_at;
  const ru = payload && payload.payment && payload.payment.receipt_url;
  const receiptUrl = typeof ru === 'string' && /^https:\/\//.test(ru) ? ru : '';
  let name;
  if (ev.type === 'new_brief') name = 'brief_received';
  else if (paidAt && !notified.has(`${ev.briefId}:brief_payment_received`) && !notified.has(`${ev.briefId}:brief_payment_receipt`)) {
    // First time we see this brief as paid: send the payment message (it already says work has started).
    name = 'brief_payment_received';
    if (receiptUrl) { name = 'brief_payment_receipt'; notified.add(`${ev.briefId}:brief_payment_received`); }
    notified.add(`${ev.briefId}:brief_work_started`);
  } else name = clientTemplateFor(ev);
  if (!name) return;
  const key = `${ev.briefId}:${name}`;
  if (notified.has(key)) return;
  notified.add(key);
  saveState();
  try {
    await sendTemplate(ev.phone, name, [ev.clientName || 'Client', ev.trackUrl || (siteUrl() + '/track/' + ev.briefId)], name === 'brief_payment_receipt' ? receiptUrl : undefined);
    console.log(`[client] notified ${ev.phone} with ${name} for ${ev.briefId}`);
  } catch (e) {
    notified.delete(key);
    console.error('client notify failed:', e.message);
  }
}

// Mirror every platform event into the Office Desk board (best effort).
async function forwardToDesk(payload) {
  const url = process.env.DESK_INGEST_URL;
  const key = process.env.DESK_INGEST_SECRET;
  if (!url || !key || !payload || typeof payload !== 'object') return;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
    });
    console.log(`[desk] ingest -> HTTP ${r.status}`);
  } catch (e) {
    console.error('[desk] ingest failed:', e.message);
  }
}

// Until client templates are approved (CLIENT_NOTIFY off), push the payment receipt image to the owner to forward manually.
async function sendReceiptToOwner(ev, payload) {
  try {
    if (process.env.CLIENT_NOTIFY === '1') return;
    const pay = payload && payload.payment;
    const url = pay && typeof pay.receipt_url === 'string' && /^https:\/\//.test(pay.receipt_url) ? pay.receipt_url : '';
    if (!url || !pay.paid_at || !ev.briefId) return;
    // Only right after "Confirm payment": ignore later events (survey verified, drafts, etc.) that merely carry an old paid_at.
    const age = Date.now() - Date.parse(pay.paid_at);
    if (!Number.isFinite(age) || age > 10 * 60 * 1000) return;
    if ((payload && payload.test) || /test/i.test(ev.briefId)) return;
    const k = `${ev.briefId}|receipt-owner`;
    if (persisted.alerts[k]) return;
    persisted.alerts[k] = Date.now();
    saveState();
    const cap = `Payment receipt: ${ev.briefId} ${ev.clientName || ''}${ev.phone ? ' (' + ev.phone + ')' : ''}. Forward to the client.\nTrack current status: ${ev.trackUrl || (siteUrl() + '/track/' + ev.briefId)}`;
    const o = process.env.OWNER_WHATSAPP;
    if (o) await sendImage(o, url, cap).catch((e) => console.error('owner receipt whatsapp failed:', e.message));
    if (telegramEnabled()) await sendTelegramPhoto(url, cap).catch((e) => console.error('owner receipt telegram failed:', e.message));
  } catch (e) { console.error('receipt to owner failed:', e.message); }
}

async function handlePlatformEvent(payload) {
  forwardToDesk(payload);
  forwardToPlanner(payload);
  const ev = parseEvent(payload, { siteUrl: siteUrl(), cc: cc() });
  sendReceiptToOwner(ev, payload);
  try { console.log('[payload] ' + JSON.stringify(payload).slice(0, 2000)); } catch (_) {}
  console.log(`[event] type=${ev.type} briefId=${ev.briefId || '-'} name=${ev.clientName || '-'}`);
  logLine('events.jsonl', { parsed: ev });
  const o = owner();
  const alertKey = `${ev.briefId}|${ev.type}|${ev.status}|${(payload && payload.payment && payload.payment.paid_at) || ''}|${ev.instruction || ''}`;
  const lastAt = persisted.alerts[alertKey] || 0;
  const dupAlert = ev.briefId && Date.now() - lastAt < 10 * 60 * 1000;
  // A brief we already announced as new must not announce "new" again (e.g. after a revert).
  const newKey = `${ev.briefId}|announced-new`;
  const repeatNew = ev.type === 'new_brief' && ev.briefId && persisted.alerts[newKey];
  if (ev.type === 'new_brief' && ev.briefId && !persisted.alerts[newKey]) persisted.alerts[newKey] = Date.now();
  if (!dupAlert) { persisted.alerts[alertKey] = Date.now(); saveState(); }
  if (dupAlert || repeatNew) {
    console.log('[alert] duplicate or repeated new-brief, skipped');
  } else if (o) {
    await sendOwner(buildOwnerMessage(ev), ownerTemplate(ev)).catch((e) => console.error('owner alert failed:', e.message));
  } else {
    console.warn('OWNER_WHATSAPP not set; no owner alert sent');
  }
  notifyClient(ev, payload);
  if (ev.type === 'instruction' && ev.phone && cfg.rules.ackClientOnInstruction && ev.phone !== o) {
    await sendText(ev.phone, cfg.messages.instructionAck).catch((e) => console.error('client ack failed:', e.message));
  }
}

// ---------- Meta -> us (inbound WhatsApp) ----------
app.get('/whatsapp', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && process.env.WHATSAPP_VERIFY_TOKEN && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

const seen = new Set();
app.post('/whatsapp', (req, res) => {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (appSecret) {
    const sig = req.get('x-hub-signature-256') || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.rawBody || '').digest('hex');
    if (!safeEqual(sig, expected)) return res.sendStatus(401);
  }
  logLine('inbound.jsonl', { body: req.body });
  res.sendStatus(200);
  handleInbound(req.body).catch((e) => console.error('inbound error', e.message));
});

async function handleInbound(body) {
  const o = owner();
  const msgs = [];
  for (const entry of (body && body.entry) || []) {
    for (const change of entry.changes || []) {
      for (const m of (change.value && change.value.messages) || []) msgs.push(m);
    }
  }
  for (const m of msgs) {
    if (m.id) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      if (seen.size > 5000) seen.clear();
    }
    const from = normalizePhone(m.from, cc());
    const text = (m.text && m.text.body) || (m.button && m.button.text) || (m.interactive && ((m.interactive.button_reply || {}).title || (m.interactive.list_reply || {}).title)) || '';
    const clean = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
    const isOwner = o && from === o;
    console.log(`[inbound] from=${from} owner=${!!isOwner} text=${JSON.stringify(text)}`);
    if (isOwner) {
      if (cfg.rules.replyAcceptedToOwner && cfg.ownerAcceptWords.includes(clean)) {
        logLine('actions.jsonl', { action: 'owner_accepted', from, text });
        console.log('[action] owner accepted');
        await sendText(from, cfg.messages.ownerAcceptedReply).catch((e) => console.error(e.message));
      }
      // other owner messages: no auto reply (avoids noise/loops)
    } else if (cfg.rules.replyThankYouToClients) {
      logLine('actions.jsonl', { action: 'client_message', from, text });
      await sendText(from, cfg.messages.clientInboundReply).catch((e) => console.error(e.message));
      if (o) await sendOwner(`💬 Client message from +${from}:\n${text || '(non-text message)'}`).catch((e) => console.error(e.message));
    }
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`alamco-webhook listening on :${port} | dryRun=${isDryRun()} | owner=${owner() || 'NOT SET'}`);
});
