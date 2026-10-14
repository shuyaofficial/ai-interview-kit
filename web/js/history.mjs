// 履歴: 過去の面接の点数と、直前に完了した面接との差。
import { $, h, shortLabel } from './dom.mjs';
import { api, state, nav, clearTimers, show } from './state.mjs';
import { rankFromScores } from '../rank.mjs';
import { fmtDate } from './dom.mjs';
import { LABELS } from './labels.mjs';
import { voiceLabel } from './voice-choice.mjs';

const AXIS_SHORT = { structure: '結論', specificity: '具体性', ownership: '主体性', consistency: '一貫性', motivation: '志望度', responsiveness: '的確さ' };
const STATUS_LABEL = { stopped: '途中で止めた', done: '完了', error: 'エラー', scoring: '採点中', interviewing: '面接中', ready: '準備済み', reviewing: '添削中' };

function deltaCell(cur, prev, label) {
  const td = (...c) => h('td', { class: 'num', 'data-label': label }, ...c);
  if (cur == null) return td('—');
  if (prev == null) return td(String(cur));
  const d = cur - prev;
  const mark = d > 0 ? h('span', { class: 'up', text: ` ↑${d}` }) : d < 0 ? h('span', { class: 'down', text: ` ↓${-d}` }) : h('span', { class: 'muted', text: ' →' });
  return td(String(cur), mark);
}

export async function showHistory() {
  clearTimers();
  nav.teardownRtc();
  show('history');
  const { config } = state;
  const list = (await api('/api/sessions')).filter((x) => !(x.gym && x.status === 'ready')); // 始めただけの gym は出さない
  const box = $('history-body');
  if (!list.length) {
    const start = h('button', { type: 'button', class: 'primary', text: 'ES を書く' });
    start.addEventListener('click', nav.newInterview);
    box.replaceChildren(h('p', { class: 'muted', text: 'まだ面接の記録がありません。' }), start);
    return;
  }
  const modeLabel = (id) => config.modes.find((m) => m.id === id)?.label ?? '';
  const rows = list.map((item, i) => {
    const prev = list.slice(i + 1).find((x) => x.status === 'done' && x.scores && Boolean(x.gym) === Boolean(item.gym));
    const r = item.scores ? rankFromScores(item.scores) : null;
    const open = h('button', { type: 'button', class: 'open', text: item.company });
    open.addEventListener('click', () => nav.openSession(item.id));
    return h('tr', { 'data-id': item.id },
      h('td', { class: 'when', text: fmtDate(item.createdAt) }),
      h('td', { class: 'who' }, open, h('span', { class: 'small kind', text: item.gym ? ` ${LABELS.gym.short}` : ` ${shortLabel(modeLabel(item.mode))}` }),
        h('span', { class: 'small kind voice-tag', text: ` ・${voiceLabel(item.voice, true)}` })),
      h('td', { class: 'status', text: STATUS_LABEL[item.status] ?? item.status }),
      h('td', { class: 'total' }, r ? [h('span', { class: 'rank-chip', text: r.rank }), h('span', { class: 'pts', text: ` ${r.points}` })] : '—'),
      config.axes.map((ax) => deltaCell(item.scores?.[ax.id], prev?.scores?.[ax.id], AXIS_SHORT[ax.id] ?? ax.label)));
  });
  box.replaceChildren(
    h('table', { class: 'history' },
      h('thead', {}, h('tr', {}, h('th', { text: '日時' }), h('th', { text: '企業' }), h('th', { text: '状態' }), h('th', { text: '総合' }),
        config.axes.map((ax) => h('th', { class: 'num', title: ax.label, text: AXIS_SHORT[ax.id] ?? ax.label })))),
      h('tbody', {}, rows)),
    h('p', { class: 'muted', text: `矢印は、直前に完了した同じ種類（通常の面接、または${LABELS.gym.name}）との点数の差です。総合は 6 軸の平均から決めたランクと 100 点換算です。` }));
}
