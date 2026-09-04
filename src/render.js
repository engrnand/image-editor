// Viewport + drawing: composite the document, the selection overlay with marching
// ants, and the transform handles for the active layer.

import { doc, localBounds, fontOf, layerCorners } from './doc.js';

export const view = { scale: 1, ox: 0, oy: 0 };

let canvas, stage, ctx, dpr = 1;
let dirty = true;
let antPhase = 0;
let overlayDraw = null;
let showHandlesFor = null;
let cursorRing = null;

const checker = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const x = c.getContext('2d');
  x.fillStyle = '#2a2e36'; x.fillRect(0, 0, 16, 16);
  x.fillStyle = '#343943'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
  return c;
})();

export function attach(canvasEl, stageEl) {
  canvas = canvasEl;
  stage = stageEl;
  ctx = canvas.getContext('2d');
  new ResizeObserver(() => { resize(); requestRender(); }).observe(stage);
  resize();
  requestAnimationFrame(loop);
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  const w = stage.clientWidth, h = stage.clientHeight;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
}

export const requestRender = () => { dirty = true; };
export const setOverlayDraw = (fn) => { overlayDraw = fn; requestRender(); };
export const setHandles = (layer) => { showHandlesFor = layer; requestRender(); };

/**
 * The painting cursor, drawn in screen space so it always shows the brush at its
 * true size on the image. Without it a 28 px brush at 30% zoom is nine pixels of
 * nothing and the tool feels broken.
 */
export const setCursorRing = (ring) => { cursorRing = ring; requestRender(); };

export function fit() {
  if (!doc.base) return;
  const pad = 48;
  const sw = stage.clientWidth - pad, sh = stage.clientHeight - pad;
  view.scale = Math.min(sw / doc.w, sh / doc.h, 4);
  centre();
  requestRender();
}

function centre() {
  view.ox = (stage.clientWidth - doc.w * view.scale) / 2;
  view.oy = (stage.clientHeight - doc.h * view.scale) / 2;
}

export function zoomAt(sx, sy, factor) {
  const next = Math.max(0.05, Math.min(16, view.scale * factor));
  const k = next / view.scale;
  view.ox = sx - (sx - view.ox) * k;
  view.oy = sy - (sy - view.oy) * k;
  view.scale = next;
  requestRender();
}

export function panBy(dx, dy) {
  view.ox += dx; view.oy += dy;
  requestRender();
}

export const screenToDoc = (sx, sy) => [(sx - view.ox) / view.scale, (sy - view.oy) / view.scale];
export const docToScreen = (dx, dy) => [dx * view.scale + view.ox, dy * view.scale + view.oy];

export function paintLayer(target, layer) {
  target.save();
  target.globalAlpha = layer.opacity ?? 1;
  target.translate(layer.x, layer.y);
  target.rotate(layer.rot);
  target.scale(layer.scale, layer.scale);
  if (layer.type === 'image') {
    target.drawImage(layer.canvas, 0, 0);
  } else {
    const b = localBounds(layer);
    target.font = fontOf(layer);
    target.fillStyle = layer.colour;
    target.textAlign = layer.align;
    target.textBaseline = 'top';
    b.lines.forEach((line, i) => target.fillText(line, 0, i * b.lh));
  }
  target.restore();
}

/** Flatten base + layers into a fresh canvas (export, flatten, history). */
export function composite() {
  const out = document.createElement('canvas');
  out.width = doc.w; out.height = doc.h;
  const c = out.getContext('2d');
  c.drawImage(doc.base, 0, 0);
  for (const l of doc.layers) paintLayer(c, l);
  return out;
}

function antsPath(sel) {
  if (sel.path) return sel.path;
  const p = new Path2D();
  for (const pts of sel.contours) {
    if (pts.length < 4) continue;
    p.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i], pts[i + 1]);
    p.closePath();
  }
  sel.path = p;
  return p;
}

