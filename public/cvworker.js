/* eslint-env worker */
// All OpenCV work happens here, off the main thread: loading the 10 MB WASM build,
// edge-preserving smoothing, GrabCut and inpainting all block for a while and
// would otherwise freeze the canvas.
//
// Protocol: { id, op, ...payload } in, { id, ok, ...result } out.

let cv = null;
let cvReady = null;
let cache = { version: -1, srcRGB: null, msRGB: null, w: 0, h: 0 };

const SMOOTH_MAX = 720; // edge-preserving pass runs at this size, then scales back up

const LOCAL = '/vendor/opencv.js';
const REMOTE = 'https://docs.opencv.org/4.9.0/opencv.js';

function initCV() {
  return new Promise((resolve, reject) => {
    let loaded = false;
    for (const url of [LOCAL, REMOTE]) {
      try { self.importScripts(url); loaded = true; break; }
      catch { /* try the next source */ }
    }
    if (!loaded) return reject(new Error('OpenCV.js could not be loaded.'));
    if (!self.cv) return reject(new Error('OpenCV.js loaded but exposed nothing.'));

    // Two traps in one object:
    //  1. The module is *thenable*, so resolving a promise with it makes the
    //     promise machinery call that `then` and wait forever. Never hand it to
    //     resolve() — stash it in `cv` and resolve with nothing.
    //  2. `Mat` shows up before the JS helper layer (matFromArray, the CV_*
    //     constants) is installed, so polling on `Mat` alone hands back a
    //     half-built module whose calls never return.
    const isReady = (m) => !!(m && m.Mat && typeof m.matFromArray === 'function' &&
      typeof m.grabCut === 'function' && m.CV_8UC4 !== undefined);

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(bail);
      cv = self.cv;
      try { delete cv.then; } catch { /* non-configurable, harmless */ }
      resolve();
    };

    if (isReady(self.cv)) return finish();
    const poll = setInterval(() => { if (isReady(self.cv)) finish(); }, 30);
    const bail = setTimeout(() => {
      if (settled) return;
      clearInterval(poll);
      reject(new Error('OpenCV.js did not finish initialising.'));
    }, 60000);
  });
}

/* -------------------------------------------------------------- Mat lifetime */

function bag() {
  const items = [];
  const track = (m) => { items.push(m); return m; };
  track.free = () => {
    for (const m of items) { try { m.delete(); } catch { /* already gone */ } }
    items.length = 0;
  };
  return track;
}

const structEl = (n) => cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(n, n));
const maskMat = (arr, w, h) => cv.matFromArray(h, w, cv.CV_8UC1, arr);
const rgbaMat = (pixels, w, h) => cv.matFromArray(h, w, cv.CV_8UC4, pixels);

/* -------------------------------------------------------------- shared steps */

function invalidate() {
  for (const key of ['srcRGB', 'msRGB']) {
    if (cache[key]) { try { cache[key].delete(); } catch { /* ignore */ } }
    cache[key] = null;
  }
  cache.version = -1;
}

/**
 * Cache the two Mats every selection tool needs: the RGB image, and a flattened
 * copy where a dog's coat collapses into a few near-uniform regions instead of
 * thousands of slightly different pixels — that is what makes one click grab the
 * whole animal instead of one patch of fur.
 *
 * Mean-shift segmentation would be the textbook choice, but pyrMeanShiftFiltering
 * is not compiled into the stock opencv.js build, so this uses a median pass plus
 * two bilateral passes. Both preserve edges while killing texture, and together
 * they cost ~0.4 s at 720 px instead of tens of seconds.
 */
function prepare({ pixels, width, height, version }) {
  if (cache.version === version && cache.srcRGB) return {};
  invalidate();

  const t = bag();
  const rgba = t(rgbaMat(new Uint8Array(pixels), width, height));
  const srcRGB = new cv.Mat();
  cv.cvtColor(rgba, srcRGB, cv.COLOR_RGBA2RGB);

  const scale = Math.min(1, SMOOTH_MAX / Math.max(width, height));
  const small = t(new cv.Mat());
  cv.resize(srcRGB, small,
    new cv.Size(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))),
    0, 0, cv.INTER_AREA);

  const med = t(new cv.Mat());
  cv.medianBlur(small, med, 5);
  const pass1 = t(new cv.Mat());
  cv.bilateralFilter(med, pass1, 9, 60, 30, cv.BORDER_DEFAULT);
  const pass2 = t(new cv.Mat());
  cv.bilateralFilter(pass1, pass2, 9, 60, 30, cv.BORDER_DEFAULT);

  const msRGB = new cv.Mat();
  cv.resize(pass2, msRGB, new cv.Size(width, height), 0, 0, cv.INTER_LINEAR);

  t.free();
  cache = { version, srcRGB, msRGB, w: width, h: height };
  return {};
}

