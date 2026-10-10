// Minimal Telegram Bot API client for owner alerts.
function enabled() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function sendTelegram(text) {
  if (!enabled()) return { skipped: 'telegram not configured' };
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: String(text).slice(0, 4000), disable_web_page_preview: false }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`Telegram ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  console.log('[sent] telegram -> owner');
  return data;
}

module.exports = { sendTelegram, telegramEnabled: enabled };
