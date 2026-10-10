// Tolerant payload parsing: the real payload shape of the platform is unknown,
// so we search nested keys by normalised name.
const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

function findValue(obj, names, maxDepth = 4) {
  const wanted = names.map(norm);
  // breadth-first, so shallow keys win; earlier names in the list win at the same level
  let level = [obj];
  for (let d = 0; d <= maxDepth && level.length; d++) {
    const next = [];
    for (const name of wanted) {
      for (const o of level) {
        if (o && typeof o === 'object' && !Array.isArray(o)) {
          for (const k of Object.keys(o)) {
            if (norm(k) === name) {
              const v = o[k];
              if (v !== null && v !== undefined && typeof v !== 'object' && String(v).trim() !== '') {
                return String(v).trim();
              }
            }
          }
        }
      }
    }
    for (const o of level) {
      if (o && typeof o === 'object') {
        for (const v of Array.isArray(o) ? o : Object.values(o)) {
          if (v && typeof v === 'object') next.push(v);
        }
      }
    }
    level = next;
  }
  return '';
}

function normalizePhone(p, cc = '91') {
  let d = String(p || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = cc + d;
  return d;
}

function parseEvent(payload, { siteUrl = 'https://alamcostudio.com', cc = '91' } = {}) {
  const p = payload && typeof payload === 'object' ? payload : { raw: payload };
  const eventName = findValue(p, ['event', 'eventType', 'type', 'action', 'topic'], 1).toLowerCase();
  const briefId = findValue(p, ['briefId', 'brief_id', 'trackingId', 'trackId', 'reference', 'ref', 'id', 'code']);
  const instruction = findValue(p, [
    'specialInstruction', 'specialInstructions', 'special_instruction', 'instruction', 'instructions',
    'clientInstruction', 'clientNote', 'note', 'notes', 'comment', 'message', 'text', 'remarks',
  ]);
  const clientName = findValue(p, ['clientName', 'client_name', 'customerName', 'customer', 'name', 'fullName', 'client']);
  const phone = normalizePhone(findValue(p, ['phone', 'mobile', 'clientPhone', 'clientMobile', 'whatsapp', 'contact', 'phoneNumber']), cc);
  const area = findValue(p, ['area', 'builtUpArea', 'sqft', 'size']);
  const plot = findValue(p, ['plot', 'plotSize', 'plotArea', 'location', 'site']);
  const status = findValue(p, ['status', 'milestone', 'stage'], 2);

  let type;
  if (/instruction|note|comment|message/.test(eventName) || (instruction && !/new|creat|brief|entry|lead|enquir|inquir/.test(eventName))) {
    type = instruction ? 'instruction' : 'unknown';
  } else if (/new|creat|brief|entry|lead|enquir|inquir|export/.test(eventName) || briefId) {
    type = 'new_brief';
  } else {
    type = 'unknown';
  }
  // payload that carries both a brief and an instruction under a "new" event name stays new_brief
  const trackUrl = briefId ? `${siteUrl.replace(/\/$/, '')}/track/${encodeURIComponent(briefId)}` : '';
  return { type, eventName, briefId, clientName, phone, area, plot, instruction, status, trackUrl };
}

module.exports = { parseEvent, findValue, normalizePhone };
