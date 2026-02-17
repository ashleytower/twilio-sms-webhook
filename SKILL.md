# Twilio SMS Skill

Receives SMS messages via Twilio webhook, auto-drafts bilingual replies using Claude, and sends to Telegram for approval via web UI before responding.

## Architecture

```
Client texts +1 438 255 7557
        ↓
Twilio POSTs to Railway webhook
        ↓
Server: validate → store in Supabase → draft reply with Claude (bilingual)
        ↓
Telegram notification with web approval link
        ↓
Ashley clicks link → Web UI to approve/edit/reject
        ↓
Server sends SMS via Twilio API
```

## Features

- Twilio signature validation for security
- Bilingual support (French/English - detects and matches language)
- Auto-draft replies using Claude 3.5 Haiku
- Conversation history stored in Supabase
- Web-based approval UI (avoids Telegram webhook conflicts with OpenClaw)
- Full audit trail of sent messages

## Phone Number

**+1 438 255 7557** - MTL Craft Cocktails business line

## Voice Mode Toggle

The same webhook handles voice mode switching:
- `GET /voice/mode` - Check current mode (ai or forward)
- `POST /voice/mode` - Set mode: `{"mode": "ai"}` or `{"mode": "forward"}`

AI mode = Vapi answers, can transfer to Ashley
Forward mode = Calls go directly to Ashley's cell

## Database

Supabase tables:
- `sms_conversations` - one per phone number (phone, client_name, message_count)
- `sms_messages` - full message history with `incoming_body` column

## Routes

| Endpoint | Purpose |
|----------|---------|
| `POST /incoming` | Twilio SMS webhook |
| `POST /status` | Delivery status callback |
| `GET /approval/:messageId` | Web approval UI (view) |
| `POST /approval/:messageId` | Web approval UI (action) |
| `POST /voice` | Voice routing (AI or forward) |
| `GET /voice/mode` | Check voice mode |
| `POST /voice/mode` | Toggle voice mode |
| `GET /messages/search` | Read-only search (API key required) |
| `POST /simulate` | Dry-run SMS (API key required) |
| `GET /health` | Health check |

## Deployment

Deployed on Railway: `https://twilio-sms-production-b6b8.up.railway.app`

Environment variables managed in Railway dashboard.

## Read-Only API

Set `SMS_READ_API_KEY` and pass it as `x-api-key` for `/messages/search`.
Optional: set `SMS_READ_ALLOWLIST` (comma-separated IPs) to restrict access.

## Simulation (Dry Run)

POST `/simulate` with `x-api-key` and JSON:
```
{ "from": "+15145551234", "body": "Can we swap margarita for paloma?", "sendApproval": false }
```

Returns the drafted reply + any detected menu action without sending SMS or Telegram.

## MTL App Integration (Menu Updates)

Set:
- `MTL_API_BASE_URL` (e.g., https://mtl-craft-cocktails-ai.vercel.app)
- `MTL_API_SECRET` (matches API_SECRET in the MTL app)

When a client asks to swap a cocktail (e.g., "change margarita to a paloma"),
the SMS agent runs a dry-run against the MTL app and, on approval, applies the update.
Supports: add, remove, replace.

## MTL App Integration (Inbound SMS Storage)

If `MTL_API_BASE_URL` + `MTL_API_SECRET` are set, every inbound SMS is forwarded to:
- `POST /api/sms/inbound`

This stores the message in the MTL app's `sms_messages` table so the Memory Assistant
can answer queries like "Did John send his address yet?"

Outbound replies sent by the approval flow are also forwarded to:
- `POST /api/sms/inbound` with `direction: "outbound"`
