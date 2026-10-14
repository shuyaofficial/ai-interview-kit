// ES のデータ形（設問を自由に増減できる items 形式）。旧形式（gakuchika / selfPr / motivation）は normalizeEs で変換する。
export const MODES = ['first', 'second', 'final', 'midcareer'];
export const MAX_FIELD = 2000;
export const MAX_ITEMS = 8;
export const MAX_TITLE = 100;
export const LEGACY_FIELDS = [
  { field: 'gakuchika', title: '学生時代に力を入れたこと' },
  { field: 'selfPr', title: '自己PR' },
  { field: 'motivation', title: '志望動機' },
];

/** 既定の設問。新卒は 3 問 400 字、中途は 4 問。 */
export const DEFAULT_ITEMS = {
  newgrad: [
    { title: '学生時代に力を入れたこと', limit: 400 },
    { title: '自己PR', limit: 400 },
    { title: '志望動機', limit: 400 },
  ],
  midcareer: [
    { title: '職務要約', limit: 300 },
    { title: '職務経歴と実績', limit: 800 },
    { title: '転職理由', limit: 400 },
    { title: '志望動機', limit: 400 },
  ],
};

export class EsError extends Error {}

/** ESが提出されていない面接（normalizeEs の noEs: true）。会社名・業界・職種は空でもよい。 */
export const hasEs = (es) => !es?.noEs;
/** 履歴・一覧に出す会社名。ESなしで会社名が空のときの代わりの表示。 */
export const displayCompany = (es) => es.company?.trim() || '（会社名なし）';
export const NO_ES_TEXT = 'ESは提出されていません。自己紹介と回答の中身から深掘りする。';

const len = (s) => [...s].length;
const itemId = (i) => `q${i + 1}`;

function str(v, name, { required = true, max = MAX_FIELD } = {}) {
  if (typeof v !== 'string') throw new EsError(`${name} は文字列`);
  if (required && !v.trim()) throw new EsError(`${name} が空`);
  if (len(v) > max) throw new EsError(`${name} は ${max} 字以内`);
  return v;
}

function legacyItems(es) {
  return LEGACY_FIELDS.map(({ field, title }, i) => ({ id: itemId(i), title, limit: 400, text: str(es[field], `es.${field}`) }));
}

/**
 * 旧形式・新形式のどちらも受け取り、検証して正規形を返す（入力は変更しない）。
 * 正規形: { company, industry, role, mode, plan, items: [{id, title, limit, text}] }
 * 不正なら EsError。mode / plan が無ければ first / defaultPlan。
 */
export function normalizeEs(es, { defaultPlan = 'standard', plans = null } = {}) {
  if (!es || typeof es !== 'object' || Array.isArray(es)) throw new EsError('es はオブジェクト');
  const noEs = es.noEs === true;
  const field = (name) => (noEs ? str(es[name] ?? '', `es.${name}`, { required: false, max: MAX_TITLE }) : str(es[name], `es.${name}`));
  const out = {
    company: field('company'),
    industry: field('industry'),
    role: field('role'),
    mode: es.mode ?? 'first',
    plan: es.plan ?? defaultPlan,
  };
  if (!MODES.includes(out.mode)) throw new EsError(`es.mode は ${MODES.join(' / ')} のいずれか`);
  if (typeof out.plan !== 'string' || (plans && !plans.includes(out.plan))) throw new EsError('es.plan が不正');
  if (noEs) {
    if (es.items !== undefined && !(Array.isArray(es.items) && es.items.length === 0)) throw new EsError('ESなしの面接に設問は付けられない');
    return { ...out, noEs: true, items: [] };
  }
  if (es.items === undefined) return { ...out, items: legacyItems(es) };
  if (!Array.isArray(es.items)) throw new EsError('es.items は配列');
  if (es.items.length < 1 || es.items.length > MAX_ITEMS) throw new EsError(`設問は 1〜${MAX_ITEMS} 個`);
  const items = es.items.map((it, i) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) throw new EsError(`es.items[${i}] はオブジェクト`);
    const limit = it.limit ?? 0;
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_FIELD) throw new EsError(`es.items[${i}].limit は 0〜${MAX_FIELD} の整数`);
    return {
      id: itemId(i),
      title: str(it.title, `es.items[${i}].title`, { max: MAX_TITLE }),
      limit,
      text: str(it.text ?? '', `es.items[${i}].text`, { required: false }),
    };
  });
  if (!items.some((it) => it.text.trim())) throw new EsError('本文が書かれた設問が1つも無い');
  return { ...out, items };
}

/** 設問の本文を「## 題 / 本文」で並べた文字列（プロンプト用）。 */
export function itemsText(es) {
  if (!hasEs(es)) return NO_ES_TEXT;
  return es.items
    .map((it) => `## ${it.title}${it.limit ? `（${it.limit}字以内）` : ''}\n${it.text.trim() ? it.text : '（未記入）'}`)
    .join('\n\n');
}

/**
 * 保存済みの添削結果を items 形式に揃える。旧形式（items[].field）は設問 id に対応づける。
 * 戻り値: { items: [{id, title, ...}], plan } か null。
 */
export function normalizeReview(review, es) {
  if (!review || !Array.isArray(review.items)) return null;
  const items = review.items.map((it) => {
    if (it.id) return it;
    const i = LEGACY_FIELDS.findIndex((f) => f.field === it.field);
    const base = es.items[i];
    const { field: _f, ...rest } = it;
    return { id: base?.id ?? itemId(Math.max(i, 0)), title: base?.title ?? it.field, ...rest };
  });
  return { ...review, items };
}
