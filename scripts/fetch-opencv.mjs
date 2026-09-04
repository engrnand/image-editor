// Downloads the OpenCV.js WASM build into public/vendor so the editor runs
// entirely from its own origin (and offline). ~10 MB, so it is gitignored.

import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

const URL_ = process.env.OPENCV_URL || 'https://docs.opencv.org/4.9.0/opencv.js';
const OUT_DIR = path.resolve('public/vendor');
const OUT = path.join(OUT_DIR, 'opencv.js');

const existing = await stat(OUT).catch(() => null);
if (existing && existing.size > 1_000_000 && !process.argv.includes('--force')) {
  console.log(`opencv.js already present (${(existing.size / 1e6).toFixed(1)} MB). Use --force to re-download.`);
  process.exit(0);
}

console.log('Downloading', URL_);
const res = await fetch(URL_);
if (!res.ok) {
  console.error(`Download failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
await mkdir(OUT_DIR, { recursive: true });
await pipeline(Readable.fromWeb(res.body), createWriteStream(OUT));
const { size } = await stat(OUT);
console.log(`Saved ${OUT} (${(size / 1e6).toFixed(1)} MB)`);
