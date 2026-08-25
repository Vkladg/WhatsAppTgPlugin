import fs from 'node:fs';
import path from 'node:path';
import { resolveDataFile, ensureDirs } from './util.js';

export function readJson(file, fallback = null) {
  const p = resolveDataFile(file);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, obj) {
  ensureDirs();
  const p = resolveDataFile(file);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

export function loadChatIndex(app) {
  return readJson(`index-${app}.json`, null);
}

export function saveChatIndex(app, chats) {
  return writeJson(`index-${app}.json`, { savedAt: Date.now(), chats });
}

export function kvGet(key, fallback = null) {
  const kv = readJson('kv.json', {});
  return key in kv ? kv[key] : fallback;
}

export function kvSet(key, value) {
  const kv = readJson('kv.json', {});
  kv[key] = value;
  writeJson('kv.json', kv);
}
