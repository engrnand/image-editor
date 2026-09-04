// UI wiring: tools, pointer gestures, panel actions.

import { maskBounds, maskCount } from './cvx.js';
import { ready } from './cvclient.js';
import {
  doc, hasImage, setImage, touchBase, addImageLayer, addTextLayer, activeLayer,
  removeLayer, setSelection, clearSelection, combine, pushHistory, undo, redo,
  canUndo, canRedo, localBounds, hitTest, layerCorners,
} from './doc.js';
import {
  attach, view, fit, zoomAt, panBy, screenToDoc, requestRender,
  setOverlayDraw, setHandles, setCursorRing, composite, handleAt,
} from './render.js';
import { magicSelect, boxSelect, resizeMask, featherMask, prepare } from './select.js';
import { inpaint, cutOut, eraseMasked, adjustInside, estimateInkColour } from './ops.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const canvas = $('canvas');
const busyEl = $('busy');
const hintEl = $('hint');

let tool = 'magic';
let gesture = null;
let spaceHeld = false;
let cloneSource = null;   // doc-space point set with Alt+click
let cloneOffset = null;   // [dx, dy] from cursor to source
let cloneSrcSnapshot = null;
let brushLayer = null;    // scratch canvas for refine-brush strokes
let brushErasing = false;
let lastPt = null;        // latest pointer position, needed to resume a drag after an async step

attach(canvas, stage);

/* ------------------------------------------------------------------ helpers */

let hintTimer = 0;
function hint(text, warn = false) {
  hintEl.textContent = text;
  hintEl.classList.toggle('warn', warn);
  hintEl.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => hintEl.classList.remove('show'), warn ? 6000 : 3200);
}

async function busy(text, fn) {
  $('busyText').textContent = text;
  busyEl.hidden = false;
  // Two frames so the spinner is actually painted before we block on WASM.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    hint(err && err.message ? err.message : String(err), true);
    return null;
  } finally {
    busyEl.hidden = true;
  }
}

const modeFrom = (e) => (e.altKey ? 'subtract' : e.shiftKey ? 'add' : 'new');

async function applyMask(mask, mode) {
  const next = combine(doc.sel ? doc.sel.mask : null, mask, mode);
  await setSelection(next);
  refreshSelectionUI();
  requestRender();
}

function refreshSelectionUI() {
  const on = !!doc.sel;
  $('sel-actions').hidden = !on;
  if (on) {
    const n = maskCount(doc.sel.mask);
    const pct = ((n / (doc.w * doc.h)) * 100).toFixed(1);
    $('selInfo').textContent = `${n.toLocaleString()} px · ${pct}%`;
  }
}

/** Keep the text panel available while a text layer is active, whatever the tool. */
function revealTextPanel() {
  const l = activeLayer();
  if (l && l.type === 'text') $('opt-text').hidden = false;
}

function refreshUI() {
  revealTextPanel();
  $('undo').disabled = !canUndo();
  $('redo').disabled = !canRedo();
  $('zoomLabel').textContent = Math.round(view.scale * 100) + '%';
  refreshSelectionUI();
  renderLayerList();
  setHandles(tool === 'move' ? activeLayer() : null);
  requestRender();
}

/* -------------------------------------------------------------------- tools */

const CURSORS = {
  magic: 'crosshair', box: 'crosshair', rect: 'crosshair', lasso: 'crosshair',
  brush: 'none', clone: 'none', move: 'default', text: 'text',
};

function setTool(next) {
  tool = next;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === next));
  for (const id of ['magic', 'box', 'rect', 'lasso', 'brush', 'move', 'clone', 'text']) {
    const el = $('opt-' + id);
    if (el) el.hidden = id !== next;
  }
  canvas.style.cursor = CURSORS[next] || 'default';
  if (next !== 'brush' && next !== 'clone') setCursorRing(null);
  revealTextPanel();
  if (next !== 'clone') { cloneSource = null; cloneOffset = null; }
  setHandles(next === 'move' ? activeLayer() : null);
  if (next === 'clone') hint('Alt+click to set the source point, then paint.');
  if (next === 'magic') hint('Click on an object to trace it.');
  if (next === 'move' && doc.sel) hint('Drag inside the selection to lift it onto its own layer. Alt-drag copies it.');
  requestRender();
}

