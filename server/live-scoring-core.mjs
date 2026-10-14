// 面接中の採点の純粋な部分: プロンプトの組み立て（テンプレートは引数）・引用の検証とやり直し・結果の組み立て・採点キュー。
// Node のサーバー（live-scoring.mjs）、Cloudflare の Functions、ブラウザ（採点キューだけ）が同じものを読む。
import { fillTemplate, forbiddenText, MODE_DEFAULTS } from './interview-core.mjs';
import { esText, axesText, noEsRule, transcriptText, validateEvidence, scanForbidden, assertScoringShape, retryNote, dedupe, norm } from './scoring-core.mjs';
import { AXIS_IDS } from './rubric.mjs';
import { exchangeKey, exchangeText, splitExchanges } from './exchanges.mjs';

const labelOf = (es, modeInfo) => modeInfo?.label ?? MODE_DEFAULTS[es.mode]?.label ?? MODE_DEFAULTS.first.label;

export function buildQScorePrompt(es, ex, modeInfo, template) {
  return fillTemplate(template, {
    modeLabel: labelOf(es, modeInfo),
    noEsRule: noEsRule(es),
    axes: axesText(es),
    es: esText(es),
    exchange: exchangeText(ex),
  });
}

/** final に渡す、済んだ質問の要約。まだの質問は「採点中」と書く。 */
export function qSummaryText(jobs) {
  if (!jobs.length) return '（質問ごとの評価はまだありません。逐語録から判断する）';
  return jobs.map((j, i) => {
    if (j.status !== 'done') return `${i + 1}. ${j.question}\n   （この質問はまだ採点中。逐語録から判断する）`;
    return `${i + 1}. ${j.question}\n   ${j.result.score}点 / 良い点: ${j.result.good} / 改善点: ${j.result.improve}`;
  }).join('\n');
}

export function buildFinalPrompt(es, turns, jobs, modeInfo, template) {
  return fillTemplate(template, {
    modeLabel: labelOf(es, modeInfo),
    noEsRule: noEsRule(es),
    axes: axesText(es),
    forbidden: forbiddenText(),
    qsummary: qSummaryText(jobs),
    es: esText(es),
    transcript: transcriptText(turns),
  });
}

function assertQShape(r) {
  const ok = r && Number.isInteger(r.score) && r.score >= 1 && r.score <= 5
    && ['quote', 'good', 'improve', 'modelAnswer'].every((k) => typeof r[k] === 'string');
  if (!ok) throw new Error('q-score の結果の形が不正');
}

const quoteOk = (quote, ex) => {
  const q = norm(quote);
  return Boolean(q) && ex.turns.some((t) => t.role === 'candidate' && norm(t.text).includes(q));
};

/**
 * 1やりとりを採点する。引用がそのやりとりの応募者の発言に無ければ、1回だけやり直す。
 * それでも合わなければ quote を空にして quoteInvalid:true を付ける（捏造した引用は見せない）。
 * run は ({prompt, schema, onProgress}) => Promise<object>。schema は q-score のスキーマ、template は q-score.md の中身。
 */
export async function scoreExchange(es, ex, { run, schema, template, modeInfo = null, onProgress = null }) {
  const prompt = buildQScorePrompt(es, ex, modeInfo, template);
  let r = await run({ prompt, schema, onProgress });
  assertQShape(r);
  let retried = false;
  if (!quoteOk(r.quote, ex)) {
    retried = true;
    const note = `\n\n# 前回の引用違反（直して再採点する）\nquote の「${r.quote}」は応募者の発言に一字一句は存在しなかった。応募者の発言の text から、そのままコピーした部分文字列に差し替えること。他の判断は変えなくてよい。\n`;
    const second = await run({ prompt: prompt + note, schema, onProgress });
    assertQShape(second);
    r = second;
  }
  const valid = quoteOk(r.quote, ex);
  return {
    question: ex.question,
    startMs: ex.questionStartMs,
    score: r.score,
    quote: valid ? r.quote : '',
    ...(valid ? {} : { quoteInvalid: true }),
    good: r.good,
    improve: r.improve,
    modelAnswer: r.modelAnswer,
    retried,
  };
}

