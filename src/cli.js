#!/usr/bin/env node
import path from 'node:path';
import readline from 'node:readline/promises';
import { Command } from 'commander';
import {
  DATA_DIR,
  DOWNLOAD_DIR,
  WtError,
  ensureDirs,
  findBrowser,
  isoFromUnix,
  jsonOut,
  log,
  parseDateArg,
  sanitizeName,
  truncate,
} from './util.js';
import { kvGet, loadChatIndex, saveChatIndex, readJson } from './store.js';

const INDEX_TTL_MS = 5 * 60 * 1000;

async function core(appName) {
  if (appName === 'tg') return import('./core/telegram.js');
  if (appName === 'wa') return import('./core/whatsapp.js');
  throw new WtError('INVALID_ARG', `Unknown app "${appName}" (use tg|wa)`);
}

function die(err) {
  if (err instanceof WtError) {
    log(`ERROR [${err.code}] ${err.message}`);
    if (err.hint) log('HINT:', err.hint);
    process.exit(1);
  }
  log('FATAL', err && err.stack ? err.stack : String(err));
  process.exit(1);
}

async function run(fn) {
  try {
    await fn();
    setTimeout(() => process.exit(0), 500).unref();
  } catch (e) {
    die(e);
  }
}

function normalizeRange(opts) {
  const fromTs = opts.from ? parseDateArg(opts.from).fromTs : null;
  const toTs = opts.to ? parseDateArg(opts.to).toTs : null;
  return { fromTs, toTs };
}

