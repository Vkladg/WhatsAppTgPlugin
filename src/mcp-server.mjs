#!/usr/bin/env node
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  DATA_DIR,
  DOWNLOAD_DIR,
  WtError,
  ensureDirs,
  isoFromUnix,
  log,
  parseDateArg,
  sanitizeName,
} from './util.js';
import { loadChatIndex, saveChatIndex } from './store.js';

const INDEX_TTL_MS = 5 * 60 * 1000;

const SKILL_HINT =
  'Full tutorial with CLI cookbook: skills/wt-reader/SKILL.md relative to the wt-reader install dir.';

const DATE_HINT =
  "Dates are LOCAL time. Accepted formats: 'YYYY-MM-DD' (whole day), 'YYYY-MM-DD HH:mm', 'today', 'yesterday', '<N>d' (last N days), unix seconds.";

async function core(appName) {
  if (appName === 'tg') return import('./core/telegram.js');
  if (appName === 'wa') return import('./core/whatsapp.js');
  throw new WtError('INVALID_ARG', `Unknown app "${appName}" (use tg|wa)`);
}

async function getChatsFor(app, { refresh = false } = {}) {
  const mod = await core(app);
  if (refresh) {
    const fresh = await mod.listChats({ filter: '', limit: 2000 });
    saveChatIndex(app, fresh);
    return fresh;
  }
  const cached = loadChatIndex(app);
  if (cached && Array.isArray(cached.chats) && Date.now() - cached.savedAt < INDEX_TTL_MS) {
    return cached.chats;
  }
  const fresh = await mod.listChats({ filter: '', limit: 2000 });
  saveChatIndex(app, fresh);
  return fresh;
}

function matchChat(chats, query) {
  const q = String(query).trim().toLowerCase();
  if (!q) throw new WtError('INVALID_ARG', 'Empty chat query');
  const byId = chats.find((c) => String(c.id) === q);
  if (byId) return byId;
  const hits = chats.filter((c) => String(c.name).toLowerCase().includes(q));
  if (hits.length === 0) {
    throw new WtError(
      'CHAT_NOT_FOUND',
      `No chat matching "${query}"`,
      'Run wt_list_chats or: node src/cli.js list-chats to see available chat names'
    );
  }
  if (hits.length > 1) {
    throw new WtError(
      'AMBIGUOUS_CHAT',
      `"${query}" matches ${hits.length} chats`,
      'Candidates: ' + hits.slice(0, 10).map((c) => `${c.name} (${c.id})`).join('; ')
    );
  }
  return hits[0];
}

async function buildStatus() {
  ensureDirs();
  const out = { dataDir: DATA_DIR, downloadDir: DOWNLOAD_DIR };
  try {
    const tg = await import('./core/telegram.js');
    const cfg = await tg.ensureConfigured();
    out.telegram = { configured: cfg.configured, hint: cfg.hint };
    if (cfg.configured) {
      try {
        await tg.connect();
        out.telegram.me = await tg.me();
      } catch (e) {
        out.telegram.connectError = e.message;
      }
    }
  } catch (e) {
    out.telegram = { error: e.message };
  }
  try {
    const wa = await import('./core/whatsapp.js');
    const linked = await wa.isLinked();
    out.whatsapp = { linked };
    if (linked) {
      try {
        await wa.connect();
        out.whatsapp.me = await wa.me();
      } catch (e) {
        out.whatsapp.connectError = e.message;
      }
    }
  } catch (e) {
    out.whatsapp = { error: e.message };
  }
  return out;
}

async function listChats(args) {
  ensureDirs();
  const filter = String(args.filter || '').trim().toLowerCase();
  const limit = args.limit == null ? 50 : args.limit;
  const chats = await getChatsFor(args.app, { refresh: !!args.refresh });
  const filtered = chats.filter((c) => !filter || String(c.name).toLowerCase().includes(filter));
  return {
    app: args.app,
    total: filtered.length,
    count: Math.min(filtered.length, limit),
    chats: filtered.slice(0, limit),
  };
}

async function getMessages(args) {
  ensureDirs();
  const mod = await core(args.app);
  const chats = await getChatsFor(args.app, { refresh: true });
  const chat = matchChat(chats, args.chat);
  const fromTs = parseDateArg(args.from || null).fromTs;
  const toTs = args.to ? parseDateArg(args.to).toTs : null;
  const msgs = await mod.getMessages({
    chat: String(chat.id),
    from: fromTs,
    to: toTs,
    limit: args.limit == null ? 200 : args.limit,
    search: args.search || null,
    hasMedia: args.has_media == null ? null : !!args.has_media,
    scanLimit: args.scan_limit == null ? 5000 : args.scan_limit,
  });
  let files = [];
  if (args.download) {
    const outDir = path.join(String(args.out_dir || DOWNLOAD_DIR), `${args.app}-${sanitizeName(chat.name)}`);
    for (const m of msgs) {
      if (!m.hasMedia) continue;
      try {
        const r = await mod.downloadFile({ chat: String(chat.id), messageId: m.id, outDir });
        files.push({ messageId: m.id, ...r });
      } catch (e) {
        files.push({ messageId: m.id, error: e.message });
      }
    }
  }
  return {
    chat: { id: chat.id, name: chat.name, app: chat.app },
    range: { from: fromTs ? isoFromUnix(fromTs) : null, to: toTs ? isoFromUnix(toTs) : null },
    count: msgs.length,
    downloaded: files.length ? files : undefined,
    messages: msgs,
  };
}

