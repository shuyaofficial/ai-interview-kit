// 無料枠と端末の識別。ログインは作らない。初回に乱数の端末 ID を Cookie で渡し、data/quota/<端末ID>.json に { used, bonus, sessions[], surveyDoneAt } を持つ。個人情報は入れない。
// 数える単位: 音声の面接セッションが終了し、応募者の発言が1件以上あったもの（接続に失敗したもの・ES 添削・ES 読み取り・クセチェックは数えない）。
import { readFileSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HttpError, readJson, writeJson } from './http-util.mjs';

export const DEVICE_COOKIE = 'iv_device';
export const DEVICE_RE = /^[a-f0-9]{32}$/;
export const QUOTA_CODES = Object.freeze({ survey: 'quota_survey', plan: 'quota_plan' });
const YEAR_SEC = 60 * 60 * 24 * 365;

/** 設定: quota.json の freeInterviews（既定 1）。環境変数 QUOTA_DISABLED=1 で無効。 */
export function loadQuotaConfig({ file, env = process.env, override = null } = {}) {
  let freeInterviews = 1;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (Number.isInteger(raw.freeInterviews) && raw.freeInterviews >= 0) freeInterviews = raw.freeInterviews;
  } catch { /* 読めなければ既定値 */ }
  const base = { freeInterviews, enabled: env.QUOTA_DISABLED !== '1' };
  return override ? { ...base, ...override } : base;
}

// ---- 端末 ID（Cookie）----

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export const deviceFrom = (req) => {
  const id = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
  return DEVICE_RE.test(id ?? '') ? id : null;
};

/** 127.0.0.1 / localhost 以外（tailscale serve --https 経由）か、https 経由の転送なら Secure を付ける。 */
export function isSecure(req) {
  if (String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https') return true;
  return !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(req.headers.host ?? ''));
}

export function deviceCookie(id, secure) {
  return `${DEVICE_COOKIE}=${id}; Path=/; Max-Age=${YEAR_SEC}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

/** 端末 ID を返す。まだ無ければ新しく作り、set-cookie を res に積む（writeHead より前に呼ぶ）。 */
export function ensureDevice(req, res) {
  const known = deviceFrom(req);
  if (known) return known;
  const id = randomBytes(16).toString('hex');
  res.setHeader('set-cookie', deviceCookie(id, isSecure(req)));
  return id;
}

// ---- 端末ごとのファイル ----

const blank = () => ({ used: 0, bonus: 0, sessions: [], surveyDoneAt: null });

export function createQuotaStore(dir) {
  const fileOf = (id) => {
    if (!DEVICE_RE.test(id)) throw new Error('端末IDの形が不正（英小文字と数字の32文字）');
    return join(dir, `${id}.json`);
  };
  const tails = new Map();
  const locked = (id, fn) => {
    const next = (tails.get(id) ?? Promise.resolve()).then(fn, fn);
    tails.set(id, next.catch(() => {}));
    return next;
  };
  const read = async (id) => ({ ...blank(), ...(await readJson(fileOf(id))) });
  const update = (id, change) => locked(id, async () => {
    await mkdir(dir, { recursive: true });
    const next = change(await read(id));
    await writeJson(fileOf(id), next);
    return next;
  });
  return {
    read,
    /** 数える。同じセッションは1回だけ。 */
    record: (id, sessionId) => update(id, (d) => (d.sessions.some((s) => s.id === sessionId)
      ? d
      : { ...d, used: d.used + 1, sessions: [...d.sessions, { id: sessionId, at: new Date().toISOString() }] })),
    markSurvey: (id) => update(id, (d) => ({ ...d, surveyDoneAt: d.surveyDoneAt ?? new Date().toISOString() })),
    grant: (id, n) => update(id, (d) => ({ ...d, bonus: d.bonus + n })),
    async list() {
      let names = [];
      try { names = (await readdir(dir)).filter((f) => f.endsWith('.json')); } catch { return []; }
      return Promise.all(names.map(async (f) => ({ device: f.slice(0, -5), ...(await readJson(join(dir, f))) })));
    },
    /** id を指定した端末だけ、または null で全端末のファイルを消す（無料枠が元に戻る）。消した端末の ID を返す。 */
    async reset(id) {
      const ids = id ? [id] : (await this.list()).map((d) => d.device);
      await Promise.all(ids.map((x) => rm(fileOf(x), { force: true })));
      return ids;
    },
  };
}

// ---- 判定 ----

export function createQuota({ dir, config }) {
  const store = createQuotaStore(dir);

  async function view(device) {
    const d = await store.read(device);
    const remaining = Math.max(0, config.freeInterviews + d.bonus - d.used);
    const exhausted = config.enabled && remaining === 0;
    const next = !exhausted ? 'ok' : d.surveyDoneAt ? 'plan' : 'survey';
    return { enabled: config.enabled, free: config.freeInterviews, used: d.used, remaining, surveyDone: Boolean(d.surveyDoneAt), exhausted, next };
  }

  /** 音声セッションを始める前の関門。上限なら決まったコードで断る。 */
  async function assertCanStart(device) {
    const v = await view(device);
    if (v.next === 'survey') throw new HttpError(402, '無料の面接は終わりました。2分のアンケートにご協力ください', QUOTA_CODES.survey);
    if (v.next === 'plan') throw new HttpError(402, '無料の面接は終わりました。プランは準備中です', QUOTA_CODES.plan);
  }

  return {
    store, view, assertCanStart,
    enabled: config.enabled,
    record: (device, sessionId) => (config.enabled && device ? store.record(device, sessionId) : null),
    markSurvey: (device) => store.markSurvey(device),
  };
}