document.querySelectorAll('.tool').forEach((b) => {
  b.addEventListener('click', () => setTool(b.dataset.tool));
});

/* ------------------------------------------------------------- opening files */

async function openFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = async () => {
    const info = setImage(img);
    URL.revokeObjectURL(url);
    $('drop').classList.add('hide');
    fit();
    refreshUI();
    if (info.scaled) hint(`Image downscaled to ${info.w}×${info.h} so tracing stays responsive.`);
    await busy('Loading OpenCV and analysing the image…', async () => {
      await ready();
      await prepare(doc.base, doc.version);
    });
    hint('Ready. Pick Magic and click an object.');
  };
  img.onerror = () => hint('That file could not be decoded as an image.', true);
  img.src = url;
}

$('file').addEventListener('change', (e) => openFile(e.target.files[0]));
stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragover'); });
stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('dragover');
  openFile(e.dataTransfer.files[0]);
});

/* --------------------------------------------------------------- navigation */

stage.addEventListener('wheel', (e) => {
  if (!hasImage()) return;
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  $('zoomLabel').textContent = Math.round(view.scale * 100) + '%';
}, { passive: false });

$('zoomIn').onclick = () => { zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1.25); refreshUI(); };
$('zoomOut').onclick = () => { zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 0.8); refreshUI(); };
$('zoomFit').onclick = () => { fit(); refreshUI(); };

/* ------------------------------------------------------------------ gestures */

function docPt(e) {
  const rect = canvas.getBoundingClientRect();
  return screenToDoc(e.clientX - rect.left, e.clientY - rect.top);
}
function screenPt(e) {
  const rect = canvas.getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
}

canvas.addEventListener('pointerdown', (e) => {
  if (!hasImage()) return;
  canvas.setPointerCapture(e.pointerId);
  const [dx, dy] = docPt(e);
  const [sx, sy] = screenPt(e);

  if (e.button === 1 || spaceHeld) {
    gesture = { kind: 'pan', sx, sy };
    canvas.style.cursor = 'grabbing';
    return;
  }
  if (e.button !== 0) return;

  switch (tool) {
    case 'magic':
      gesture = { kind: 'magic', dx, dy, sx, sy, mode: modeFrom(e) };
      break;
    case 'box':
    case 'rect':
      gesture = { kind: tool, x0: dx, y0: dy, x1: dx, y1: dy, mode: modeFrom(e) };
      break;
    case 'lasso':
      gesture = { kind: 'lasso', pts: [[dx, dy]], mode: modeFrom(e) };
      break;
    case 'brush':
      startBrush(dx, dy, e.altKey);
      break;
    case 'clone':
      if (e.altKey) {
        cloneSource = [dx, dy];
        hint('Source set. Now drag to paint from there.');
        gesture = null;
        return;
      }
      if (!cloneSource) { hint('Alt+click first to set the clone source.', true); return; }
      pushHistory();
      cloneOffset = [cloneSource[0] - dx, cloneSource[1] - dy];
      cloneSrcSnapshot = document.createElement('canvas');
      cloneSrcSnapshot.width = doc.w; cloneSrcSnapshot.height = doc.h;
      cloneSrcSnapshot.getContext('2d').drawImage(doc.base, 0, 0);
      gesture = { kind: 'clone' };
      cloneStamp(dx, dy);
      break;
    case 'move':
      startMove(dx, dy, sx, sy, e);
      break;
    case 'text':
      placeText(dx, dy);
      break;
  }
  drawGestureOverlay();
});

canvas.addEventListener('pointermove', (e) => {
  if (!hasImage()) return;
  const [dx, dy] = docPt(e);
  const [sx, sy] = screenPt(e);
  lastPt = { dx, dy, sx, sy };
  updateCursorRing(dx, dy, e.altKey);

  if (tool === 'move' && !gesture) {
    const h = handleAt(sx, sy, activeLayer());
    const movable = hitTest(dx, dy) || insideSelection(dx, dy);
    canvas.style.cursor = h === 'rot' ? 'grab' : h ? 'nwse-resize' : (movable ? 'move' : 'default');
  }
  if (!gesture) return;

  switch (gesture.kind) {
    case 'pan':
      panBy(sx - gesture.sx, sy - gesture.sy);
      gesture.sx = sx; gesture.sy = sy;
      break;
    case 'box': case 'rect':
      gesture.x1 = dx; gesture.y1 = dy;
      break;
    case 'lasso':
      gesture.pts.push([dx, dy]);
      break;
    case 'brush':
      paintBrush(dx, dy);
      break;
    case 'clone':
      cloneStamp(dx, dy);
      break;
    case 'move':
      moveDrag(dx, dy, sx, sy);
      break;
  }
  drawGestureOverlay();
  requestRender();
});

