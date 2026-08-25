import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { DATA_DIR, DOWNLOAD_DIR, ensureDirs, log, WtError, isoFromUnix, truncate, sanitizeName } from '../util.js';
import { readJson, writeJson } from '../store.js';

const SESSION_FILE = 'tg.session.txt';
const CONFIG_FILE = 'tg-config.json';
const DESKTOP_API_ID = 2040;
const DESKTOP_API_HASH = 'b18441a1ff607e10a989891a5462e627';

let client = null;
const chatEntities = new Map();
const senderNames = new Map();

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
};

function sessionPath() {
  return path.join(DATA_DIR, SESSION_FILE);
}

function readSessionString() {
  try {
    const s = fs.readFileSync(sessionPath(), 'utf8').trim();
    return s || null;
  } catch {
    return null;
  }
}

function idStr(v) {
  if (v == null) return null;
  try {
    return String(typeof v.toString === 'function' ? v.toString() : v);
  } catch {
    return String(v);
  }
}

function displayName(e) {
  if (!e) return '';
  return (
    e.title ||
    [e.firstName, e.lastName].filter(Boolean).join(' ') ||
    e.username ||
    idStr(e.id) ||
    ''
  );
}

function normalizeLimit(n, def) {
  const num = Number(n);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : def;
}

function unixOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new WtError('INVALID_ARG', `Invalid unix timestamp: ${v}`);
  return n;
}

function chatTypeOf(entity) {
  if (entity instanceof Api.User) return entity.bot ? 'bot' : 'private';
  if (entity instanceof Api.Channel) return entity.megagroup ? 'group' : 'channel';
  if (entity instanceof Api.Chat || entity instanceof Api.ChatForbidden) return 'group';
  return 'private';
}

function chatFromDialog(d) {
  const e = d.entity;
  return {
    id: idStr(d.id),
    app: 'tg',
    name: d.title || d.name || displayName(e),
    type: chatTypeOf(e),
    lastMessageAt: isoFromUnix(d.date),
    lastMessagePreview: d.message && d.message.message ? truncate(d.message.message, 120) : null,
  };
}

function mediaInfo(msg) {
  if (!msg.media) return { mime: null, fileName: null };
  const doc = msg.document;
  if (doc) {
    let fileName = null;
    for (const a of doc.attributes || []) {
      if (a instanceof Api.DocumentAttributeFilename && a.fileName) fileName = a.fileName;
    }
    return { mime: doc.mimeType || null, fileName };
  }
  if (msg.photo) return { mime: 'image/jpeg', fileName: null };
  return { mime: null, fileName: null };
}

async function resolveById(c, id) {
  if (chatEntities.has(id)) return chatEntities.get(id);
  try {
    const num = Number(id);
    const e = await c.getEntity(num);
    chatEntities.set(id, e);
    return e;
  } catch {
    throw new WtError('CHAT_NOT_FOUND', `Cannot resolve chat id ${id}`, 'Run list-chats first so the chat entity gets cached');
  }
}

async function findChat(c, chat) {
  if (chat == null || String(chat).trim() === '') {
    throw new WtError('INVALID_ARG', 'Chat query is required', 'Pass chat name substring or exact numeric id from list-chats');
  }
  const s = String(chat).trim();
  if (/^-?\d+$/.test(s)) {
    const e = await resolveById(c, s);
    return { id: s, name: displayName(e), input: await c.getInputEntity(e) };
  }
  const q = s.toLowerCase();
  const matches = [];
  for await (const d of c.iterDialogs({ limit: 2000 })) {
    const nm = d.title || d.name || '';
    if (nm.toLowerCase().includes(q)) {
      const id = idStr(d.id);
      if (d.entity) chatEntities.set(id, d.entity);
      matches.push({ id, name: d.title || d.name || '', entity: d.entity });
      if (matches.length >= 6) break;
    }
  }
  if (matches.length === 0) {
    throw new WtError('CHAT_NOT_FOUND', `No chat matching "${s}"`, 'Run list-chats to see available chats');
  }
  if (matches.length > 1) {
    throw new WtError(
      'AMBIGUOUS_CHAT',
      `Multiple chats match "${s}": ${matches.map((m) => m.name).join(', ')}`,
      'Use exact chat id from list-chats'
    );
  }
  const m = matches[0];
  return { id: m.id, name: m.name, input: await c.getInputEntity(m.entity) };
}

async function toMsg(msg, chatId, chatName) {
  const sid = idStr(msg.senderId) ?? '';
  let sender = '';
  if (sid && senderNames.has(sid)) {
    sender = senderNames.get(sid);
  } else {
    try {
      const s = await msg.getSender();
      if (s) sender = displayName(s);
    } catch {}
    if (!sender && msg.postAuthor) sender = msg.postAuthor;
    if (sid) senderNames.set(sid, sender);
  }
  const info = mediaInfo(msg);
  return {
    id: String(msg.id),
    chatId,
    chatName,
    sender,
    senderId: sid,
    dateISO: isoFromUnix(msg.date),
    timestamp: Number(msg.date),
    text: msg.message || '',
    hasMedia: !!msg.media,
    mediaMime: info.mime,
    fileName: info.fileName,
    outgoing: !!msg.out,
    replyToId: msg.replyTo && msg.replyTo.replyToMsgId != null ? String(msg.replyTo.replyToMsgId) : null,
  };
}

