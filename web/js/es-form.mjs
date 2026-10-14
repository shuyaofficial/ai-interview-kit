// ES 入力画面: 応募先・面接の種類・プラン・設問（自由に増減）と、PDF・画像からの読み取り。
import { $, h } from './dom.mjs';
import { api, state, nav } from './state.mjs';
import { progressBar, paintBars } from './progress.mjs';
import { voiceChoice } from './voice-choice.mjs';

const MAX_FILE = 10 * 1024 * 1024;
const MIME_BY_EXT = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const form = { mode: 'first', plan: null, kind: 'newgrad', touched: false, nextKey: 0, voice: null };

const kindOfMode = (mode) => (mode === 'midcareer' ? 'midcareer' : 'newgrad');
const itemCards = () => [...$('items').children];

// ---------- 設問 ----------

function updateCounter(card) {
  const n = [...card.querySelector('textarea').value].length;
  const limit = Number(card.querySelector('.limit-input').value) || 0;
  const el = card.querySelector('.counter');
  const over = limit > 0 && n > limit;
  el.textContent = limit > 0 ? (over ? `${n} / ${limit} 字（${n - limit} 字超過）` : `${n} / ${limit} 字`) : `${n} 字`;
  el.classList.toggle('over', over);
  el.classList.toggle('near', limit > 0 && !over && n >= limit * 0.9);
}

function refreshItemUi() {
  const cards = itemCards();
  cards.forEach((card, i) => {
    card.querySelector('.item-no').textContent = `設問 ${i + 1}`;
    card.querySelector('.remove-item').disabled = cards.length <= 1;
  });
  $('btn-add-item').disabled = cards.length >= state.config.maxItems;
  $('items-note').textContent = `設問は ${cards.length} / ${state.config.maxItems} 個。1 設問は 2000 字まで。`;
}

function addItem(item = { title: '', limit: 400, text: '' }) {
  form.nextKey += 1;
  const key = form.nextKey;
  const title = h('input', { id: `f-title-${key}`, class: 'title-input', type: 'text', maxlength: '100', required: true, 'aria-label': '設問のタイトル' });
  const limit = h('input', { id: `f-limit-${key}`, class: 'limit-input', type: 'number', min: '0', max: '2000', step: '1', inputmode: 'numeric', 'aria-label': '字数の目安（0 は目安なし）' });
  const text = h('textarea', { id: `f-text-${key}`, rows: '7', maxlength: '2000', 'aria-label': '本文' });
  const remove = h('button', { type: 'button', class: 'remove-item', text: '削除' });
  const counter = h('p', { class: 'counter' });
  title.value = item.title;
  limit.value = String(item.limit ?? 0);
  text.value = item.text;
  const card = h('div', { class: 'card item-card' },
    h('div', { class: 'item-head' },
      h('span', { class: 'item-no small' }),
      h('label', { class: 'item-title' }, h('span', { class: 'visually-hidden', text: 'タイトル' }), title),
      h('label', { class: 'item-limit small' }, '目安 ', limit, ' 字'),
      remove),
    text, counter);
  const touch = () => { form.touched = true; updateCounter(card); };
  text.addEventListener('input', touch);
  limit.addEventListener('input', () => updateCounter(card));
  title.addEventListener('input', () => { form.touched = true; });
  remove.addEventListener('click', () => {
    card.remove();
    form.touched = true;
    refreshItemUi();
  });
  $('items').append(card);
  updateCounter(card);
  refreshItemUi();
  return card;
}

function setItems(items) {
  $('items').replaceChildren();
  for (const it of items) addItem(it);
  if (!items.length) addItem();
}

function defaultItemsFor(kind) {
  return state.config.defaultItems[kind].map((it) => ({ ...it, text: '' }));
}

// ---------- 種類・プラン ----------

function choice(name, value, labelText, detail, { checked, disabled }) {
  const input = h('input', { type: 'radio', name, value, checked, disabled });
  const label = h('label', { class: `choice${disabled ? ' off' : ''}` }, input, h('span', { class: 'choice-body' }, h('b', { text: labelText }), h('span', { class: 'small', text: detail })));
  return { label, input };
}

function buildModes() {
  const box = $('mode-options');
  box.replaceChildren();
  for (const m of state.config.modes) {
    const { label, input } = choice('mode', m.id, m.label, m.available ? `約${m.durationMin}分` : '準備中', { checked: m.id === form.mode, disabled: !m.available });
    input.addEventListener('change', () => {
      form.mode = m.id;
      const kind = kindOfMode(m.id);
      if (kind !== form.kind && !form.touched) setItems(defaultItemsFor(kind)); // 何も書いていなければ、新卒/中途の既定の設問に入れ替える
      form.kind = kind;
      $('mode-purpose').textContent = m.purpose;
    });
    box.append(label);
  }
  $('mode-purpose').textContent = state.config.modes.find((m) => m.id === form.mode)?.purpose ?? '';
}

