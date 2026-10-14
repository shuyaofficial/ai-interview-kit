// 面接官プロンプトの組み立て（面接の種類ごと）と逐語録レコーダ。純関数の本体は interview-core.mjs（Cloudflare 版とブラウザも読む）。
// このファイルは、プロンプト・質問データをファイルから読む Node 用の口。既存の呼び出し側は変更しなくてよい。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shapeBank, describeModes, buildInterviewerPrompt as buildWithTemplate } from './interview-core.mjs';

export {
  fillTemplate, MODE_DEFAULTS, forbiddenText, stagesText, GENERAL_FOCUS, focusPointsText, stripEs, adaptBank,
  employerText, roleLine, companyNote, KICKOFF_TEXT, createRecorder,
} from './interview-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadPrompt(name) {
  return readFileSync(join(HERE, 'prompts', `${name}.md`), 'utf8');
}

const BANK_DIR = join(HERE, 'question-banks');

function readJsonSync(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** 一次の質問データ（後方互換。stages だけを使う呼び出し用）。 */
export function loadBank() {
  return JSON.parse(readFileSync(join(HERE, 'question-bank.json'), 'utf8'));
}

/**
 * 面接の種類の質問データ。一次は question-bank.json、ほかは question-banks/<mode>.json。
 * ファイルが無い・壊れている種類は null（画面では「準備中」）。一次は必ず返る。
 */
export function loadModeBank(mode = 'first', dir = BANK_DIR) {
  return shapeBank(mode, mode === 'first' ? loadBank() : readJsonSync(join(dir, `${mode}.json`)));
}

/** 画面に出す面接の種類の一覧。bank が無い種類は available:false。 */
export function listModes(dir = BANK_DIR) {
  return describeModes((id) => loadModeBank(id, dir));
}

const INTERVIEWER_TEMPLATE = loadPrompt('interviewer');

/** 純関数。bank は loadModeBank の戻り値（生の一次 bank でも、一次の既定値で補って動く）。template の既定は interviewer.md。 */
export function buildInterviewerPrompt(es, plan, rawBank, template = INTERVIEWER_TEMPLATE) {
  return buildWithTemplate(es, plan, rawBank, template);
}
