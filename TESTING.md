# Clinic Bot Server — TESTING.md

Server: `~/workspace/goals/whatsapp-clinic-receptionist-bot/server/index.js`
Stack: Node.js + Express. No DB yet (in-memory pause map).

## Start
```bash
cd ~/workspace/goals/whatsapp-clinic-receptionist-bot/server
cp .env.example .env   # then fill values
node index.js
```

## What's verified (2026-09-17, local tests)
- GET /webhook verification: correct token -> returns challenge; wrong token -> 403
- POST /webhook patient text -> Derja reply generated (fallback keywords, no AI key needed)
- smb_message_echoes (staff replies from Business app) -> bot auto-pauses 30 min for that chat
- Message while paused -> bot stays silent
- Outbound HTTPS to graph.facebook.com works (send path will work once token set)

## Still needed for live sandbox test
1. WHATSAPP_TOKEN — fresh token from developers.facebook.com (temp tokens expire ~24h;
   the 2026-09-16 one is likely expired). WhatsApp > API Setup > Temporary access token.
2. PHONE_NUMBER_ID — same page, under the test number +1 (555) 162-8321
   ("Phone number ID", NOT the phone number itself).
3. Webhook: Meta dashboard > WhatsApp > Configuration > Webhook >
   Callback URL = <public-url>/webhook , Verify token = value of VERIFY_TOKEN.
   Subscribe to fields: `messages`. (For echo: `smb_message_echoes` if shown.)
4. AI_API_KEY (OpenAI or compatible) — optional for first live test; fallback replies
   work without it, real Derja AI needs it.

## Public URL problem (2026-09-17)
This dev VM sits behind an HTTP proxy that breaks tunnel services:
- cloudflared quick tunnel: TLS handshake fails through proxy
- localtunnel: starts but never issues a URL
Meta requires a public HTTPS webhook URL. Options when testing live:
  a) Deploy server to Render/Railway (public URL included) — recommended for pilot anyway
  b) Run tunnel from a machine without the proxy
