// Selection algorithms — all classical computer vision, no models.
// The heavy lifting lives in public/cvworker.js; this module is the typed façade.
//
//   magicSelect : flood fill on an edge-preserving (median + bilateral) copy of the
//                 image, then GrabCut refinement so the border lands on the real edge.
//   boxSelect   : GrabCut initialised from a user rectangle.
//   Every function returns a Uint8Array mask of w*h bytes, 0 or 255.

import { call, ready } from './cvclient.js';
import { imageDataOf } from './cvx.js';

let preparedVersion = -1;

/** Forget the worker-side cache — call whenever the background pixels change. */
export function invalidate() {
  preparedVersion = -1;
}

/** Upload the current background to the worker and build its flattened copy. */
export async function prepare(canvas, version) {
  await ready();
  if (preparedVersion === version) return;
  const img = imageDataOf(canvas);
  await call('prepare', {
    pixels: img.data.buffer,
    width: canvas.width,
    height: canvas.height,
    version,
  }, [img.data.buffer]);
  preparedVersion = version;
}

/** One-click object selection. */
export async function magicSelect(canvas, version, x, y, opts = {}) {
  const { tolerance = 26, refine = true, iterations = 2, contiguous = true } = opts;
  await prepare(canvas, version);
  const res = await call('magic', { x, y, tolerance, refine, iterations, contiguous });
  return new Uint8Array(res.mask);
}

/** GrabCut seeded by a user-drawn rectangle. */
export async function boxSelect(canvas, version, rect, iterations = 3) {
  await prepare(canvas, version);
  const res = await call('box', { rect, iterations });
  return new Uint8Array(res.mask);
}

/** Morphological grow (positive) / shrink (negative) of an existing mask. */
export async function resizeMask(mask, w, h, pixels) {
  if (!pixels) return mask;
  const res = await call('maskResize', { mask, w, h, pixels });
  return new Uint8Array(res.mask);
}

/** Gaussian-feathered copy of a mask, used as the alpha channel when cutting out. */
export async function featherMask(mask, w, h, radius) {
  if (!radius) return mask;
  const res = await call('feather', { mask, w, h, radius });
  return new Uint8Array(res.mask);
}

/** Contours as flat [x0,y0,x1,y1,…] arrays, for drawing marching ants. */
export async function contoursOf(mask, w, h) {
  const res = await call('contours', { mask, w, h });
  return res.contours.map((buf) => new Int32Array(buf));
}
