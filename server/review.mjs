// ES 添削（設問ごと・面接プラン）と ES 読み取りのプロンプト組み立て、結果の検査。
// 純関数の本体は review-core.mjs（Cloudflare 版も読む）。ここはテンプレートとスキーマをファイルから読む Node 用の口。
import { loadPrompt } from './interview.mjs';
import { loadSchema } from './scoring.mjs';
import { buildEsItemPrompt as itemWith, buildEsPlanPrompt as planWith } from './review-core.mjs';

export { lengthRule, assertItemReview, assertPlan, normalizeExtract } from './review-core.mjs';

const ITEM_TEMPLATE = loadPrompt('es-item');
const PLAN_TEMPLATE = loadPrompt('es-plan');
const EXTRACT_TEMPLATE = loadPrompt('es-extract');

export const buildEsItemPrompt = (es, item, modeInfo = null) => itemWith(es, item, modeInfo, ITEM_TEMPLATE);
export const buildEsPlanPrompt = (es, modeInfo = null) => planWith(es, modeInfo, PLAN_TEMPLATE);

export const esItemSchema = () => loadSchema('es-item');
export const esPlanSchema = () => loadSchema('es-plan');
export const esExtractSchema = () => loadSchema('es-extract');
export const extractPrompt = () => EXTRACT_TEMPLATE;
