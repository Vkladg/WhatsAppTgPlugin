# Contributing

Thanks for considering a contribution! wt-reader is intentionally small and strictly read-only.

## Ground rules

1. **Read-only forever.** PRs adding send/edit/delete capabilities will be rejected. This is the project's core promise.
2. No telemetry, no new runtime dependencies without discussion.
3. No code comments; keep the style consistent with existing modules (ESM, `WtError` codes, stderr-only diagnostics).
4. Windows is the primary platform, but macOS/Linux must not regress (`src/util.js` browser detection).

## Dev workflow

```bash
git clone <repo> && cd wt-reader
npm install          # PUPPETEER_SKIP_DOWNLOAD is set automatically for whatsapp-web.js? No: set it yourself on Windows CI-less machines
npm run doctor       # environment check
node --check src/cli.js && node --check src/mcp-server.mjs && node --check src/core/*.js
```

Manual test checklist before opening a PR:

- [ ] `node src/cli.js --help` renders
- [ ] `list-chats`, `get-messages`, `get-file` work against at least one live app
- [ ] Unauthenticated commands fail with a clean `AUTH_REQUIRED` hint (no stack traces)
- [ ] MCP server answers `tools/list` over stdio

## WhatsApp Web breakages

WhatsApp Web changes can break reading (see CHANGELOG 1.0.0 - the `$1` minification incident). If `getChats` starts throwing minified errors:

1. Check whether upstream whatsapp-web.js has a fix; prefer upgrading.
2. Otherwise pin `webVersionCache` in `src/core/whatsapp.js` to a known-good build from [wppconnect-team/wa-version](https://github.com/wppconnect-team/wa-version) and document it here.