canvas.addEventListener('pointerup', async (e) => {
  if (!gesture) { canvas.style.cursor = CURSORS[tool]; return; }
  const g = gesture;
  gesture = null;
  setOverlayDraw(null);
  canvas.style.cursor = CURSORS[tool] || 'default';

  if (g.kind === 'magic') {
    await busy('Tracing the object…', async () => {
      const mask = await magicSelect(doc.base, doc.version, g.dx, g.dy, {
        tolerance: +$('tolerance').value,
        refine: $('magicRefine').checked,
        iterations: +$('magicIters').value,
        contiguous: $('magicContig').checked,
      });
      await applyMask(mask, g.mode);
    });
    if (doc.sel) hint('Tidy the edge with Refine (R), or switch to Move (V) and drag it.');
  } else if (g.kind === 'box') {
    const r = normRect(g);
    if (r.w < 6 || r.h < 6) { hint('Drag a larger box.', true); return; }
    await busy('Separating foreground from background…', async () => {
      const mask = await boxSelect(doc.base, doc.version, r, +$('boxIters').value);
      await applyMask(mask, g.mode);
    });
  } else if (g.kind === 'rect') {
    const r = normRect(g);
    if (r.w < 2 || r.h < 2) return;
    const mask = new Uint8Array(doc.w * doc.h);
    for (let y = r.y; y < r.y + r.h; y++) {
      if (y < 0 || y >= doc.h) continue;
      for (let x = r.x; x < r.x + r.w; x++) {
        if (x >= 0 && x < doc.w) mask[y * doc.w + x] = 255;
      }
    }
    await applyMask(mask, g.mode);
  } else if (g.kind === 'lasso') {
    if (g.pts.length < 3) return;
    const c = document.createElement('canvas');
    c.width = doc.w; c.height = doc.h;
    const cx = c.getContext('2d');
    cx.fillStyle = '#fff';
    cx.beginPath();
    cx.moveTo(g.pts[0][0], g.pts[0][1]);
    for (const [x, y] of g.pts.slice(1)) cx.lineTo(x, y);
    cx.closePath();
    cx.fill();
    const px = cx.getImageData(0, 0, doc.w, doc.h).data;
    const mask = new Uint8Array(doc.w * doc.h);
    for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4 + 3] > 127 ? 255 : 0;
    await applyMask(mask, g.mode);
  } else if (g.kind === 'brush') {
    await commitBrush();
  } else if (g.kind === 'clone') {
    touchBase();
  }
  refreshUI();
});

canvas.addEventListener('pointercancel', () => { gesture = null; setOverlayDraw(null); });

/** Show the brush outline at its true size on the image, plus the clone source. */
function updateCursorRing(dx, dy, alt) {
  if (tool !== 'brush' && tool !== 'clone') return setCursorRing(null);
  const clone = tool === 'clone';
  let src = null;
  if (clone) {
    if (cloneOffset) src = { x: dx + cloneOffset[0], y: dy + cloneOffset[1] };
    else if (cloneSource) src = { x: cloneSource[0], y: cloneSource[1] };
  }
  setCursorRing({
    x: dx, y: dy,
    r: (clone ? +$('cloneSize').value : +$('brushSize').value) / 2,
    erase: !clone && alt,
    src,
  });
}

canvas.addEventListener('pointerleave', () => setCursorRing(null));

function normRect(g) {
  return {
    x: Math.round(Math.min(g.x0, g.x1)),
    y: Math.round(Math.min(g.y0, g.y1)),
    w: Math.round(Math.abs(g.x1 - g.x0)),
    h: Math.round(Math.abs(g.y1 - g.y0)),
  };
}

