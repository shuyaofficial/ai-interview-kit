// 面接官の声「Gemini 3.8 Live（試験）」のサーバー側: キーの読み込みと短期トークンの発行（Node 版）。
// 設定の正本（モデル・VAD・setup・確認した公式ドキュメントの URL）は gemini-config.mjs。Cloudflare 版の Functions も同じものを読む。
import { loadKeys, makeRedactor, safeError } from './secrets.mjs';
import { LABELS } from '../web/js/labels.mjs';
import { TOKEN_URL, tokenRequestBody } from './gemini-config.mjs';

export { GEMINI_MODEL, GEMINI_WS_BASE, VAD, buildSetup, LOCKED_FIELDS, wsUrl } from './gemini-config.mjs';

export const VOICES = ['codex', 'gemini'];


/** 画面の声の選択肢。Gemini はキーのファイルが設定されているときだけ選べる。 */
export function voiceOptions() {
  return [
    { id: 'codex', label: LABELS.voice.codex, available: true },
    { id: 'gemini', label: LABELS.voice.gemini, available: geminiConfigured(), notice: LABELS.voice.geminiNotice, offText: LABELS.voice.geminiOff },
  ];
}

/** 作成時の声の指定を検証する。未指定は codex。gemini は設定が無ければ断る。 */
export function parseVoice(value) {
  if (value === undefined || value === null || value === '') return 'codex';
  if (!VOICES.includes(value)) throw new GeminiError('voice が不正（codex か gemini）');
  if (value === 'gemini' && !geminiConfigured()) throw new GeminiError(`${LABELS.voice.gemini}は${LABELS.voice.geminiOff}`);
  return value;
}

const ENV_FILE = () => process.env.GEMINI_ENV_FILE || '';

/** 設定されているか（キーの値は読まない）。画面の「準備中」判定に使う。 */
export const geminiConfigured = () => Boolean(ENV_FILE());

/** GEMINI_ENV_FILE から GEMINI_API_KEY の行だけをその場で読む。無ければ null。キーは呼び出し側の関数の外へ出さない。 */
async function readKey() {
  if (!ENV_FILE()) return null;
  const keys = await loadKeys(ENV_FILE(), ['GEMINI_API_KEY']);
  return keys?.GEMINI_API_KEY ?? null;
}

export class GeminiError extends Error {}

/**
 * 短期トークンを1つ発行する。戻り値の token は1回だけ使え、すぐ失効する。
 * fetchImpl はテスト用の差し替え。エラー文・ログにキーとトークンは出さない。
 */
export async function issueToken({ prompt, fetchImpl = fetch, now = Date.now }) {
  const key = await readKey().catch(() => { throw new GeminiError('Gemini のキーを読めなかった'); });
  if (!key) throw new GeminiError('Gemini のキーが設定されていない');
  const redact = makeRedactor([key]);
  const body = tokenRequestBody(prompt, now());
  let res;
  try {
    res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new GeminiError(`トークンを発行できなかった: ${safeError(e.message, redact)}`);
  }
  const text = await res.text();
  if (!res.ok) throw new GeminiError(`トークンの発行が拒否された (HTTP ${res.status}): ${safeError(text.slice(0, 300), redact)}`);
  let name;
  try { name = JSON.parse(text).name; } catch { /* 下で扱う */ }
  if (typeof name !== 'string' || !name) throw new GeminiError('トークンの応答が想定外の形だった');
  return { token: name, redact: makeRedactor([key, name]) };
}

