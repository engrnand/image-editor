// Document state: background pixels, layers, selection and undo history.

import { cloneCanvas } from './ops.js';
import { contoursOf, invalidate } from './select.js';

export const MAX_SIDE = 2000; // images are downscaled to this so GrabCut stays interactive

let nextId = 1;

export const doc = {
  w: 0,
  h: 0,
  base: null,          // HTMLCanvasElement — the flattened background
  layers: [],          // floating image / text layers, drawn back to front
  activeId: null,
  sel: null,           // { mask: Uint8Array, contours: Int32Array[], overlay: HTMLCanvasElement }
  version: 0,          // bumped whenever base pixels change (invalidates the CV cache)
  history: [],
  future: [],
};

export const hasImage = () => !!doc.base;

export function setImage(source) {
  const scale = Math.min(1, MAX_SIDE / Math.max(source.width, source.height));
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  // The background is read back constantly (every selection, fill and adjustment).
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);

  doc.base = c;
  doc.w = w; doc.h = h;
  doc.layers = [];
  doc.activeId = null;
  doc.sel = null;
  doc.history = [];
  doc.future = [];
  touchBase();
  return { scaled: scale < 1, w, h };
}

/** Call after any change to the background pixels. */
export function touchBase() {
  doc.version++;
  invalidate();
}

/* ---------------- layers ---------------- */

export function addImageLayer(canvas, x, y, name = 'Cut-out') {
  const layer = {
    id: nextId++, type: 'image', name,
    canvas, x, y, scale: 1, rot: 0, opacity: 1,
  };
  doc.layers.push(layer);
  doc.activeId = layer.id;
  return layer;
}

export function addTextLayer(props) {
  const layer = {
    id: nextId++, type: 'text', name: 'Text',
    text: 'Your text', x: 0, y: 0, size: 42,
    family: 'Inter, system-ui, sans-serif', colour: '#ffffff',
    bold: false, italic: false, align: 'left',
    scale: 1, rot: 0, opacity: 1,
    ...props,
  };
  layer.name = (layer.text || 'Text').split('\n')[0].slice(0, 24) || 'Text';
  doc.layers.push(layer);
  doc.activeId = layer.id;
  return layer;
}

export const activeLayer = () => doc.layers.find((l) => l.id === doc.activeId) || null;

export function removeLayer(id) {
  const i = doc.layers.findIndex((l) => l.id === id);
  if (i >= 0) doc.layers.splice(i, 1);
  if (doc.activeId === id) doc.activeId = null;
}

export function fontOf(layer) {
  return `${layer.italic ? 'italic ' : ''}${layer.bold ? '700 ' : '400 '}${layer.size}px ${layer.family}`;
}

const measureCtx = document.createElement('canvas').getContext('2d');

/** Local (pre-transform) box of a layer, relative to its anchor point. */
export function localBounds(layer) {
  if (layer.type === 'image') {
    return { ox: 0, oy: 0, w: layer.canvas.width, h: layer.canvas.height };
  }
  measureCtx.font = fontOf(layer);
  const lines = String(layer.text).split('\n');
  let w = 0;
  for (const line of lines) w = Math.max(w, measureCtx.measureText(line).width);
  const lh = layer.size * 1.2;
  const h = lines.length * lh;
  const ox = layer.align === 'center' ? -w / 2 : layer.align === 'right' ? -w : 0;
  return { ox, oy: 0, w: Math.max(w, 4), h, lines, lh };
}

/** The four corners of a layer in document coordinates, clockwise from top-left. */
export function layerCorners(layer) {
  const b = localBounds(layer);
  const cos = Math.cos(layer.rot), sin = Math.sin(layer.rot), s = layer.scale;
  const pts = [[b.ox, b.oy], [b.ox + b.w, b.oy], [b.ox + b.w, b.oy + b.h], [b.ox, b.oy + b.h]];
  return pts.map(([px, py]) => {
    const sx = px * s, sy = py * s;
    return [layer.x + sx * cos - sy * sin, layer.y + sx * sin + sy * cos];
  });
}

/** Document point -> layer-local point (undo rotate/scale/translate). */
export function toLocal(layer, x, y) {
  const dx = x - layer.x, dy = y - layer.y;
  const cos = Math.cos(-layer.rot), sin = Math.sin(-layer.rot);
  return [(dx * cos - dy * sin) / layer.scale, (dx * sin + dy * cos) / layer.scale];
}

export function hitTest(x, y) {
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    const b = localBounds(l);
    const [lx, ly] = toLocal(l, x, y);
    if (lx >= b.ox - 2 && lx <= b.ox + b.w + 2 && ly >= b.oy - 2 && ly <= b.oy + b.h + 2) return l;
  }
  return null;
}

/* ---------------- selection ---------------- */

export async function setSelection(mask) {
  if (!mask) return clearSelection();
  let any = false;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { any = true; break; }
  if (!any) return clearSelection();

  const contours = await contoursOf(mask, doc.w, doc.h);
  const overlay = document.createElement('canvas');
  overlay.width = doc.w; overlay.height = doc.h;
  const img = overlay.getContext('2d').createImageData(doc.w, doc.h);
  const px = img.data;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    px[i * 4] = 76; px[i * 4 + 1] = 141; px[i * 4 + 2] = 255;
    px[i * 4 + 3] = Math.round(mask[i] * 0.30);
  }
  overlay.getContext('2d').putImageData(img, 0, 0);
  doc.sel = { mask, contours, overlay };
  return doc.sel;
}

export function clearSelection() {
  doc.sel = null;
  return null;
}

export function combine(base, add, mode) {
  if (!base) return mode === 'subtract' ? new Uint8Array(add.length) : add;
  if (mode === 'new') return add;
  const out = new Uint8Array(base.length);
  for (let i = 0; i < base.length; i++) {
    out[i] = mode === 'subtract'
      ? (add[i] ? 0 : base[i])
      : Math.max(base[i], add[i]);
  }
  return out;
}

/* ---------------- history ---------------- */

function snapshot() {
  return {
    base: cloneCanvas(doc.base, true), // stays the read-back background when restored
    w: doc.w, h: doc.h,
    activeId: doc.activeId,
    mask: doc.sel ? doc.sel.mask.slice() : null,
    layers: doc.layers.map((l) => (l.type === 'image'
      ? { ...l, canvas: cloneCanvas(l.canvas) }
      : { ...l })),
  };
}

async function restore(snap) {
  doc.base = snap.base;
  doc.w = snap.w; doc.h = snap.h;
  doc.layers = snap.layers;
  doc.activeId = snap.activeId;
  touchBase();
  if (snap.mask) await setSelection(snap.mask); else clearSelection();
}

export function pushHistory() {
  if (!doc.base) return;
  doc.history.push(snapshot());
  if (doc.history.length > 24) doc.history.shift();
  doc.future.length = 0;
}

export async function undo() {
  if (!doc.history.length) return false;
  doc.future.push(snapshot());
  await restore(doc.history.pop());
  return true;
}

export async function redo() {
  if (!doc.future.length) return false;
  doc.history.push(snapshot());
  await restore(doc.future.pop());
  return true;
}

export const canUndo = () => doc.history.length > 0;
export const canRedo = () => doc.future.length > 0;
