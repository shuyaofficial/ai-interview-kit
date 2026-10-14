// 音声以外の LLM 呼び出しの唯一の入口。プランの provider を見て claude-runner / codex-bridge に振り分け、
// 処理の種類（kind）ごとの所要秒と出力文字数を記録して、進み具合の見込み（expectedSec）を返す。
// 封じ込めの引数（--setting-sources "" / --tools "" / --strict-mcp-config / --disable hooks など）は
// claude-runner.mjs と codex-bridge.mjs の側にある。ここでは外さず、他の経路で LLM を呼ばない。
import { readFileSync } from 'node:fs';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { runStructuredClaude } from './claude-runner.mjs';
import { getBridge } from './codex-bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const KEEP = 10;

export const KINDS = ['es-item', 'es-plan', 'es-extract', 'q-score', 'final', 'score'];
/** 実測がまだ無いときの所要秒（Haiku 想定）。 */
export const DEFAULT_EXPECTED_SEC = { 'es-item': 25, 'es-plan': 25, 'es-extract': 30, 'q-score': 20, final: 40, score: 60 };

export function loadPlans(file = join(HERE, 'plans.json')) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (!raw?.plans?.[raw.default]) throw new Error('plans.json: default のプランが無い');
  for (const [id, def] of Object.entries(raw.plans)) {
    for (const [kind, o] of Object.entries(def.overrides ?? {})) {
      if (!o || typeof o !== 'object' || Array.isArray(o) || ('provider' in o)) throw new Error(`plans.json: ${id}.overrides.${kind} は model / effort だけを持つオブジェクト`);
    }
  }
  return raw;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * @param {{plans?: object, timingsFile?: string, runClaude?: Function, runCodex?: Function, now?: () => number}} opts
 * runClaude / runCodex は ({prompt, schema, model, effort, files, onProgress}) => Promise<object>。テストで差し替える。
 */
export function createLlm({
  plans = loadPlans(),
  timingsFile = join(ROOT, 'data', 'timings.json'),
  runClaude = (a) => runStructuredClaude(a),
  runCodex = ({ files = [], ...a }) => getBridge().runStructured({ ...a, images: files }),
  now = Date.now,
} = {}) {
  let cache = null; // { "<kind>:<plan>": [{sec, chars}] }
  let chain = Promise.resolve();

  const planId = (plan) => (typeof plan === 'string' ? plan : plan?.id) ?? plans.default;
  /** プランの定義に、処理の種類（kind）ごとの上書き（plans.json の overrides）を重ねる。モデルの選び方はここだけで決める。 */
  const resolvePlan = (plan, kind = null) => {
    const id = planId(plan);
    const { overrides = {}, ...def } = plans.plans[id] ?? {};
    if (!plans.plans[id]) throw new Error(`未知のプラン: ${id}`);
    return { id, ...def, ...(kind ? overrides[kind] : null) };
  };

  async function load() {
    if (cache) return cache;
    try { cache = JSON.parse(await readFile(timingsFile, 'utf8')); } catch { cache = {}; }
    return cache;
  }

  /** 書き込みは直列にして、同時に終わった処理の記録が上書きし合わないようにする。 */
  function record(kind, id, sec, chars) {
    chain = chain.then(async () => {
      const t = await load();
      const key = `${kind}:${id}`;
      t[key] = [...(t[key] ?? []), { sec: Math.round(sec * 10) / 10, chars }].slice(-KEEP);
      await mkdir(dirname(timingsFile), { recursive: true });
      const tmp = `${timingsFile}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, JSON.stringify(t, null, 2));
      await rename(tmp, timingsFile);
    }).catch(() => {});
    return chain;
  }

  /** 直近10件の中央値（秒）。記録が無ければ初期値。 */
  function expectedSec(kind, plan) {
    const rows = cache?.[`${kind}:${planId(plan)}`];
    if (rows?.length) return median(rows.map((r) => r.sec));
    return DEFAULT_EXPECTED_SEC[kind] ?? 30;
  }

  /** 直近10件の出力文字数の中央値。記録が無ければ null。 */
  function expectedChars(kind, plan) {
    const rows = (cache?.[`${kind}:${planId(plan)}`] ?? []).filter((r) => r.chars > 0);
    return rows.length ? median(rows.map((r) => r.chars)) : null;
  }

  /**
   * @param {{kind?: string, plan?: string|object, prompt: string, schema: object, files?: string[], onProgress?: (chars:number)=>void}} opts
   */
  async function runStructured({ kind = 'score', plan, prompt, schema, files = [], onProgress = null }) {
    const p = resolvePlan(plan, kind);
    const t0 = now();
    let chars = 0;
    const progress = (n) => { chars = n; onProgress?.(n); };
    let out;
    if (p.provider === 'claude') {
      out = await runClaude({ prompt, schema, model: p.model, effort: p.effort ?? null, files, onProgress: progress });
    } else if (p.provider === 'codex') {
      out = await runCodex({ prompt, schema, model: p.model ?? null, effort: p.effort ?? 'low', serviceTier: p.serviceTier ?? null, files, onProgress: progress });
    } else {
      throw new Error(`未知の provider: ${p.provider}`);
    }
    record(kind, p.id, (now() - t0) / 1000, chars);
    return out;
  }

  return { runStructured, expectedSec, expectedChars, resolvePlan, plans, ready: load, flush: () => chain };
}

let shared = null;
export function getLlm() {
  shared ??= createLlm();
  return shared;
}