/**
 * final（6軸・総評・次の練習・適法性）。引用違反があれば1回だけやり直す。score() の軸部分と同じ規則。
 * axisIds を渡すと（1 話題の練習）その軸だけを採点結果に残し、残りは unobserved に入れる（0 点にはしない）。buildPrompt はそのときのプロンプトの組み立て。
 */
export async function scoreFinal(es, turns, jobs, { run, schema, template, modeInfo = null, onProgress = null, axisIds = null, buildPrompt = buildFinalPrompt }) {
  const prompt = buildPrompt(es, turns, jobs, modeInfo, template);
  const only = (r) => (axisIds ? { ...r, axes: r.axes.filter((a) => axisIds.includes(a.axis)) } : r);
  let result = await run({ prompt, schema, onProgress });
  assertScoringShape(result, axisIds ?? undefined);
  result = only(result);
  let violations = validateEvidence(result, turns);
  let retried = false;
  if (violations.length) {
    retried = true;
    const second = await run({ prompt: prompt + retryNote(violations), schema, onProgress });
    assertScoringShape(second, axisIds ?? undefined);
    const v2 = validateEvidence(only(second), turns);
    if (v2.length <= violations.length) { result = only(second); violations = v2; }
  }
  const bad = new Set(violations.filter((v) => v.kind === 'axis').map((v) => v.axis));
  const axes = result.axes.map((a) => (bad.has(a.axis) ? { ...a, evidenceInvalid: true } : { ...a }));
  const llmViolations = (result.compliance?.violations ?? []).map((v) => ({ ...v, source: 'llm' }));
  return {
    axes,
    ...(axisIds ? { unobserved: AXIS_IDS.filter((id) => !axisIds.includes(id)) } : {}),
    overall: result.overall,
    llmCompliance: llmViolations,
    evidenceViolations: violations,
    compliance: { violations: dedupe([...llmViolations, ...scanForbidden(turns)]) },
    retried,
  };
}

/** 採点結果の組み立て。scoring.questions は、済んだやりとりを面接の順に並べたもの。 */
export function assembleScoring(jobs, fin) {
  const questions = jobs.filter((j) => j.status === 'done').map((j) => ({ ...j.result }));
  return {
    scoring: { axes: fin.axes, ...(fin.unobserved ? { unobserved: fin.unobserved } : {}), questions, overall: fin.overall, compliance: { violations: fin.llmCompliance } },
    evidenceViolations: [...fin.evidenceViolations, ...jobs.filter((j) => j.result?.quoteInvalid).map((j) => ({ kind: 'question', quote: '', reason: `質問「${j.question}」の引用が回答に一致しない` }))],
    compliance: fin.compliance,
  };
}

/** 保存済みの採点の進み具合（scoring.json）から、採点が済んだやりとりだけを取り出す。区切りは逐語録から作り直し、質問文が一致したものだけ使う。 */
export function seedFromSnapshot(turns, snap) {
  return splitExchanges(turns).flatMap((exchange, i) => {
    const j = snap?.exchanges?.[i];
    return j?.status === 'done' && j.result && j.question === exchange.question
      ? [{ exchange, result: j.result, startedAt: j.startedAt, doneAt: j.doneAt, chars: j.chars }]
      : [];
  });
}

const publicJob = (j) => ({
  index: j.index, question: j.question, status: j.status, startedAt: j.startedAt, doneAt: j.doneAt, error: j.error, chars: j.chars, result: j.result,
});

/**
 * 面接中の採点を取りまとめる。addExchange（やりとりが閉じるたび）で q-score をキューに積み、同時に最大 concurrency 本まで走らせる。
 * finish(turns) で終了処理（最後のやりとり + final）。同じやりとりは key で重複排除し、面接中の結果を使い回す。
 * 採点の実行は注入する: scoreOne(exchange, onProgress) => 1やりとりの結果、scoreFin(turns, jobs, onProgress) => final の結果。
 *   Node は scoreExchange / scoreFinal を直接、ブラウザは Functions を呼ぶ関数を渡す。
 * @param {{scoreOne: Function, scoreFin: Function, onChange?: Function, concurrency?: number, now?: () => number, seed?: object[]}} opts
 */
