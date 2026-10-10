const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cfg = require('./config');
const { parseEvent, normalizePhone } = require('./detect');
const { sendText, isDryRun } = require('./whatsapp');

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

app.get('/', (_req, res) => res.json({ ok: true, service: 'alamco-webhook', dryRun: isDryRun() }));

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

function buildOwnerMessage(ev) {
  const lines = [];
  if (ev.type === 'instruction') {
    lines.push('📝 പുതിയ Special Instruction / New client instruction');
  } else if (ev.type === 'new_brief') {
    lines.push('🆕 പുതിയ Entry വന്നു / New brief on Alamco Studio');
  } else if (ev.status) {
    lines.push('🔄 സ്റ്റാറ്റസ് മാറ്റം / Status update on Alamco Studio');
  } else {
    lines.push('ℹ️ Alamco Studio update (unrecognised format)');
  }
  if (ev.clientName) lines.push(`Client / ക്ലയന്റ്: ${ev.clientName}`);
  if (ev.phone) lines.push(`Phone: +${ev.phone}`);
  if (ev.briefId) lines.push(`Brief ID: ${ev.briefId}`);
  if (ev.type === 'new_brief') {
    if (ev.plot) lines.push(`Plot/Location: ${ev.plot}`);
    if (ev.area) lines.push(`Area: ${ev.area}`);
  }
  if (ev.status && ev.type !== 'instruction') lines.push(`Status: ${String(ev.status).replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase())}`);
  if (ev.type === 'instruction') lines.push(`Instruction / നിർദ്ദേശം: ${ev.instruction}`);
  if (ev.trackUrl) lines.push(`Track: ${ev.trackUrl}`);
  if (ev.type === 'instruction') lines.push('Reply "ok" to accept / സ്വീകരിക്കാൻ "ok" അയക്കുക');
  return lines.join('\n');
}

function ownerTemplate(ev) {
  const e = process.env;
  if (ev.type === 'new_brief' && e.WHATSAPP_TEMPLATE_NEW_BRIEF) {
    return { name: e.WHATSAPP_TEMPLATE_NEW_BRIEF, params: [ev.clientName, ev.phone && '+' + ev.phone, ev.briefId, ev.trackUrl] };
  }
  if (ev.type === 'instruction' && e.WHATSAPP_TEMPLATE_INSTRUCTION) {
    return { name: e.WHATSAPP_TEMPLATE_INSTRUCTION, params: [ev.clientName, ev.phone && '+' + ev.phone, ev.briefId, ev.instruction, ev.trackUrl] };
  }
  return undefined;
}

async function handlePlatformEvent(payload) {
  const ev = parseEvent(payload, { siteUrl: siteUrl(), cc: cc() });
  try { console.log('[payload] ' + JSON.stringify(payload).slice(0, 2000)); } catch (_) {}
  console.log(`[event] type=${ev.type} briefId=${ev.briefId || '-'} name=${ev.clientName || '-'}`);
  logLine('events.jsonl', { parsed: ev });
  const o = owner();
  if (o) {
    await sendText(o, buildOwnerMessage(ev), ownerTemplate(ev)).catch((e) => console.error('owner alert failed:', e.message));
  } else {
    console.warn('OWNER_WHATSAPP not set; no owner alert sent');
  }
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
      if (o) await sendText(o, `💬 Client message from +${from}:\n${text || '(non-text message)'}`).catch((e) => console.error(e.message));
    }
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`alamco-webhook listening on :${port} | dryRun=${isDryRun()} | owner=${owner() || 'NOT SET'}`);
});
