# Twilio SMS Skill

Receives SMS messages via Twilio webhook, auto-drafts replies using Mem0 + Calendar context, and sends to Telegram for approval before responding.

## Architecture

```
Client texts +1 438 255 7557
        ↓
Twilio POSTs to Railway webhook
        ↓
Server: validate → store → lookup Mem0 → check calendar → draft reply → Telegram approval
        ↓
User taps [Approve] in Telegram
        ↓
Server sends SMS via Twilio API
```

## Features

- Twilio signature validation for security
- Client context lookup via Mem0 (pricing, services, past interactions)
- Calendar context display (leads + bookings) to inform approval decisions
- Auto-draft replies using Claude
- Real-time Telegram approval with inline buttons
- Full conversation history in Supabase

## Environment Variables

See `.env.example` for required variables.

## Deployment

1. Deploy to Railway: `railway up`
2. Get public URL from Railway dashboard
3. Update Twilio webhook: `https://your-app.railway.app/incoming`
4. Set Telegram bot webhook: `https://your-app.railway.app/approval`

## Database

Uses existing Supabase tables:
- `sms_conversations` - one per phone number
- `sms_messages` - full message history

## Routes

- `POST /incoming` - Twilio webhook for incoming SMS
- `POST /status` - Twilio delivery status callback
- `POST /approval` - Telegram inline button callback
- `GET /health` - Health check endpoint
