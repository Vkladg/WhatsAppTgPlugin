<div align="center">

# wt-reader

**Read-only Telegram + WhatsApp reader for AI agents**

List chats · Read history by name + date range · Search text · Download attachments

*CLI + MCP server — works with Claude Code, Codex, Antigravity, Cursor, Cline...*

![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen) ![license](https://img.shields.io/badge/license-MIT-blue) ![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey) ![mcp](https://img.shields.io/badge/MCP-stdio-purple) ![read--only](https://img.shields.io/badge/scope-read%20only-orange)

</div>

---

**No send / edit / delete capabilities at all — strictly read-only by design.**
There is no write API anywhere in the codebase; you cannot break your chats with this tool even if you try.

## Why

AI coding agents (Claude Code, Codex, Antigravity...) can already read your code — but not your messengers.
wt-reader gives them safe, structured access:

```
$ wt get-messages --app tg --chat "Family" --from 7d
{
  "chat": { "id": "1234567890", "name": "Family", "app": "tg" },
  "messages": [
    {
      "id": "31234",
      "sender": "Alex",
      "dateISO": "2026-08-25T20:54:44",
      "text": "see you tomorrow!",
      "hasMedia": false,
      "outgoing": false
    }
  ]
}
```

## Quick start

```bash
git clone <repo> && cd wt-reader
npm install

# One-time auth (~30 sec each)
npm run qr:tg     # Telegram: scan QR with phone (Settings -> Devices -> Link Desktop Device)
npm run link:wa   # WhatsApp: scan terminal QR (or --pair 380123456789)

# Use
node src/cli.js list-chats --app all -l 30 --compact
node src/cli.js get-messages --app tg --chat "Family" --from 2026-08-01 --to 2026-08-10
node src/cli.js get-messages --app wa --chat "Work Chat" --from today --search "invoice"
node src/cli.js get-file --app tg --chat "-1001234567890" --message-id 78137
npm run doctor    # environment check
```

Sessions persist in `data/` — you link once and never again.

## CLI reference

| Command | What it does |
| --- | --- |
| `status` | Auth state of both apps |
| `doctor` | Environment check (browser, deps, dirs) |
| `list-chats [-a app] [-f filter] [-l N] [--refresh] [--compact]` | Chats sorted by last message |
| `get-messages --app tg\|wa --chat NAME [options]` | History by name/id + date range |
| `get-file --app tg\|wa --chat NAME --message-id ID` | Download one attachment |
| `qr-tg` / `login-tg` / `link-wa` / `reset-tg` / `reset-wa` | Auth management |

**Options for `get-messages`:** `--from`, `--to` (exclusive), `--limit`, `--search`, `--has-media true|false`, `--download`, `--out DIR`, `--compact`, `--scan-limit`.

**Date formats (local time):** `2026-08-01` · `2026-08-01 14:30` · `today` · `yesterday` · `7d` · unix seconds.

**Chat matching:** case-insensitive substring of the name, or exact id. Ambiguous matches fail and list candidates with ids.

## Connect your agent

Full agent-facing cookbook lives in [`skills/wt-reader/SKILL.md`](skills/wt-reader/SKILL.md); registration snippets in [`AGENTS.md`](AGENTS.md). TL;DR:

<details>
<summary><b>Claude Code</b> — <code>.mcp.json</code></summary>

```json
{
  "mcpServers": {
    "wt-reader": { "command": "node", "args": ["<abs path>/src/mcp-server.mjs"] }
  }
}
```
</details>

<details>
<summary><b>Codex</b> — <code>~/.codex/config.toml</code></summary>

```toml
[mcp_servers.wt-reader]
command = "node"
args = ["<abs path>/src/mcp-server.mjs"]
```
</details>

<details>
<summary><b>Antigravity / Cursor / Cline</b> — generic JSON</summary>

```json
{ "mcpServers": { "wt-reader": { "command": "node", "args": ["<abs>/src/mcp-server.mjs"] } } }
```
</details>

MCP tools mirror the CLI: `wt_status`, `wt_list_chats`, `wt_get_messages`, `wt_get_file`.

## How it works

| App | Engine | Notes |
| --- | --- | --- |
| Telegram | [gramjs](https://github.com/gram-js/gramjs) (MTProto) | QR device-link, no api-id needed; session string in `data/tg.session.txt` |
| WhatsApp | [whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js) fork + headless Edge/Chrome | Linked-device protocol; profile in `data/wa-auth/` |

Requirements: Node ≥ 18, Microsoft Edge or Google Chrome installed.

### Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `WT_DATA_DIR` | `<repo>/data` | Sessions & indexes location |
| `WT_DOWNLOAD_DIR` | `<repo>/downloads` | Where attachments are saved |
| `WA_WEB_VERSION` | *(auto)* | Override pinned WhatsApp Web build URL |

## Troubleshooting

- **`AUTH_REQUIRED`** — run the auth command shown in the hint; sessions survive reboots.
- **`AMBIGUOUS_CHAT`** — expected: several chats share the name; rerun with the exact id from the hint.
- **WhatsApp minified errors (`r: r`)** — WhatsApp Web updates break automation libs periodically. We ship a patched fork; if it recurs, see [CONTRIBUTING](CONTRIBUTING.md#whatsapp-web-breakages).
- **Telegram connect hangs** — some ISPs throttle MTProto on port 80; retrying usually lands on a working DC.
- Anything else: `npm run doctor`.

## Security

Sessions in `data/` grant full **read** access to your messengers. They are git-ignored; never commit or share them.
Details and revocation instructions: [SECURITY.md](SECURITY.md).

## Contributing

PRs welcome — but read the one non-negotiable rule first: [read-only forever](CONTRIBUTING.md#ground-rules).

## License & disclaimer

[MIT](LICENSE). Not affiliated with or endorsed by Telegram or WhatsApp. Use responsibly and within their terms of service.
