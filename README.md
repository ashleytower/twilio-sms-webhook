# Twilio SMS Webhook

SMS integration with Telegram approval workflow. Receives SMS via Twilio, auto-drafts replies using Claude + Mem0 context, sends to Telegram for approval.

## Architecture

```
Client texts +1 438 255 7557
        ↓
Twilio POSTs to /incoming
        ↓
Server: validate → store → lookup Mem0 → check calendar → draft reply
        ↓
Telegram approval with [Approve] [Edit] [Reject] buttons
        ↓
User approves → SMS sent via Twilio API
```

## Endpoints

- `POST /incoming` - Twilio webhook for incoming SMS
- `POST /status` - Twilio delivery status callback
- `POST /approval` - Telegram inline button callback
- `GET /health` - Health check

## Environment Variables

See `.env.example` for required variables.

## Deployment

Connected to Railway for auto-deploy on push.

