// gym（手ごわい面接官の練習）のセッションを作る。ES は、本文で渡されたもの > 指定したセッションのもの > 直近のセッションのもの > ESなし（企業名・業界・職種は任意）、の順。
import { HttpError, readJson, writeJson } from './http-util.mjs';
import { normalizeEs, EsError, displayCompany, hasEs } from './es.mjs';
import { parseGymStart } from './gym.mjs';
import { mkdir } from 'node:fs/promises';

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

async function resolveEs(body, { metas, file, defaultPlan, plans }) {
  const opts = { defaultPlan, plans };
  try {
    if (body.es) return normalizeEs(body.es, opts);
    if (body.quick) {
      const { company, industry, role, mode } = body.quick;
      return normalizeEs({ company, industry, role, mode, noEs: true }, opts);
    }
    const ids = body.fromSession ? [body.fromSession] : [...metas.values()].filter((m) => !m.gym).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map((m) => m.id);
    if (body.fromSession && !ID_RE.test(body.fromSession)) throw new HttpError(400, 'fromSession が不正');
    for (const id of ids) {
      const es = await readJson(file(id, 'es'));
      if (es && !es.noEs) return normalizeEs(es, opts);
    }
  } catch (e) {
    if (e instanceof EsError) throw new HttpError(400, e.message);
    throw e;
  }
  throw new HttpError(400, '使える ES がありません。「ESなし」を選んでください');
}

/** body: { consent: true, type, level, anxiety: [6], reappraisal?, es? | quick? | fromSession? } */
export async function createGymSession(body, ctx) {
  const start = parseGymStart(body);
  const voice = ctx.voiceOf(body.voice);
  const es = await resolveEs(body, ctx);
  const id = ctx.newId();
  await mkdir(ctx.sessDir(id), { recursive: true });
  await writeJson(ctx.file(id, 'es'), es);
  await ctx.setMeta(id, {
    id, createdAt: new Date().toISOString(), company: displayCompany(es), noEs: !hasEs(es), status: 'ready', error: null, scores: null, mode: es.mode, plan: es.plan, voice,
    gym: { type: start.type, level: start.level, anxietyBefore: start.anxietyBefore, reappraisal: start.reappraisal, anxietyAfter: null, selfTalk: null, stopped: false, stopReason: null },
  });
  return { id };
}
