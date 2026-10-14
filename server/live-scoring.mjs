// 面接中に1問（1やりとり）ずつ裏で採点し、終了時は「最後のやりとり」と「全体（final）」だけを走らせる。
// 純粋な部分は live-scoring-core.mjs（Cloudflare 版とブラウザも読む）。ここはプロンプトとスキーマをファイルから読む Node 用の口。
import { loadPrompt } from './interview.mjs';
import { loadSchema } from './scoring.mjs';
import * as core from './live-scoring-core.mjs';

export { qSummaryText, assembleScoring, seedFromSnapshot } from './live-scoring-core.mjs';

const Q_TEMPLATE = loadPrompt('q-score');
const FINAL_TEMPLATE = loadPrompt('final');

export const buildQScorePrompt = (es, ex, modeInfo = null) => core.buildQScorePrompt(es, ex, modeInfo, Q_TEMPLATE);
export const buildFinalPrompt = (es, turns, jobs, modeInfo = null) => core.buildFinalPrompt(es, turns, jobs, modeInfo, FINAL_TEMPLATE);

/** 1やりとりを採点する。引用がそのやりとりの応募者の発言に無ければ、1回だけやり直す（core.scoreExchange）。 */
export const scoreExchange = (es, ex, { run, modeInfo = null, onProgress = null }) =>
  core.scoreExchange(es, ex, { run, modeInfo, onProgress, schema: loadSchema('q-score'), template: Q_TEMPLATE });

/** final（6軸・総評・次の練習・適法性）。引用違反があれば1回だけやり直す（core.scoreFinal）。 */
export const scoreFinal = (es, turns, jobs, { run, modeInfo = null, onProgress = null }) =>
  core.scoreFinal(es, turns, jobs, { run, modeInfo, onProgress, schema: loadSchema('final'), template: FINAL_TEMPLATE });

/**
 * 面接中の採点の取りまとめ。run は ({kind, prompt, schema, onProgress}) => Promise<object>（llm.runStructured をプラン付きで包んだもの）。
 * @param {{run: Function, es: object, modeInfo?: object, onChange?: Function, concurrency?: number, now?: () => number, seed?: object[]}} opts
 */
export function createScorer({ run, es, modeInfo = null, ...rest }) {
  return core.createScorerCore({
    ...rest,
    scoreOne: (exchange, onProgress) => scoreExchange(es, exchange, { run: (a) => run({ kind: 'q-score', ...a }), modeInfo, onProgress }),
    scoreFin: (turns, jobs, onProgress) => scoreFinal(es, turns, jobs, { run: (a) => run({ kind: 'final', ...a }), modeInfo, onProgress }),
  });
}
