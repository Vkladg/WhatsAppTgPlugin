# wt-reader

Read-only reader for the user's **Telegram** and **WhatsApp**, built for AI agents (Claude Code, Codex, Antigravity, Cursor, Cline...). List chats, read message history by name + date range, search text, download attachments. It has **no send/edit/delete capabilities at all — strictly read-only by design.**

## Full tutorial

See [skills/wt-reader/SKILL.md](skills/wt-reader/SKILL.md) for the complete agent-facing cookbook: commands, date formats, chat matching rules, output fields and troubleshooting.

## Run the CLI (no npx, no install step)

From this repo's root:

```bash
node src/cli.js status
node src/cli.js list-chats --app all -l 30 --compact
node src/cli.js get-messages --app tg --chat "Family" --from 7d --compact
node src/cli.js get-file --app wa --chat "Anna" --message-id <id> --out ./out
```

## One-time auth

```bash
node src/cli.js qr-tg       # Telegram: scan QR with phone (Settings -> Devices -> Link Desktop Device)
node src/cli.js login-tg    # Telegram alternative: api-id/api-hash from my.telegram.org + phone code
node src/cli.js link-wa     # WhatsApp: QR in terminal, or --pair 79991234567
```

Sessions are stored under `data/`. Reset via `reset-tg` / `reset-wa`.

## Register as MCP server

Server entry point: `<abs path to repo>/src/mcp-server.mjs` (stdio transport). Exposes tools `wt_status`, `wt_list_chats`, `wt_get_messages`, `wt_get_file`.

### Claude Code — `.mcp.json` in project root

Use an absolute path to `mcp-server.mjs` (Claude Code may launch MCP servers with a different working directory):

```json
{
  "mcpServers": {
    "wt-reader": {
      "command": "node",
      "args": ["C:\\absolute\\path\\to\\WhatsAppTgPlugin\\src\\mcp-server.mjs"]
    }
  }
}
```

### Codex — `~/.codex/config.toml`

```toml
[mcp_servers.wt-reader]
command = "node"
args = ["C:\\absolute\\path\\to\\WhatsAppTgPlugin\\src\\mcp-server.mjs"]
```

### Generic JSON config (Antigravity / Cursor / Cline)

```json
{
  "mcpServers": {
    "wt-reader": {
      "command": "node",
      "args": ["<abs>/src/mcp-server.mjs"]
    }
  }
}
```

## Notes for agents

- Dates are **local time**: `2026-08-01`, `2026-08-01 14:30`, `today`, `yesterday`, `7d`.
- `--chat` is a case-insensitive name substring; on ambiguity the error lists candidate chats/ids.
- The server never writes to stdout except MCP JSON-RPC frames; diagnostics go to stderr.
