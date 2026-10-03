// On-device OCR with Tesseract.js. The photo never leaves the phone; only the
// OCR engine and English language data are downloaded (once, then cached).

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

async function readLabel(canvas, onProgress) {
  progressHandler = (m) => {
    // Loading steps happen once; recognition reports 0..1 progress.
    if (m.status === "recognizing text") onProgress("Reading text…", m.progress);
    else onProgress("Loading reader (first time only)…", null);
  };
  const worker = await getWorker();
  const { data } = await worker.recognize(preprocess(canvas));
  return { text: data.text, confidence: data.confidence };
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

// Draws an image file onto a canvas, scaled so text is large enough for OCR
// but the image is not so big that phones run out of memory.
async function loadToCanvas(file, maxDim = 2000) {
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
