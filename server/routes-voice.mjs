// 面接官の声 Gemini 3.8 Live の API（接続方式と確認した URL は gemini-live.mjs の先頭）。
//   POST /api/sessions/:id/gemini  面接を始める。無料枠・状態の確認 → 短期トークンを1つ発行して返す（キー本体は返さない）。
//   POST /api/sessions/:id/gemini/abort  接続できなかったとき、面接を始める前の状態へ戻す（話した記録があれば戻さない）。
//   POST /api/sessions/:id/voice   ブラウザが Gemini から受けた字幕を送る。Codex の字幕と同じ逐語録・字幕（SSE）・1問ごとの採点に流す。
import { HttpError, readBody, sendJson } from './http-util.mjs';
import { issueToken, wsUrl, GEMINI_MODEL, GeminiError } from './gemini-live.mjs';
import { KICKOFF_TEXT } from './interview.mjs';

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const ROUTE = /^\/api\/sessions\/([^/]+)\/(gemini\/abort|gemini|voice)$/;
const MAX_EVENTS = 200;
const MAX_TEXT = 5000;
const ROLES = new Set(['user', 'assistant']);

/** ブラウザから届いた字幕イベントを検証する（形が違えば 400）。 */
export function parseVoiceEvents(body) {
  const events = body?.events ?? [];
  if (!Array.isArray(events) || events.length > MAX_EVENTS) throw new HttpError(400, 'events が不正');
  return events.map((e) => {
    if (!ROLES.has(e?.role) || !['delta', 'done'].includes(e?.kind) || typeof e?.text !== 'string' || e.text.length > MAX_TEXT) throw new HttpError(400, 'events の形が不正');
    return { role: e.role, kind: e.kind, text: e.text };
  });
}

/** ctx: { metas, live, emit, beginLive, abortLive, issueVoiceToken } */
export function createVoiceRoutes({ metas, live, emit, beginLive, abortLive, issueVoiceToken = issueToken }) {
  async function start(id, device) {
    const meta = metas.get(id);
    if (!meta) throw new HttpError(404, 'セッションが無い');
    if (meta.voice !== 'gemini') throw new HttpError(409, 'この面接は Gemini の声で作られていない');
    const { entry, prompt } = await beginLive(id, device);
    entry.voice = 'gemini';
    try {
      const { token } = await issueVoiceToken({ prompt });
      return { url: wsUrl(token), model: GEMINI_MODEL, kickoffText: KICKOFF_TEXT };
    } catch (e) {
      await abortLive(id, entry);
      if (e instanceof GeminiError) throw new HttpError(502, `面接を開始できなかった: ${e.message}`);
      throw e;
    }
  }

  async function abort(id) {
    const entry = live.get(id);
    if (!entry || entry.voice !== 'gemini') throw new HttpError(409, '進行中の Gemini の面接が無い');
    if (entry.recorder.turnCount() > 0) throw new HttpError(409, 'もう話し始めているので戻せない。終了で採点する');
    await abortLive(id, entry);
    return { ok: true };
  }

  function receive(id, body) {
    const entry = live.get(id);
    if (!entry || entry.voice !== 'gemini') throw new HttpError(409, '進行中の Gemini の面接が無い');
    const events = parseVoiceEvents(body);
    if (body.ready === true) entry.recorder.start(); // 接続が確立した時刻を逐語録の 0 ms にする
    for (const ev of events) {
      const params = ev.kind === 'delta' ? { role: ev.role, delta: ev.text } : { role: ev.role, text: ev.text };
      const caption = entry.recorder.handle(`thread/realtime/transcript/${ev.kind}`, params);
      if (caption) emit(id, caption);
    }
    return { ok: true };
  }

  return async function handle(req, res, url, device) {
    const m = ROUTE.exec(url.pathname);
    if (!m) return false;
    if (!ID_RE.test(m[1])) throw new HttpError(400, 'id が不正（英数とハイフンのみ）');
    if (req.method !== 'POST') throw new HttpError(405, 'POST のみ');
    const body = m[2] === 'voice' ? await readBody(req) : {};
    const out = m[2] === 'gemini' ? await start(m[1], device) : m[2] === 'voice' ? receive(m[1], body) : await abort(m[1]);
    sendJson(res, 200, out);
    return true;
  };
}
