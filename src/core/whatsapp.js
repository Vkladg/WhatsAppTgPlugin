import path from 'node:path';
import fs from 'node:fs';
import wwjs from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { DATA_DIR, WtError, log, isoFromUnix, findBrowser, sanitizeName, truncate } from '../util.js';

const { Client, LocalAuth } = wwjs;

const AUTH_DIR = path.join(DATA_DIR, 'wa-auth');
const CLIENT_ID = 'default';
const SESSION_DIR_NAME = `session-${CLIENT_ID}`;
const CONNECT_TIMEOUT_MS = 90000;
const LINK_TIMEOUT_MS = 300000;
const DOWNLOAD_SCAN_LIMIT = 20000;

let client = null;
let connectPromise = null;
let exitHookInstalled = false;
const contactNameCache = new Map();

function ensureExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    try {
      if (client && typeof client.destroy === 'function') client.destroy();
    } catch {}
  });
}

function createClient() {
  ensureExitHook();
  return new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_DIR, clientId: CLIENT_ID }),
    puppeteer: {
      headless: true,
      executablePath: findBrowser(),
      args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
    },
    webVersionCache: { type: 'local' },
  });
}

export async function isLinked() {
  try {
    return JSON.parse(fs.readFileSync(path.join(AUTH_DIR, 'linked.json'), 'utf8')).linked === true;
  } catch {
    return false;
  }
}

function markLinked() {
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(path.join(AUTH_DIR, 'linked.json'), JSON.stringify({ linked: true, linkedAt: new Date().toISOString() }));
  } catch (err) {
    log(`Failed to write link marker: ${err?.message || err}`);
  }
}

async function doConnect() {
  return new Promise((resolve, reject) => {
    const c = createClient();
    let settled = false;
    let timer = null;

    function finish(err, value) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { c.removeListener('qr', onQr); } catch {}
      try { c.removeListener('auth_failure', onAuthFailure); } catch {}
      try { c.removeListener('ready', onReady); } catch {}
      if (err) {
        try { c.destroy().catch(() => {}); } catch {}
        reject(err);
      } else {
        resolve(value);
      }
    }

    function onReady() {
      if (client === c) return finish(null, c);
      client = c;
      markLinked();
      log(`WhatsApp connected as ${c.info?.wid?._serialized ?? 'unknown'}`);
      finish(null, c);
    }

    function onAuthFailure(message) {
      finish(new WtError('UPSTREAM', `WhatsApp authentication failed${message ? `: ${message}` : ''}`, "Session may be stale; run 'wt reset-wa' then 'wt link-wa'"));
    }

    function onQr() {
      log('WhatsApp session missing or expired: run "wt link-wa" to scan a QR code or use a pairing code');
    }

    timer = setTimeout(() => finish(new WtError('UPSTREAM', 'WhatsApp client did not become ready within 90s', "Run 'wt link-wa' to relink")), CONNECT_TIMEOUT_MS);
    c.on('qr', onQr);
    c.on('auth_failure', onAuthFailure);
    c.on('ready', onReady);
    c.initialize().catch((err) => finish(new WtError('UPSTREAM', `Failed to start WhatsApp client: ${err.message}`)));
  });
}

export async function connect() {
  if (client) return client;
  if (!(await isLinked())) {
    throw new WtError('AUTH_REQUIRED', 'WhatsApp is not linked', "Run 'npm run link:wa' to scan QR or use pairing code");
  }
  if (!connectPromise) {
    connectPromise = doConnect().catch((err) => {
      connectPromise = null;
      throw err;
    });
  }
  return connectPromise;
}

export async function disconnect() {
  const c = client;
  client = null;
  connectPromise = null;
  contactNameCache.clear();
  if (!c) return;
  try {
    await c.destroy();
  } catch (err) {
    log(`WhatsApp destroy failed: ${err?.message || err}`);
  }
}

export async function me() {
  const c = await connect();
  const info = c.info;
  if (!info || !info.wid) throw new WtError('AUTH_REQUIRED', 'WhatsApp client is not authenticated yet');
  return {
    id: info.wid._serialized,
    name: info.pushname,
    pushname: info.pushname,
    phone: info.wid.user,
  };
}

function chatType(ch) {
  if (ch.isGroup) return 'group';
  const id = ch.id?._serialized || '';
  if (/^[\d-]+@newsletter$/.test(id)) return 'channel';
  if (/status@broadcast$/.test(id)) return 'channel';
  return 'private';
}

export async function listChats({ filter = '', limit = 50 } = {}) {
  const c = await connect();
  const chats = await c.getChats();
  const needle = String(filter || '').toLowerCase();
  const rows = chats.map((ch) => {
    const ts = Number.isFinite(ch.timestamp) ? ch.timestamp : (ch.lastMessage?.timestamp ?? null);
    const previewBody = ch.lastMessage ? String(ch.lastMessage.body ?? '').replace(/\s*\n+\s*/g, ' ').trim() : '';
    return {
      ts,
      chat: {
        id: ch.id._serialized,
        app: 'wa',
        name: String(ch.name || '').trim(),
        type: chatType(ch),
        lastMessageAt: isoFromUnix(ts),
        lastMessagePreview: previewBody ? truncate(previewBody, 120) : null,
      },
    };
  });
  rows.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  return rows
    .filter((r) => !needle || r.chat.name.toLowerCase().includes(needle))
    .slice(0, Math.max(1, Number(limit) || 50))
    .map((r) => r.chat);
}

