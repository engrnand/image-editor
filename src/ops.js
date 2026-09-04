// Pixel operations: content fill (inpainting), cut-out, adjustments, ink sampling.
// Anything that needs OpenCV is delegated to the worker; the rest is plain canvas work.

import { call } from './cvclient.js';
import { imageDataOf } from './cvx.js';

/**
 * `readBack` marks a canvas we pull pixels off repeatedly (anything that can become
 * the background). Chrome keeps those in CPU memory instead of round-tripping the
 * GPU on every getImageData. Never set it on a canvas that is mostly *drawn*, since
 * it gives up hardware acceleration.
 */
function makeCanvas(w, h, readBack = false) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  if (readBack) c.getContext('2d', { willReadFrequently: true });
  return c;
}

export function cloneCanvas(src, readBack = false) {
  const c = makeCanvas(src.width, src.height, readBack);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

function canvasFromPixels(buffer, w, h) {
  const c = makeCanvas(w, h, true);
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buffer), w, h), 0, 0);
  return c;
}

/**
 * Remove whatever the mask covers and fill it from the surrounding pixels.
 * Returns a new canvas.
 */
export async function inpaint(canvas, mask, { radius = 4, algo = 'telea', grow = 3 } = {}) {
  const w = canvas.width, h = canvas.height;
  const img = imageDataOf(canvas);
  const res = await call('inpaint',
    { pixels: img.data.buffer, w, h, mask, radius, algo, grow },
    [img.data.buffer]);
  return canvasFromPixels(res.pixels, w, h);
}

/**
 * Copy the masked pixels into their own transparent canvas, cropped to the mask
 * bounds. The (optionally feathered) mask becomes the alpha channel.
 */
export function cutOut(canvas, mask, alphaMask, w, h, bounds) {
  if (!bounds) return null;
  const pad = 2;
  const x = Math.max(0, bounds.x - pad);
  const y = Math.max(0, bounds.y - pad);
  const bw = Math.min(w - x, bounds.w + pad * 2);
  const bh = Math.min(h - y, bounds.h + pad * 2);

  const out = makeCanvas(bw, bh);
  const octx = out.getContext('2d');
  octx.drawImage(canvas, x, y, bw, bh, 0, 0, bw, bh);

  const img = octx.getImageData(0, 0, bw, bh);
  const px = img.data;
  const alpha = alphaMask || mask;
  for (let j = 0; j < bh; j++) {
    const srcRow = (y + j) * w + x;
    const dstRow = j * bw;
    for (let i = 0; i < bw; i++) px[(dstRow + i) * 4 + 3] = alpha[srcRow + i];
  }
  octx.putImageData(img, 0, 0);
  return { canvas: out, x, y };
}

/** Punch the masked pixels out of a canvas, leaving transparency. */
export function eraseMasked(canvas, mask) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  for (let i = 0, n = w * h; i < n; i++) {
    if (mask[i]) px[i * 4 + 3] = Math.min(px[i * 4 + 3], 255 - mask[i]);
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Brightness / contrast / saturation / blur applied only where the mask is set. */
export async function adjustInside(canvas, mask, opts) {
  const { brightness = 0, contrast = 0, saturation = 0, blur = 0 } = opts;
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;

  let blurred = null;
  if (blur > 0) {
    const copy = ctx.getImageData(0, 0, w, h);
    const res = await call('blur', { pixels: copy.data.buffer, w, h, radius: blur }, [copy.data.buffer]);
    blurred = new Uint8ClampedArray(res.pixels);
  }

  const cAmount = contrast * 1.5;
  const cFactor = (259 * (cAmount + 255)) / (255 * (259 - cAmount));
  const sFactor = 1 + saturation / 100;
  const bAdd = brightness * 1.5;

  for (let i = 0, n = w * h; i < n; i++) {
    const a = mask[i];
    if (!a) continue;
    const o = i * 4;
    let r = blurred ? blurred[o] : px[o];
    let g = blurred ? blurred[o + 1] : px[o + 1];
    let b = blurred ? blurred[o + 2] : px[o + 2];

    r += bAdd; g += bAdd; b += bAdd;
    r = cFactor * (r - 128) + 128;
    g = cFactor * (g - 128) + 128;
    b = cFactor * (b - 128) + 128;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = lum + (r - lum) * sFactor;
    g = lum + (g - lum) * sFactor;
    b = lum + (b - lum) * sFactor;

    const k = a / 255;
    px[o] = px[o] * (1 - k) + r * k;
    px[o + 1] = px[o + 1] * (1 - k) + g * k;
    px[o + 2] = px[o + 2] * (1 - k) + b * k;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

const hex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/**
 * Guess the ink colour of selected text: take the ring just outside the selection
 * as "paper", then average the selected pixels sitting furthest away from it.
 */
export async function estimateInkColour(canvas, mask, w, h) {
  const res = await call('ring', { mask, w, h, size: 13 });
  const ringMask = new Uint8Array(res.mask);
  const px = imageDataOf(canvas).data;

  let br = 0, bg = 0, bb = 0, bn = 0;
  for (let i = 0, n = w * h; i < n; i++) {
    if (!ringMask[i]) continue;
    br += px[i * 4]; bg += px[i * 4 + 1]; bb += px[i * 4 + 2]; bn++;
  }
  if (!bn) return '#ffffff';
  br /= bn; bg /= bn; bb /= bn;

  const picks = [];
  for (let i = 0, n = w * h; i < n; i++) {
    if (!mask[i]) continue;
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    picks.push([(r - br) ** 2 + (g - bg) ** 2 + (b - bb) ** 2, r, g, b]);
  }
  if (!picks.length) return '#ffffff';
  picks.sort((a, z) => z[0] - a[0]);

  const take = Math.max(1, Math.floor(picks.length * 0.12));
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < take; i++) { r += picks[i][1]; g += picks[i][2]; b += picks[i][3]; }
  return '#' + hex(r / take) + hex(g / take) + hex(b / take);
}
