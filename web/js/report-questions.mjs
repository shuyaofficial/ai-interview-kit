// 質問別のフィードバック。面接中に採点が済んだ質問からカードを出し、まだの質問は進み具合のバー付きの枠で待たせる。
import { h, ico, shortLabel } from './dom.mjs';
import { state } from './state.mjs';
import { progressBar } from './progress.mjs';
import { stageIndexAt } from './interview.mjs';

let filter = ''; // 選択中の段階タブ（再描画しても保つ）

function stageOf(card, transcript) {
  const ms = card.startMs ?? transcript?.turns[card.questionTurn]?.startMs;
  if (!Number.isFinite(ms)) return null;
  return Math.min(stageIndexAt(ms / 1000), state.stages.length - 1);
}

function waitingCard(c, i) {
  const open = c.status === 'running' || c.status === 'queued';
  return h('article', { class: 'qcard pending', 'data-status': c.status },
    h('header', {}, h('span', { class: 'qnum', text: String(i + 1).padStart(2, '0') }), h('h4', { text: c.question })),
    c.status === 'error'
      ? h('p', { class: 'error', text: 'この質問の採点に失敗しました。' })
      : h('div', { class: 'wait-row' }, h('span', { class: 'small', text: open && c.status === 'running' ? '採点中です' : '順番を待っています' }), progressBar(c.key, `${c.question}の採点の進み具合`)));
}

function doneCard(c, i, stage) {
  const q = c.result;
  return h('article', { class: 'qcard', 'data-stage': stage ?? '' },
    h('header', {},
      h('span', { class: 'qnum', text: String(i + 1).padStart(2, '0') }),
      h('h4', { text: q.question }),
      h('span', { class: 'qscore', text: `${q.score} / 5` }),
      stage != null ? h('span', { class: 'chip', text: shortLabel(state.stages[stage].label) }) : null),
    h('p', {}, h('span', { class: 'label good', text: '良かった点' }), q.good),
    h('p', {}, h('span', { class: 'label improve', text: '改善点' }), q.improve),
    q.quote ? h('blockquote', { text: q.quote }) : null,
    h('span', { class: 'label', text: '模範回答の例' }),
    h('div', { class: 'rewrite', text: q.modelAnswer }));
}

/**
 * @param {Array<{key: string, status: string, question: string, result?: object, startMs?: number}>} list 面接の順
 * @param {object|null} transcript 旧形式の質問（questionTurn）から時刻を引くときだけ使う
 */
export function renderQuestions(list, transcript) {
  const staged = list.map((c, i) => ({ c, i, stage: c.status === 'done' ? stageOf({ ...c.result, startMs: c.result.startMs ?? c.startMs }, transcript) : null }));
  const cards = staged.map(({ c, i, stage }) => (c.status === 'done' ? doneCard(c, i, stage) : waitingCard(c, i)));
  const track = h('div', { class: 'qtrack', tabindex: '0', role: 'group', 'aria-label': '質問ごとの評価' }, cards);
  const used = [...new Set(staged.map((x) => x.stage).filter((s) => s != null))].sort((a, b) => a - b);
  if (filter !== '' && !used.includes(Number(filter))) filter = '';
  const apply = () => { cards.forEach((c, i) => { c.hidden = filter !== '' && String(staged[i].stage ?? '') !== filter; }); };
  const tabs = h('div', { class: 'tabs' });
  const next = h('button', { type: 'button', class: 'qnext', 'aria-label': '次の質問へ' }, ico('i-chev'));
  const syncNext = () => { next.hidden = track.scrollWidth <= track.clientWidth + 1; };
  for (const f of [{ key: '', label: 'すべて' }, ...used.map((s) => ({ key: String(s), label: shortLabel(state.stages[s].label) }))]) {
    const b = h('button', { type: 'button', class: 'tab', 'aria-pressed': String(f.key === filter), text: f.label });
    b.addEventListener('click', () => {
      filter = f.key;
      for (const t of tabs.children) t.setAttribute('aria-pressed', String(t === b));
      apply();
      track.scrollLeft = 0;
      syncNext();
    });
    tabs.append(b);
  }
  apply();
  requestAnimationFrame(syncNext);
  next.addEventListener('click', () => track.scrollBy({ left: track.clientWidth * 0.8, behavior: 'smooth' }));
  return h('section', { class: 'panel questions', 'aria-labelledby': 'h-questions' },
    h('div', { class: 'panel-head' }, h('h3', { id: 'h-questions', text: '質問別のフィードバック' }), used.length ? tabs : null),
    used.length ? h('p', { class: 'small', text: '段階は、質問が出た時刻を各段階の目安時間に当てはめて振り分けています。' }) : null,
    h('div', { class: 'qwrap' }, track, next));
}
