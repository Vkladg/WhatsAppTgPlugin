import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.WT_DATA_DIR ? path.resolve(process.env.WT_DATA_DIR) : path.join(ROOT, 'data');
export const DOWNLOAD_DIR = process.env.WT_DOWNLOAD_DIR ? path.resolve(process.env.WT_DOWNLOAD_DIR) : path.join(ROOT, 'downloads');

export function ensureDirs() {
  for (const d of [DATA_DIR, DOWNLOAD_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function log(...args) {
  process.stderr.write('[wt] ' + args.map(String).join(' ') + '\n');
}

export class WtError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function isoFromUnix(secOrMs) {
  if (secOrMs == null) return null;
  let ms = Number(secOrMs);
  if (ms > 1e12) ms = ms;
  else ms = ms * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const DAY = 86400;

function startOfDay(tsSec) {
  const d = new Date(tsSec * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export function parseDateArg(str) {
  if (str == null || str === '') return { fromTs: null, toTs: null };
  const s = String(str).trim();
  if (/^\d{9,13}$/.test(s)) {
    const n = Number(s);
    const sec = n > 1e12 ? Math.floor(n / 1000) : n;
    return { fromTs: sec, toTs: sec + 1 };
  }
  const now = Math.floor(Date.now() / 1000);
  const low = s.toLowerCase();
  if (low === 'today') return { fromTs: startOfDay(now), toTs: startOfDay(now) + DAY };
  if (low === 'yesterday') return { fromTs: startOfDay(now) - DAY, toTs: startOfDay(now) };
  const mRel = low.match(/^(\d+)d$/);
  if (mRel) return { fromTs: now - Number(mRel[1]) * DAY, toTs: null };
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const from = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
    const fromTs = Math.floor(from.getTime() / 1000);
    return { fromTs, toTs: fromTs + DAY };
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0), 0);
    const ts = Math.floor(d.getTime() / 1000);
    return { fromTs: ts, toTs: ts + 1 };
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const ts = Math.floor(d.getTime() / 1000);
    return { fromTs: ts, toTs: ts + 1 };
  }
  throw new WtError('INVALID_ARG', `Cannot parse date: "${s}"`, "Use '2026-08-01', '2026-08-01 14:30', 'today', 'yesterday', '7d'");
}

export function sanitizeName(s) {
  const raw = String(s || 'unknown').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim();
  const extMatch = raw.match(/(\.[A-Za-z0-9]{1,8})$/);
  const ext = extMatch ? extMatch[1] : '';
  const base = ext ? raw.slice(0, raw.length - ext.length) : raw;
  return ((base.slice(0, 120) || 'unknown') + ext) || 'unknown';
}

export function truncate(s, n = 80) {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

const WIN_BROWSERS = [
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const MAC_BROWSERS = [
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

const LINUX_BROWSERS = [
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

export function findBrowser() {
  const candidates =
    process.platform === 'darwin' ? MAC_BROWSERS : process.platform === 'linux' ? LINUX_BROWSERS : WIN_BROWSERS;
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  throw new WtError('UPSTREAM', `No Edge or Chrome found for WhatsApp automation (${process.platform})`, 'Install Microsoft Edge or Google Chrome');
}

export function jsonOut(obj, pretty = true) {
  process.stdout.write(JSON.stringify(obj, null, pretty ? 2 : 0) + '\n');
}

export function resolveDataFile(name) {
  if (path.isAbsolute(name)) return name;
  return path.join(DATA_DIR, name);
}
