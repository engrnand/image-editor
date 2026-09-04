// Thin promise wrapper around the OpenCV worker (public/cvworker.js).

let worker = null;
let seq = 0;
let readyPromise = null;
const waiting = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker('/cvworker.js');
  worker.onmessage = ({ data }) => {
    const pending = waiting.get(data.id);
    if (!pending) return;
    waiting.delete(data.id);
    if (data.ok) pending.resolve(data);
    else pending.reject(new Error(data.error || 'OpenCV worker failed.'));
  };
  worker.onerror = (e) => {
    for (const [, p] of waiting) p.reject(new Error('OpenCV worker crashed: ' + e.message));
    waiting.clear();
  };
  return worker;
}

/**
 * Send one job. Inputs are structured-cloned (never transferred) so the caller's
 * arrays stay usable; outputs come back as transferred buffers.
 */
export function call(op, payload = {}, transfer = []) {
  ensureWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, op, ...payload }, transfer);
  });
}

/** Resolves once the WASM runtime is up. Safe to call repeatedly. */
export function ready() {
  if (!readyPromise) readyPromise = call('init');
  return readyPromise;
}