function drawGestureOverlay() {
  const g = gesture;
  if (!g) { setOverlayDraw(null); return; }
  setOverlayDraw((ctx) => {
    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.scale, view.scale);
    ctx.lineWidth = 1 / view.scale;
    if (g.kind === 'box' || g.kind === 'rect') {
      const r = normRect(g);
      ctx.strokeStyle = '#fff';
      ctx.setLineDash([4 / view.scale, 4 / view.scale]);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(76,141,255,.12)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
    } else if (g.kind === 'lasso') {
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(g.pts[0][0], g.pts[0][1]);
      for (const [x, y] of g.pts) ctx.lineTo(x, y);
      ctx.stroke();
    } else if (g.kind === 'brush' && brushLayer) {
      ctx.globalAlpha = 0.45;
      ctx.drawImage(brushLayer, 0, 0);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  });
}

/* --------------------------------------------------------------- refine brush */

function startBrush(x, y, erase) {
  brushErasing = erase;
  brushLayer = document.createElement('canvas');
  brushLayer.width = doc.w; brushLayer.height = doc.h;
  const c = brushLayer.getContext('2d');
  c.fillStyle = erase ? '#ff5a5a' : '#4c8dff';
  c.lineCap = 'round'; c.lineJoin = 'round';
  c.strokeStyle = c.fillStyle;
  c.lineWidth = +$('brushSize').value;
  c.beginPath();
  c.moveTo(x, y);
  c.lineTo(x + 0.01, y);
  c.stroke();
  gesture = { kind: 'brush', last: [x, y] };
}

function paintBrush(x, y) {
  const c = brushLayer.getContext('2d');
  c.lineWidth = +$('brushSize').value;
  c.beginPath();
  c.moveTo(gesture.last[0], gesture.last[1]);
  c.lineTo(x, y);
  c.stroke();
  gesture.last = [x, y];
}

async function commitBrush() {
  if (!brushLayer) return;
  const px = brushLayer.getContext('2d').getImageData(0, 0, doc.w, doc.h).data;
  const mask = doc.sel ? doc.sel.mask.slice() : new Uint8Array(doc.w * doc.h);
  for (let i = 0; i < mask.length; i++) {
    if (px[i * 4 + 3] > 20) mask[i] = brushErasing ? 0 : 255;
  }
  brushLayer = null;
  await setSelection(mask);
}

/* ---------------------------------------------------------------- clone stamp */