async function resolveChat(query) {
  if (!query || typeof query !== 'string') throw new WtError('INVALID_ARG', 'chat query is required', "Pass a chat name substring or an exact id like '4915xxxxxxx@c.us'");
  const c = await connect();
  const chats = await c.getChats();
  const exact = chats.find((ch) => ch.id && ch.id._serialized === query);
  if (exact) return exact;
  const needle = query.trim().toLowerCase();
  const matches = chats.filter((ch) => String(ch.name || '').toLowerCase().includes(needle));
  if (matches.length === 0) {
    throw new WtError('CHAT_NOT_FOUND', `No WhatsApp chat matching "${query}"`, 'Use wt list-chats -a wa to see available chats');
  }
  if (matches.length > 1) {
    const candidates = matches.slice(0, 10).map((ch) => `${ch.name || ch.id._serialized} (${ch.id._serialized})`).join('; ');
    throw new WtError('AMBIGUOUS_CHAT', `${matches.length} WhatsApp chats match "${query}"`, `Candidates: ${candidates}`);
  }
  return matches[0];
}

function replyToIdOf(m) {
  try {
    const qid = m?._data?.quotedMsg?.id?._serialized ?? m?._data?.quotedMsg?.id ?? m?._data?.quotedStanzaID ?? null;
    return typeof qid === 'string' && qid ? qid : null;
  } catch {
    return null;
  }
}

async function senderDisplayName(m, chatIsGroup) {
  if (m.fromMe) return 'me';
  const jid = m.author || m.from || '?';
  if (contactNameCache.has(jid)) return contactNameCache.get(jid);
  let name = '';
  if (chatIsGroup || m.author) {
    try {
      const contact = await m.getContact();
      name = contact.pushname || contact.formattedName || contact.name || contact.number || jid.split('@')[0] || '';
    } catch {
      name = '';
    }
  } else {
    name = '';
  }
  if (!name) {
    try {
      const contact = await m.getContact();
      name = contact.pushname || contact.formattedName || contact.name || '';
    } catch {}
  }
  contactNameCache.set(jid, name);
  return name;
}

export async function getMessages({ chat, from = null, to = null, limit = 200, search = null, hasMedia = null, scanLimit = 5000 }) {
  if (!chat) throw new WtError('INVALID_ARG', 'chat is required');
  const chatInst = await resolveChat(chat);
  const scanCap = Math.max(Number(scanLimit) || 5000, Number(limit) || 200);
  let fetched;
  try {
    fetched = await chatInst.fetchMessages({ limit: scanCap });
  } catch (err) {
    throw new WtError('UPSTREAM', `fetchMessages failed for "${chatInst.name || chatInst.id._serialized}": ${err?.message || err}`);
  }
  const fromTs = from == null ? null : Number(from);
  const toTs = to == null ? null : Number(to);
  const needle = search == null || search === '' ? null : String(search).toLowerCase();
  const mediaFilter = hasMedia == null ? null : Boolean(hasMedia);
  const filtered = [];
  for (const m of fetched) {
    const ts = Number(m.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (fromTs != null && ts < fromTs) continue;
    if (toTs != null && ts >= toTs) continue;
    if (needle != null && !String(m.body || '').toLowerCase().includes(needle)) continue;
    if (mediaFilter != null && !!m.hasMedia !== mediaFilter) continue;
    filtered.push(m);
  }
  filtered.sort((a, b) => b.timestamp - a.timestamp);
  const capped = filtered.slice(0, Math.max(1, Number(limit) || 200));
  const isGroupChat = !!chatInst.isGroup;
  const out = [];
  for (const m of capped) {
    out.push({
      id: m.id._serialized,
      chatId: chatInst.id._serialized,
      chatName: String(chatInst.name || ''),
      sender: await senderDisplayName(m, isGroupChat),
      senderId: m.author || m.from || '',
      dateISO: isoFromUnix(m.timestamp),
      timestamp: Number(m.timestamp),
      text: m.body || '',
      hasMedia: !!m.hasMedia,
      mediaMime: m?._data?.mimetype || null,
      fileName: m?._data?.filename || m?._data?.filename?.vcard || null,
      outgoing: !!m.fromMe,
      replyToId: replyToIdOf(m),
    });
  }
  return out;
}

function extForMime(mime) {
  const table = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/amr': '.amr',
    'application/pdf': '.pdf',
    'application/zip': '.zip',
    'text/plain': '.txt',
    'text/vcard': '.vcf',
  };
  const key = String(mime || '').toLowerCase().split(';')[0].trim();
  return table[key] || '';
}