function buildVoice() {
  form.voice = voiceChoice('es-voice');
  $('voice-options').replaceChildren(form.voice.el);
}

function buildPlans() {
  const box = $('plan-options');
  box.replaceChildren();
  form.plan ??= state.config.defaultPlan;
  for (const p of state.config.plans) {
    const { label, input } = choice('plan', p.id, p.label, p.price, { checked: p.id === form.plan, disabled: false });
    input.addEventListener('change', () => { form.plan = p.id; });
    box.append(label);
  }
}

// ---------- 読み取り（PDF・画像）----------

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fileMime(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] ?? file.type;
}

function fillDraft(d) {
  for (const k of ['company', 'industry', 'role']) if (d[k]) $(`f-${k}`).value = d[k];
  if (d.items.length) {
    setItems(d.items);
    form.touched = true;
  }
}

async function runExtract() {
  const file = $('f-file').files[0];
  const note = $('extract-state');
  if (!file) { note.textContent = 'ファイルを選んでください。'; return; }
  if (file.size > MAX_FILE) { note.textContent = 'ファイルは 10MB 以下にしてください。'; return; }
  if (!MIME_BY_EXT[file.name.split('.').pop().toLowerCase()]) { note.textContent = '読み取れるのは PDF・PNG・JPG・WEBP です。'; return; }
  $('btn-extract').disabled = true;
  const startedAt = performance.now();
  const expected = state.config.expected['es-extract'];
  const box = $('extract-progress');
  box.replaceChildren(progressBar('extract', '読み取りの進み具合'));
  box.hidden = false;
  const tick = setInterval(() => paintBars(box, () => Math.min(0.95, (performance.now() - startedAt) / 1000 / expected)), 300);
  note.textContent = '読み取り中です。しばらくお待ちください。';
  try {
    const dataBase64 = toBase64(await file.arrayBuffer());
    const draft = await api('/api/es/extract', { method: 'POST', body: { filename: file.name, mime: fileMime(file), dataBase64, plan: form.plan } });
    fillDraft(draft);
    note.textContent = draft.items.length
      ? `下書きを入れました（設問 ${draft.items.length} 件）。読み間違いがないか確かめて、直してから送ってください。`
      : '文字を読み取れませんでした。画像が鮮明か確かめるか、直接入力してください。';
  } catch (e) {
    note.textContent = `読み取れませんでした: ${e.message}`;
  } finally {
    clearInterval(tick);
    box.hidden = true;
    $('btn-extract').disabled = false;
  }
}

// ---------- 送信 ----------

function collectEs() {
  return {
    company: $('f-company').value,
    industry: $('f-industry').value,
    role: $('f-role').value,
    mode: form.mode,
    plan: form.plan,
    items: itemCards().map((card) => ({
      title: card.querySelector('.title-input').value,
      limit: Number(card.querySelector('.limit-input').value) || 0,
      text: card.querySelector('textarea').value,
    })),
  };
}

async function submit(e) {
  e.preventDefault();
  const err = $('es-error');
  err.hidden = true;
  $('btn-submit-es').disabled = true;
  try {
    const { id } = await api('/api/sessions', { method: 'POST', body: { es: collectEs(), voice: form.voice.value() } });
    nav.openSession(id);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    $('btn-submit-es').disabled = false;
  }
}

export function setupEsForm() {
  form.plan = state.config.defaultPlan;
  buildModes();
  buildVoice();
  buildPlans();
  setItems(defaultItemsFor('newgrad'));
  form.touched = false;
  $('btn-add-item').addEventListener('click', () => { form.touched = true; addItem({ title: '', limit: 400, text: '' }).querySelector('.title-input').focus(); });
  $('btn-extract').addEventListener('click', runExtract);
  $('es-form').addEventListener('submit', submit);
}

/** 画面を開くたびに、空の初期状態へ戻す。 */
export function resetEsForm() {
  $('es-form').reset();
  form.mode = 'first';
  form.kind = 'newgrad';
  form.plan = state.config.defaultPlan;
  form.touched = false;
  buildModes();
  buildVoice();
  buildPlans();
  setItems(defaultItemsFor('newgrad'));
  form.touched = false;
  $('extract-state').textContent = '';
  $('es-error').hidden = true;
}
