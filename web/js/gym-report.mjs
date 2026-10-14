// gym を終えたあとの画面: 圧は練習のための設定だったという明示と相談先、終了後の自己評価、練習の目安（切り返しの型・立て直しの速さ）。
import { $, h, clip } from './dom.mjs';
import { api, state } from './state.mjs';
import { likert } from './forms.mjs';
import { LABELS } from './labels.mjs';

const cfg = () => state.config.gym;
const mean = (v) => Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10;
const sigs = { end: '', extra: '' };

/** 結果画面を開くたびに、上段・下段を描き直せるようにする。 */
export function resetGymReport() {
  sigs.end = '';
  sigs.extra = '';
  $('gym-end').replaceChildren();
  $('gym-extra').replaceChildren();
}

function afterForm(s, repaint) {
  const rows = cfg().anxietyItems.map((t, i) => likert({ name: `gym-after-${i}`, legend: `${i + 1}. ${t}`, count: 5, ends: [cfg().anxietyScale[0], cfg().anxietyScale[4]] }));
  const talk = h('input', { type: 'checkbox', id: 'gym-talk' });
  const reason = s.gym.stopped ? h('select', { id: 'gym-reason', 'aria-label': '止めた理由（任意）' },
    h('option', { value: '', text: '止めた理由（選ばなくても構いません）' }), cfg().stopReasons.map((r) => h('option', { value: r.id, text: r.label }))) : null;
  const save = h('button', { type: 'button', class: 'primary', text: '終了後の自己評価を保存', disabled: true });
  rows.forEach((r) => r.el.addEventListener('change', () => { save.disabled = rows.some((x) => x.value() == null); }));
  save.addEventListener('click', async () => {
    save.disabled = true;
    await api(`/api/sessions/${s.id}/gym/after`, { method: 'POST', body: { anxiety: rows.map((r) => r.value()), selfTalk: talk.checked, stopReason: reason?.value || null } });
    repaint();
  });
  return h('section', { class: 'card', 'aria-labelledby': 'h-gym-after' },
    h('h3', { id: 'h-gym-after', text: '今の気持ち（開始前と同じ6項目）' }),
    h('p', { class: 'small', text: '診断ではなく、開始前との変化を見るための自己評価です。' }),
    rows.map((r) => r.el),
    h('label', { class: 'check-row', for: 'gym-talk' }, talk, h('span', { text: '質問の合間に「三人称ひとこと」（自分の名前で呼びかける）を使った' })),
    reason ? h('div', { class: 'field-row' }, reason) : null,
    h('div', { class: 'actions' }, save));
}

function afterSummary(g) {
  return h('section', { class: 'panel', 'aria-labelledby': 'h-gym-sum' },
    h('h3', { id: 'h-gym-sum', text: '開始前と終了後の自己評価' }),
    h('p', {}, `6項目の平均（1〜5、低いほど落ち着いている）: 開始前 `, h('b', { text: String(mean(g.anxietyBefore)) }), ' → 終了後 ', h('b', { text: String(mean(g.anxietyAfter)) })),
    h('p', { text: g.hint.note }),
    g.reappraisal ? h('p', { class: 'small', text: `開始前に決めた、自分の言葉: 「${g.reappraisal}」` }) : null);
}

/** 上段: 明示・相談先・自己評価。自己評価の入力中に作り直さないよう、状態が変わったときだけ描く。 */
export function paintGymEnd(s, repaint) {
  const box = $('gym-end');
  if (!s.gym) { box.replaceChildren(); sigs.end = ''; return; }
  const sig = `${s.id}|${s.gym.anxietyAfter ? 'a' : 'b'}|${s.gym.stopped}`;
  if (sig === sigs.end) return;
  sigs.end = sig;
  box.replaceChildren(
    h('section', { class: 'panel gym-notice', role: 'region', 'aria-labelledby': 'h-gym-notice' },
      h('h3', { id: 'h-gym-notice', text: `${LABELS.gym.name}を終えました（${s.gym.typeLabel}）` }),
      h('p', { id: 'gym-consult', text: cfg().consultLine }),
      s.gym.stopped ? h('p', { text: '途中で止めました。減点にも、記録の欠損にもなりません。ここまでの会話は、そのまま振り返れます。' }) : null),
    s.gym.anxietyAfter ? afterSummary(s.gym) : afterForm(s, repaint));
}

const part = (label, p) => h('span', { class: `part${p.met ? ' met' : ''}`, text: `${label} ${p.met ? '○' : '—'}` });

function rebound(r) {
  if (!r) return null;
  if (!r.asked) return h('p', { class: 'muted', text: '今回は否定的な質問や疑う質問が無かったため、切り返しの型の目安は出ません。' });
  return [
    h('p', {}, `${r.asked} 問のうち、事実・責任・更新の3点がそろったのは `, h('b', { text: String(r.complete) }), ' 問でした。'),
    r.rebuttals.map((x) => h('div', { class: 'rebound-row' },
      h('b', { text: clip(x.question, 70) }),
      h('div', { class: 'parts' }, part('事実を認める', x.fact), part('責任の範囲', x.responsibility), part('その後の変化', x.update)),
      x.comment ? h('p', { class: 'small', text: x.comment }) : null)),
    r.summary ? h('p', { class: 'small', text: r.summary }) : null,
  ];
}

function recovery(r) {
  if (!r.count) return h('p', { class: 'muted', text: '面接官の質問に答えた回数が少なく、立て直しの速さは出せませんでした。' });
  return [
    h('dl', { class: 'facts' },
      h('div', {}, h('dt', { text: '答え始めるまで' }), h('dd', {}, h('b', { text: String(r.avgStartSec) }), ` 秒（平均）。最長 ${r.maxStartSec} 秒、${r.slowStartSec} 秒以上かかった回答は ${r.slowCount} 回`)),
      h('div', {}, h('dt', { text: '言いよどみ' }), h('dd', {}, h('b', { text: String(r.totalFillers) }), ` 回（1回答あたり ${r.fillersPerAnswer}）`))),
  ];
}

/** 練習の目安。6軸の点とは別で、ランクにも入らない。 */
export function paintGymExtra(s) {
  const box = $('gym-extra');
  if (!s.gym) { box.replaceChildren(); sigs.extra = ''; return; }
  const g = s.gymScore;
  const sig = `${s.id}|${g ? g.createdAt : s.status}`;
  if (sig === sigs.extra) return;
  sigs.extra = sig;
  if (!g) {
    box.replaceChildren(s.status === 'scoring' ? h('p', { class: 'muted', text: '練習の目安を計算中です。' }) : h('span'));
    return;
  }
  box.replaceChildren(h('section', { class: 'panel', 'aria-labelledby': 'h-gym-extra' },
    h('h3', { id: 'h-gym-extra', text: '練習の目安（6軸の点には入りません）' }),
    h('h4', { text: '切り返しの型（事実・責任・更新）' }),
    g.rebound ? rebound(g.rebound) : h('p', { class: 'error', text: g.error ?? '判定できませんでした。' }),
    h('h4', { text: '立て直しの速さ' }),
    recovery(g.recovery),
    h('p', { class: 'small', text: 'どちらも目安です。立て直しの速さは音声認識の時刻から数えるため、少しずれます。偽りや盛った答えを良しとする採点ではありません。' })));
}