export async function downloadFile({ chat, messageId, outDir }) {
  if (!messageId || typeof messageId !== 'string') throw new WtError('INVALID_ARG', 'messageId is required');
  if (!outDir) throw new WtError('INVALID_ARG', 'outDir is required');
  const chatInst = await resolveChat(chat);
  let fetched;
  try {
    fetched = await chatInst.fetchMessages({ limit: DOWNLOAD_SCAN_LIMIT });
  } catch (err) {
    throw new WtError('UPSTREAM', `fetchMessages failed for "${chatInst.name || chatInst.id._serialized}": ${err?.message || err}`);
  }
  const msg = fetched.find((m) => m?.id?._serialized === messageId);
  if (!msg) throw new WtError('NO_MESSAGE', `Message ${messageId} not found in "${chatInst.name || chatInst.id._serialized}"`, 'The message may be older than the scanned history');
  if (!msg.hasMedia) throw new WtError('MEDIA_ERROR', 'message has no media');
  let md;
  try {
    md = await msg.downloadMedia();
  } catch (err) {
    throw new WtError('MEDIA_ERROR', `Media download failed: ${err?.message || err}`);
  }
  if (!md || !md.data) throw new WtError('MEDIA_ERROR', 'Media unavailable (expired or could not be re-fetched)');
  fs.mkdirSync(outDir, { recursive: true });
  const rawName = md.filename || msg._data?.filename || `${sanitizeName(messageId)}${extForMime(md.mimetype)}`;
  const fileName = sanitizeName(rawName);
  const savedPath = path.join(outDir, fileName);
  fs.writeFileSync(savedPath, Buffer.from(md.data, 'base64'));
  const sizeBytes = fs.statSync(savedPath).size;
  return { savedPath, fileName, sizeBytes };
}

export async function link({ pairPhone = null } = {}) {
  if (client) {
    log('WhatsApp client already linked and connected');
    return;
  }
  const digits = pairPhone ? String(pairPhone).replace(/\D/g, '') : null;
  if (pairPhone && digits.length < 6) throw new WtError('INVALID_ARG', `Invalid pairing phone: ${pairPhone}`, "Use international format without '+', e.g. 79991234567");
  connectPromise = null;
  return new Promise((resolve, reject) => {
    const c = createClient();
    let settled = false;
    let timer = null;

    function finish(err, value) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { c.removeListener('qr', onQr); } catch {}
      try { c.removeListener('code', onCode); } catch {}
      try { c.removeListener('auth_failure', onAuthFailure); } catch {}
      try { c.removeListener('ready', onReady); } catch {}
      if (err) {
        try { c.destroy().catch(() => {}); } catch {}
        reject(err);
      } else {
        client = value;
        resolve(value);
      }
    }

    function onReady() {
      markLinked();
      log(`WhatsApp linked as ${c.info?.wid?._serialized ?? 'unknown'}`);
      finish(null, c);
    }

    function onAuthFailure(message) {
      finish(new WtError('UPSTREAM', `WhatsApp linking failed${message ? `: ${message}` : ''}`));
    }

    async function requestPairing() {
      if (!digits) return;
      if (typeof c.requestPairingCode !== 'function') {
        finish(new WtError('UPSTREAM', 'installed whatsapp-web.js does not expose requestPairingCode'));
        return;
      }
      const code = await c.requestPairingCode(digits);
      const pretty = String(code).replace(/[^A-Za-z0-9]/g, '').toUpperCase().replace(/^(.{4})(.{4})$/, '$1-$2');
      process.stdout.write(`PAIRING CODE: ${pretty}\n`);
      process.stdout.write('Enter this code on the phone: WhatsApp > Linked devices > Link a device > Link with phone number\n');
    }

    function onQr(qr) {
      if (digits) {
        requestPairing().catch((err) => finish(new WtError('UPSTREAM', `Pairing code request failed: ${err?.message || err}`)));
        return;
      }
      process.stdout.write('\nScan this QR code with WhatsApp (Settings > Linked devices > Link a device):\n');
      qrcode.generate(qr, { small: true });
    }

    function onCode(code) {
      const pretty = String(code).replace(/[^A-Za-z0-9]/g, '').toUpperCase().replace(/^(.{4})(.{4})$/, '$1-$2');
      process.stdout.write(`PAIRING CODE: ${pretty}\n`);
      process.stdout.write('Enter this code on the phone: WhatsApp > Linked devices > Link a device > Link with phone number\n');
    }

    c.on('qr', onQr);
    c.on('code', onCode);
    c.on('auth_failure', onAuthFailure);
    c.on('ready', onReady);
    timer = setTimeout(() => finish(new WtError('UPSTREAM', 'Linking timed out after 300s without reaching ready state')), LINK_TIMEOUT_MS);
    log('Launching WhatsApp Web for linking...');
    c.initialize().catch((err) => finish(new WtError('UPSTREAM', `Failed to launch WhatsApp client: ${err?.message || err}`)));
  }).then((linkedClient) => {
    connectPromise = Promise.resolve(linkedClient);
    try {
      const who = linkedClient.info?.pushname || linkedClient.info?.wid?._serialized;
      process.stdout.write(`LINKED OK: ${who}\n`);
    } catch {}
  });
}