export function createScorerCore({ scoreOne, scoreFin, onChange = () => {}, concurrency = 2, now = Date.now, seed = [] }) {
  const jobs = new Map();
  let order = [];
  // 採点済みのやりとり（やり直しのとき、済んだ分を使い回す）。seedFromSnapshot の戻り値を渡す
  for (const s of seed) {
    const key = exchangeKey(s.exchange);
    jobs.set(key, { key, index: order.length, exchange: s.exchange, question: s.exchange.question, status: 'done', startedAt: s.startedAt ?? null, doneAt: s.doneAt ?? null, error: null, chars: s.chars ?? 0, result: s.result });
    order = [...order, key];
  }
  const queue = [];
  let running = 0;
  let fin = { status: 'idle', startedAt: null, doneAt: null, error: null, chars: 0 };
  let finResult = null; // final の結果。6軸・総評ができた時点で画面に差し込めるよう、全体の完了を待たず公開する

  const changed = () => onChange(snapshot());
  const list = () => order.map((k) => jobs.get(k));

  function snapshot() {
    return { exchanges: list().map(publicJob), final: { ...fin, result: finResult && { axes: finResult.axes, ...(finResult.unobserved ? { unobserved: finResult.unobserved } : {}), overall: finResult.overall, compliance: finResult.compliance, evidenceViolations: finResult.evidenceViolations } } };
  }

  async function runJob(job) {
    job.status = 'running';
    job.startedAt = now();
    changed();
    const attempt = () => scoreOne(job.exchange, (n) => { job.chars = n; });
    try {
      try { job.result = await attempt(); } catch { job.result = await attempt(); } // 1回だけ自動でやり直す
      job.status = 'done';
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
    }
    job.doneAt = now();
    running -= 1;
    pump();
    changed();
  }

  function pump() {
    while (running < concurrency && queue.length) {
      running += 1;
      runJob(queue.shift());
    }
  }

  function addExchange(ex) {
    const key = exchangeKey(ex);
    if (jobs.has(key)) return jobs.get(key);
    const job = { key, index: order.length, exchange: ex, question: ex.question, status: 'queued', startedAt: null, doneAt: null, error: null, chars: 0, result: null };
    jobs.set(key, job);
    order = [...order, key];
    queue.push(job);
    changed();
    pump();
    return job;
  }

  const settled = (job) => new Promise((resolve) => {
    const check = () => (job.status === 'done' || job.status === 'error' ? resolve() : setTimeout(check, 100));
    check();
  });

  /** 面接終了。残りのやりとりを積み、final を走らせ、全部そろったら採点結果を返す。final が失敗したら例外。 */
  async function finish(turns) {
    const exchanges = splitExchanges(turns);
    const endKeys = exchanges.map((ex) => addExchange(ex).key);
    order = endKeys; // 区切りが面接中と変わったときは、終了時の区切りを正とする
    order.forEach((k, i) => { jobs.get(k).index = i; });
    fin = { status: 'running', startedAt: now(), doneAt: null, error: null, chars: 0 };
    changed();
    const finalPromise = scoreFin(turns, list().map((j) => ({ ...j })), (n) => { fin.chars = n; });
    finalPromise.then((r) => {
      finResult = r;
      fin = { ...fin, status: 'done', doneAt: now() };
      changed();
    }, () => {});
    try {
      const [result] = await Promise.all([finalPromise, ...list().map(settled)]);
      return assembleScoring(list(), result);
    } catch (e) {
      if (fin.status !== 'done') fin = { ...fin, status: 'error', doneAt: now(), error: e.message };
      changed();
      throw e;
    }
  }

  return { addExchange, finish, snapshot };
}

