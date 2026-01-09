# Messaging Options for Track Log Submission

Analysis of alternative channels for pilots to submit IGC track logs beyond email.

## Context

Apps like FlySkyHy and Naviter Navigator allow pilots to share IGC files via:
- Email (currently supported)
- SMS / Messages
- WhatsApp
- Other share targets

This exploration evaluates options for accepting submissions via these channels, with the potential for a chat interface that can respond with analysis links.

## Channel Comparison

| Channel | Setup Complexity | Cost | Chat Interface | File Support | Global Reach |
|---------|------------------|------|----------------|--------------|--------------|
| **Email** | Low | Free | No | ✅ Attachments | ✅ Universal |
| **Telegram Bot** | Low | Free | ✅ Yes | ✅ Documents | Good (popular in EU/AU) |
| **WhatsApp Business** | Medium-High | ~$0.005-0.05/msg | ✅ Yes | ✅ Documents | ✅ Universal |
| **SMS/MMS** | Medium | ~$0.01-0.02/msg | Limited | ⚠️ MMS only (US-centric) | ⚠️ MMS limited |

## Telegram Bot (Recommended)

### Why Telegram?

1. **Free** - No per-message costs, unlimited usage
2. **Simple webhook setup** - Works perfectly with Cloudflare Workers
3. **Rich chat interface** - Can reply with flight analysis, links, inline buttons
4. **File support** - Native document sharing (IGC files work fine)
5. **Popular with pilots** - Many aviation/outdoor communities use Telegram
6. **Bot API is excellent** - Well-documented, easy to implement

### Example Flow

```
Pilot shares IGC to @TaskScoreBot
        │
        ▼
┌───────────────────────────────────────────────────┐
│ Telegram Worker                                   │
│  - Receives webhook with file_id                  │
│  - Downloads file via Telegram API                │
│  - Validates pilot (by Telegram user ID or phone) │
│  - Stores IGC in R2                               │
│  - Replies with analysis link                     │
└───────────────────────────────────────────────────┘
        │
        ▼
Bot replies:
"✓ Flight received, John!
 📍 Task: Corryong Day 3
 📏 Distance: 87.4km
 🔗 View analysis: taskscore.com/flights/abc123"
```

### Technical Implementation

Telegram bots use webhooks that fit perfectly with serverless:

1. Create bot via @BotFather, get token
2. Set webhook URL to your Worker endpoint
3. Worker receives POST with message payload
4. For files: payload contains `file_id`
5. Use `getFile` API to get download URL
6. Download file content within Worker
7. Process and store as usual
8. Reply using `sendMessage` API

### Pilot Authorization

Options for validating pilots:
- **Telegram user ID** - Admin links Telegram ID to pilot record
- **Phone number** - Telegram can share phone (with user consent)
- **Registration flow** - Pilot sends `/register email@example.com` to link accounts

### Architecture Addition

```
                                 ┌─────────────────────────────────┐
                                 │        Cloudflare Pages         │
                                 │   - Public: view flights/tasks  │
                                 │   - Admin: manage competitions  │
                                 └────────────────┬────────────────┘
                                                  │
       ┌──────────────────────────────────────────┼───────────────┐
       │                          │               │               │
       ▼                          ▼               ▼               ▼
┌─────────────────┐    ┌─────────────────┐   ┌─────────┐   ┌─────────┐
│  Email Worker   │    │ Telegram Worker │   │   R2    │   │   D1    │
│                 │    │                 │   │ Storage │   │   DB    │
│ - Receive email │    │ - Webhook recv  │   │ (IGCs)  │   │         │
│ - Check sender  │    │ - Download file │   └─────────┘   │ - Pilots│
│ - Parse IGC     │    │ - Check user    │                 │ - Tasks │
│ - Store to R2   │    │ - Store to R2   │   ┌─────────┐   │ - Comps │
└─────────────────┘    │ - Reply w/link  │   │   API   │   └─────────┘
       ▲               └─────────────────┘   │  Worker │
       │                        ▲            └─────────┘
   pilot@email                  │
                         @TaskScoreBot
```

## WhatsApp Business API

### Pros
- Universal reach (most popular messaging app globally)
- Rich media and interactive messages
- Professional appearance

### Cons
- **Meta Business verification required** - Bureaucratic process
- **Per-conversation pricing** - $0.005-0.05 depending on region and message type
- **Template messages required** - Outbound messages must use pre-approved templates
- **Complex setup** - More moving parts than Telegram

### Pricing Details
- User-initiated conversations: ~$0.005-0.01
- Business-initiated conversations: ~$0.02-0.05
- 1000 free conversations/month on some tiers

### When to Consider
- If targeting markets where Telegram adoption is low
- If professional/business appearance is critical
- If budget allows for per-message costs

### Resources
- [WhatsApp Cloud API Worker Template](https://github.com/depombo/whatsapp-api-cf-worker)
- [WhatsApp Business Webhooks Guide](https://business.whatsapp.com/blog/how-to-use-webhooks-from-whatsapp-business-api)

## SMS/MMS (via Twilio)

### Pros
- Works with any phone (no app install)
- Simple for users

### Cons
- **MMS is US-centric** - Poor/no support in AU, EU, and most of the world
- **Per-message costs** - SMS ~$0.008, MMS ~$0.01-0.02
- **No rich replies** - Text only, no buttons or formatting
- **File size limits** - MMS typically limited to 1-5MB

### Pricing (Twilio)
- Inbound SMS: $0.0079/message
- Inbound MMS: $0.0100/message
- Outbound SMS: $0.0079/message
- Outbound MMS: $0.0200/message
- Phone number: ~$1/month

### When to Consider
- US-only competitions
- Pilots who refuse to install apps
- Simple notification replies (no files back)

### Resources
- [Twilio Messaging Webhooks](https://www.twilio.com/docs/usage/webhooks/messaging-webhooks)
- [Twilio Pricing](https://www.twilio.com/en-us/pricing/messaging)

## Recommendation

**Start with Email + Telegram:**

1. **Email** - Universal fallback, already planned
2. **Telegram** - Rich chat interface, free, good pilot adoption

This combination covers most use cases without cost or complexity. WhatsApp can be added later if there's demand from pilots who don't use Telegram.

## References

- [Serverless Telegram Bot Guide (2025)](https://sampo.website/blog/en/2025/serverless-tg-bot/)
- [Telegram Bot on Cloud Run (Dec 2025)](https://medium.com/@alexander.tyutin/running-a-production-ready-webhook-telegram-bot-on-google-cloud-run-a-security-first-approach-57b589ff8e48)
- [Telegram Bot API Documentation](https://core.telegram.org/bots/api)
