import test from 'node:test';
import assert from 'node:assert/strict';
import { rankFromScores } from '../web/rank.mjs';

// ブラウザ側は web/rank.mjs を import する（写しは持たない）。
const impls = [['web/rank.mjs', rankFromScores]];

for (const [name, fn] of impls) {
  test(`${name}: 取り出せる`, () => assert.equal(typeof fn, 'function'));
  if (typeof fn !== 'function') continue;

  test(`${name}: 境界値（ちょうどと直下）`, () => {
    const cases = [
      [5, 'S'], [4.5, 'S'], [4.49, 'A'],
      [3.8, 'A'], [3.79, 'B'],
      [3.0, 'B'], [2.99, 'C'],
      [2.2, 'C'], [2.19, 'D'],
      [1, 'D'],
    ];
    for (const [avg, rank] of cases) assert.equal(fn([avg]).rank, rank, `平均 ${avg}`);
  });

  test(`${name}: 6軸の平均と100点換算`, () => {
    const r = fn({ structure: 4, specificity: 4, ownership: 3, consistency: 4, motivation: 3, responsiveness: 4 });
    assert.equal(r.rank, 'B'); // 22/6 = 3.67
    assert.equal(r.points, 73);
    assert.ok(Math.abs(r.avg - 22 / 6) < 1e-12);
    assert.equal(fn([5, 5, 5, 5, 5, 5]).points, 100);
    assert.equal(fn([4, 5, 5, 4, 5, 4]).rank, 'S'); // 27/6 = 4.5 ちょうど
    assert.equal(fn([3, 3, 3, 3, 3, 3]).rank, 'B');
    assert.equal(fn([4, 4, 4, 4, 4, 3]).rank, 'A'); // 23/6 = 3.83
  });

  test(`${name}: 空・不正は null`, () => {
    for (const bad of [null, undefined, {}, [], 'x', 4, [NaN], [Infinity], ['4'], [0], [6], { a: 3, b: null }, { a: 3, b: 'x' }]) {
      assert.equal(fn(bad), null, JSON.stringify(bad));
    }
  });
}