async function getChatsFor(app, { refresh = false } = {}) {
  const mod = await core(app);
  const cached = loadChatIndex(app);
  if (!refresh && cached && Array.isArray(cached.chats) && Date.now() - cached.savedAt < INDEX_TTL_MS) {
    return cached.chats;
  }
  const chats = await mod.listChats({ filter: '', limit: 2000 });
  saveChatIndex(app, chats);
  return chats;
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
      'Run: wt list-chats to see available chat names'
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

const program = new Command();
program.name('wt').description('Read-only Telegram + WhatsApp reader for AI agents').version('0.1.0');

program
  .command('status')
  .description('Show authentication status for both apps')
  .action(() =>
    run(async () => {
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
        out.whatsapp = { linked: await wa.isLinked() };
        if (out.whatsapp.linked) {
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
      jsonOut(out);
    })
  );

program
  .command('doctor')
  .description('Check environment prerequisites')
  .action(() =>
    run(async () => {
      const checks = {};
      checks.node = process.version;
      try {
        checks.browser = findBrowser();
      } catch (e) {
        checks.browser = null;
        checks.browserHint = e.message;
      }
      const fs = await import('node:fs');
      checks.tdata = fs.existsSync(process.env.APPDATA + '\\Telegram Desktop\\tdata');
      checks.dataDirWritable = (() => {
        try {
          ensureDirs();
          const probe = path.join(DATA_DIR, '.probe');
          fs.writeFileSync(probe, 'x');
          fs.unlinkSync(probe);
          return true;
        } catch {
          return false;
        }
      })();
      for (const dep of ['telegram', 'whatsapp-web.js', 'qrcode-terminal', 'commander']) {
        try {
          await import(dep.startsWith('qrcode') ? 'qrcode-terminal' : dep === 'telegram' ? 'telegram' : dep);
          checks['dep:' + dep] = true;
        } catch {
          checks['dep:' + dep] = false;
        }
      }
      jsonOut(checks);
    })
  );

program
  .command('list-chats')
  .description('List chats with last message time/preview')
  .option('-a, --app <app>', 'tg | wa | all', 'all')
  .option('-f, --filter <substr>', 'name substring filter', '')
  .option('-l, --limit <n>', 'max chats returned', '50')
  .option('--refresh', 'bypass cache and rebuild index')
  .option('--compact', 'one JSON line per chat')
  .action((opts) =>
    run(async () => {
      ensureDirs();
      const apps = opts.app === 'all' ? ['tg', 'wa'] : [opts.app];
      const result = {};
      for (const app of apps) {
        try {
          const mod = await core(app);
          let chats;
          if (opts.refresh) {
            chats = await mod.listChats({ filter: '', limit: 2000 });
            saveChatIndex(app, chats);
          } else {
            chats = await getChatsFor(app);
          }
          const f = String(opts.filter).toLowerCase();
          const filtered = chats.filter((c) => !f || String(c.name).toLowerCase().includes(f));
          result[app] = filtered.slice(0, Number(opts.limit));
          result[app + '_total'] = filtered.length;
        } catch (e) {
          result[app] = [];
          result[app + '_error'] = { code: e.code || 'UPSTREAM', message: e.message, hint: e.hint };
        }
      }
      if (opts.compact) {
        const lines = [];
        for (const app of apps) {
          for (const c of result[app]) lines.push(JSON.stringify(c));
        }
        process.stdout.write(lines.join('\n') + '\n');
      } else {
        jsonOut(result);
      }
    })
  );

program
  .command('get-messages')
  .description('Read messages from a chat in a date range (local time)')
  .requiredOption('--app <app>', 'tg | wa')
  .requiredOption('--chat <name-or-id>', 'chat name substring or id')
  .option('--from <date>', "start, e.g. '2026-08-01' or '7d'")
  .option('--to <date>', 'end (exclusive)')
  .option('--limit <n>', 'max messages', '200')
  .option('--search <text>', 'substring filter on text')
  .option('--has-media <bool>', 'filter by media presence', undefined)
  .option('--scan-limit <n>', 'internal scan window (wa)', '5000')
  .option('--download', 'download media of matched messages')
  .option('--out <dir>', 'download directory', DOWNLOAD_DIR)
  .option('--compact', 'one JSON per message')
  .action((opts) =>
    run(async () => {
      ensureDirs();
      const mod = await core(opts.app);
      const chats = await getChatsFor(opts.app, { refresh: true });
      const chat = matchChat(chats, opts.chat);
      const { fromTs, toTs } = normalizeRange(opts);
      const msgs = await mod.getMessages({
        chat: String(chat.id),
        from: fromTs,
        to: toTs,
        limit: Number(opts.limit),
        search: opts.search || null,
        hasMedia: opts.hasMedia == null ? null : opts.hasMedia === 'true',
        scanLimit: Number(opts.scanLimit),
      });
      let files = [];
      if (opts.download) {
        const outDir = path.join(String(opts.out), `${opts.app}-${sanitizeName(chat.name)}`);
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
      if (opts.compact) {
        process.stdout.write(msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
      } else {
        jsonOut({
          chat: { id: chat.id, name: chat.name, app: chat.app },
          range: { from: fromTs ? isoFromUnix(fromTs) : null, to: toTs ? isoFromUnix(toTs) : null },
          count: msgs.length,
          downloaded: files.length ? files : undefined,
          messages: msgs,
        });
      }
    })
  );

program
  .command('get-file')
  .description('Download media/file attached to one message')
  .requiredOption('--app <app>', 'tg | wa')
  .requiredOption('--chat <name-or-id>', 'chat name substring or id')
  .requiredOption('--message-id <id>', 'message id')
  .option('--out <dir>', 'download directory', DOWNLOAD_DIR)
  .action((opts) =>
    run(async () => {
      ensureDirs();
      const mod = await core(opts.app);
      const chats = await getChatsFor(opts.app, { refresh: true });
      const chat = matchChat(chats, opts.chat);
      const r = await mod.downloadFile({ chat: String(chat.id), messageId: opts.messageId, outDir: String(opts.out) });
      jsonOut(r);
    })
  );

program
  .command('qr-tg')
  .description('Login Telegram by scanning QR with your phone (Settings -> Devices -> Link Desktop Device)')
  .option('--api-id <id>', 'custom api id (default: official desktop)')
  .option('--api-hash <hash>', 'custom api hash')
  .action((opts) =>
    run(async () => {
      const tg = await import('./core/telegram.js');
      const res = await tg.loginQr({ apiId: opts.apiId || null, apiHash: opts.apiHash || null });
      jsonOut(res);
    })
  );

program
  .command('login-tg')
  .description('Interactive Telegram login (API id/hash from my.telegram.org)')
  .option('--api-id <id>')
  .option('--api-hash <hash>')
  .option('--phone <phone>')
  .option('--code <code>')
  .option('--password <pw>')
  .action((opts) =>
    run(async () => {
      const tg = await import('./core/telegram.js');
      const res = await tg.loginInteractive({
        apiId: opts.apiId ? Number(opts.apiId) : null,
        apiHash: opts.apiHash || null,
        phone: opts.phone || null,
        code: opts.code || null,
        password: opts.password || null,
      });
      jsonOut(res);
    })
  );

program
  .command('link-wa')
  .description('Link WhatsApp via QR code or phone pairing code (one-time)')
  .option('--pair <phone>', 'phone number digits only for pairing code flow')
  .action((opts) =>
    run(async () => {
      const wa = await import('./core/whatsapp.js');
      await wa.link({ pairPhone: opts.pair || null });
      jsonOut({ ok: true, message: 'WhatsApp linked. Session saved.' });
    })
  );

program
  .command('reset-tg')
  .description('Delete Telegram session/config')
  .action(() =>
    run(async () => {
      const fs = await import('node:fs');
      for (const f of ['tg.session.txt', 'tg-config.json']) {
        const p = path.join(DATA_DIR, f);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      jsonOut({ ok: true });
    })
  );

program
  .command('reset-wa')
  .description('Delete WhatsApp session')
  .action(() =>
    run(async () => {
      const fs = await import('node:fs');
      fs.rmSync(path.join(DATA_DIR, 'wa-auth'), { recursive: true, force: true });
      jsonOut({ ok: true });
    })
  );

program.parseAsync(process.argv).catch(die);
