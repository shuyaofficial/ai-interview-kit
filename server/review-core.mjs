// ES 添削（設問ごと・面接プラン）と ES 読み取りの純関数: プロンプトの組み立て（テンプレートは引数）と、結果の検査。
// Node のサーバーは review.mjs 経由で、Cloudflare の Functions がこのファイルを直接読む。
import { fillTemplate, MODE_DEFAULTS } from './interview-core.mjs';
import { itemsText, MAX_ITEMS, MAX_FIELD, MAX_TITLE } from './es.mjs';

const hiringKind = (es) => (es.mode === 'midcareer' ? '中途' : '新卒');
const modeLabel = (es, modeInfo) => modeInfo?.label ?? MODE_DEFAULTS[es.mode]?.label ?? MODE_DEFAULTS.first.label;

export function lengthRule(limit) {
  return limit > 0
    ? `字数が設問の目安（${limit}字）の9割〜10割か。5=9割以上で超過なし。3=7割程度。1=半分以下か超過。`
    : '字数が内容に対して過不足ないか（字数の目安は指定されていない）。5=過不足がない。1=極端に短いか冗長。';
}

export function buildEsItemPrompt(es, item, modeInfo, template) {
  return fillTemplate(template, {
    hiringKind: hiringKind(es),
    lengthRule: lengthRule(item.limit),
    company: es.company,
    industry: es.industry,
    role: es.role,
    modeLabel: modeLabel(es, modeInfo),
    title: item.title,
    limitNote: item.limit ? `（${item.limit}字以内）` : '',
    text: item.text,
  });
}

export function buildEsPlanPrompt(es, modeInfo, template) {
  const focus = modeInfo?.focus?.length ? modeInfo.focus : MODE_DEFAULTS[es.mode]?.focus ?? [];
  return fillTemplate(template, {
    hiringKind: hiringKind(es),
    modeLabel: modeLabel(es, modeInfo),
    focus: focus.length ? focus.map((f) => `  - ${f}`).join('\n') : '  - ES の記述から自然に深掘りする',
    company: es.company,
    industry: es.industry,
    role: es.role,
    es: itemsText(es),
  });
}

const clip = (v, n) => [...String(v ?? '')].slice(0, n).join('');

/** LLM が返した添削結果の形を検査する（崩れていれば例外）。 */
export function assertItemReview(r) {
  const s = r?.scores;
  const ok = s && ['prep', 'specificity', 'length'].every((k) => Number.isInteger(s[k]) && s[k] >= 1 && s[k] <= 5)
    && Array.isArray(r.comments) && typeof r.rewrite === 'string';
  if (!ok) throw new Error('ES 添削の結果の形が不正');
  return r;
}

export function assertPlan(r) {
  if (!Array.isArray(r?.focusPoints)) throw new Error('面接プランの結果に focusPoints が無い');
  return r;
}

/** 読み取り結果を、フォームに入れられる下書きに整える（長さ・個数を丸める）。 */
export function normalizeExtract(r) {
  if (!r || typeof r !== 'object' || !Array.isArray(r.items)) throw new Error('読み取り結果の形が不正');
  const items = r.items.slice(0, MAX_ITEMS).map((it, i) => ({
    title: clip(it?.title, MAX_TITLE).trim() || `設問${i + 1}`,
    limit: Number.isInteger(it?.limit) && it.limit >= 0 && it.limit <= MAX_FIELD ? it.limit : 0,
    text: clip(it?.text, MAX_FIELD),
  }));
  return { company: clip(r.company, 200).trim(), industry: clip(r.industry, 200).trim(), role: clip(r.role, 200).trim(), items };
}
