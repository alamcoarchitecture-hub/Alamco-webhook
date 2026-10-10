# Alamco Webhook (WhatsApp alerts + auto-reply)

A small Node.js (Express) service for https://alamcostudio.com.

What it does:
- Receives data from your platform at `POST /alamco-webhook`.
- Sends YOU a WhatsApp message when a **new brief/entry** arrives or a client adds a **special instruction**.
- Sends the CLIENT an automatic "Thank you, ലഭിച്ചു..." reply when an instruction includes their phone.
- Receives WhatsApp messages at `POST /whatsapp`: if you reply "ok / accept / accepted" it answers "Accepted."; any client message gets "Thank you".

## 1. Run locally (safe test, nothing is sent)

```
npm install
cp .env.example .env     # keep DRY_RUN=1
export $(grep -v '^#' .env | xargs)   # or just: DRY_RUN=1 npm start
npm start
```
In dry-run mode (DRY_RUN=1, or WhatsApp keys missing) messages are only printed in the console.

Test with curl (new brief):
```
curl -X POST http://localhost:3000/alamco-webhook \
  -H "Content-Type: application/json" \
  -d '{"event":"brief.created","brief":{"id":"ALM-20261009-004","clientName":"Rahul Menon","phone":"9847012345","plot":"10 cents, Kochi","area":"2400 sqft"}}'
```
Special instruction:
```
curl -X POST http://localhost:3000/alamco-webhook \
  -H "Content-Type: application/json" \
  -d '{"briefId":"ALM-20261009-004","clientName":"Rahul Menon","phone":"9847012345","instruction":"Please add a prayer room"}'
```
Inbound WhatsApp message (like Meta sends):
```
curl -X POST http://localhost:3000/whatsapp -H "Content-Type: application/json" \
  -d '{"entry":[{"changes":[{"value":{"messages":[{"id":"m1","from":"917012332006","type":"text","text":{"body":"ok"}}]}}]}]}'
```
(If you set WEBHOOK_SECRET, add `-H "X-Webhook-Secret: yoursecret"` to the first two.)

Every payload the platform sends is saved in `logs/payloads.jsonl`. Open it to see the real shape. If fields are missed, edit the name lists in `src/detect.js`.

## 2. Deploy (free options)

The service needs a public HTTPS address. Push this folder to a GitHub repo first.

**Render (easy):** New → Web Service → connect repo → Build `npm install` → Start `npm start` → Free plan. Add env vars (section 4). Your URL: `https://<name>.onrender.com`. (Free plan sleeps after idle; the first request can take ~50s. Meta retries, but for steady use pick a paid or always-on plan.) Logs on free disks are lost on restart; check Render's log screen too.

**Railway:** New Project → Deploy from GitHub → add Variables → Settings → Generate Domain. (Small free trial credit.)

**Vercel:** Not a good fit for this long-running Express server; use Render or Railway.

Check it works: open `https://<host>/` — you should see `{"ok":true,...}`.

## 3. Connect the platform

Add this secret/env var where alamcostudio.com is built (the Secrets screen):

```
ALAMCO_WEBHOOK_URL=https://<host>/alamco-webhook
```
If you use WEBHOOK_SECRET and the platform cannot send headers, use `https://<host>/alamco-webhook?secret=YOURSECRET` instead. Redeploy/restart the platform, then press **Export for ALAMCO Bot** on a brief.

Important: the Export button is manual. For automatic alerts on every new brief and every client instruction, the platform's code must POST to `ALAMCO_WEBHOOK_URL` at those moments (a few lines in the app's server code). Give the developer/builder this README and the curl examples.

## 4. Environment variables

| Name | Needed | Meaning |
|---|---|---|
| OWNER_WHATSAPP | yes | Your number, digits with country code, e.g. 917012332006 |
| WHATSAPP_TOKEN | for real sending | Meta access token |
| WHATSAPP_PHONE_NUMBER_ID | for real sending | Meta phone number ID |
| WHATSAPP_VERIFY_TOKEN | for inbound | Any secret word you choose; same one goes into Meta |
| DRY_RUN | no | 1 = print only |
| WEBHOOK_SECRET | no | Protects /alamco-webhook |
| WHATSAPP_APP_SECRET | no | Verifies Meta's signature on /whatsapp |
| SITE_URL | no | Default https://alamcostudio.com |
| DEFAULT_COUNTRY_CODE | no | Default 91 (added to 10-digit numbers) |
| WHATSAPP_TEMPLATE_NEW_BRIEF | no | Approved template name (fallback) |
| WHATSAPP_TEMPLATE_INSTRUCTION | no | Approved template name (fallback) |
| WHATSAPP_TEMPLATE_LANG | no | Template language code, default `en` |
| PORT, GRAPH_API_VERSION, LOG_DIR | no | Defaults 3000, v21.0, ./logs |

## 5. Get Meta WhatsApp Cloud API keys (step by step)

1. Go to https://developers.facebook.com → log in → **My Apps → Create App** → type **Business**.
2. In the app, **Add product → WhatsApp → Set up**. Link or create a Meta Business account.
3. **WhatsApp → API Setup**. You get a test number and a **Phone number ID** → this is `WHATSAPP_PHONE_NUMBER_ID`.
4. Under "To", add your own number (917012332006) as a recipient and confirm the code WhatsApp sends.
5. A temporary access token is shown there (24 hours). For a permanent one: business.facebook.com → Settings → **Users → System users** → add a system user (Admin) → **Add assets** (your app) → **Generate token** with `whatsapp_business_messaging` and `whatsapp_business_management`. This is `WHATSAPP_TOKEN`.
6. To use your own number instead of the test number: API Setup → **Add phone number** (the number must not be active on a normal WhatsApp app). Add a payment method for conversations later.
7. **Inbound webhook:** WhatsApp → **Configuration → Webhook → Edit**. Callback URL `https://<host>/whatsapp`, Verify token = your `WHATSAPP_VERIFY_TOKEN`. Click Verify and Save, then **subscribe to the `messages` field**.
8. Put all values in the host's environment variables, set `DRY_RUN=0` (or remove it), and redeploy.

## 6. The 24-hour rule and templates

WhatsApp only lets a business send free text to a person who messaged the business in the last 24 hours. Otherwise you must use an **approved template**.

- To keep getting alerts: send "hi" from your own phone to the bot number now and then (this opens the 24h window), OR set up templates.
- Templates: WhatsApp Manager → Message templates → Create (category Utility, language as in `WHATSAPP_TEMPLATE_LANG`). Body examples:
  - New brief (`WHATSAPP_TEMPLATE_NEW_BRIEF`): `New brief from {{1}} ({{2}}). Brief ID: {{3}}. Track: {{4}}`
  - Instruction (`WHATSAPP_TEMPLATE_INSTRUCTION`): `New instruction from {{1}} ({{2}}) for {{3}}: {{4}}. Track: {{5}}`
- The service tries normal text first; if Meta rejects it and a template name is set, it sends the template with the parameters in that order.
- Auto-acks to clients (instruction acknowledgement) are free text too, so they only deliver if the client messaged you in the last 24h; otherwise they fail (logged). Create a template and extend `src/server.js` if you need that.

## 7. Edit the rules / texts

`src/config.js` holds the reply words, messages and on/off switches.

## Notes
- Unknown payload shapes still produce an "unrecognised format" alert so you notice them; check `logs/payloads.jsonl`.
- Only dependency: `express`. Needs Node 18+.
