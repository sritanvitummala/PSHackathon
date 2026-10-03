const $ = (id) => document.getElementById(id);
const EN = I18N.en;

let photoCanvas = null;
let whileAwake = false; // from the last parse; drops overnight reminder times
let multiStep = false; // e.g. "2 tablets day 1, then 1 daily" - can't be fully translated

// ---------- Setup ----------

for (const [key, lang] of Object.entries(I18N)) $("language").append(option(key, lang.name));
const browserLang = navigator.language.slice(0, 2);
if (I18N[browserLang]) $("language").value = browserLang;

$("f-unit").append(option("", "—"), ...Object.entries(EN.unit).map(([k, v]) => option(k, v)));
$("f-route").append(option("", "—"), ...Object.entries(EN.route).map(([k, v]) => option(k, v)));
$("f-schedule").append(...Object.entries(EN.schedule).map(([k, v]) => option(k, v)));
$("f-food").append(option("", "—"), ...Object.entries(EN.food).map(([k, v]) => option(k, v)));
for (const [key, text] of Object.entries(EN.warning)) {
  const label = document.createElement("label");
  label.className = "check";
  const box = Object.assign(document.createElement("input"), { type: "checkbox", value: key });
  label.append(box, " " + text);
  $("f-warnings").append(label);
}

$("start-date").value = toDateInput(new Date());
warmUpOcr();

// ---------- Step 1: photo + OCR ----------

$("photo").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setStatus("");
  photoCanvas = await loadToCanvas(file);
  e.target.value = ""; // allow picking the same file again
  showPreview();
});

$("retake-btn").addEventListener("click", () => $("photo").click());

$("rotate-btn").addEventListener("click", () => {
  photoCanvas = rotateCanvas(photoCanvas);
  showPreview();
});

function showPreview() {
  $("preview").src = photoCanvas.toDataURL("image/jpeg", 0.85);
  $("photo-drop").hidden = true;
  $("photo-wrap").hidden = false;
  setCrop(null);
}

// ---------- Crop box: drag on the photo to select the label ----------

let crop = null; // {x, y, w, h} as 0-1 fractions of the image
let dragStart = null;

function pointerFraction(e) {
  const r = $("preview").getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
}

