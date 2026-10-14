import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule, createPlan, recordDone, clearDone, planView, STEPS, addDays, daysBetween, scheduleNote } from '../server/warmup.mjs';

const ids = (sch) => sch.map((s) => s.steps);

test('日程の組み替え: 本番まで7日は 1日1練習で、最後が本番の前日', () => {
  const s = buildSchedule(7);
  assert.deepEqual(s.map((x) => x.offset), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(ids(s).flat(), STEPS.map((x) => x.id));
  assert.ok(s.every((x) => x.steps.length === 1));
});

test('日程の組み替え: 本番まで14日は間隔が広がり、順序は保たれ、最後が前日', () => {
  const s = buildSchedule(14);
  assert.deepEqual(s.map((x) => x.offset), [0, 2, 4, 7, 9, 11, 13]);
  assert.deepEqual(ids(s).flat(), STEPS.map((x) => x.id));
  assert.equal(s.length, 7);
  const gaps = s.slice(1).map((x, i) => x.offset - s[i].offset);
  assert.ok(gaps.every((g) => g >= 1 && g <= 3));
});

test('日程の組み替え: 本番まで3日は3日に詰め、順序は保たれ、すべての練習が入り、最後が前日', () => {
  const s = buildSchedule(3);
  assert.deepEqual(s.map((x) => x.offset), [0, 1, 2]);
  assert.deepEqual(ids(s), [['baseline', 'narrow', 'recall'], ['swap', 'gym'], ['full', 'light']]);
  assert.deepEqual(ids(s).flat(), STEPS.map((x) => x.id));
});

test('日程の組み替え: 範囲外は 400。2日・30日が端', () => {
  for (const d of [1, 0, -1, 31, 2.5, '7', null]) assert.throws(() => buildSchedule(d), (e) => e.status === 400, String(d));
  assert.equal(buildSchedule(2).length, 2);
  assert.equal(buildSchedule(30).at(-1).offset, 29);
  for (let d = 2; d <= 30; d += 1) {
    const s = buildSchedule(d);
    assert.equal(s.at(-1).offset, d - 1, `D=${d}`);
    assert.deepEqual(ids(s).flat(), STEPS.map((x) => x.id), `D=${d}`);
  }
});

test('計画: 日付は今日から数え、本番日と説明（間隔の割合・仮説の明記）が付く', () => {
  const p = createPlan({ today: '2026-10-13', daysToReal: 14, intention: { when: '平日の夜9時', where: '自室' } });
  assert.equal(p.realDate, '2026-10-27');
  assert.deepEqual(p.sessions.map((s) => s.date), ['2026-10-13', '2026-10-15', '2026-10-17', '2026-10-20', '2026-10-22', '2026-10-24', '2026-10-26']);
  assert.deepEqual(p.intention, { when: '平日の夜9時', where: '自室' });
  assert.match(p.note, /約2\.2日/);
  assert.match(scheduleNote(3, buildSchedule(3)), /3日に詰めています/);
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(daysBetween('2026-10-13', '2026-10-20'), 7);
  assert.throws(() => createPlan({ today: '2026-10-13', daysToReal: 7, intention: { when: 'あ'.repeat(41) } }), (e) => e.status === 400);
});

test('実施記録・自信度・点の差: 1回目と最終回の点の差だけを出す。記録は上書き・取り消しでき、元の計画は変えない', () => {
  const p0 = createPlan({ today: '2026-10-13', daysToReal: 7 });
  const p1 = recordDone(p0, 1, { confidence: 2, sessionId: 'a', at: 't1' });
  assert.equal(p0.sessions[0].done, null, '元の計画は変えない');
  const p2 = recordDone(recordDone(p1, 7, { confidence: 4, sessionId: 'b', at: 't7' }), 3, { confidence: 3, at: 't3' });
  const pts = { a: 58, b: 66 };
  const v = planView(p2, '2026-10-19', (id) => pts[id] ?? null);
  assert.deepEqual(v.diff, { first: 58, last: 66, delta: 8 });
  assert.deepEqual(v.sessions.map((s) => s.status), ['done', 'late', 'done', 'late', 'late', 'late', 'done']);
  assert.equal(v.sessions[0].done.confidence, 2);
  assert.equal(v.sessions[0].points, 58);
  assert.equal(v.sessions[2].points, null, '面接を紐づけない回は点なし');
  assert.equal(v.current, 2);
  assert.equal(v.allDone, false);
  assert.equal(v.daysLeft, 1);
  assert.ok(v.notes.some((n) => n.includes('仮説')) && v.notes.some((n) => n.includes('7日で自信がつく')));
  // 片方しか点が無ければ差は出さない
  assert.equal(planView(p1, '2026-10-13', (id) => pts[id]).diff, null);
  const undone = clearDone(p2, 1);
  assert.equal(undone.sessions[0].done, null);
  assert.throws(() => recordDone(p0, 9, { confidence: 3, at: 't' }), (e) => e.status === 404);
  for (const c of [0, 6, 2.5, '3', undefined]) assert.throws(() => recordDone(p0, 1, { confidence: c, at: 't' }), (e) => e.status === 400);
});

test('今日の練習: 今日の回 → 遅れた回 → 次の回の順に選ぶ。全部終われば null', () => {
  const p = createPlan({ today: '2026-10-13', daysToReal: 7 });
  assert.equal(planView(p, '2026-10-13').current, 1);
  assert.equal(planView(p, '2026-10-13').sessions[0].status, 'today');
  assert.equal(planView(p, '2026-10-15').current, 1, '1回目が遅れていれば、それが先');
  const done1 = recordDone(p, 1, { confidence: 3, at: 't' });
  assert.equal(planView(done1, '2026-10-13').current, 2, '今日の分が済めば、次の回');
  assert.equal(planView(done1, '2026-10-13').sessions[1].status, 'upcoming');
  let all = p;
  for (const s of p.sessions) all = recordDone(all, s.n, { confidence: 3, at: 't' });
  const v = planView(all, '2026-10-30');
  assert.equal(v.current, null);
  assert.equal(v.allDone, true);
  assert.equal(planView(null, '2026-10-13'), null);
});
