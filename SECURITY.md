# Security policy

## Reporting a vulnerability

Please open a private security advisory via GitHub ("Security" -> "Report a vulnerability") instead of a public issue.

## Data handling

This tool stores **your own** messenger sessions on disk:

| Path | Contents |
| --- | --- |
| `data/tg.session.txt` | Telegram authorization key |
| `data/tg-config.json` | Telegram api id/hash |
| `data/wa-auth/` | WhatsApp Web browser profile (cookies, IndexedDB) |
| `downloads/` | Files you explicitly downloaded |

Anyone with access to these folders can read your messengers. They are git-ignored by default - never commit, copy or share them.

If a session leaks: revoke the device on your phone (Telegram: Settings -> Devices; WhatsApp: Linked devices), then `node src/cli.js reset-tg && node src/cli.js reset-wa`.

## Scope

- The codebase contains no telemetry, analytics or network calls beyond Telegram MTProto / web.whatsapp.com itself.
- Strictly read-only: there are no send/edit/delete code paths at all.