export async function ensureConfigured() {
  const cfg = readJson(CONFIG_FILE, null);
  const configured = Boolean(readSessionString() && cfg && cfg.apiId && cfg.apiHash);
  return { configured, hint: configured ? '' : 'Run: npm run qr:tg (or npm run login:tg)' };
}

export async function connect() {
  if (client) return client;
  const cfg = readJson(CONFIG_FILE, null);
  const sessionStr = readSessionString();
  if (!sessionStr || !cfg || !cfg.apiId || !cfg.apiHash) {
    throw new WtError('AUTH_REQUIRED', 'Telegram is not logged in', 'Run: npm run qr:tg (or npm run login:tg)');
  }
  const c = new TelegramClient(new StringSession(sessionStr), Number(cfg.apiId), String(cfg.apiHash), {
    connectionRetries: 5,
    retryDelay: 1500,
  });
  await c.connect();
  client = c;
  log('telegram connected');
  return client;
}

export async function disconnect() {
  if (!client) return;
  try {
    await client.disconnect();
  } catch (e) {
    log('telegram disconnect failed:', (e && e.message) || e);
  }
  client = null;
}

export async function me() {
  const c = await connect();
  const u = await c.getMe();
  return {
    id: idStr(u.id),
    name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || '',
    username: u.username || null,
    phone: u.phone || null,
  };
}

export async function listChats({ filter = '', limit = 50 } = {}) {
  const c = await connect();
  const lim = normalizeLimit(limit, 50);
  const fetchCap = Math.min(Math.max(lim * 3, 50), 2000);
  const q = String(filter || '').trim().toLowerCase();
  const entries = [];
  for await (const d of c.iterDialogs({ limit: fetchCap })) {
    const chat = chatFromDialog(d);
    if (!chat.id) continue;
    if (d.entity) chatEntities.set(chat.id, d.entity);
    if (!q || chat.name.toLowerCase().includes(q)) {
      entries.push({ chat, ts: d.date ? Number(d.date) : 0 });
    }
  }
  entries.sort((a, b) => b.ts - a.ts);
  return entries.slice(0, lim).map((x) => x.chat);
}

export async function getMessages({ chat, from = null, to = null, limit = 200, search = null, hasMedia = null } = {}) {
  const c = await connect();
  const target = await findChat(c, chat);
  const lim = normalizeLimit(limit, 200);
  const fromTs = unixOrNull(from);
  const toTs = unixOrNull(to);
  const q = search == null || search === '' ? null : String(search).toLowerCase();
  const wantMedia = hasMedia == null ? null : Boolean(hasMedia);
  const out = [];
  let scanned = 0;
  for await (const msg of c.iterMessages(target.input, { offsetDate: toTs == null ? undefined : toTs })) {
    scanned++;
    const ts = Number(msg.date);
    if (fromTs != null && ts < fromTs) break;
    let keep = true;
    if (q != null && !(msg.message || '').toLowerCase().includes(q)) keep = false;
    if (keep && wantMedia != null && Boolean(msg.media) !== wantMedia) keep = false;
    if (keep) out.push(await toMsg(msg, target.id, target.name));
    if (out.length >= lim || scanned >= 20000) break;
  }
  return out;
}

export async function downloadFile({ chat, messageId, outDir } = {}) {
  const c = await connect();
  const target = await findChat(c, chat);
  const mid = Number(messageId);
  if (!Number.isInteger(mid) || mid <= 0) {
    throw new WtError('INVALID_ARG', `Invalid messageId: ${messageId}`);
  }
  const res = await c.getMessages(target.input, { ids: [mid] });
  const msg = res && res.length ? res[0] : null;
  if (!msg || !msg.media) {
    throw new WtError('NO_MESSAGE', `Message ${mid} has no media`);
  }
  const buf = await c.downloadMedia(msg, {});
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw new WtError('MEDIA_ERROR', `Failed to download media of message ${mid}`);
  }
  const info = mediaInfo(msg);
  const fileName = sanitizeName(info.fileName || mid + (EXT_BY_MIME[info.mime] || ''));
  const dir = outDir ? path.resolve(String(outDir)) : DOWNLOAD_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const savedPath = path.join(dir, fileName);
  fs.writeFileSync(savedPath, buf);
  log('saved', savedPath, buf.length, 'bytes');
  return { savedPath, fileName, sizeBytes: buf.length };
}