function cloneStamp(x, y) {
  if (!cloneOffset || !cloneSrcSnapshot) return;
  const r = +$('cloneSize').value / 2;
  const soft = +$('cloneSoft').value / 100;
  const sx = x + cloneOffset[0];
  const sy = y + cloneOffset[1];
  const d = Math.max(2, Math.ceil(r * 2));

  const tmp = document.createElement('canvas');
  tmp.width = d; tmp.height = d;
  const t = tmp.getContext('2d');
  t.drawImage(cloneSrcSnapshot, sx - r, sy - r, d, d, 0, 0, d, d);
  t.globalCompositeOperation = 'destination-in';
  const grad = t.createRadialGradient(d / 2, d / 2, (d / 2) * (1 - soft), d / 2, d / 2, d / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  t.fillStyle = grad;
  t.fillRect(0, 0, d, d);

  const b = doc.base.getContext('2d');
  b.drawImage(tmp, x - r, y - r);
}

/* ------------------------------------------------------------ move / transform */

function centreOf(layer) {
  const c = layerCorners(layer);
  return [(c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2];
}

function insideSelection(dx, dy) {
  if (!doc.sel) return false;
  const x = Math.round(dx), y = Math.round(dy);
  if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return false;
  return doc.sel.mask[y * doc.w + x] > 0;
}

function beginDrag(layer, handle, dx, dy, skipHistory) {
  if (!skipHistory) pushHistory();
  const [cx, cy] = centreOf(layer);
  gesture = {
    kind: 'move', layer, handle,
    startX: dx, startY: dy,
    lx: layer.x, ly: layer.y,
    scale0: layer.scale, rot0: layer.rot,
    cx, cy,
    dist0: Math.hypot(dx - cx, dy - cy) || 1,
    ang0: Math.atan2(dy - cy, dx - cx),
  };
}

/**
 * Dragging inside a selection lifts it onto its own layer first (filling the hole
 * behind it, or leaving the original when Alt is held) and then keeps dragging that
 * layer. The lift is async, so the gesture parks in 'floating' until it lands and
 * resumes from wherever the pointer has got to.
 */
async function floatSelectionThenDrag(copy) {
  const token = { kind: 'floating' };
  gesture = token;
  const layer = await extract(!copy);
  if (gesture !== token) return; // released (or cancelled) while we were working
  if (!layer) { gesture = null; return; }
  const p = lastPt || { dx: layer.x, dy: layer.y };
  beginDrag(layer, null, p.dx, p.dy, true);
}

function startMove(dx, dy, sx, sy, e) {
  let layer = activeLayer();
  const handle = handleAt(sx, sy, layer);
  if (!handle) {
    layer = hitTest(dx, dy);
    if (!layer && insideSelection(dx, dy)) return floatSelectionThenDrag(e.altKey);
    doc.activeId = layer ? layer.id : null;
    setHandles(layer);
    renderLayerList();
    if (layer && layer.type === 'text') loadTextPanel(layer);
    if (!layer) return;
  }
  beginDrag(layer, handle, dx, dy);
}

function moveDrag(dx, dy) {
  const g = gesture;
  const l = g.layer;
  if (!g.handle) {
    l.x = g.lx + (dx - g.startX);
    l.y = g.ly + (dy - g.startY);
  } else if (g.handle === 'rot') {
    l.rot = g.rot0 + (Math.atan2(dy - g.cy, dx - g.cx) - g.ang0);
  } else {
    const k = Math.hypot(dx - g.cx, dy - g.cy) / g.dist0;
    const next = Math.max(0.03, g.scale0 * k);
    // Scale about the centre so the layer does not run away from the cursor.
    const cos = Math.cos(l.rot), sin = Math.sin(l.rot);
    const b = localBounds(l);
    const half = [(b.ox + b.w / 2), (b.oy + b.h / 2)];
    l.scale = next;
    l.x = g.cx - (half[0] * next * cos - half[1] * next * sin);
    l.y = g.cy - (half[0] * next * sin + half[1] * next * cos);
  }
  setHandles(l);
}

/* ---------------------------------------------------------------------- text */

function textPropsFromPanel() {
  return {
    text: $('textValue').value || ' ',
    family: $('textFamily').value,
    size: +$('textSize').value,
    colour: $('textColor').value,
    bold: $('textBold').classList.contains('on'),
    italic: $('textItalic').classList.contains('on'),
    align: $('textAlign').value,
  };
}

function loadTextPanel(layer) {
  $('textValue').value = layer.text;
  $('textFamily').value = layer.family;
  $('textSize').value = layer.size;
  $('textSizeVal').textContent = layer.size;
  $('textColor').value = /^#[0-9a-f]{6}$/i.test(layer.colour) ? layer.colour : '#ffffff';
  $('textBold').classList.toggle('on', !!layer.bold);
  $('textItalic').classList.toggle('on', !!layer.italic);
  $('textAlign').value = layer.align;
}

function placeText(x, y) {
  pushHistory();
  const layer = addTextLayer({ ...textPropsFromPanel(), x, y });
  layer.y -= layer.size / 2;
  setTool('move');
  loadTextPanel(layer);
  refreshUI();
}

function syncActiveText() {
  const l = activeLayer();
  if (!l || l.type !== 'text') return;
  Object.assign(l, textPropsFromPanel());
  l.name = (l.text || 'Text').split('\n')[0].slice(0, 24) || 'Text';
  renderLayerList();
  setHandles(tool === 'move' ? l : null);
  requestRender();
}

['textValue', 'textFamily', 'textSize', 'textColor', 'textAlign'].forEach((id) => {
  $(id).addEventListener('input', syncActiveText);
});
$('textBold').onclick = () => { $('textBold').classList.toggle('on'); syncActiveText(); };
$('textItalic').onclick = () => { $('textItalic').classList.toggle('on'); syncActiveText(); };
$('addText').onclick = () => {
  if (!hasImage()) return hint('Open an image first.', true);
  placeText(doc.w / 2, doc.h / 2);
};

/* ------------------------------------------------------------------- layers */

function renderLayerList() {
  const list = $('layerList');
  list.innerHTML = '';
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    const li = document.createElement('li');
    li.className = 'layer' + (l.id === doc.activeId ? ' active' : '');
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (l.type === 'image') thumb.style.backgroundImage = `url(${l.canvas.toDataURL()})`;
    else thumb.textContent = 'T';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = l.name;
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Delete layer';
    x.onclick = (ev) => {
      ev.stopPropagation();
      pushHistory();
      removeLayer(l.id);
      refreshUI();
    };
    li.append(thumb, nm, x);
    li.onclick = () => {
      doc.activeId = l.id;
      if (l.type === 'text') loadTextPanel(l);
      setTool('move');
      refreshUI();
    };
    list.append(li);
  }
}

$('flatten').onclick = () => {
  if (!hasImage() || !doc.layers.length) return;
  pushHistory();
  doc.base = composite();
  doc.layers = [];
  doc.activeId = null;
  touchBase();
  refreshUI();
};

/* ------------------------------------------------------------ selection actions */

$('selNone').onclick = () => { clearSelection(); refreshUI(); };
$('selInvert').onclick = async () => {
  if (!doc.sel) return;
  const m = doc.sel.mask;
  const out = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) out[i] = m[i] ? 0 : 255;
  await setSelection(out);
  refreshUI();
};
$('selGrow').onclick = async () => {
  if (!doc.sel) return;
  await busy('Growing…', async () => setSelection(await resizeMask(doc.sel.mask, doc.w, doc.h, 2)));
  refreshUI();
};
$('selShrink').onclick = async () => {
  if (!doc.sel) return;
  await busy('Shrinking…', async () => setSelection(await resizeMask(doc.sel.mask, doc.w, doc.h, -2)));
  refreshUI();
};

