// HTTP サーバーの共通部品（エラー型・JSON の読み書き・本文の読み取り・静的配信）。
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join, dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

export const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
export const MAX_BODY = 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.mjs': 'text/javascript; charset=utf-8',
};
export const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; connect-src 'self' wss://generativelanguage.googleapis.com; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'",
};

export class HttpError extends Error {
  /** code は画面が分岐に使う決まった文字列（例: quota_survey）。無ければ null。 */
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

const tails = new Map(); // file -> 直前の書き込み（同じファイルへの書き込みは呼び出し順に直列化する）

/** 一時ファイルに書いてから置き換える。同じファイルへの同時書き込みは呼び出し順に実行する。 */
export function writeJson(file, value) {
  const body = JSON.stringify(value, null, 2);
  const run = async () => {
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, file);
  };
  const next = (tails.get(file) ?? Promise.resolve()).then(run, run);
  tails.set(file, next.catch(() => {}));
  return next;
}

export async function readBody(req, max = MAX_BODY) {
  const label = `${Math.round(max / 1024 / 1024)}MB`;
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > max) throw new HttpError(413, `本文が ${label} を超えている`);
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new HttpError(413, `本文が ${label} を超えている`);
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'JSON として読めない'); }
}

export function sendJson(res, status, value) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

export async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = resolve(WEB, rel);
  const type = TYPES[extname(file)];
  if (!file.startsWith(WEB + sep) || !type) throw new HttpError(404, 'not found');
  let body;
  try { body = await readFile(file); } catch { throw new HttpError(404, 'not found'); }
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type });
  res.end(body);
}
