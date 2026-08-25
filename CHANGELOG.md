# Changelog

## 1.0.0 - 2026-08-25

First stable release.

- Read-only CLI: `status`, `doctor`, `list-chats`, `get-messages`, `get-file`
- One-time auth: Telegram QR device-link (`qr-tg`) or phone login (`login-tg`); WhatsApp QR / pairing-code linking (`link-wa`)
- MCP stdio server exposing `wt_status`, `wt_list_chats`, `wt_get_messages`, `wt_get_file`
- Agent skill cookbook in `skills/wt-reader/SKILL.md`
- Local-time date parsing: `YYYY-MM-DD`, `YYYY-MM-DD HH:mm`, `today`, `yesterday`, `<N>d`, unix seconds
- Media download with original filenames (extension-preserving sanitizer)

### Fixed during hardening

- gramjs QR flow crashed on `LoginTokenRetry` (class absent in telegram@2.x) after a successful scan
- CLI could hang after finishing work because gramjs kept sockets open; commands now exit deterministically
- WhatsApp July-2026 `_serialized -> $1` minification broke `getChats`/media (`r: r` errors) - switched to the community fix fork and documented the pin strategy
- `isLinked()` false positives from pre-auth LocalAuth folders; replaced with an explicit link marker file