function drawHandles(target) {
  const layer = showHandlesFor;
  if (!layer) return;
  const corners = layerCorners(layer).map(([x, y]) => docToScreen(x, y));
  target.save();
  target.setTransform(dpr, 0, 0, dpr, 0, 0);
  target.strokeStyle = '#4c8dff';
  target.lineWidth = 1;
  target.beginPath();
  target.moveTo(corners[0][0], corners[0][1]);
  for (let i = 1; i < 4; i++) target.lineTo(corners[i][0], corners[i][1]);
  target.closePath();
  target.stroke();

  const [rx, ry] = rotateHandlePos(corners);
  target.beginPath();
  target.moveTo((corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2);
  target.lineTo(rx, ry);
  target.stroke();

  target.fillStyle = '#fff';
  for (const [x, y] of corners) {
    target.beginPath(); target.rect(x - 4, y - 4, 8, 8); target.fill(); target.stroke();
  }
  target.beginPath(); target.arc(rx, ry, 4.5, 0, Math.PI * 2); target.fill(); target.stroke();
  target.restore();
}

export function rotateHandlePos(screenCorners) {
  const mx = (screenCorners[0][0] + screenCorners[1][0]) / 2;
  const my = (screenCorners[0][1] + screenCorners[1][1]) / 2;
  const cx = (screenCorners[0][0] + screenCorners[2][0]) / 2;
  const cy = (screenCorners[0][1] + screenCorners[2][1]) / 2;
  const len = Math.hypot(mx - cx, my - cy) || 1;
  return [mx + ((mx - cx) / len) * 26, my + ((my - cy) / len) * 26];
}

/** Which transform handle is under a screen point, if any. */
export function handleAt(sx, sy, layer) {
  if (!layer) return null;
  const corners = layerCorners(layer).map(([x, y]) => docToScreen(x, y));
  const names = ['nw', 'ne', 'se', 'sw'];
  for (let i = 0; i < 4; i++) {
    if (Math.hypot(corners[i][0] - sx, corners[i][1] - sy) <= 7) return names[i];
  }
  const [rx, ry] = rotateHandlePos(corners);
  if (Math.hypot(rx - sx, ry - sy) <= 8) return 'rot';
  return null;
}

function drawCursorRing(target) {
  if (!cursorRing) return;
  const r = Math.max(2.5, cursorRing.r * view.scale);
  const [sx, sy] = docToScreen(cursorRing.x, cursorRing.y);
  target.save();
  target.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (cursorRing.src) {
    const [ax, ay] = docToScreen(cursorRing.src.x, cursorRing.src.y);
    target.setLineDash([4, 3]);
    target.strokeStyle = 'rgba(123,214,182,.9)';
    target.lineWidth = 1.25;
    target.beginPath(); target.arc(ax, ay, r, 0, Math.PI * 2); target.stroke();
    target.beginPath(); target.moveTo(ax, ay); target.lineTo(sx, sy); target.stroke();
    target.setLineDash([]);
  }

  // Dark halo first so the ring stays visible on light and dark pixels alike.
  target.strokeStyle = 'rgba(0,0,0,.55)';
  target.lineWidth = 3;
  target.beginPath(); target.arc(sx, sy, r, 0, Math.PI * 2); target.stroke();
  target.strokeStyle = cursorRing.erase ? '#ff8a82' : '#fff';
  target.lineWidth = 1.25;
  target.beginPath(); target.arc(sx, sy, r, 0, Math.PI * 2); target.stroke();
  target.restore();
}

function loop() {
  const animating = !!doc.sel;
  if (animating) { antPhase = (antPhase + 0.35) % 10; dirty = true; }
  if (dirty) { dirty = false; draw(); }
  requestAnimationFrame(loop);
}

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!doc.base) return;

  ctx.save();
  ctx.translate(view.ox, view.oy);
  ctx.scale(view.scale, view.scale);

  ctx.save();
  ctx.fillStyle = ctx.createPattern(checker, 'repeat');
  ctx.scale(1 / view.scale, 1 / view.scale);
  ctx.fillRect(0, 0, doc.w * view.scale, doc.h * view.scale);
  ctx.restore();

  ctx.imageSmoothingEnabled = view.scale < 1;
  ctx.drawImage(doc.base, 0, 0);
  for (const l of doc.layers) paintLayer(ctx, l);

  if (doc.sel) {
    ctx.drawImage(doc.sel.overlay, 0, 0);
    const path = antsPath(doc.sel);
    const s = view.scale;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1.2 / s;
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(0,0,0,.85)';
    ctx.stroke(path);
    ctx.setLineDash([5 / s, 5 / s]);
    ctx.lineDashOffset = -antPhase / s;
    ctx.strokeStyle = '#fff';
    ctx.stroke(path);
    ctx.restore();
  }
  ctx.restore();

  drawHandles(ctx);

  if (overlayDraw) {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    overlayDraw(ctx, view);
    ctx.restore();
  }

  drawCursorRing(ctx);
}
