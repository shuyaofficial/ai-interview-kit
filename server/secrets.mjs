// API キーの扱い: 環境ファイルから欲しい名前の行だけ読み、ログ・出力・エラー文へ出さない（伏せ字）。
// scripts/voice-api.mjs（比較スクリプト）と server/（Gemini の面接）が共有する。
import { readFile } from 'node:fs/promises';

const MASK = '[伏せ字]';

/** `.env.local` の本文から、欲しい名前の値だけを取り出す（それ以外の行は読み捨てる）。 */
export function parseEnv(text, wanted) {
  const found = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || !wanted.includes(m[1])) continue;
    const v = m[2].replace(/^(["'])(.*)\1$/, '$2');
    if (v) found[m[1]] = v;
  }
  return found;
}

/** `.env.local` が無ければ null。あれば wanted の名前だけを返す（process.env は読まない・書かない）。 */
export async function loadKeys(envPath, wanted) {
  const text = await readFile(envPath, 'utf8').catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(new Error('.env.local を読めない'))));
  return text === null ? null : parseEnv(text, wanted);
}

/** 文字列からキーを伏せる関数を作る。渡されたキーそのものに加え、キーの形（sk-…、Google のキー、key=…、Bearer …）も伏せる。 */
export function makeRedactor(secrets) {
  const literals = secrets.filter((s) => typeof s === 'string' && s.length >= 6).flatMap((s) => [s, encodeURIComponent(s)]);
  return (value) => {
    let s = String(value ?? '');
    for (const lit of literals) s = s.split(lit).join(MASK);
    return s
      .replace(/\bsk-[A-Za-z0-9_*.-]{4,}/g, MASK)
      .replace(/AIz\u0061[0-9A-Za-z_-]{10,}/g, MASK)
      .replace(/auth_tokens\/[A-Za-z0-9_=+\/-]{6,}/g, MASK) // Gemini の ephemeral token
      .replace(/\b(key|api_key|access_token)=[^&\s"']+/gi, `$1=${MASK}`)
      .replace(/Bearer\s+[^\s"']+/gi, `Bearer ${MASK}`);
  };
}

// エラーの本文にキーの一部（"Incorrect API key provided: sk-…xyz"）が入りうるので、認証まわりの文面は本文ごと伏せる
const AUTH_LIKE = /api[ _-]?key|authori[sz]|credential|permission|token|unauthenticated|forbidden/i;
export const safeError = (text, redact) => {
  const s = redact(text);
  return AUTH_LIKE.test(s) ? '認証・権限のエラー（本文は伏せた）' : s;
};

