// Gemini から受けた字幕を、サーバーへまとめて送る（POST /api/sessions/:id/voice）。
// 同じ話者の delta は1つにまとめ、done は待たずにすぐ送る。送信は1本ずつ順番に行う（順番が崩れると逐語録が壊れる）。
export function createUploader({ send, onError, delayMs = 250, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let queue = [];
  let ready = false;
  let timer = null;
  let chain = Promise.resolve();

  function flush() {
    clearTimer(timer);
    timer = null;
    if (!queue.length && !ready) return chain;
    const body = { events: queue, ...(ready ? { ready: true } : {}) };
    queue = [];
    ready = false;
    chain = chain.then(() => send(body)).catch((e) => onError?.(e));
    return chain;
  }

  return {
    push(ev) {
      const last = queue[queue.length - 1];
      if (ev.kind === 'delta' && last?.kind === 'delta' && last.role === ev.role) queue = [...queue.slice(0, -1), { ...last, text: last.text + ev.text }];
      else queue = [...queue, { role: ev.role, kind: ev.kind, text: ev.text }];
      if (ev.kind === 'done') flush();
      else if (!timer) timer = setTimer(flush, delayMs);
    },
    /** 接続が確立した合図（サーバーが逐語録の 0 ms を置く）。 */
    markReady() { ready = true; flush(); },
    flush,
  };
}