$('doRemove').onclick = async () => {
  if (!doc.sel) return;
  const area = maskCount(doc.sel.mask) / (doc.w * doc.h);
  pushHistory();
  await busy('Filling the hole from the surrounding pixels…', async () => {
    doc.base = await inpaint(doc.base, doc.sel.mask, {
      radius: +$('inpRadius').value,
      algo: $('inpAlgo').value,
      grow: +$('inpGrow').value,
    });
    touchBase();
    clearSelection();
  });
  refreshUI();
  if (area > 0.08) {
    hint('Large area filled — expect softness. Clean it up with the clone stamp.', true);
  }
};

$('doCut').onclick = () => extract(true);
$('doCopy').onclick = () => extract(false);

async function extract(fillHole) {
  if (!doc.sel) return null;
  pushHistory();
  let created = null;
  await busy(fillHole ? 'Cutting out and filling the hole…' : 'Copying to a layer…', async () => {
    const feather = +$('feather').value;
    const alpha = feather ? await featherMask(doc.sel.mask, doc.w, doc.h, feather) : doc.sel.mask;
    const bounds = maskBounds(doc.sel.mask, doc.w, doc.h);
    const piece = cutOut(doc.base, doc.sel.mask, alpha, doc.w, doc.h, bounds);
    if (!piece) throw new Error('Selection is empty.');
    if (fillHole) {
      doc.base = await inpaint(doc.base, doc.sel.mask, {
        radius: +$('inpRadius').value,
        algo: $('inpAlgo').value,
        grow: +$('inpGrow').value,
      });
      touchBase();
    }
    created = addImageLayer(piece.canvas, piece.x, piece.y, fillHole ? 'Moved object' : 'Copy');
    clearSelection();
    setTool('move');
  });
  refreshUI();
  if (created) hint('Drag it. Corner handles scale, the top handle rotates.');
  return created;
}

$('doErase').onclick = async () => {
  if (!doc.sel) return;
  pushHistory();
  eraseMasked(doc.base, doc.sel.mask);
  touchBase();
  clearSelection();
  refreshUI();
};

$('doReplaceText').onclick = async () => {
  if (!doc.sel) return;
  const bounds = maskBounds(doc.sel.mask, doc.w, doc.h);
  if (!bounds) return;
  pushHistory();
  await busy('Wiping the old text…', async () => {
    const colour = await estimateInkColour(doc.base, doc.sel.mask, doc.w, doc.h);
    doc.base = await inpaint(doc.base, doc.sel.mask, {
      radius: +$('inpRadius').value,
      algo: $('inpAlgo').value,
      grow: Math.max(2, +$('inpGrow').value),
    });
    touchBase();
    clearSelection();

    const size = Math.max(8, Math.round(bounds.h * 0.82));
    $('textSize').value = Math.min(400, size);
    $('textSizeVal').textContent = $('textSize').value;
    $('textColor').value = colour;
    const layer = addTextLayer({
      ...textPropsFromPanel(),
      text: $('textValue').value || 'New text',
      colour,
      size: +$('textSize').value,
      align: 'left',
      x: bounds.x,
      y: bounds.y + (bounds.h - size) / 2,
    });
    loadTextPanel(layer);
    setTool('text');
    $('opt-text').hidden = false;
  });
  refreshUI();
  $('textValue').focus();
  $('textValue').select();
  hint('Type the replacement in the Text panel; it updates live.');
};