/** Keep only the blob containing (x, y) — drops speckle left by the flood fill. */
function keepComponentAt(mask, x, y) {
  const t = bag();
  const labels = t(new cv.Mat());
  const stats = t(new cv.Mat());
  const centroids = t(new cv.Mat());
  const n = cv.connectedComponentsWithStats(mask, labels, stats, centroids, 8, cv.CV_32S);
  if (n <= 1) { t.free(); return mask; }

  const label = labels.intAt(y, x);
  const out = new cv.Mat.zeros(mask.rows, mask.cols, cv.CV_8UC1);
  if (label > 0) {
    const target = t(new cv.Mat(labels.rows, labels.cols, cv.CV_32S, new cv.Scalar(label)));
    const eq = t(new cv.Mat());
    cv.compare(labels, target, eq, cv.CMP_EQ);
    eq.copyTo(out);
  } else {
    mask.copyTo(out);
  }
  mask.delete();
  t.free();
  return out;
}

function cleanUp(mask) {
  const t = bag();
  const k = t(structEl(5));
  cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k);
  cv.morphologyEx(mask, mask, cv.MORPH_OPEN, k);
  t.free();
}

/** Fill interior holes so the object does not come back with see-through patches. */
function fillHoles(mask) {
  // Flood the background inwards from a corner; if the object touches every corner
  // there is no background to flood from, so leave the mask alone.
  const corners = [[0, 0], [mask.cols - 1, 0], [0, mask.rows - 1], [mask.cols - 1, mask.rows - 1]];
  const seed = corners.find(([x, y]) => mask.ucharAt(y, x) === 0);
  if (!seed) return;

  const t = bag();
  const flood = t(mask.clone());
  const ff = t(new cv.Mat.zeros(mask.rows + 2, mask.cols + 2, cv.CV_8UC1));
  cv.floodFill(flood, ff, new cv.Point(seed[0], seed[1]), new cv.Scalar(255),
    new cv.Rect(), new cv.Scalar(0), new cv.Scalar(0), 4);
  const holes = t(new cv.Mat());
  cv.bitwise_not(flood, holes);
  cv.bitwise_or(mask, holes, mask);
  t.free();
}

/**
 * GrabCut refinement: the rough mask becomes "probably foreground", a ring around
 * it "probably background", its eroded core is locked as foreground. Runs on the
 * bounding box only, which is what keeps a click interactive.
 */
function grabCutRefine(rough, iterations) {
  const t = bag();
  try {
    const src = cache.srcRGB;
    const inner = t(new cv.Mat());
    const outer = t(new cv.Mat());
    cv.erode(rough, inner, t(structEl(9)));
    cv.dilate(rough, outer, t(structEl(35)));
    if (cv.countNonZero(inner) < 40) rough.copyTo(inner);

    const pad = 14;
    const box = cv.boundingRect(outer);
    const x = Math.max(0, box.x - pad);
    const y = Math.max(0, box.y - pad);
    const rect = new cv.Rect(x, y,
      Math.min(src.cols - x, box.width + pad * 2),
      Math.min(src.rows - y, box.height + pad * 2));
    if (rect.width < 8 || rect.height < 8) { t.free(); return null; }

    const gc = t(new cv.Mat(src.rows, src.cols, cv.CV_8UC1, new cv.Scalar(cv.GC_BGD)));
    gc.setTo(new cv.Scalar(cv.GC_PR_BGD), outer);
    gc.setTo(new cv.Scalar(cv.GC_PR_FGD), rough);
    gc.setTo(new cv.Scalar(cv.GC_FGD), inner);

    const sub = t(src.roi(rect).clone());
    const gsub = t(gc.roi(rect).clone());

    // GrabCut needs some background inside the window to build a model against.
    if (gsub.rows * gsub.cols - cv.countNonZero(gsub) < 200) { t.free(); return null; }

    cv.grabCut(sub, gsub, new cv.Rect(0, 0, 1, 1), t(new cv.Mat()), t(new cv.Mat()),
      iterations, cv.GC_INIT_WITH_MASK);

    // GC_FGD = 1 and GC_PR_FGD = 3 have bit 0 set; GC_BGD = 0 and GC_PR_BGD = 2 do not.
    const fg = t(new cv.Mat());
    cv.bitwise_and(gsub, t(new cv.Mat(gsub.rows, gsub.cols, cv.CV_8UC1, new cv.Scalar(1))), fg);
    const fg255 = t(new cv.Mat());
    fg.convertTo(fg255, cv.CV_8UC1, 255);
    if (cv.countNonZero(fg255) < 25) { t.free(); return null; }

    const out = new cv.Mat.zeros(src.rows, src.cols, cv.CV_8UC1);
    const dstRoi = out.roi(rect);
    fg255.copyTo(dstRoi);
    dstRoi.delete();
    t.free();
    return out;
  } catch (err) {
    t.free();
    return null;
  }
}