async function getFile(args) {
  ensureDirs();
  const mod = await core(args.app);
  const chats = await getChatsFor(args.app, { refresh: true });
  const chat = matchChat(chats, args.chat);
  return mod.downloadFile({
    chat: String(chat.id),
    messageId: args.message_id,
    outDir: String(args.out_dir || DOWNLOAD_DIR),
  });
}

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(e) {
  let text;
  if (e instanceof WtError) {
    text = `ERROR [${e.code}] ${e.message}`;
    if (e.hint) text += `\nHINT: ${e.hint}`;
  } else {
    text = 'ERROR ' + (e && e.stack ? e.stack : String(e));
  }
  log(text);
  return { content: [{ type: 'text', text }], isError: true };
}

function wrap(fn) {
  return async (args) => {
    try {
      return ok(await fn(args || {}));
    } catch (e) {
      return fail(e);
    }
  };
}

process.on('uncaughtException', (e) => log('FATAL', e && e.stack ? e.stack : String(e)));
process.on('unhandledRejection', (e) => log('FATAL', e && e.stack ? e.stack : String(e)));

const server = new McpServer({ name: 'wt-reader', version: '0.1.0' });

server.registerTool(
  'wt_status',
  {
    title: 'wt status',
    description:
      'Show authentication/status for Telegram and WhatsApp (read-only tool; never sends anything). ' +
      'Returns configured/linked flags, account info and dataDir. No params. ' +
      'If not authenticated, one-time setup is done via CLI: node src/cli.js login-tg / link-wa. ' +
      SKILL_HINT,
    inputSchema: {},
  },
  wrap(() => buildStatus())
);

server.registerTool(
  'wt_list_chats',
  {
    title: 'wt list chats',
    description:
      'List chats of one app with last message time and preview. READ-ONLY. app is required: "tg" (Telegram) or "wa" (WhatsApp). ' +
      'filter: case-insensitive name substring. limit: max chats (default 50). refresh: true bypasses the 5-minute index cache. ' +
      SKILL_HINT,
    inputSchema: {
      app: z.enum(['tg', 'wa']).describe('Which messenger: tg | wa'),
      filter: z.string().optional().describe('Case-insensitive substring on chat name'),
      limit: z.number().int().positive().optional().describe('Max chats returned (default 50)'),
      refresh: z.boolean().optional().describe('true = rebuild index ignoring cache'),
    },
  },
  wrap(listChats)
);

server.registerTool(
  'wt_get_messages',
  {
    title: 'wt get messages',
    description:
      'Read messages from a Telegram or WhatsApp chat. READ-ONLY (cannot send/edit anything). ' +
      'app: "tg" | "wa". chat: chat NAME substring (case-insensitive, must be unique) or exact chat id. ' +
      'from/to are LOCAL time: ' +
      DATE_HINT +
      ' to is exclusive. search: case-insensitive substring in text. has_media: true/false filter. ' +
      'download: also download media attachments into out_dir (or <downloads>/<app>-<chat>). ' +
      'Returns chat info, resolved range, messages with dateISO/sender/outgoing/hasMedia/fileName/text. ' +
      SKILL_HINT,
    inputSchema: {
      app: z.enum(['tg', 'wa']).describe('Which messenger: tg | wa'),
      chat: z.string().min(1).describe('Chat name substring or exact id'),
      from: z.string().optional().describe('Start of range, local time: YYYY-MM-DD | YYYY-MM-DD HH:mm | today | yesterday | Nd'),
      to: z.string().optional().describe('End of range (exclusive), same formats as from'),
      limit: z.number().int().positive().optional().describe('Max messages (default 200)'),
      search: z.string().optional().describe('Case-insensitive substring on message text'),
      has_media: z.boolean().optional().describe('Filter by media presence'),
      scan_limit: z.number().int().positive().optional().describe('Internal scan window (default 5000)'),
      download: z.boolean().optional().describe('Download media of matched messages'),
      out_dir: z.string().optional().describe('Download directory (default <project>/downloads/<app>-<chat>)'),
    },
  },
  wrap(getMessages)
);

server.registerTool(
  'wt_get_file',
  {
    title: 'wt get file',
    description:
      'Download the file/media attached to ONE message by its id. READ-ONLY (download only writes a local copy, nothing is sent). ' +
      'app: "tg" | "wa". chat: name substring (case-insensitive, unique) or exact id. message_id: id as returned by wt_get_messages (Msg.id). ' +
      'out_dir: target directory (default project downloads dir). Returns savedPath, fileName, sizeBytes. ' +
      SKILL_HINT,
    inputSchema: {
      app: z.enum(['tg', 'wa']).describe('Which messenger: tg | wa'),
      chat: z.string().min(1).describe('Chat name substring or exact id'),
      message_id: z.string().min(1).describe('Message id (Msg.id from wt_get_messages)'),
      out_dir: z.string().optional().describe('Download directory (default downloads dir)'),
    },
  },
  wrap(getFile)
);

await server.connect(new StdioServerTransport());
log('wt-reader MCP server ready (stdio)');
