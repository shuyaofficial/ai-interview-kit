// ES 添削を設問ごと・面接プランごとに並列で走らせ、できた順に結果を保存して通知する。
import { join } from 'node:path';
import { HttpError, readJson, writeJson } from './http-util.mjs';
import { normalizeEs, normalizeReview } from './es.mjs';
import { buildEsItemPrompt, buildEsPlanPrompt, esItemSchema, esPlanSchema, assertItemReview, assertPlan } from './review.mjs';

const idle = () => ({ status: 'pending', startedAt: null, doneAt: null, error: null });

/**
 * @param {{llm: object, dir: (id: string) => string, getMeta: Function, setMeta: Function, emit: Function, loadBank: Function}} deps
 */
export function createReviewManager({ llm, dir, getMeta, setMeta, emit, loadBank }) {
  const records = new Map(); // id -> { es, state: {items, plan}, results: {items, plan}, chars }

  function newRecord(es) {
    return {
      es,
      state: { items: Object.fromEntries(es.items.map((it) => [it.id, it.text.trim() ? idle() : { ...idle(), status: 'skipped' }])), plan: idle() },
      results: { items: {}, plan: null },
      chars: {},
    };
  }

  /** 保存済みのファイルから記録を作る（再起動後や旧形式のセッション用）。 */
  async function restore(id, es) {
    const rec = newRecord(es);
    const meta = getMeta(id);
    for (const [k, p] of Object.entries(meta?.review?.items ?? {})) if (rec.state.items[k]) rec.state.items[k] = p;
    if (meta?.review?.plan) rec.state.plan = meta.review.plan;
    const saved = normalizeReview(await readJson(join(dir(id), 'esReview.json')), es);
    const done = { status: 'done', startedAt: null, doneAt: null, error: null };
    for (const it of saved?.items ?? []) {
      rec.results.items[it.id] = it;
      if (rec.state.items[it.id]?.status !== 'done') rec.state.items[it.id] = done;
    }
    if (saved?.plan) {
      rec.results.plan = saved.plan;
      if (rec.state.plan.status !== 'done') rec.state.plan = done;
    }
    return rec;
  }

  async function record(id, esMaybe) {
    if (records.has(id)) return records.get(id);
    const es = esMaybe ?? normalizeEs(await readJson(join(dir(id), 'es.json')));
    const rec = await restore(id, es);
    records.set(id, rec);
    return rec;
  }

  const patch = (rec, piece, p) => {
    const cur = piece === 'plan' ? rec.state.plan : rec.state.items[piece];
    const next = { ...cur, ...p };
    rec.state = piece === 'plan' ? { ...rec.state, plan: next } : { ...rec.state, items: { ...rec.state.items, [piece]: next } };
  };

  async function persist(id, rec) {
    const items = rec.es.items.map((it) => rec.results.items[it.id]).filter(Boolean);
    await Promise.all([
      writeJson(join(dir(id), 'esReview.json'), { items, plan: rec.results.plan }),
      setMeta(id, { review: rec.state }),
    ]);
  }

  /** 全部の処理が終わったら、セッションの状態を ready（1つでも成功）か error にする。 */
  async function settle(id, rec) {
    const all = [...Object.values(rec.state.items), rec.state.plan];
    if (all.some((p) => p.status === 'running' || p.status === 'pending')) return;
    if (getMeta(id)?.status !== 'reviewing') return;
    const anyDone = all.some((p) => p.status === 'done');
    await setMeta(id, anyDone ? { status: 'ready', error: null } : { status: 'error', error: 'ES 添削に失敗した。やり直すか、そのまま面接を始められる' });
  }

  async function runPiece(id, rec, piece) {
    const { es } = rec;
    const bank = loadBank(es.mode);
    const isPlan = piece === 'plan';
    const item = isPlan ? null : es.items.find((it) => it.id === piece);
    patch(rec, piece, { status: 'running', startedAt: Date.now(), doneAt: null, error: null });
    rec.chars[piece] = 0;
    emit(id, { type: 'review', piece, status: 'running' });
    try {
      const raw = await llm.runStructured({
        kind: isPlan ? 'es-plan' : 'es-item',
        plan: es.plan,
        prompt: isPlan ? buildEsPlanPrompt(es, bank) : buildEsItemPrompt(es, item, bank),
        schema: isPlan ? esPlanSchema() : esItemSchema(),
        onProgress: (n) => { rec.chars[piece] = n; },
      });
      if (isPlan) rec.results = { ...rec.results, plan: assertPlan(raw) };
      else rec.results = { ...rec.results, items: { ...rec.results.items, [piece]: { id: item.id, title: item.title, ...assertItemReview(raw) } } };
      patch(rec, piece, { status: 'done', doneAt: Date.now() });
    } catch (e) {
      console.error(`[review ${id}/${piece}]`, e.message);
      patch(rec, piece, { status: 'error', doneAt: Date.now(), error: e.message });
    }
    await persist(id, rec);
    emit(id, { type: 'review', piece, status: (isPlan ? rec.state.plan : rec.state.items[piece]).status });
    await settle(id, rec);
  }

  return {
    /** 新しいセッション。設問ごとと面接プランを同時に走らせる（待たない）。 */
    start(id, es) {
      const rec = newRecord(es);
      records.set(id, rec);
      const pieces = [...es.items.filter((it) => it.text.trim()).map((it) => it.id), 'plan'];
      persist(id, rec).catch(() => {});
      for (const piece of pieces) runPiece(id, rec, piece);
    },

    /** 失敗した1件だけやり直す。 */
    async retry(id, piece) {
      const meta = getMeta(id);
      if (!meta) throw new HttpError(404, 'セッションが無い');
      if (await readJson(join(dir(id), 'transcript.json'))) throw new HttpError(409, '面接が終わった後は添削をやり直せない');
      if (!['reviewing', 'ready', 'error'].includes(meta.status)) throw new HttpError(409, 'この状態では添削をやり直せない');
      const rec = await record(id);
      const cur = piece === 'plan' ? rec.state.plan : rec.state.items[piece];
      if (!cur) throw new HttpError(404, 'その設問は無い');
      if (cur.status !== 'error') throw new HttpError(409, '失敗した処理だけやり直せる');
      if (meta.status !== 'reviewing') await setMeta(id, { status: 'reviewing', error: null });
      runPiece(id, rec, piece);
      return { ok: true };
    },

    /** サーバー再起動で中断された処理を error にして、やり直せるようにする。 */
    async interrupt(id) {
      const rec = await record(id);
      for (const it of rec.es.items) if (['running', 'pending'].includes(rec.state.items[it.id].status)) patch(rec, it.id, { status: 'error', error: 'サーバーの再起動で処理が中断された' });
      if (['running', 'pending'].includes(rec.state.plan.status)) patch(rec, 'plan', { status: 'error', error: 'サーバーの再起動で処理が中断された' });
      await persist(id, rec);
      await settle(id, rec);
    },

    /** 画面用。{ state, results, chars }。es が分からない（読めない）セッションは空。 */
    async view(id, es) {
      if (!es) return { state: { items: {}, plan: idle() }, results: { items: [], plan: null }, chars: {} };
      const rec = await record(id, es);
      return {
        state: rec.state,
        results: { items: es.items.map((it) => rec.results.items[it.id]).filter(Boolean), plan: rec.results.plan },
        chars: rec.chars,
      };
    },
  };
}
