// 本人用データの API: lens（data/lens.json）、warmup（data/warmup.json）、gym の開始と記録。データはこの端末の data/ だけに置く。
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { HttpError, readBody, readJson, sendJson, writeJson } from './http-util.mjs';
import { buildLensView, scoreLens, parseOverride } from './lens.mjs';
import { createPlan, recordDone, clearDone, planView, pointsOf, todayString, MIN_DAYS, MAX_DAYS, STEPS } from './warmup.mjs';
import { createGymSession } from './gym-session.mjs';
import { gymHistory } from './gym.mjs';
import { loadModeBank } from './interview.mjs';
import { rankFromScores } from '../web/rank.mjs';

const LENS_SESSIONS = 5;

/** ctx: { dataDir, metas, file, sessDir, setMeta, newId, defaultPlan, planIds, bankDir } */
export function createUserRoutes(ctx) {
  const lensFile = join(ctx.dataDir, 'lens.json');
  const warmupFile = join(ctx.dataDir, 'warmup.json');
  const doneSessions = () => [...ctx.metas.values()].filter((m) => m.status === 'done' && m.scores).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  async function lensView() {
    const rows = doneSessions().filter((m) => !m.gym).slice(0, LENS_SESSIONS);
    const sessions = [];
    for (const m of rows) {
      const t = await readJson(ctx.file(m.id, 'transcript'));
      if (t?.turns) sessions.push({ id: m.id, company: m.company, createdAt: m.createdAt, turns: t.turns });
    }
    return buildLensView(await readJson(lensFile), sessions);
  }

  async function lensRoute(path, body) {
    const store = (await readJson(lensFile)) ?? { answers: null, override: { bars: {}, hypothesis: null } };
    const save = (next) => writeJson(lensFile, { ...next, updatedAt: new Date().toISOString() });
    if (path === '/api/lens') {
      scoreLens(body.answers);
      await save({ ...store, answers: body.answers });
    } else if (path === '/api/lens/override') {
      const o = parseOverride(body);
      const bars = { ...store.override?.bars, ...o.bars };
      for (const [k, v] of Object.entries(body.bars ?? {})) if (v === null) delete bars[k];
      await save({ ...store, override: { bars, hypothesis: 'hypothesis' in body ? o.hypothesis : store.override?.hypothesis ?? null } });
    } else {
      await rm(lensFile, { force: true });
    }
    return lensView();
  }

  async function warmupView() {
    const stored = await readJson(warmupFile);
    const linkable = doneSessions().slice(0, 20).map((m) => ({ id: m.id, createdAt: m.createdAt, company: m.company, gym: Boolean(m.gym), points: pointsOf(m.scores) }));
    const bank = loadModeBank('first', ctx.bankDir);
    return {
      plan: planView(stored?.plan ?? null, todayString(), (id) => (ctx.metas.get(id)?.scores ? pointsOf(ctx.metas.get(id).scores) : null)),
      today: todayString(),
      minDays: MIN_DAYS,
      maxDays: MAX_DAYS,
      steps: STEPS,
      linkable,
      cards: bank.stages.map((s) => ({ stage: s.label, question: s.questions[0].text })),
    };
  }

  async function warmupRoute(path, body) {
    const stored = await readJson(warmupFile);
    if (path === '/api/warmup') {
      await writeJson(warmupFile, { plan: createPlan({ today: todayString(), daysToReal: body.daysToReal, intention: body.intention ?? {} }) });
    } else if (path === '/api/warmup/clear') {
      await rm(warmupFile, { force: true });
    } else {
      if (!stored?.plan) throw new HttpError(404, '計画がまだ無い');
      if (body.sessionId != null && !ctx.metas.get(body.sessionId)) throw new HttpError(400, 'その面接は無い');
      const next = path === '/api/warmup/undo'
        ? clearDone(stored.plan, body.n)
        : recordDone(stored.plan, body.n, { confidence: body.confidence, sessionId: body.sessionId ?? null, at: new Date().toISOString() });
      await writeJson(warmupFile, { plan: next });
    }
    return warmupView();
  }

  /** 該当しない経路は false。 */
  return async function handle(req, res, url) {
    const { pathname: p } = url;
    const get = req.method === 'GET';
    if (p === '/api/lens' && get) return sendJson(res, 200, await lensView()) ?? true;
    if (['/api/lens', '/api/lens/override', '/api/lens/clear'].includes(p) && req.method === 'POST') return sendJson(res, 200, await lensRoute(p, await readBody(req))) ?? true;
    if (p === '/api/warmup' && get) return sendJson(res, 200, await warmupView()) ?? true;
    if (['/api/warmup', '/api/warmup/clear', '/api/warmup/done', '/api/warmup/undo'].includes(p) && req.method === 'POST') return sendJson(res, 200, await warmupRoute(p, await readBody(req))) ?? true;
    if (p === '/api/gym' && get) return sendJson(res, 200, gymHistory([...ctx.metas.values()], (s) => rankFromScores(s)?.points ?? null)) ?? true;
    if (p === '/api/gym/sessions' && req.method === 'POST') return sendJson(res, 200, await createGymSession(await readBody(req), { ...ctx, plans: ctx.planIds() })) ?? true;
    return false;
  };
}
