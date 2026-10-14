// ES添削・採点のプロンプト組み立てと、LLM を使わない決定論の検査（話し方の目安・引用検証・禁止語）。
// 純関数の本体は scoring-core.mjs（Cloudflare 版とブラウザも読む）。ここはファイルからプロンプトとスキーマを読む Node 用の口と、一括採点 score()。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillTemplate, loadPrompt, forbiddenText } from './interview.mjs';
import { axesText, noEsRule, esText, transcriptText, norm, validateEvidence, scanForbidden, assertScoringShape, retryNote, dedupe } from './scoring-core.mjs';
import { getLlm } from './llm.mjs';

export {
  axesText, noEsRule, esText, transcriptText, countFillers, fillerRegex, computeSpeechMetrics, norm, validateEvidence, scanForbidden,
  assertScoringShape, retryNote, dedupe,
} from './scoring-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ES_CHAR_LIMIT = 400;

export function loadSchema(name) {
  return JSON.parse(readFileSync(join(HERE, 'schemas', `${name}.schema.json`), 'utf8'));
}

const ES_REVIEW_TEMPLATE = loadPrompt('es-review');
const SCORING_TEMPLATE = loadPrompt('scoring');

export function buildEsReviewPrompt(es) {
  return fillTemplate(ES_REVIEW_TEMPLATE, {
    limit: ES_CHAR_LIMIT,
    company: es.company,
    industry: es.industry,
    role: es.role,
    gakuchika: es.gakuchika,
    selfPr: es.selfPr,
    motivation: es.motivation,
  });
}


export function buildScoringPrompt(es, turns) {
  return fillTemplate(SCORING_TEMPLATE, {
    noEsRule: noEsRule(es),
    axes: axesText(es),
    forbidden: forbiddenText(),
    es: esText(es),
    transcript: transcriptText(turns),
  });
}



/**
 * LLM で採点し、引用違反があれば違反箇所を添えて1回だけ再採点する。
 * それでも違反した軸には evidenceInvalid:true を付ける。compliance は LLM と scanForbidden の合算。
 * run は ({prompt, schema}) => Promise<object>。既定は llm.mjs 経由（plan で provider が決まる）、テストでは差し替える。
 */
export async function score(es, turns, { run = (a) => getLlm().runStructured({ kind: 'score', ...a }) } = {}) {
  const schema = loadSchema('scoring');
  const prompt = buildScoringPrompt(es, turns);
  let result = await run({ prompt, schema });
  assertScoringShape(result);
  let violations = validateEvidence(result, turns);
  let retried = false;
  if (violations.length) {
    retried = true;
    const second = await run({ prompt: prompt + retryNote(violations), schema });
    assertScoringShape(second);
    const secondViolations = validateEvidence(second, turns);
    if (secondViolations.length <= violations.length) {
      result = second;
      violations = secondViolations;
    }
  }
  const badAxes = new Set(violations.filter((v) => v.kind === 'axis').map((v) => v.axis));
  const axes = result.axes.map((a) => (badAxes.has(a.axis) ? { ...a, evidenceInvalid: true } : { ...a }));
  const llmViolations = (result.compliance?.violations ?? []).map((v) => ({ ...v, source: 'llm' }));
  const compliance = { violations: dedupe([...llmViolations, ...scanForbidden(turns)]) };
  return {
    scoring: { ...result, axes, compliance: { violations: llmViolations } },
    evidenceViolations: violations,
    compliance,
    retried,
  };
}
