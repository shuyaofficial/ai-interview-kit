// 面接の終了と採点の取りまとめ、採点が失敗したときのやり直し（総評・質問ごと）。
import { HttpError, readJson, writeJson } from './http-util.mjs';
import { normalizeEs } from './es.mjs';
import { computeSpeechMetrics } from './scoring.mjs';
import { createScorer, seedFromSnapshot, scoreExchange } from './live-scoring.mjs';
import { splitExchanges } from './exchanges.mjs';
import { scoreGym } from './gym-score.mjs';
import { gymModeInfo } from './gym.mjs';

const BUSY = ['scoring', 'interviewing'];

/** 採点が済んだ質問を面接の順に並べる。 */
export const questionsFromSnapshot = (snap) => (snap?.exchanges ?? []).filter((e) => e.status === 'done' && e.result).map((e) => ({ ...e.result }));

/** report.evidenceViolations のうち、質問の引用違反だけを snapshot から作り直す。 */
function evidenceFor(report, snap) {
  const kept = (report.evidenceViolations ?? []).filter((v) => v.kind !== 'question');
  const bad = (snap?.exchanges ?? []).filter((e) => e.result?.quoteInvalid).map((e) => ({ kind: 'question', quote: '', reason: `質問「${e.question}」の引用が回答に一致しない` }));
  return [...kept, ...bad];
}

/**
 * @param {{live: Map, scorers: Map, file: Function, getMeta: Function, setMeta: Function, emit: Function, bridge: object, llm: object, loadBank: Function}} d
 */