function setCrop(c) {
  crop = c;
  const box = $("crop-box");
  box.hidden = !c;
  if (!c) return;
  Object.assign(box.style, {
    left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%`,
  });
}

$("preview").addEventListener("pointerdown", (e) => {
  e.preventDefault();
  $("preview").setPointerCapture(e.pointerId);
  dragStart = pointerFraction(e);
  setCrop({ ...dragStart, w: 0, h: 0 });
});

$("preview").addEventListener("pointermove", (e) => {
  if (!dragStart) return;
  const p = pointerFraction(e);
  setCrop({
    x: Math.min(dragStart.x, p.x), y: Math.min(dragStart.y, p.y),
    w: Math.abs(p.x - dragStart.x), h: Math.abs(p.y - dragStart.y),
  });
});

$("preview").addEventListener("pointerup", () => {
  dragStart = null;
  if (crop && (crop.w < 0.04 || crop.h < 0.04)) setCrop(null); // a tap clears the box
});

// ---------- Read ----------

$("scan-btn").addEventListener("click", async () => {
  $("scan-btn").disabled = true;
  $("progress").hidden = false;
  try {
    const results = await readLabel(photoCanvas, crop, (msg, progress) => {
      setStatus(msg);
      if (progress == null) $("progress").removeAttribute("value");
      else $("progress").value = progress;
    });
    const best = pickBestReading(results);
    if (!best.fullText.trim()) {
      throw new Error("No text found. Drag a box around the label, get closer, or tap ↻ to rotate.");
    }
    const poor = !best.doseQty || best.schedule === "other";
    setStatus(poor && !crop ? "Tip: drag a box around the label text, then tap Read label again." : "");
    fillForm(best);
  } catch (err) {
    setStatus(err.message || "Could not read the photo.", true);
  } finally {
    $("scan-btn").disabled = false;
    $("progress").hidden = true;
  }
});

// Each OCR pass reads the label a bit differently; keep the one that yields the
// most usable dosing info, using OCR confidence as the tie-breaker.
function pickBestReading(results) {
  const score = (p) => (p.directions ? 2 : 0) + (p.doseQty ? 2 : 0) + (p.schedule !== "other" ? 2 : 0)
    + (p.medicationKnown ? 1 : 0) + p.ocrConfidence / 100;
  return results
    .map((r) => parseLabel(r.text, r.confidence))
    .reduce((best, p) => (score(p) > score(best) ? p : best));
}

$("manual-btn").addEventListener("click", () => {
  fillForm(parseLabel(""));
  $("issues").hidden = true;
  $("directions").focus();
});

function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("error", isError);
}

// ---------- Step 2: confirm details ----------

function fillForm(p) {
  $("directions").value = p.directions;
  $("f-med").value = p.medication;
  $("f-strength").value = p.strength;
  fillDosing(p);
  $("fulltext").textContent = p.fullText;
  $("fulltext-wrap").hidden = !p.fullText.trim();
  showIssues(parseIssues(p));

  for (const id of ["confirm-card", "result-card", "reminder-card"]) $(id).hidden = false;
  update();
  $("confirm-card").scrollIntoView({ behavior: "smooth" });
}

function fillDosing(p) {
  $("f-qty").value = p.doseQty ?? "";
  $("f-unit").value = p.doseUnit;
  $("f-route").value = p.route;
  $("f-schedule").value = p.schedule;
  $("f-prn").checked = p.asNeeded;
  $("f-food").value = p.food;
  $("f-days").value = p.durationDays || 0;
  for (const box of $("f-warnings").querySelectorAll("input")) box.checked = p.warnings.includes(box.value);
  whileAwake = p.whileAwake;
  multiStep = p.multiStep;
  resetTimes();
}

function showIssues(issues) {
  $("issues").hidden = issues.length === 0;
  $("issues").replaceChildren(el("strong", "Please check: "), issues.join(", "));
}

$("reparse-btn").addEventListener("click", () => {
  const p = parseDirections($("directions").value, $("fulltext").textContent);
  fillDosing(p);
  showIssues(parseIssues({ ...p, ...readForm(), medicationKnown: true, ocrConfidence: 100 }));
  update();
});

$("f-schedule").addEventListener("change", resetTimes);
$("f-prn").addEventListener("change", resetTimes);
$("confirm-card").addEventListener("input", update);
$("confirm-card").addEventListener("change", update);
$("language").addEventListener("change", update);

function readForm() {
  return {
    medication: $("f-med").value.trim(),
    strength: $("f-strength").value.trim(),
    doseQty: Number($("f-qty").value) || null,
    doseUnit: $("f-unit").value,
    route: $("f-route").value,
    schedule: $("f-schedule").value,
    asNeeded: $("f-prn").checked,
    food: $("f-food").value,
    durationDays: Number($("f-days").value) || 0,
    warnings: [...$("f-warnings").querySelectorAll("input:checked")].map((b) => b.value),
    directions: $("directions").value.trim(),
    times: [...$("times").querySelectorAll("input")].map((i) => i.value).filter(Boolean).sort(),
  };
}

// ---------- Step 3: translated instructions ----------

function currentLang() {
  return I18N[$("language").value] || EN;
}

// Builds every translated line from the confirmed form, so it can be shown,
// read aloud, and written into calendar events consistently.
function translate(d, L) {
  let when = L.schedule[d.schedule];
  if (d.asNeeded && d.schedule !== "as_needed") when += ` — ${L.schedule.as_needed}`;
  if (d.times.length) when += ` (${d.times.join(", ")})`;
  const info = DRUG_INFO[Object.keys(I18N).find((k) => I18N[k] === L)] || DRUG_INFO.en;
  const cls = drugClass(d.medication, d.strength);
  return {
    title: [d.medication, d.strength].filter(Boolean).join(" ") || "—",
    purpose: cls ? { label: info.label, name: info.classes[cls][0], desc: info.classes[cls][1], note: info.note } : null,
    dose: d.doseQty ? `${d.doseQty} × ${L.unit[d.doseUnit] || ""}`.trim() : "",
    how: [L.route[d.route], L.food[d.food]].filter(Boolean).join(" · "),
    when,
    days: d.durationDays ? String(d.durationDays) : "",
    warnings: d.warnings.map((w) => L.warning[w]),
    unknown: d.schedule === "other" || !d.doseQty || multiStep ? L.label.unknown : "",
    disclaimer: L.label.disclaimer,
  };
}

function update() {
  const L = currentLang();
  const t = translate(readForm(), L);

  $("translated").dir = L.rtl ? "rtl" : "ltr";
  $("translated").lang = L.tts;
  $("t-med").textContent = t.title;
  $("t-purpose").hidden = !t.purpose;
  if (t.purpose) {
    $("t-purpose-label").textContent = t.purpose.label;
    $("t-purpose-name").textContent = t.purpose.name;
    $("t-purpose-desc").textContent = t.purpose.desc;
    $("t-purpose-note").textContent = t.purpose.note;
  }
  setFact("dose", L.label.dose, t.dose);
  setFact("how", L.label.how, t.how);
  setFact("when", L.label.when, t.when);
  setFact("days", L.label.duration, t.days);
  $("t-warnings-label").textContent = `⚠️ ${L.label.warnings}`;
  $("t-warnings").replaceChildren(...t.warnings.map((w) => el("li", w)));
  $("t-warnings-wrap").hidden = t.warnings.length === 0;
  $("t-unknown").textContent = t.unknown;
  $("t-unknown").hidden = !t.unknown;
  $("t-disclaimer").textContent = t.disclaimer;
}

function setFact(key, label, value) {
  $(`t-${key}-label`).textContent = label;
  $(`t-${key}`).textContent = value;
  $(`t-${key}-label`).hidden = $(`t-${key}`).hidden = !value;
}

// ---------- Read aloud ----------

// Browsers fall back to their default (usually English) voice when only `lang`
// is set, so pick a voice for the language explicitly.
function findVoice(L) {
  const voices = speechSynthesis.getVoices();
  const norm = (code) => code.toLowerCase().replace("_", "-");
  const exact = norm(L.tts);
  const bases = [exact.split("-")[0], ...(L.ttsAlt || [])];
  const matches = voices.filter((v) => norm(v.lang) === exact)
    .concat(voices.filter((v) => bases.includes(norm(v.lang).split("-")[0])));
  // Prefer the higher-quality neural/online voices when there are several.
  return matches.find((v) => /natural|neural|online|google/i.test(v.name)) || matches[0] || null;
}

// Voices load asynchronously; wait briefly for them on first use.
function voicesReady() {
  if (speechSynthesis.getVoices().length) return Promise.resolve();
  return new Promise((resolve) => {
    speechSynthesis.addEventListener("voiceschanged", resolve, { once: true });
    setTimeout(resolve, 1500);
  });
}

async function updateVoiceStatus() {
  if (!("speechSynthesis" in window)) {
    $("speak-btn").hidden = true;
    return;
  }
  await voicesReady();
  const L = currentLang();
  const voice = findVoice(L);
  $("speak-btn").disabled = !voice;
  $("speak-status").textContent = voice ? "" :
    `This device has no ${L.name} voice. Try Microsoft Edge, or add ${L.name} under text-to-speech in your phone's settings.`;
}

$("speak-btn").addEventListener("click", async () => {
  await voicesReady();
  const L = currentLang();
  const voice = findVoice(L);
  if (!voice) return updateVoiceStatus();
  const t = translate(readForm(), L);
  const text = [t.title, t.purpose && `${t.purpose.name}. ${t.purpose.desc}`, t.dose, t.how, t.when, ...t.warnings, t.unknown, t.disclaimer].filter(Boolean).join(". ");
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.voice = voice;
  utter.lang = voice.lang;
  utter.rate = 0.9; // a little slower is easier to follow
  speechSynthesis.speak(utter);
});

$("language").addEventListener("change", updateVoiceStatus);
if ("speechSynthesis" in window) speechSynthesis.addEventListener("voiceschanged", updateVoiceStatus);
updateVoiceStatus();

// ---------- Step 4: reminders ----------

function resetTimes() {
  $("times").replaceChildren();
  for (const time of defaultTimes($("f-schedule").value, whileAwake, $("f-prn").checked)) addTimeRow(time);
  update();
}

function addTimeRow(value = "08:00") {
  const row = document.createElement("li");
  const input = Object.assign(document.createElement("input"), { type: "time", value });
  input.addEventListener("input", update);
  const remove = el("button", "✕");
  remove.type = "button";
  remove.setAttribute("aria-label", "Remove time");
  remove.addEventListener("click", () => { row.remove(); update(); });
  row.append(input, remove);
  $("times").append(row);
}

$("add-time").addEventListener("click", () => { addTimeRow(); update(); });

$("ics-btn").addEventListener("click", () => {
  const d = readForm();
  if (d.times.length === 0) {
    $("ics-status").textContent = "Add at least one dose time first.";
    return;
  }
  const ics = buildIcs(d, translate(d, currentLang()), $("start-date").value);
  const name = (d.medication || "medication").replace(/[^\w-]+/g, "_");
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
  Object.assign(document.createElement("a"), { href: url, download: `${name}-reminders.ics` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  $("ics-status").textContent = "Calendar file downloaded. Open it to add the reminders.";
});

// One repeating VEVENT per dose time, each with an alert at the dose time.
function buildIcs(d, t, startDate) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const date = startDate.replace(/-/g, "");
  const title = `💊 ${[t.title, t.dose].filter((s) => s && s !== "—").join(" — ")}`;
  const description = [t.purpose && `${t.purpose.name}: ${t.purpose.desc}`, t.dose, t.how, t.when, ...t.warnings, "", `Label: ${d.directions}`, t.disclaimer]
    .filter((s) => s != null).join("\n");

  const weekly = d.schedule === "weekly";
  let rrule = weekly ? "FREQ=WEEKLY" : "FREQ=DAILY";
  if (d.durationDays > 0) rrule += `;COUNT=${weekly ? Math.ceil(d.durationDays / 7) : d.durationDays}`;

  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MediBridge//EN", "CALSCALE:GREGORIAN"];
  for (const time of d.times) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uniqueId()}@medibridge`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${date}T${time.replace(":", "")}00`,
      "DURATION:PT15M",
      `RRULE:${rrule}`,
      `SUMMARY:${icsEscape(title)}`,
      `DESCRIPTION:${icsEscape(description)}`,
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${icsEscape(title)}`,
      "TRIGGER:PT0M",
      "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

function icsEscape(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

// RFC 5545: lines longer than 75 octets must be folded (matters for non-Latin scripts).
function foldLine(line) {
  const enc = new TextEncoder();
  const parts = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const size = enc.encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes + size > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

// ---------- Helpers ----------

function option(value, text) {
  return Object.assign(document.createElement("option"), { value, textContent: text });
}

function el(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

// crypto.randomUUID only exists on https pages; phones on http://<laptop-ip> lack it.
function uniqueId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function toDateInput(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
