# Trace Editor

A browser image editor that traces an object from a single click, removes it, moves it, or
replaces text in the picture — using **classical computer vision only**. No neural network,
no model download, no server. The image never leaves the browser.

```bash
npm install
npm run fetch:opencv   # one-off: pulls the ~10 MB OpenCV.js WASM build into public/vendor
npm run dev
```

Then open http://localhost:5180 and drop an image on the canvas.

## What it does

| Tool | Key | What happens |
| --- | --- | --- |
| **Magic** | `W` | Click an object → it gets traced. Flood fill on an edge-preserving copy finds the region, GrabCut snaps the border to the real edge. |
| **Object** | `B` | Drag a box around an object → GrabCut separates foreground from background. The reliable option when Magic struggles. |
| **Rect** | `M` | Plain rectangular marquee. The right tool for selecting a line of text. |
| **Lasso** | `L` | Freehand outline. |
| **Refine** | `R` | Brush pixels into the selection; hold `Alt` to brush them out. The ring on the canvas is the true brush size. `[` / `]` resize. |
| **Move** | `V` | **Drag inside a selection to lift it onto its own layer and move it** — the hole behind it is filled in the same gesture, and `Alt`-drag copies instead. Also drags existing layers; corner handles scale, the top handle rotates. |
| **Clone** | `S` | `Alt`+click a source, then paint from it. The manual repair for whatever the automatic fill smudges. |
| **Text** | `T` | Click to place an editable text layer. |

`Shift` while selecting adds to the selection, `Alt` subtracts. Space or middle-drag pans,
the wheel zooms, `Ctrl+Z` / `Ctrl+Shift+Z` undo and redo, `Ctrl+D` deselects, `Ctrl+0` fits.

Once something is selected:

- **Remove & fill** — inpaints the hole from the surrounding pixels.
- **Cut to layer** — lifts the object onto its own transparent layer and fills the hole
  behind it, so you can drag, scale and rotate it. **Copy to layer** leaves the original.
  Dragging inside the selection with the Move tool does the same thing in one gesture.
- **Wipe & add text layer** — the text-replacement flow: erases the selected words and drops
  an editable text layer in their place, with the size and ink colour sampled from the
  original.
- **Adjust inside selection** — brightness, contrast, saturation and blur, masked.

## How it works

Everything runs in `public/cvworker.js`, a Web Worker holding an OpenCV.js (WASM) build.
The worker exists because GrabCut and inpainting block for seconds at a time; on the main
thread they would freeze the canvas.

**Selection.** On load the worker caches two versions of the image: the RGB original, and a
flattened copy (one median pass plus two bilateral passes). The flattened copy is what makes
one click grab a whole animal rather than one patch of fur — it removes texture while keeping
edges. A click runs `floodFill` with `FLOODFILL_FIXED_RANGE` on that copy (so the fill is
compared against the clicked colour and cannot drift across a gradient), then morphological
cleanup, then hole filling, then a `grabCut` pass seeded from the rough mask: eroded core as
certain foreground, the mask as probable foreground, a dilated ring as probable background.
GrabCut runs on the bounding box only, which is what keeps a click interactive. If it collapses
onto a sliver, the rough mask is kept instead.

*Mean-shift segmentation is the textbook choice here, but `pyrMeanShiftFiltering` is not
compiled into the stock opencv.js build — hence median + bilateral.*

**Removal.** `cv.inpaint` with Telea or Navier–Stokes. Both propagate colour and gradient
inwards from the hole boundary. Nothing is invented.

**Text replacement.** Select the words, sample the ring just outside the selection as "paper"
and the selected pixels furthest from it as "ink", inpaint the words away, and place a text
layer sized from the selection height.

## Where it falls down

Being honest about the limits of a no-model approach:

- **Hair, fur edges, motion blur, semi-transparent things.** GrabCut gives a hard edge; it has
  no notion of alpha matting. Expect to clean up with the refine brush.
- **Busy backgrounds** where the object and background share colours — Magic will bleed, and
  the Object box is the better tool.
- **Large removals.** Telea and Navier–Stokes fill from the boundary, so a big hole comes out
  soft and streaky. Small objects, wires, blemishes and text are where they shine; for anything
  large, remove in pieces and finish with the clone stamp.
- **Font matching** on replaced text is manual — the colour and size are sampled, the typeface
  is your choice from the dropdown.

For any of these, a segmentation model would do better. That is the trade being made here.

## Layout

```
index.html            UI shell
src/main.js           tools, pointer gestures, panel wiring
src/doc.js            document state, layers, selection, undo history
src/render.js         viewport, compositing, marching ants, transform handles
src/select.js         selection API (façade over the worker)
src/ops.js            inpaint, cut-out, adjustments, ink sampling
src/cvclient.js       promise wrapper around the worker
src/cvx.js            mask helpers that need no OpenCV
public/cvworker.js    all OpenCV work
scripts/fetch-opencv.mjs
```

Images are downscaled to 2000 px on the longest side on load, so GrabCut stays interactive;
that is also the export resolution.

`public/vendor/opencv.js` is gitignored because of its size — `npm run fetch:opencv` fetches
it. If it is missing, the worker falls back to loading OpenCV from `docs.opencv.org`.
