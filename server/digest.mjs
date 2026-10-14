// 感想アンケートの「使いにくかった点」をまとめる。LLM は llm.runStructured（スタンダードのプラン）だけを通す。
// 引用は原文に実在するかを機械で確かめる。実在しない引用は捨て、引用が残らないテーマは出力しない。
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson } from './http-util.mjs';
import { fillTemplate, loadPrompt } from './interview.mjs';
import { loadSchema, norm } from './scoring.mjs';
import { areaLabel } from './feedback.mjs';

export const EFFORTS = ['小', '中', '大'];
export const PRIORITIES = ['高', '中', '低'];
export const NO_FEEDBACK = '感想はまだありません';

/** 感想の届いた時刻（ms）。createdAt が読めなければファイルの更新時刻。 */
const arrivedAt = (row, mtimeMs) => {
  const t = Date.parse(row.createdAt);
  return Number.isFinite(t) ? t : mtimeMs;
};

/**
 * dir の *.json（digest- で始まるまとめ・状態ファイルは除く）を読み、「使いにくかった点を送る」にチェックがあり、中身がある感想だけを返す。
 * since（ISO 時刻）を渡すと、それより後に届いた感想だけを対象にする（all は全体の件数、fresh は since より後の件数、latest は全体で最も新しい感想の時刻）。
 */
export async function loadFeedback(dir, { since = null } = {}) {
  let names = [];
  try { names = (await readdir(dir)).filter((f) => f.endsWith('.json') && !f.startsWith('digest-')).sort(); } catch { return { all: 0, fresh: 0, latest: null, usable: [] }; }
  const sinceMs = since ? Date.parse(since) : null;
  if (since && !Number.isFinite(sinceMs)) throw new Error(`since が時刻として読めない: ${since}`);
  const loaded = await Promise.all(names.map(async (f) => {
    const row = await readJson(join(dir, f)).catch(() => null);
    return row ? { row, at: arrivedAt(row, (await stat(join(dir, f))).mtimeMs) } : null;
  }));
  const rows = loaded.filter(Boolean);
  const fresh = rows.filter((r) => sinceMs === null || r.at > sinceMs);
  const usable = fresh
    .map((r) => r.row)
    .filter((r) => r.sendToDev === true && (r.bad?.text?.trim() || r.bad?.picks?.length))
    .map((r, i) => ({ n: i + 1, id: r.id, rating: r.rating, picks: r.bad.picks ?? [], text: (r.bad.text ?? '').trim() }));
  const latestMs = rows.length ? Math.max(...rows.map((r) => r.at)) : null;
  return { all: rows.length, fresh: fresh.length, latest: latestMs === null ? null : new Date(latestMs).toISOString(), usable };
}

export function buildDigestPrompt(usable) {
  const lines = usable.map((u) => `[${u.n}] 選んだ場所: ${u.picks.map(areaLabel).join('、') || '（なし）'}\n原文: ${u.text || '（自由記入なし）'}`);
  return fillTemplate(loadPrompt('feedback-digest'), { total: usable.length, feedback: lines.join('\n\n') });
}

/** スキーマの形の検査（外部のライブラリを使わない）。違反の文字列の配列。 */
export function shapeErrors(out) {
  const errs = [];
  if (!out || !Array.isArray(out.themes)) return ['themes が配列でない'];
  out.themes.forEach((t, i) => {
    const at = `themes[${i}]`;
    for (const k of ['theme', 'cause', 'fix']) if (typeof t?.[k] !== 'string' || !t[k].trim()) errs.push(`${at}.${k} が空か文字列でない`);
    if (!Number.isInteger(t?.count) || t.count < 1) errs.push(`${at}.count は 1 以上の整数（最終的な件数は、引用が実在する感想の数に直す）`);
    if (!Array.isArray(t?.quotes) || t.quotes.length < 1 || t.quotes.some((q) => typeof q !== 'string' || !norm(q))) errs.push(`${at}.quotes は空でない文字列が1つ以上`);
    if (!EFFORTS.includes(t?.effort)) errs.push(`${at}.effort は ${EFFORTS.join('/')}`);
    if (!PRIORITIES.includes(t?.priority)) errs.push(`${at}.priority は ${PRIORITIES.join('/')}`);
  });
  return errs;
}

/** 引用が、感想の原文のどれかに実在するか。 */
export const quoteExists = (quote, usable) => {
  const q = norm(quote);
  return Boolean(q) && usable.some((u) => norm(u.text).includes(q));
};

/** 実在しない引用を捨て、引用が残らないテーマを落とす。件数は引用が実在する感想の数に直す。新しいオブジェクトを返す。 */
export function verifyThemes(out, usable) {
  const kept = [];
  const dropped = [];
  for (const t of out.themes) {
    const quotes = t.quotes.filter((q) => quoteExists(q, usable));
    if (!quotes.length) { dropped.push(t.theme); continue; }
    const count = usable.filter((u) => quotes.some((q) => norm(u.text).includes(norm(q)))).length;
    kept.push({ ...t, quotes, count, ...(count !== t.count ? { llmCount: t.count } : {}) });
  }
  return { themes: kept, dropped, badQuotes: out.themes.flatMap((t) => t.quotes.filter((q) => !quoteExists(q, usable))) };
}

/**
 * まとめを作る。形か引用に違反があれば、1回だけ違反を添えて作り直す。run は ({prompt, schema}) => Promise<object>。
 * @returns {Promise<{themes: object[], dropped: string[], total: number, retried: boolean}>}
 */
export async function digest(usable, { run }) {
  const schema = loadSchema('feedback-digest');
  const prompt = buildDigestPrompt(usable);
  const attempt = async (p) => {
    const out = await run({ prompt: p, schema });
    const errs = shapeErrors(out);
    if (errs.length) return { errs };
    const v = verifyThemes(out, usable);
    return { v, errs: v.badQuotes.map((q) => `原文に無い引用: 「${q}」`) };
  };
  let r = await attempt(prompt);
  let retried = false;
  if (r.errs.length) {
    retried = true;
    const note = `\n\n# 前回の出力の違反（直して作り直す）\n${r.errs.map((e) => `- ${e}`).join('\n')}\n引用は原文から一字一句そのままコピーすること。\n`;
    r = await attempt(prompt + note);
  }
  if (!r.v) throw new Error(`まとめの形が不正: ${r.errs.join(' / ')}`);
  return { themes: r.v.themes, dropped: r.v.dropped, total: usable.length, retried };
}


/** Markdown に整える。優先度の高い順、同じなら件数の多い順。 */
export function renderMarkdown(result, { date, all }) {
  const themes = [...result.themes].sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || b.count - a.count);
  const head = [`# 使いにくかった点のまとめ（${date}）`, '', `対象の感想: ${result.total}件（全体 ${all}件のうち、使いにくかった点を送る設定のもの）。テーマ ${themes.length}個。`, ''];
  const body = themes.flatMap((t, i) => [
    `## ${i + 1}. ${t.theme}`, '',
    `- 件数: ${t.count}件`, `- 手間: ${t.effort}`, `- 検討の優先度: ${t.priority}`, `- 考えられる原因: ${t.cause}`, `- 直し方の案: ${t.fix}`,
    '- 原文の引用:', ...t.quotes.map((q) => `  - 「${q}」`), '',
  ]);
  const tail = result.dropped.length ? [`注: 引用が原文に無かったため、次のテーマは出力から外した: ${result.dropped.join('、')}`, ''] : [];
  return [...head, ...body, ...tail].join('\n');
}
