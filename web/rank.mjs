// 6軸の平均点からランク（S〜D）と100点換算を決める。決定論の純関数。
// 注意: ブラウザ側の web/app.js に同じ関数の写しがある（サーバーが .mjs を配信しないため）。
// 変えるときは両方を変える。tests/rank.test.mjs が写しとの一致を検査する。
const EPS = 1e-9;
const RANKS = [['S', 4.5], ['A', 3.8], ['B', 3.0], ['C', 2.2]];

/** @param {Record<string, number> | number[] | null | undefined} scores 各軸 1〜5 の点
 *  @returns {{rank: 'S'|'A'|'B'|'C'|'D', points: number, avg: number} | null} */
export function rankFromScores(scores) {
  const values = Array.isArray(scores) ? scores : scores && typeof scores === 'object' ? Object.values(scores) : [];
  if (!values.length || !values.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 5)) return null;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const rank = RANKS.find(([, min]) => avg >= min - EPS)?.[0] ?? 'D';
  return { rank, points: Math.round((avg / 5) * 100), avg };
}