$('doAdjust').onclick = async () => {
  if (!doc.sel) return;
  pushHistory();
  await busy('Applying…', async () => {
    await adjustInside(doc.base, doc.sel.mask, {
      brightness: +$('adjB').value,
      contrast: +$('adjC').value,
      saturation: +$('adjS').value,
      blur: +$('adjBlur').value,
    });
    touchBase();
  });
  for (const id of ['adjB', 'adjC', 'adjS', 'adjBlur']) {
    $(id).value = 0;
    $(id + 'Val') && ($(id + 'Val').textContent = '0');
  }
  $('adjBVal').textContent = '0'; $('adjCVal').textContent = '0';
  $('adjSVal').textContent = '0'; $('adjBlurVal').textContent = '0';
  refreshUI();
};

/* ------------------------------------------------------------- history / export */

$('undo').onclick = async () => { await undo(); refreshUI(); };
$('redo').onclick = async () => { await redo(); refreshUI(); };

$('export').onclick = () => {
  if (!hasImage()) return hint('Open an image first.', true);
  composite().toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'trace-editor.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, 'image/png');
};

/* --------------------------------------------------------------- slider labels */

const LABELS = {
  tolerance: 'tolVal', magicIters: 'mIterVal', boxIters: 'bIterVal', brushSize: 'brushVal',
  cloneSize: 'cloneVal', cloneSoft: 'cloneSoftVal', textSize: 'textSizeVal',
  inpRadius: 'inpRadiusVal', inpGrow: 'inpGrowVal', feather: 'featherVal',
  adjB: 'adjBVal', adjC: 'adjCVal', adjS: 'adjSVal', adjBlur: 'adjBlurVal',
};
for (const [input, label] of Object.entries(LABELS)) {
  const el = $(input);
  if (!el) continue;
  el.addEventListener('input', () => { $(label).textContent = el.value; });
}

/* -------------------------------------------------------------------- keyboard */

const TOOL_KEYS = { w: 'magic', b: 'box', m: 'rect', l: 'lasso', r: 'brush', v: 'move', s: 'clone', t: 'text' };

window.addEventListener('keydown', async (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (e.code === 'Space' && !typing) { spaceHeld = true; canvas.style.cursor = 'grab'; e.preventDefault(); }
  if (typing) return;

  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === 'z') {
    e.preventDefault();
    if (e.shiftKey) await redo(); else await undo();
    refreshUI();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && key === 'y') { e.preventDefault(); await redo(); refreshUI(); return; }
  if ((e.ctrlKey || e.metaKey) && key === 'd') { e.preventDefault(); clearSelection(); refreshUI(); return; }
  if ((e.ctrlKey || e.metaKey) && key === '0') { e.preventDefault(); fit(); refreshUI(); return; }
  if (e.ctrlKey || e.metaKey) return;

  if (TOOL_KEYS[key]) { setTool(TOOL_KEYS[key]); return; }
  if (key === '[' || key === ']') {
    const id = tool === 'clone' ? 'cloneSize' : 'brushSize';
    const el = $(id);
    el.value = Math.max(+el.min, Math.min(+el.max, +el.value + (key === ']' ? 6 : -6)));
    $(LABELS[id]).textContent = el.value;
    return;
  }
  if (key === 'delete' || key === 'backspace') {
    const l = activeLayer();
    if (tool === 'move' && l) { pushHistory(); removeLayer(l.id); refreshUI(); }
    else if (doc.sel) $('doRemove').click();
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceHeld = false; canvas.style.cursor = CURSORS[tool] || 'default'; }
});

/* ------------------------------------------------------------------------ boot */

setTool('magic');
refreshUI();
ready().then(() => hint('OpenCV ready — open an image to start.')).catch((e) => hint(e.message, true));
