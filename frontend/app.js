// Languages offered in the picker. `tts` is the BCP-47 tag used for read-aloud.
const LANGUAGES = [
  { name: "English", tts: "en-US" },
  { name: "Spanish", tts: "es-ES" },
  { name: "Chinese (Simplified)", tts: "zh-CN" },
  { name: "Hindi", tts: "hi-IN" },
  { name: "Telugu", tts: "te-IN" },
  { name: "Tamil", tts: "ta-IN" },
  { name: "Arabic", tts: "ar-SA", rtl: true },
  { name: "Urdu", tts: "ur-PK", rtl: true },
  { name: "Vietnamese", tts: "vi-VN" },
  { name: "Korean", tts: "ko-KR" },
  { name: "Tagalog", tts: "fil-PH" },
  { name: "French", tts: "fr-FR" },
  { name: "Portuguese", tts: "pt-BR" },
  { name: "Russian", tts: "ru-RU" },
  { name: "Japanese", tts: "ja-JP" },
  { name: "German", tts: "de-DE" },
  { name: "Polish", tts: "pl-PL" },
  { name: "Haitian Creole", tts: "ht-HT" },
];

const $ = (id) => document.getElementById(id);
let photoBlob = null;
let result = null;

// ---------- Setup ----------

for (const lang of LANGUAGES) {
  const opt = document.createElement("option");
  opt.value = lang.name;
  opt.textContent = lang.name;
  $("language").append(opt);
}
// Pre-select the browser's language when we support it.
const browserLang = navigator.language.slice(0, 2);
const match = LANGUAGES.find((l) => l.tts.startsWith(browserLang));
if (match) $("language").value = match.name;

$("start-date").value = toDateInput(new Date());

// ---------- Photo capture ----------

$("photo").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setStatus("");
  photoBlob = await shrinkImage(file);
  $("preview").src = URL.createObjectURL(photoBlob);
  $("preview").hidden = false;
  $("photo-hint").hidden = true;
  $("scan-btn").disabled = false;
});

// Phone photos are often 5-12 MB; resize to keep uploads fast and under the API limit.
async function shrinkImage(file, maxDim = 1600) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
}

// ---------- Scan ----------

$("scan-btn").addEventListener("click", async () => {
  if (!photoBlob) return;
  $("scan-btn").disabled = true;
  setStatus("Reading your label… this takes a few seconds.");

  const form = new FormData();
  form.append("image", photoBlob, "label.jpg");
  form.append("language", $("language").value);

  try {
    const res = await fetch("/api/scan", { method: "POST", body: form });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Something went wrong.");
    if (!body.is_prescription_label) {
      throw new Error("That doesn't look like a prescription label. Try again with the label facing the camera.");
    }
    result = { ...body, lang: currentLang() };
    setStatus("");
    renderResult();
    renderReminders();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    $("scan-btn").disabled = false;
  }
});

function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("error", isError);
}

// ---------- Results ----------

function renderResult() {
  const r = result;
  const t = r.translation;
  const lang = r.lang;

  $("low-confidence").hidden = r.confidence !== "low";
  $("med-name").textContent = r.medication_name || "Unknown medication";
  $("med-strength").textContent = [r.strength, r.dose_amount].filter(Boolean).join(" · ");

  $("translated").dir = lang.rtl ? "rtl" : "ltr";
  $("translated").lang = lang.tts;
  $("t-summary").textContent = t.summary;
  $("t-how").textContent = t.how_to_take;
  $("t-when").textContent = t.when_to_take;
  $("t-disclaimer").textContent = t.disclaimer;
  $("t-warnings").replaceChildren(...t.warnings.map((w) => li(w)));
  $("t-warnings-wrap").hidden = t.warnings.length === 0;

  $("orig-directions").textContent = r.label_directions_verbatim || "(not readable)";
  const details = [
    ["Patient", r.patient_name], ["Prescriber", r.prescriber], ["Pharmacy", r.pharmacy],
    ["Pharmacy phone", r.pharmacy_phone], ["Rx #", r.rx_number],
    ["Quantity", r.quantity], ["Refills", r.refills],
  ].filter(([, v]) => v);
  $("orig-details").replaceChildren(
    ...details.flatMap(([k, v]) => [el("dt", k), el("dd", v)])
  );

  $("result-card").hidden = false;
  $("result-card").scrollIntoView({ behavior: "smooth" });
}

$("speak-btn").addEventListener("click", () => {
  const t = result.translation;
  const text = [t.summary, t.how_to_take, t.when_to_take, ...t.warnings, t.disclaimer].join(". ");
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = result.lang.tts;
  speechSynthesis.speak(utter);
});

// ---------- Reminders ----------

function renderReminders() {
  const r = result;
  $("prn-note").hidden = r.schedule_type !== "as_needed";
  $("repeat").value = r.schedule_type === "weekly" ? "weekly" : "daily";
  $("duration").value = r.duration_days || 0;
  $("times").replaceChildren();
  for (const time of r.suggested_times) addTimeRow(time);
  $("reminder-card").hidden = false;
}

function addTimeRow(value = "08:00") {
  const row = document.createElement("li");
  const input = document.createElement("input");
  input.type = "time";
  input.value = value;
  const remove = el("button", "✕");
  remove.type = "button";
  remove.setAttribute("aria-label", "Remove time");
  remove.addEventListener("click", () => row.remove());
  row.append(input, remove);
  $("times").append(row);
}

$("add-time").addEventListener("click", () => addTimeRow());

$("ics-btn").addEventListener("click", () => {
  const times = [...$("times").querySelectorAll("input")].map((i) => i.value).filter(Boolean);
  if (times.length === 0) {
    alert("Add at least one dose time first.");
    return;
  }
  const ics = buildIcs({
    times,
    startDate: $("start-date").value,
    repeat: $("repeat").value,
    durationDays: Number($("duration").value) || 0,
  });
  const name = (result.medication_name || "medication").replace(/[^\w-]+/g, "_");
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${name}-reminders.ics` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

// One repeating VEVENT per dose time, each with a pop-up alarm at the dose time.
function buildIcs({ times, startDate, repeat, durationDays }) {
  const r = result;
  const t = r.translation;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const date = startDate.replace(/-/g, "");
  const description = [
    t.summary, t.how_to_take, t.when_to_take, ...t.warnings, "",
    `Label: ${r.label_directions_verbatim}`, t.disclaimer,
  ].join("\n");

  let rrule = repeat === "weekly" ? "FREQ=WEEKLY" : "FREQ=DAILY";
  if (durationDays > 0) {
    const count = repeat === "weekly" ? Math.ceil(durationDays / 7) : durationDays;
    rrule += `;COUNT=${count}`;
  }

  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//PillPal//EN", "CALSCALE:GREGORIAN"];
  for (const time of times) {
    const hhmm = time.replace(":", "");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${crypto.randomUUID()}@pillpal`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${date}T${hhmm}00`,
      "DURATION:PT15M",
      `RRULE:${rrule}`,
      `SUMMARY:💊 ${icsEscape(t.reminder_title)}`,
      `DESCRIPTION:${icsEscape(description)}`,
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${icsEscape(t.reminder_title)}`,
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

function currentLang() {
  return LANGUAGES.find((l) => l.name === $("language").value) || LANGUAGES[0];
}

function el(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function li(text) {
  return el("li", text);
}

function toDateInput(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