/* ------------------------------------------------------------------ handlers */

function magic({ x: px, y: py, tolerance, refine, iterations, contiguous }) {
  const { srcRGB, msRGB, w, h } = cache;
  if (!srcRGB) throw new Error('No image prepared.');
  const x = Math.max(0, Math.min(w - 1, Math.round(px)));
  const y = Math.max(0, Math.min(h - 1, Math.round(py)));

  const t = bag();
  // FIXED_RANGE compares every candidate against the clicked colour rather than
  // against its neighbour, so the fill cannot slowly drift across a gradient.
  const flags = 8 | (255 << 8) | cv.FLOODFILL_MASK_ONLY | cv.FLOODFILL_FIXED_RANGE;
  const lo = new cv.Scalar(tolerance, tolerance, tolerance, tolerance);
  const up = new cv.Scalar(tolerance, tolerance, tolerance, tolerance);

  const ffMask = t(new cv.Mat.zeros(h + 2, w + 2, cv.CV_8UC1));
  const work = t(msRGB.clone());
  cv.floodFill(work, ffMask, new cv.Point(x, y), new cv.Scalar(0, 0, 0), new cv.Rect(), lo, up, flags);

  let cropped = ffMask.roi(new cv.Rect(1, 1, w, h));
  let rough = cropped.clone();
  cropped.delete();

  if (cv.countNonZero(rough) < 12) {
    // Nothing usable on the posterised copy — retry against the raw pixels.
    const ff2 = t(new cv.Mat.zeros(h + 2, w + 2, cv.CV_8UC1));
    const raw = t(srcRGB.clone());
    cv.floodFill(raw, ff2, new cv.Point(x, y), new cv.Scalar(0, 0, 0), new cv.Rect(), lo, up, flags);
    rough.delete();
    cropped = ff2.roi(new cv.Rect(1, 1, w, h));
    rough = cropped.clone();
    cropped.delete();
  }

  cleanUp(rough);
  if (contiguous) rough = keepComponentAt(rough, x, y);
  fillHoles(rough);

  let final = rough;
  const coverage = cv.countNonZero(rough) / (w * h);
  if (refine && coverage > 0.0002 && coverage < 0.92) {
    const refined = grabCutRefine(rough, iterations);
    if (refined) {
      // Guard against GrabCut collapsing onto a sliver.
      const ok = refined.ucharAt(y, x) > 0 &&
                 cv.countNonZero(refined) > cv.countNonZero(rough) * 0.25;
      if (ok) {
        fillHoles(refined);
        final = contiguous ? keepComponentAt(refined, x, y) : refined;
        rough.delete();
      } else {
        refined.delete();
      }
    }
  }

  const out = new Uint8Array(final.data);
  final.delete();
  t.free();
  return { mask: out.buffer, transfer: [out.buffer] };
}

function box({ rect, iterations }) {
  const { srcRGB, w, h } = cache;
  if (!srcRGB) throw new Error('No image prepared.');
  const rx = Math.max(0, Math.min(w - 2, Math.round(rect.x)));
  const ry = Math.max(0, Math.min(h - 2, Math.round(rect.y)));
  const rw = Math.max(2, Math.min(w - rx, Math.round(rect.w)));
  const rh = Math.max(2, Math.min(h - ry, Math.round(rect.h)));

  // Give GrabCut a margin of guaranteed background around the user's box.
  const pad = Math.max(8, Math.round(Math.min(rw, rh) * 0.18));
  const ox = Math.max(0, rx - pad);
  const oy = Math.max(0, ry - pad);
  const ow = Math.min(w - ox, rw + (rx - ox) + pad);
  const oh = Math.min(h - oy, rh + (ry - oy) + pad);

  const t = bag();
  try {
    const sub = t(srcRGB.roi(new cv.Rect(ox, oy, ow, oh)).clone());
    const gc = t(new cv.Mat(sub.rows, sub.cols, cv.CV_8UC1, new cv.Scalar(cv.GC_BGD)));
    cv.grabCut(sub, gc, new cv.Rect(rx - ox, ry - oy, rw, rh),
      t(new cv.Mat()), t(new cv.Mat()), iterations, cv.GC_INIT_WITH_RECT);

    const fg = t(new cv.Mat());
    cv.bitwise_and(gc, t(new cv.Mat(gc.rows, gc.cols, cv.CV_8UC1, new cv.Scalar(1))), fg);
    const fg255 = t(new cv.Mat());
    fg.convertTo(fg255, cv.CV_8UC1, 255);
    cleanUp(fg255);
    fillHoles(fg255);

    const full = t(new cv.Mat.zeros(h, w, cv.CV_8UC1));
    const dstRoi = full.roi(new cv.Rect(ox, oy, ow, oh));
    fg255.copyTo(dstRoi);
    dstRoi.delete();

    const out = new Uint8Array(full.data);
    t.free();
    return { mask: out.buffer, transfer: [out.buffer] };
  } catch (err) {
    t.free();
    throw new Error('GrabCut could not separate that box — try a slightly larger one.');
  }
}

