// On-device OCR with Tesseract.js. The photo never leaves the phone; only the
// OCR engine and English language data are downloaded (once, then cached).

// Tesseract reads best when capital letters are ~30px+ tall, so the label area
// is scaled to roughly this size (up or down) before reading.
const OCR_TARGET_PX = 2000;
const MAX_UPSCALE = 8;
// Two layout modes: 6 = one uniform block of text, 11 = scattered text.
// Labels look like either depending on the photo, so we try both.
const PAGE_MODES = ["6", "11"];

let workerPromise = null;
let progressHandler = () => {};

function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker("eng", 1, {
      logger: (m) => progressHandler(m),
    });
  }
  return workerPromise;
}

// Start downloading the engine early so the first scan is faster.
function warmUpOcr() {
  getWorker().catch(() => { workerPromise = null; });
}

// Reads the label once per page mode. `crop` is {x, y, w, h} as 0-1 fractions
// of the image, or null for the whole image. Returns one result per mode.
async function readLabel(canvas, crop, onProgress) {
  const results = [];
  for (const [i, mode] of PAGE_MODES.entries()) {
    const pass = `${i + 1}/${PAGE_MODES.length}`;
    progressHandler = (m) => {
      // Loading steps happen once; recognition reports 0..1 progress.
      if (m.status === "recognizing text") onProgress(`Reading text (pass ${pass})…`, m.progress);
      else onProgress("Loading reader (first time only)…", null);
    };
    const worker = await getWorker();
    await worker.setParameters({ tessedit_pageseg_mode: mode, user_defined_dpi: "300" });
    const { data } = await worker.recognize(preprocess(scaleForOcr(cropCanvas(canvas, crop))));
    results.push({ text: data.text, confidence: data.confidence });
  }
  return results;
}

function cropCanvas(source, crop) {
  if (!crop) return source;
  const x = Math.round(crop.x * source.width);
  const y = Math.round(crop.y * source.height);
  const w = Math.max(1, Math.round(crop.w * source.width));
  const h = Math.max(1, Math.round(crop.h * source.height));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(source, x, y, w, h, 0, 0, w, h);
  return canvas;
}

function scaleForOcr(source) {
  const scale = Math.min(MAX_UPSCALE, OCR_TARGET_PX / Math.max(source.width, source.height));
  if (Math.abs(scale - 1) < 0.05) return source;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Grayscale + contrast stretch. Helps a lot with glare and low-contrast labels.
function preprocess(source) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = img.data;

  const gray = new Uint8ClampedArray(px.length / 4);
  const hist = new Array(256).fill(0);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    gray[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    hist[gray[j]]++;
  }
  // Stretch the 2nd-98th percentile range to full black-white.
  const total = gray.length;
  let lo = 0, hi = 255, acc = 0;
  for (; lo < 255 && (acc += hist[lo]) < total * 0.02; lo++);
  acc = 0;
  for (; hi > 0 && (acc += hist[hi]) < total * 0.02; hi--);
  const range = Math.max(1, hi - lo);

  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const v = ((gray[j] - lo) * 255) / range;
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Draws an image file onto a canvas. Phone photos keep plenty of resolution so a
// cropped label is still sharp; only huge images are reduced to save memory.
async function loadToCanvas(file, maxDim = 3200) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function rotateCanvas(source) {
  const canvas = document.createElement("canvas");
  canvas.width = source.height;
  canvas.height = source.width;
  const ctx = canvas.getContext("2d");
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}
