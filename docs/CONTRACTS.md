# wt-reader module contracts (single source of truth)

Project: read-only reader for Telegram + WhatsApp for AI agents.
Runtime: Node.js >= 18, ESM ("type":"module"). Windows 11 host.
STRICT RULES:
- No code comments anywhere.
- Never write to stdout from library modules (stdout is reserved for JSON data). Diagnostics -> util.log() which writes stderr.
- Throw util.WtError(code, message, hint?) on failures. Codes: AUTH_REQUIRED, NOT_CONFIGURED, CHAT_NOT_FOUND, AMBIGUOUS_CHAT, NO_MESSAGE, MEDIA_ERROR, UPSTREAM, INVALID_ARG.
- No sending/editing/deleting capabilities of any kind. Read-only APIs only.

## Shared types

```
Chat = {
  id: string            // stable id: tg -> "<numeric-id>", wa -> jid "<x@c.us>"
  app: 'tg' | 'wa'
  name: string
  type: 'private' | 'group' | 'channel' | 'bot'
  lastMessageAt: string | null     // ISO 8601 local time e.g. 2026-08-25T14:03:11
  lastMessagePreview: string | null
}

Msg = {
  id: string
  chatId: string
  chatName: string
  sender: string            // display name
  senderId: string
  dateISO: string           // ISO local
  timestamp: number         // unix seconds
  text: string
  hasMedia: boolean
  mediaMime: string | null
  fileName: string | null
  outgoing: boolean
  replyToId: string | null
}
```

## Paths (from util.js)
- ROOT: project root. DATA_DIR: env WT_DATA_DIR || ROOT/data. DOWNLOAD_DIR: env WT_DOWNLOAD_DIR || ROOT/downloads.
- Telegram session string file: DATA_DIR/tg.session.txt ; creds DATA_DIR/tg-config.json {"apiId":number,"apiHash":string}
- WhatsApp LocalAuth dataPath: DATA_DIR/wa-auth (client id "default")
- Chat index cache: DATA_DIR/index-tg.json / index-wa.json

## util.js exports (already implemented, import from '../util.js')
- ROOT, DATA_DIR, DOWNLOAD_DIR, ensureDirs()
- log(...args)                      // stderr, prefix [wt]
- WtError                           // class extends Error, fields code, hint
- isoFromUnix(secOrMs)              // -> 'YYYY-MM-DDTHH:mm:ss' local
- parseDateArg(str)                 // -> {fromTs:number, toTs:number|null} unix SECONDS local time.
                                    // Accepts: 'YYYY-MM-DD' (full day), 'YYYY-MM-DD HH:mm', ISO,
                                    // 'today', 'yesterday', '<N>d' (last N days), unix seconds string.
                                    // to==null means "until now". End bound EXCLUSIVE.
- sanitizeName(s)                   // safe filename fragment
- truncate(s, n=80)
- findBrowser()                     // -> absolute msedge.exe/chrome.exe path or throws WtError('UPSTREAM')
- jsonOut(obj, pretty=true)         // stdout writer used ONLY by cli.js

## store.js exports (already implemented)
- readJson(file, fallback), writeJson(file, obj)   // atomic tmp+rename, paths resolved from DATA_DIR if relative
- loadChatIndex(app), saveChatIndex(app, chats)    // cached Chat[] with savedAt
- kvGet(key, fallback), kvSet(key, value)

## src/core/telegram.js MUST export exactly:
- async ensureConfigured() -> { configured:boolean, hint:string }   // true when session file AND config exist
- async connect() -> gramjs client (cached singleton; connects; AUTH_REQUIRED w/ hint if unconfigured)
- async disconnect()
- async me() -> { id, name, username, phone }
- async listChats({ filter='', limit=50 }) -> Chat[]                // sorted by lastMessageAt desc, filter substring case-insens on name
- async getMessages({ chat, from=null, to=null, limit=200, search=null, hasMedia=null }) -> Msg[]
    // chat: string query (name substring, case-insensitive) OR exact id string.
    // from/to: unix seconds or null. Iterate newest->older starting at offsetDate=toTs,
    // stop when msg.date < fromTs or collected==limit or scanned>20000.
    // search: case-insensitive substring on text. hasMedia: true/false/null filter.
- async downloadFile({ chat, messageId, outDir }) -> { savedPath, fileName, sizeBytes }

Implementation notes: use 'telegram' (gramjs) npm package, StringSession loaded from file.
Sender names resolved via caching entity map. Media filename from document attributes.

## src/core/whatsapp.js MUST export exactly:
- async isLinked() -> boolean                                       // checks DATA_DIR/wa-auth session files exist
- async link({ pairPhone=null })                                    // interactive: prints QR (qrcode-terminal) or requests
                                                                    // pairing code for pairPhone ('79991234567'); resolves once 'ready'
- async disconnect()
- async me() -> { id, name, pushname, phone }
- async listChats({ filter='', limit=50 }) -> Chat[]                // client.getChats(), map jid/name/lastMessage timestamps
- async getMessages({ chat, from=null, to=null, limit=200, search=null, hasMedia=null, scanLimit=5000 }) -> Msg[]
    // chat.fetchMessages({limit:scanLimit}) newest-first, filter locally same semantics as tg
- async downloadFile({ chat, messageId, outDir }) -> { savedPath, fileName, sizeBytes }  // msg.downloadMedia() base64 -> file

Implementation notes: whatsapp-web.js + puppeteer-core style launch using util.findBrowser(),
headless:true, LocalAuth({dataPath:DATA_DIR+'/wa-auth'}). Cache client singleton. NEVER call any send API.

## src/cli.js (owned by integrator) commands
status | doctor | list-chats [-a app] [-f filter] [-l N] [--refresh] [--raw]
get-messages --app tg|wa --chat NAME [--from D] [--to D] [--limit N] [--search S]
             [--has-media true|false] [--scan-limit N] [--download] [--out DIR] [--compact]
get-file --app tg|wa --chat NAME --message-id ID [--out DIR]
login-tg [--api-id I --api-hash H --phone P --code C --password PW]
link-wa [--pair PHONE] ; reset-tg ; reset-wa

## src/mcp-server.mjs (subagent C)
stdio MCP server exposing tools: wt_status, wt_list_chats, wt_get_messages, wt_get_file.
Same params/semantics as CLI. Return JSON.stringify(result,null,2) as text content.
Never expose any send/edit tool.
