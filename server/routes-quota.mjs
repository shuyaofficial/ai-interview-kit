// 無料枠の状態（GET /api/quota）と、感想アンケートの送信（POST /api/feedback）。
import { HttpError, readBody, sendJson } from './http-util.mjs';
import { parseFeedback, saveFeedback } from './feedback.mjs';

/** ctx: { quota, feedbackDir }。該当しない経路は false。device は index.mjs が Cookie から決めた端末 ID。 */
export function createQuotaRoutes({ quota, feedbackDir }) {
  return async function handle(req, res, url, device) {
    if (url.pathname === '/api/quota') {
      if (req.method !== 'GET') throw new HttpError(405, 'GET のみ');
      sendJson(res, 200, await quota.view(device));
      return true;
    }
    if (url.pathname === '/api/feedback') {
      if (req.method !== 'POST') throw new HttpError(405, 'POST のみ');
      const record = parseFeedback(await readBody(req));
      if ((await quota.view(device)).surveyDone) throw new HttpError(409, 'アンケートは回答済みです');
      const saved = await saveFeedback(feedbackDir, record);
      await quota.markSurvey(device);
      sendJson(res, 200, { ok: true, id: saved.id, sendToDev: saved.sendToDev, quota: await quota.view(device) });
      return true;
    }
    return false;
  };
}
