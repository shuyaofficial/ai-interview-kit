import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { endsWithQuestion, splitExchanges, createExchangeTracker, exchangeKey, exchangeText } from '../server/exchanges.mjs';

const I = (text, startMs = 0) => ({ role: 'interviewer', text, startMs, endMs: startMs + 1 });
const C = (text, startMs = 0) => ({ role: 'candidate', text, startMs, endMs: startMs + 1 });

test('endsWithQuestion: 質問文・依頼文で終わるか（挨拶・相づち・締めは違う）', () => {
  for (const t of ['学生時代に力を入れたことを教えてください。', '一番大変だったのはどのような場面でしたか。', '他の選択肢は検討しなかったのですか？', '自己紹介をお願いします。', 'ご質問はありますか', '詳しくお聞かせ下さい']) {
    assert.equal(endsWithQuestion(t), true, t);
  }
  for (const t of ['本日はよろしくお願いします。', 'ありがとうございます。', '承知しました。', '本日の面接は以上です。お疲れさまでした。', 'ゆっくりで大丈夫です。', '']) {
    assert.equal(endsWithQuestion(t), false, t);
  }
});

test('splitExchanges: 質問→回答を1往復ずつ区切る', () => {
  const ex = splitExchanges([I('自己紹介をお願いします。'), C('山田です。'), I('ガクチカを教えてください。'), C('発送です。'), I('なぜですか。'), C('ミスが多かったからです。')]);
  assert.equal(ex.length, 3);
  assert.deepEqual(ex.map((e) => e.turns.length), [2, 2, 2]);
  assert.deepEqual(ex.map((e) => e.question), ['自己紹介をお願いします。', 'ガクチカを教えてください。', 'なぜですか。']);
  assert.deepEqual(ex.map((e) => e.index), [0, 1, 2]);
});

test('splitExchanges: 質問文で終わらない発話（相づち・締め）は前のやりとりに付く', () => {
  const ex = splitExchanges([
    I('本日はよろしくお願いします。自己紹介をお願いします。'), C('山田です。'),
    I('ありがとうございます。'), // 相づち: 閉じない
    I('志望動機を教えてください。'), C('物流に関心があります。'),
    I('本日の面接は以上です。お疲れさまでした。'), // 締め: 閉じない
  ]);
  assert.equal(ex.length, 2);
  assert.deepEqual(ex.map((e) => e.turns.length), [3, 3]);
  assert.equal(ex[1].turns.at(-1).text, '本日の面接は以上です。お疲れさまでした。');
});

test('splitExchanges: 応募者が答えなかった質問はやりとりにならず、答えた回答の質問が主質問になる', () => {
  const ex = splitExchanges([I('質問Aですか。'), I('質問Bをお願いします。'), C('答えB'), I('質問Cを教えてください。')]);
  assert.equal(ex.length, 1);
  assert.equal(ex[0].question, '質問Bをお願いします。');
  assert.equal(ex[0].turns.length, 3);
  assert.deepEqual(splitExchanges([I('質問ですか。')]), []);
  assert.deepEqual(splitExchanges([]), []);
});

test('splitExchanges: 応募者の連続した発話は同じやりとり', () => {
  const ex = splitExchanges([I('教えてください。'), C('はい。'), C('えーと、実は。'), I('次を教えてください。'), C('答え')]);
  assert.deepEqual(ex.map((e) => e.turns.length), [3, 2]);
});

test('fixtures の逐語録: 面接官の質問ごとに1つ（strong / weak とも 9 個、各2発話）', () => {
  for (const name of ['strong', 'weak']) {
    const fx = JSON.parse(readFileSync(new URL(`../fixtures/${name}-transcript.json`, import.meta.url), 'utf8'));
    const ex = splitExchanges(fx.turns);
    assert.equal(ex.length, fx.turns.filter((t) => t.role === 'interviewer').length, name);
    assert.deepEqual(ex.map((e) => e.turns.length), Array(9).fill(2), name);
    assert.equal(ex.flatMap((e) => e.turns).length, fx.turns.length);
  }
});

test('createExchangeTracker: 次の質問が完了した時点で前のやりとりを返し、flush で最後を返す', () => {
  const t = createExchangeTracker();
  assert.equal(t.push(I('教えてください。')), null);
  assert.equal(t.push(C('はい')), null);
  const closed = t.push(I('次を教えてください。'));
  assert.equal(closed.turns.length, 2);
  assert.equal(t.flush(), null); // 次の質問にはまだ回答が無い
  const t2 = createExchangeTracker();
  t2.push(I('Q?')); t2.push(C('A'));
  assert.equal(t2.flush().index, 0);
  assert.equal(t2.flush(), null);
});

test('exchangeKey / exchangeText', () => {
  const e = splitExchanges([I('Q ですか。'), C('A あ')])[0];
  assert.equal(exchangeKey(e), exchangeKey(splitExchanges([I('Qですか。'), C('Aあ')])[0])); // 空白差は同じ
  assert.equal(exchangeText(e), '0: interviewer: Q ですか。\n1: candidate: A あ');
});
