// 画面とプロンプトに出る機能名・一行説明・見出しの表（正本）。改名はここだけを直す。
// ほかのファイルは名前を直書きしない（tests/labels.test.mjs が検査する）。DOM に触れないので、サーバー側（gym / warmup のプロンプト）も読む。

export const LABELS = Object.freeze({
  lens: Object.freeze({
    name: '話し方のクセチェック',
    desc: '10問と、これまでの回答から、話し方のクセと最初に試すことを1つ出します',
    heading: '話し方のクセチェック',
    clearData: 'この端末のクセチェックのデータを消す',
  }),
  warmup: Object.freeze({
    name: '本番までの練習プラン',
    desc: '面接の日までに、毎日なにを練習するかを組みます',
    heading: '本番までの練習プラン',
    homeDesc: '面接の日までの練習プランを作ります',
  }),
  gym: Object.freeze({
    name: '手ごわい面接官で練習',
    short: '手ごわい面接官',
    desc: '理詰め・圧迫・無反応・時間制限の面接官で、答えにくい質問に慣れます',
    heading: '手ごわい面接官で練習',
  }),
  quick: Object.freeze({
    name: 'ESなしですぐ面接',
    desc: '会社名や職種は空でも大丈夫。面接の種類だけ選んで、すぐ始めます',
    heading: 'ESなしですぐ面接',
  }),
  // 面接官の声の選択（server/gemini-live.mjs と web/js/voice-choice.mjs が読む）
  voice: Object.freeze({
    name: '面接官の声',
    codex: 'いつもの（既定）',
    codexShort: 'いつもの声',
    gemini: 'Gemini 3.8 Live（試験）',
    geminiShort: 'Gemini（試験）',
    geminiOff: '準備中',
    geminiNotice: '試験中。話の途中で割り込まれることがあります。料金は、あなたの Gemini API キー（Google の従量課金）にかかります',
  }),
});

/** index.html の data-label="gym.name" のような属性に、表の文字列を入れる。 */
export function applyLabels(root = globalThis.document) {
  for (const el of root.querySelectorAll('[data-label]')) {
    const [group, key] = el.dataset.label.split('.');
    const text = LABELS[group]?.[key];
    if (typeof text === 'string') el.textContent = text;
  }
}

/** アンケートの「どの画面・機能か」の選択肢。機能名は上の表から引く。 */
export const FEEDBACK_AREAS = Object.freeze([
  { id: 'es', label: 'ESの入力と添削' },
  { id: 'quick', label: LABELS.quick.name },
  { id: 'interview', label: '面接の画面（声のやりとり）' },
  { id: 'report', label: '結果のレポート' },
  { id: 'history', label: '履歴' },
  { id: 'lens', label: LABELS.lens.name },
  { id: 'warmup', label: LABELS.warmup.name },
  { id: 'gym', label: LABELS.gym.name },
  { id: 'other', label: 'そのほか' },
]);

export const FEEDBACK_MAX_CHARS = 2000;