function maskResize({ mask, w, h, pixels }) {
  const t = bag();
  const m = t(maskMat(new Uint8Array(mask), w, h));
  const out = t(new cv.Mat());
  const k = t(structEl(Math.abs(pixels) * 2 + 1));
  if (pixels > 0) cv.dilate(m, out, k); else cv.erode(m, out, k);
  const res = new Uint8Array(out.data);
  t.free();
  return { mask: res.buffer, transfer: [res.buffer] };
}

function feather({ mask, w, h, radius }) {
  const t = bag();
  const m = t(maskMat(new Uint8Array(mask), w, h));
  const out = t(new cv.Mat());
  const k = Math.max(1, Math.round(radius) * 2 + 1);
  cv.GaussianBlur(m, out, new cv.Size(k, k), 0, 0, cv.BORDER_DEFAULT);
  const res = new Uint8Array(out.data);
  t.free();
  return { mask: res.buffer, transfer: [res.buffer] };
}

function contours({ mask, w, h }) {
  const t = bag();
  const m = t(maskMat(new Uint8Array(mask), w, h));
  const vec = new cv.MatVector();
  cv.findContours(m, vec, t(new cv.Mat()), cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE);
  const list = [];
  const transfer = [];
  for (let i = 0; i < vec.size(); i++) {
    const c = vec.get(i);
    if (c.rows > 2) {
      const pts = new Int32Array(c.data32S);
      list.push(pts.buffer);
      transfer.push(pts.buffer);
    }
    c.delete();
  }
  vec.delete();
  t.free();
  return { contours: list, transfer };
}

/**
 * Telea / Navier-Stokes inpainting: both propagate colour and gradient inwards
 * from the hole boundary. Nothing is invented, which is exactly why large holes
 * come out soft — that is the honest limit of a no-model fill.
 */
function inpaint({ pixels, w, h, mask, radius, algo, grow }) {
  const t = bag();
  const rgba = t(rgbaMat(new Uint8Array(pixels), w, h));
  const rgb = t(new cv.Mat());
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);

  let m = t(maskMat(new Uint8Array(mask), w, h));
  cv.threshold(m, m, 8, 255, cv.THRESH_BINARY); // feathered edges would leave a halo
  if (grow > 0) {
    const d = t(new cv.Mat());
    cv.dilate(m, d, t(structEl(grow * 2 + 1)));
    m = d;
  }

  const filled = t(new cv.Mat());
  cv.inpaint(rgb, m, filled, radius, algo === 'ns' ? cv.INPAINT_NS : cv.INPAINT_TELEA);
  const out = t(new cv.Mat());
  cv.cvtColor(filled, out, cv.COLOR_RGB2RGBA);
  const res = new Uint8ClampedArray(out.data);
  t.free();
  return { pixels: res.buffer, transfer: [res.buffer] };
}

function blur({ pixels, w, h, radius }) {
  const t = bag();
  const src = t(rgbaMat(new Uint8Array(pixels), w, h));
  const dst = t(new cv.Mat());
  const k = Math.max(1, Math.round(radius) * 2 + 1);
  cv.GaussianBlur(src, dst, new cv.Size(k, k), 0, 0, cv.BORDER_DEFAULT);
  const res = new Uint8ClampedArray(dst.data);
  t.free();
  return { pixels: res.buffer, transfer: [res.buffer] };
}

/** The band just outside a mask — used to sample the "paper" behind text. */
function ring({ mask, w, h, size }) {
  const t = bag();
  const m = t(maskMat(new Uint8Array(mask), w, h));
  const out = t(new cv.Mat());
  cv.dilate(m, out, t(structEl(size)));
  cv.subtract(out, m, out);
  const res = new Uint8Array(out.data);
  t.free();
  return { mask: res.buffer, transfer: [res.buffer] };
}


const OPS = { prepare, magic, box, maskResize, feather, contours, inpaint, blur, ring };

self.onmessage = async ({ data }) => {
  const { id, op } = data;
  try {
    if (!cv) { cvReady = cvReady || initCV(); await cvReady; }
    if (op === 'init') return self.postMessage({ id, ok: true });
    const handler = OPS[op];
    if (!handler) throw new Error('Unknown operation: ' + op);
    const { transfer = [], ...result } = handler(data) || {};
    self.postMessage({ id, ok: true, ...result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
};
