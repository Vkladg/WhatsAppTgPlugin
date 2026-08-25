---
name: wt-reader
description: Read-only access to user's Telegram and WhatsApp - list chats, read messages by name and date range, download attached files. Use whenever the user asks to show/read/find Telegram or WhatsApp messages, chats history, or attachments.
---

# wt-reader: read-only Telegram + WhatsApp reader

Read-only tool for AI agents. It can list chats, read message history, search text and download attachments. It CANNOT send, edit or delete anything — no such API exists in this project by design.

## Two ways to call

1. MCP tools (if `wt-reader` is registered as an MCP server): `wt_status`, `wt_list_chats`, `wt_get_messages`, `wt_get_file`. Same parameters as the CLI flags below.
2. CLI from the project root (`<projectRoot>` is this repo's install dir):

```
node <projectRoot>/src/cli.js <command> [options]
```

## Command cookbook

```bash
# Status / auth check (both apps)
node src/cli.js status

# List chats of both apps with last message time, top 30
node src/cli.js list-chats --app all -l 30 --compact

# Read a group by name for a date range (local time)
node src/cli.js get-messages --app tg --chat "Family" --from 2026-08-01 --to 2026-08-10 --compact

# Last 7 days / today only
node src/cli.js get-messages --app wa --chat "Anna" --from 7d
node src/cli.js get-messages --app tg --chat "Family" --from today

# Search text inside a chat
node src/cli.js get-messages --app tg --chat "Work" --search "invoice"

# Only messages with media; download them
node src/cli.js get-messages --app wa --chat "Anna" --has-media true
node src/cli.js get-messages --app wa --chat "Anna" --has-media true --download --out ./downloads

# Download one file by message id (id comes from get-messages output field "id")
node src/cli.js get-file --app wa --chat "Anna" --message-id false_12345@c.us_ABCDEF --out ./out
```

`--app` is always `tg` | `wa` (or `all` only for `list-chats`). `--limit` caps results (default 200 messages). `--scan-limit` widens how deep WhatsApp scans (default 5000).

## Date formats (all LOCAL time)

| Value | Meaning |
| --- | --- |
| `2026-08-01` | that whole local day |
| `2026-08-01 14:30` | that minute (+1 s window) |
| `today` | since local midnight |
| `yesterday` | yesterday's full day |
| `7d` | last 7 days, until now |
| unix seconds | exact moment |

End bound (`--to`) is exclusive.

## Chat matching rule

`--chat` matches by case-insensitive substring on chat name, or exactly by chat id. If several chats match, the command fails and lists up to 10 candidates with their ids — re-run using the exact id or a more specific name.

## Output fields

Each message object contains:

- `id` — stable message id (pass to `get-file`)
- `dateISO` — local ISO time like `2026-08-25T14:03:11`
- `timestamp` — unix seconds
- `sender` — display name; `senderId`
- `outgoing` — true if sent by you
- `hasMedia` / `mediaMime` / `fileName`
- `text`, `replyToId`

Chat objects contain `id`, `app`, `name`, `type`, `lastMessageAt`, `lastMessagePreview`.

## One-time auth setup

Telegram (easiest — QR, no api-id needed):

```bash
node src/cli.js qr-tg
# Scan the printed QR with your PHONE Telegram:
# Settings -> Devices -> Link Desktop Device
```

Telegram alternative (phone code / 2FA accounts):

```bash
node src/cli.js login-tg            # asks interactively
node src/cli.js login-tg --api-id I --api-hash H --phone P --code C --password PW
```

WhatsApp (needs Edge or Chrome installed):

```bash
node src/cli.js link-wa             # shows QR to scan in WhatsApp -> Linked devices
node src/cli.js link-wa --pair 79991234567   # pairing code flow instead
```

Sessions live under `data/` (`tg.session.txt`, `tg-config.json`, `wa-auth/`). Reset with `node src/cli.js reset-tg` / `reset-wa`.

## Troubleshooting

- `AUTH_REQUIRED` — run `login-tg` or `link-wa` once (see above).
- `CHAT_NOT_FOUND` / `AMBIGUOUS_CHAT` — run `list-chats` and use exact id.
- WhatsApp fails to launch browser — install Microsoft Edge or Google Chrome.
- Stale chat list — add `--refresh` to `list-chats`.
- Never found what you need? Check `node src/cli.js doctor`.

There are NO send/edit/delete capabilities anywhere in this project. Read-only by design.
