// Minimal WhatsApp Cloud API client (uses Node's built-in fetch, Node >= 18).
const env = () => process.env;

function isDryRun() {
  const e = env();
  return e.DRY_RUN === '1' || e.DRY_RUN === 'true' || !e.WHATSAPP_TOKEN || !e.WHATSAPP_PHONE_NUMBER_ID;
}

async function graphPost(body) {
  const e = env();
  const url = `https://graph.facebook.com/${e.GRAPH_API_VERSION || 'v21.0'}/${e.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${e.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`WhatsApp API ${res.status}: ${JSON.stringify(data.error || data)}`);
    err.code = data.error && data.error.code;
    throw err;
  }
  return data;
}

// template = { name, params: [..] } (optional fallback)
async function sendText(to, text, template) {
  if (!to) return { skipped: 'no recipient' };
  if (isDryRun()) {
    console.log(`\n[DRY_RUN] WhatsApp -> ${to}${template && template.name ? ` (template fallback: ${template.name})` : ''}\n${text}\n`);
    return { dryRun: true };
  }
  try {
    const r = await graphPost({ to, type: 'text', text: { body: text, preview_url: true } });
    console.log(`[sent] text -> ${to}`);
    return r;
  } catch (err) {
    console.error(`[text failed] ${err.message}`);
    if (template && template.name) {
      const r = await graphPost({
        to,
        type: 'template',
        template: {
          name: template.name,
          language: { code: env().WHATSAPP_TEMPLATE_LANG || 'en' },
          components: [{ type: 'body', parameters: template.params.map((t) => ({ type: 'text', text: String(t || '-').replace(/\s+/g, ' ').slice(0, 1000) })) }],
        },
      });
      console.log(`[sent] template ${template.name} -> ${to}`);
      return r;
    }
    throw err;
  }
}

async function sendTemplate(to, name, params, headerImageUrl) {
  if (!to || !name) return { skipped: 'missing recipient or template' };
  if (isDryRun()) {
    console.log(`[DRY_RUN] template ${name} -> ${to} params=${JSON.stringify(params)}`);
    return { dryRun: true };
  }
  const r = await graphPost({
    to,
    type: 'template',
    template: {
      name,
      language: { code: env().WHATSAPP_TEMPLATE_LANG || 'en' },
      components: [
        ...(headerImageUrl ? [{ type: 'header', parameters: [{ type: 'image', image: { link: headerImageUrl } }] }] : []),
        { type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t || '-').replace(/\s+/g, ' ').slice(0, 1000) })) },
      ],
    },
  });
  console.log(`[sent] template ${name} -> ${to}`);
  return r;
}

async function sendImage(to, link, caption) {
  if (!to || !link) return { skipped: 'missing recipient or image' };
  if (isDryRun()) { console.log(`[DRY_RUN] image -> ${to} ${link}`); return { dryRun: true }; }
  const r = await graphPost({ to, type: 'image', image: { link, caption: String(caption || '').slice(0, 900) } });
  console.log(`[sent] image -> ${to}`);
  return r;
}

module.exports = { sendText, sendTemplate, sendImage, isDryRun };