export function createFinisher({ onCounted = null, live, scorers, file, getMeta, setMeta, emit, bridge, llm, loadBank }) {
  const retrying = new Set(); // 質問ごとのやり直しを実行中の "<id>:<index>"
  const runFor = (es) => (a) => llm.runStructured({ plan: es.plan, ...a });

  /** gym の練習の目安。失敗しても本体の採点は止めず、gym.json に理由を残す。 */
  async function runGym(id, entry, turns) {
    const r = await scoreGym({ es: entry.es, turns, type: entry.gym.type, level: entry.gym.level, run: (a) => runFor(entry.es)({ kind: 'gym', ...a }) });
    await writeJson(file(id, 'gym'), { ...r, createdAt: new Date().toISOString() });
    emit(id, { type: 'gym' });
  }

  /** 最後のやりとりと final を待って、レポートを書く。 */
  async function runScoring(id, entry, turns) {
    const gym = entry.gym && !entry.skipGym ? runGym(id, entry, turns).catch((e) => console.error(`[gym ${id}]`, e.message)) : null;
    let outcome;
    try {
      const r = await entry.scorer.finish(turns);
      const report = {
        scoring: r.scoring,
        speech: computeSpeechMetrics(turns),
        evidenceViolations: r.evidenceViolations,
        compliance: r.compliance,
        plan: entry.es.plan,
        mode: entry.es.mode,
        ...(entry.gym ? { gym: { type: entry.gym.type, level: entry.gym.level } } : {}),
        createdAt: new Date().toISOString(),
      };
      await writeJson(file(id, 'report'), report);
      outcome = { status: 'done', error: null, scores: Object.fromEntries(r.scoring.axes.map((a) => [a.axis, a.score])) };
    } catch (e) {
      console.error(`[scoring ${id}]`, e.message);
      outcome = { status: 'error', error: `採点に失敗: ${e.message}` };
    }
    // 採点の記録を書き、スコアラーを外してから状態を変える（状態が変わった時点で、やり直しを受け付けられるように）
    await writeJson(file(id, 'scoring'), entry.scorer.snapshot()).catch(() => {});
    scorers.delete(id);
    await setMeta(id, outcome);
    emit(id, { type: 'report', status: outcome.status });
    await gym;
  }

  /** 面接を終える。stopped は gym の「止める」（減点にしない・記録は残す）。 */
  async function endSession(id, { stopped = false, reason = null } = {}) {
    const entry = live.get(id);
    if (!entry) throw new HttpError(409, '進行中の面接が無い');
    live.delete(id);
    try {
      if (entry.threadId) await bridge.stopRealtime(entry.threadId);
    } catch (e) {
      console.error(`[end ${id}] stopRealtime`, e.message);
    }
    const turns = entry.recorder.finish();
    await writeJson(file(id, 'transcript'), { es: entry.es, turns });
    if (entry.gym) await setMeta(id, { gym: { ...getMeta(id).gym, stopped, stopReason: reason, endedAt: new Date().toISOString() } });
    if (!turns.some((t) => t.role === 'candidate')) {
      if (entry.gym) {
        await setMeta(id, { status: 'stopped', error: null });
        return { status: 'stopped' };
      }
      await setMeta(id, { status: 'error', error: '応募者の発言が記録されなかった（マイクと音声認識を確認してください）' });
      return { status: 'error' };
    }
    await onCounted?.(entry, id); // 応募者の発言がある音声セッションが終わった。無料枠に数える
    await setMeta(id, { status: 'scoring', error: null });
    runScoring(id, entry, turns);
    return { status: 'scoring' };
  }

  async function loadEnded(id) {
    const meta = getMeta(id);
    if (!meta) throw new HttpError(404, 'セッションが無い');
    const transcript = await readJson(file(id, 'transcript'));
    if (!transcript) throw new HttpError(409, '面接が終わっていない');
    if (live.has(id) || scorers.has(id) || BUSY.includes(meta.status)) throw new HttpError(409, '採点を実行中');
    return { meta, transcript, es: normalizeEs(transcript.es, { defaultPlan: meta.plan }) };
  }

  /** final（総評）が失敗した採点をやり直す。採点が済んだ質問は使い回し、失敗した質問と final だけを走らせる。 */
  async function retryFinal(id) {
    const { meta, transcript, es } = await loadEnded(id);
    if (meta.status !== 'error') throw new HttpError(409, '失敗した採点だけやり直せる');
    if (!transcript.turns.some((t) => t.role === 'candidate')) throw new HttpError(409, '応募者の発言が記録されていない');
    const snap = await readJson(file(id, 'scoring'));
    const bank = loadBank(es.mode);
    const gym = meta.gym ?? null;
    const scorer = createScorer({
      run: runFor(es),
      es,
      modeInfo: gym ? gymModeInfo(bank, gym.type, gym.level) : bank,
      seed: seedFromSnapshot(transcript.turns, snap),
      onChange: (snapshot) => { writeJson(file(id, 'scoring'), snapshot).catch(() => {}); emit(id, { type: 'scoring' }); },
    });
    const prevGym = gym ? await readJson(file(id, 'gym')) : null;
    scorers.set(id, scorer);
    await setMeta(id, { status: 'scoring', error: null });
    emit(id, { type: 'scoring' });
    runScoring(id, { scorer, es, gym, skipGym: Boolean(prevGym?.rebound) }, transcript.turns);
    return { status: 'scoring' };
  }

  /** 採点に失敗した質問を1つだけやり直す。総評は触らない（済んでいれば、レポートの質問の並びだけ差し替える）。 */
  async function retryExchange(id, index) {
    const { meta, transcript, es } = await loadEnded(id);
    const snap = await readJson(file(id, 'scoring'));
    const ex = splitExchanges(transcript.turns)[index];
    const job = snap?.exchanges?.[index];
    if (!ex || !job) throw new HttpError(404, 'その質問は無い');
    if (job.status === 'done') throw new HttpError(409, '採点済みの質問はやり直せない');
    if (retrying.has(`${id}:${index}`)) throw new HttpError(409, 'この質問は採点を実行中');
    retrying.add(`${id}:${index}`);
    const bank = loadBank(es.mode);
    const modeInfo = meta.gym ? gymModeInfo(bank, meta.gym.type, meta.gym.level) : bank;
    const put = async (patch) => {
      const cur = await readJson(file(id, 'scoring'));
      await writeJson(file(id, 'scoring'), { ...cur, exchanges: cur.exchanges.map((e, i) => (i === index ? { ...e, ...patch } : e)) });
    };
    await put({ status: 'running', startedAt: Date.now(), doneAt: null, error: null, chars: 0 });
    emit(id, { type: 'scoring' });
    (async () => {
      const attempt = () => scoreExchange(es, ex, { run: (a) => runFor(es)({ kind: 'q-score', ...a }), modeInfo });
      try {
        let result;
        try { result = await attempt(); } catch { result = await attempt(); }
        await put({ status: 'done', doneAt: Date.now(), error: null, result });
        const next = await readJson(file(id, 'scoring'));
        const report = await readJson(file(id, 'report'));
        if (report) {
          const merged = { ...report, scoring: { ...report.scoring, questions: questionsFromSnapshot(next) } };
          await writeJson(file(id, 'report'), { ...merged, evidenceViolations: evidenceFor(merged, next) });
        }
      } catch (e) {
        console.error(`[retry-q ${id}/${index}]`, e.message);
        await put({ status: 'error', doneAt: Date.now(), error: e.message });
      }
      retrying.delete(`${id}:${index}`);
      emit(id, { type: 'scoring' });
      emit(id, { type: 'report', status: getMeta(id)?.status });
    })();
    return { ok: true };
  }

  /** サーバーの再起動で中断された採点の記録（running / queued のまま残った質問）を error にして、やり直せるようにする。 */
  async function repairSnapshot(id) {
    const snap = await readJson(file(id, 'scoring')).catch(() => null);
    if (!snap?.exchanges?.some((e) => e.status === 'running' || e.status === 'queued')) return;
    const exchanges = snap.exchanges.map((e) => (e.status === 'running' || e.status === 'queued' ? { ...e, status: 'error', error: 'サーバーの再起動で処理が中断された' } : e));
    await writeJson(file(id, 'scoring'), { ...snap, exchanges, final: snap.final?.status === 'running' ? { ...snap.final, status: 'error', error: 'サーバーの再起動で処理が中断された' } : snap.final });
  }

  return { endSession, retryFinal, retryExchange, repairSnapshot };
}
