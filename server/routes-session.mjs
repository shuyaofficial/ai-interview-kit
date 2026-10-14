// セッションに付く新しい API: gym の「止める」と終了後の記録、採点のやり直し（総評・質問ごと）。
import { HttpError, readBody, sendJson } from './http-util.mjs';
import { parseGymAfter } from './gym.mjs';
import { LABELS } from '../web/js/labels.mjs';

const ID = '([^/]+)';
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const ROUTES = [
  { re: new RegExp(`^/api/sessions/${ID}/stop$`), name: 'stop' },
  { re: new RegExp(`^/api/sessions/${ID}/gym/after$`), name: 'after' },
  { re: new RegExp(`^/api/sessions/${ID}/final/retry$`), name: 'finalRetry' },
  { re: new RegExp(`^/api/sessions/${ID}/exchanges/([0-9]{1,3})/retry$`), name: 'exchangeRetry' },
];

/** ctx: { metas, setMeta, live, finisher } */
export function createSessionRoutes({ metas, setMeta, live, finisher }) {
  const need = (id) => {
    const meta = metas.get(id);
    if (!meta) throw new HttpError(404, 'セッションが無い');
    return meta;
  };

  const actions = {
    async stop(id) {
      if (!need(id).gym) throw new HttpError(409, `「${LABELS.gym.name}」の面接だけ「止める」を使えます`);
      return finisher.endSession(id, { stopped: true });
    },
    async after(id, _n, body) {
      const meta = need(id);
      if (!meta.gym) throw new HttpError(409, `「${LABELS.gym.name}」のセッションではない`);
      if (live.has(id)) throw new HttpError(409, '面接を終えてから記録できる');
      const a = parseGymAfter(body);
      await setMeta(id, { gym: { ...meta.gym, anxietyAfter: a.anxietyAfter, selfTalk: a.selfTalk, ...(a.stopReason ? { stopReason: a.stopReason } : {}) } });
      return { ok: true };
    },
    finalRetry: (id) => { need(id); return finisher.retryFinal(id); },
    exchangeRetry: (id, n) => { need(id); return finisher.retryExchange(id, Number(n)); },
  };

  return async function handle(req, res, url) {
    for (const { re, name } of ROUTES) {
      const m = re.exec(url.pathname);
      if (!m) continue;
      if (!ID_RE.test(m[1])) throw new HttpError(400, 'id が不正（英数とハイフンのみ）');
      if (req.method !== 'POST') throw new HttpError(405, 'POST のみ');
      const body = name === 'after' ? await readBody(req) : {};
      sendJson(res, 200, await actions[name](m[1], m[2], body));
      return true;
    }
    return false;
  };
}