export async function loginQr({ apiId = null, apiHash = null, timeoutMs = 240000 } = {}) {
  const aid = apiId ? Number(apiId) : DESKTOP_API_ID;
  const ahash = apiHash ? String(apiHash) : DESKTOP_API_HASH;
  writeJson(CONFIG_FILE, { apiId: aid, apiHash: ahash });
  const lc = new TelegramClient(new StringSession(''), aid, ahash, { connectionRetries: 3 });
  await lc.connect();
  try {
    const qrt = (await import('qrcode-terminal')).default;
    const deadline = Date.now() + Number(timeoutMs);
    let printed = false;
    while (Date.now() < deadline) {
      let res;
      try {
        res = await lc.invoke(new Api.auth.ExportLoginToken({ apiId: aid, apiHash: ahash, exceptIds: [] }));
      } catch (e) {
        if (e && e.errorMessage === 'SESSION_PASSWORD_NEEDED') {
          throw new WtError('AUTH_REQUIRED', 'This account has 2FA; use: npm run login:tg', 'Password login required for 2FA accounts');
        }
        throw e;
      }
      if (res instanceof Api.auth.LoginTokenSuccess) {
        const u = res.authorization && res.authorization.user ? res.authorization.user : await lc.getMe();
        const sessionStr = String(lc.session.save());
        ensureDirs();
        fs.writeFileSync(sessionPath(), sessionStr, 'utf8');
        return {
          ok: true,
          me: {
            id: idStr(u.id),
            name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || '',
            username: u.username || null,
            phone: u.phone || null,
          },
        };
      }
      const isPending =
        res instanceof Api.auth.LoginToken ||
        (Api.auth.LoginTokenRetry && res instanceof Api.auth.LoginTokenRetry);
      if (isPending && res.token) {
        if (!printed) {
          const url = 'tg://login?token=' + Buffer.from(res.token).toString('base64url');
          process.stdout.write('\nScan with your phone Telegram app:\nSettings -> Devices -> Link Desktop Device\n\n');
          qrt.generate(url, { small: true }, (q) => process.stdout.write(q + '\n'));
          process.stdout.write('\nWaiting for scan...\n');
          printed = true;
        } else {
          process.stdout.write('.');
        }
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (res instanceof Api.auth.LoginTokenMigrateTo) {
        await lc._switchDC(res.dcId);
        res = await lc.invoke(new Api.auth.ImportLoginToken({ token: res.token }));
        if (res instanceof Api.auth.LoginTokenSuccess) {
          const u = res.authorization && res.authorization.user ? res.authorization.user : await lc.getMe();
          const sessionStr = String(lc.session.save());
          ensureDirs();
          fs.writeFileSync(sessionPath(), sessionStr, 'utf8');
          return {
            ok: true,
            me: {
              id: idStr(u.id),
              name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || '',
              username: u.username || null,
              phone: u.phone || null,
            },
          };
        }
        continue;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new WtError('UPSTREAM', 'QR login timed out', 'Rerun: npm run qr:tg');
  } finally {
    try {
      await lc.disconnect();
    } catch {}
  }
}

function ask(rl, prompt) {
  return rl.question('[wt] ' + prompt);
}

export async function loginInteractive({ apiId, apiHash, phone, code, password } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    if (apiId == null || apiId === '') apiId = await ask(rl, 'Api ID (from my.telegram.org): ');
    if (apiHash == null || apiHash === '') apiHash = await ask(rl, 'Api hash: ');
    if (phone == null || phone === '') phone = await ask(rl, 'Phone number (international format, e.g. 79991234567): ');
    apiId = Number(apiId);
    apiHash = String(apiHash);
    if (!Number.isFinite(apiId) || apiId <= 0) throw new WtError('INVALID_ARG', `Invalid apiId: ${apiId}`);
    writeJson(CONFIG_FILE, { apiId, apiHash });
    const lc = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
    await lc.connect();
    try {
      await lc.signInUser(
        { apiId, apiHash },
        {
          phoneNumber: async () => String(phone),
          phoneCode: async () => (code != null && code !== '' ? String(code) : ask(rl, 'Login code: ')),
          password: async (hint) =>
            password != null && password !== '' ? String(password) : ask(rl, `2FA password${hint ? ` (${hint})` : ''}: `),
          onError: async (err) => {
            log('auth:', (err && err.message) || err);
            return false;
          },
        }
      );
      const meUser = await lc.getMe();
      const sessionStr = String(lc.session.save());
      ensureDirs();
      fs.writeFileSync(sessionPath(), sessionStr, 'utf8');
      return {
        ok: true,
        me: {
          id: idStr(meUser.id),
          name: [meUser.firstName, meUser.lastName].filter(Boolean).join(' ') || meUser.username || '',
          username: meUser.username || null,
          phone: meUser.phone || null,
        },
      };
    } finally {
      try {
        await lc.disconnect();
      } catch {}
    }
  } finally {
    rl.close();
  }
}
