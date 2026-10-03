// Turns prescription label text (from OCR or typed in) into structured dosing info.
// US pharmacy directions are highly formulaic ("TAKE 1 TABLET BY MOUTH TWICE DAILY"),
// so pattern rules cover most labels. Anything unrecognized is flagged, never guessed.

// Common generic drug names, used to pick the medication out of noisy OCR text.
const DRUGS = [
  "acetaminophen", "acyclovir", "albuterol", "allopurinol", "alprazolam", "amlodipine",
  "amoxicillin", "amphetamine", "apixaban", "aripiprazole", "aspirin", "atenolol", "atorvastatin",
  "azithromycin", "baclofen", "benzonatate", "bupropion", "buspirone", "carvedilol", "cefdinir",
  "cefuroxime", "cephalexin", "cetirizine", "ciprofloxacin", "citalopram", "clindamycin",
  "clonazepam", "clonidine", "clopidogrel", "colchicine", "cyclobenzaprine", "diazepam",
  "dicyclomine", "diltiazem", "donepezil", "doxycycline", "duloxetine", "ergocalciferol",
  "escitalopram", "esomeprazole", "estradiol", "famotidine", "finasteride", "fluconazole",
  "fluoxetine", "fluticasone", "furosemide", "gabapentin", "glimepiride", "glipizide",
  "hydralazine", "hydrochlorothiazide", "hydrocodone", "hydrocortisone", "hydroxyzine",
  "ibuprofen", "insulin", "ketoconazole", "lamotrigine", "latanoprost", "levetiracetam",
  "levofloxacin", "levothyroxine", "lisinopril", "lithium", "loratadine", "lorazepam", "losartan",
  "meclizine", "medroxyprogesterone", "meloxicam", "memantine", "metformin", "methocarbamol", "methotrexate",
  "methylphenidate", "methylprednisolone", "metoprolol", "metronidazole", "mirtazapine",
  "montelukast", "mupirocin", "naproxen", "nitrofurantoin", "norethindrone", "nystatin",
  "ofloxacin", "olanzapine", "omeprazole", "ondansetron", "oseltamivir", "oxycodone",
  "pantoprazole", "paroxetine", "penicillin", "potassium", "pravastatin", "prednisolone",
  "prednisone", "pregabalin", "promethazine", "propranolol", "quetiapine", "risperidone",
  "rivaroxaban", "ropinirole", "rosuvastatin", "sertraline", "sildenafil", "simvastatin",
  "sitagliptin", "spironolactone", "sulfamethoxazole", "sumatriptan", "tamsulosin", "timolol",
  "tizanidine", "tobramycin", "topiramate", "tramadol", "trazodone", "triamcinolone",
  "trimethoprim", "valacyclovir", "valsartan", "venlafaxine", "warfarin", "zolpidem",
];

const UNITS = [
  ["tablet", "tab(?:let)?s?"],
  ["capsule", "cap(?:sule)?s?"],
  ["mL", "ml|milliliters?|cc"],
  ["teaspoon", "teaspoon(?:ful)?s?|tsp"],
  ["drop", "drops?|gtts?"],
  ["puff", "puffs?|inhalations?"],
  ["spray", "sprays?"],
  ["patch", "patch(?:es)?"],
];

const WORD_NUMBERS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, half: 0.5, "½": 0.5,
};
const NUM = "(\\d+(?:\\.\\d+)?|\\d\\/\\d|½|one|two|three|four|five|six|seven|eight|nine|ten|half|an?)";

const SCHEDULE_TIMES = {
  once_daily: ["08:00"],
  twice_daily: ["08:00", "20:00"],
  three_daily: ["08:00", "14:00", "20:00"],
  four_daily: ["08:00", "12:00", "16:00", "20:00"],
  every_4h: ["08:00", "12:00", "16:00", "20:00", "00:00", "04:00"],
  every_6h: ["06:00", "12:00", "18:00", "00:00"],
  every_8h: ["06:00", "14:00", "22:00"],
  every_12h: ["08:00", "20:00"],
  morning: ["08:00"],
  evening: ["19:00"],
  bedtime: ["21:30"],
  weekly: ["08:00"],
  as_needed: [],
  other: [],
};

const DOSES_PER_DAY = {
  once_daily: 1, twice_daily: 2, three_daily: 3, four_daily: 4, every_4h: 6, every_6h: 4,
  every_8h: 3, every_12h: 2, morning: 1, evening: 1, bedtime: 1,
};

const WARNING_PATTERNS = {
  drowsy: /drows|sleepy/,
  driving: /\bdriv(e|ing)\b|operat\w* (heavy )?machinery|machines/,
  alcohol: /alcohol/,
  finish: /finish (all|the entire|this)|complete (the |all )|entire course|until (all )?gone/,
  sun: /sun ?light|sunlamp|\bsun\b|tanning/,
  no_crush: /(do not|don'?t) (crush|chew|break)|swallow whole/,
  shake: /shake well/,
  refrigerate: /refrigerat/,
  external: /external use|not for (oral|internal)|do not swallow/,
  dizzy: /dizz/,
  dairy: /dairy|\bmilk\b|antacid|calcium|\biron\b|mineral supplement/,
  grapefruit: /grapefruit/,
  pregnant: /pregnan|breast ?feed|nursing/,
  water: /full glass of water|plenty of (water|fluids)/,
};

// Words that start the directions line on a US label.
const DIRECTION_START = /\b(take|apply|inhale|instill|insert|chew|dissolve|place|give|spray|use (\d|one|two|a))\b/i;
// Lines that are label metadata rather than directions.
const METADATA_LINE = /\b(qty|quantity|refills?|rx\b|rx#|dr\.?\s|prescriber|date|filled|exp|mfg|ndc|discard|pharmacy|phone)\b|\(\d{3}\)/i;
const STRENGTH = /(\d+(?:[.,]\d+)?)\s*(?:(?:mg|mcg|µg|g|ml|units?|iu)\b|%)(\s*\/\s*\d*(?:\.\d+)?\s*ml)?/i;

function parseLabel(rawText, ocrConfidence = 100) {
  const text = normalizeOcr(rawText || "");
  const lower = text.toLowerCase();
  const directions = extractDirections(text);
  return { ...parseDirections(directions || text, lower), ...findMedication(text, directions), directions, fullText: text, ocrConfidence };
}

// Parses just the dosing fields. `context` is the full label text, used for
// warnings and quantity, which usually sit outside the directions line.
function parseDirections(directions, context = "") {
  const sig = normalizeOcr(directions).toLowerCase();
  const all = `${sig}\n${context.toLowerCase()}`;
  const dose = parseDose(sig);
  const { schedule, asNeeded, whileAwake } = parseSchedule(sig);
  return {
    doseQty: dose.qty,
    doseUnit: dose.unit,
    route: parseRoute(sig, dose.unit),
    schedule,
    asNeeded,
    whileAwake,
    multiStep: /\bthen\b|\bday 1\b|taper/.test(sig),
    durationDays: parseDuration(all, dose.qty, schedule),
    food: parseFood(all),
    warnings: Object.keys(WARNING_PATTERNS).filter((k) => WARNING_PATTERNS[k].test(all)),
  };
}

// Fix the most common Tesseract misreads on labels.
function normalizeOcr(text) {
  const units = UNITS.map(([, p]) => p).join("|");
  return text
    .replace(/\r/g, "")
    .replace(/[‘’]/g, "'")
    .replace(new RegExp(`(^|\\s)[lI|](?=\\s+(${units})\\b)`, "gim"), "$11") // "TAKE l TABLET"
    .replace(/(\d)[oO](?=\d|\s*(mg|mcg|ml)\b)/gi, "$10") // "1O MG"
    .replace(/[ \t]+/g, " ");
}

function extractDirections(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const start = lines.findIndex((l) => DIRECTION_START.test(l));
  if (start === -1) return "";
  const first = lines[start];
  const parts = [first.slice(first.search(DIRECTION_START))];
  for (let i = start + 1; i < lines.length && parts.length < 4; i++) {
    if (METADATA_LINE.test(lines[i]) || STRENGTH.test(lines[i])) break; // stop at the drug-name line
    parts.push(lines[i]);
  }
  return parts.join(" ");
}

function toNumber(token) {
  if (token in WORD_NUMBERS) return WORD_NUMBERS[token];
  if (/^\d\/\d$/.test(token)) {
    const [a, b] = token.split("/").map(Number);
    return a / b;
  }
  return parseFloat(token);
}

function parseDose(sig) {
  let best = null;
  for (const [unit, pattern] of UNITS) {
    const m = new RegExp(`(?:^|[^\\w])${NUM}\\s*(?:${pattern})\\b`, "i").exec(sig);
    if (m && (!best || m.index < best.index)) best = { index: m.index, qty: toNumber(m[1].toLowerCase()), unit };
  }
  if (best) return { qty: best.qty, unit: best.unit };
  if (/\bapply\b|thin (layer|film)/.test(sig)) return { qty: 1, unit: "application" };
  return { qty: null, unit: "" };
}

function parseRoute(sig, unit) {
  if (/\beyes?\b|ophthalmic/.test(sig)) return "eye";
  if (/\bears?\b|\botic\b/.test(sig)) return "ear";
  if (/nostrils?|nasal|\bnose\b/.test(sig)) return "nose";
  if (/inhal|\bpuffs?\b/.test(sig)) return "inhaled";
  if (/\bapply\b|topical|\bskin\b|affected area/.test(sig)) return "skin";
  if (/by mouth|orally|\bpo\b|swallow|\bchew\b/.test(sig)) return "oral";
  if (["tablet", "capsule", "mL", "teaspoon"].includes(unit)) return "oral";
  return "";
}

function parseSchedule(sig) {
  const asNeeded = /as needed|if needed|when needed|\bprn\b|as required/.test(sig);
  const whileAwake = /while awake/.test(sig);
  const day = "(?:a|per|each|every)?\\s*(?:day|daily)";
  let schedule = null;

  const interval = /every\s*(\d+)\s*(?:(?:-|to)\s*(\d+)\s*)?(?:hours?|hrs?)|\bq\s*(\d+)\s*h/.exec(sig);
  if (interval) {
    // For a range like "every 4 to 6 hours", use the longer gap (fewer doses).
    const hours = Number(interval[2] || interval[1] || interval[3]);
    schedule = { 4: "every_4h", 6: "every_6h", 8: "every_8h", 12: "every_12h", 24: "once_daily" }[hours] || "other";
  } else if (new RegExp(`(four|4)\\s*times\\s*${day}|\\bqid\\b`).test(sig)) {
    schedule = "four_daily";
  } else if (new RegExp(`(three|3)\\s*times\\s*${day}|\\btid\\b`).test(sig)) {
    schedule = "three_daily";
  } else if (new RegExp(`(twice|two times|2 times)\\s*${day}|\\bbid\\b`).test(sig)) {
    schedule = "twice_daily";
  } else if (/once (a|per|every|each) week|\bweekly\b|every week|each week/.test(sig)) {
    schedule = "weekly";
  } else if (/bedtime|before (bed|sleep)|\bq?hs\b/.test(sig)) {
    schedule = "bedtime";
  } else if (/(in the|every|each) morning|\bqam\b/.test(sig)) {
    schedule = "morning";
  } else if (/(in the|every|each) evening|at night|\bqpm\b/.test(sig)) {
    schedule = "evening";
  } else if (new RegExp(`(once|one time|1 time)\\s*${day}|\\bdaily\\b|every day|each day|\\bqd\\b`).test(sig)) {
    schedule = "once_daily";
  }

  if (!schedule) schedule = asNeeded ? "as_needed" : "other";
  return { schedule, asNeeded, whileAwake };
}

function parseDuration(text, doseQty, schedule) {
  const m = new RegExp(`(?:\\bfor|\\bx)\\s*${NUM}\\s*(days?|weeks?)`).exec(text);
  if (m) return toNumber(m[1]) * (m[2].startsWith("week") ? 7 : 1);
  // "Take until gone" + "Qty: 20" → work out how many days the supply lasts.
  const untilGone = /until (all )?(gone|finished|taken)|finish all|entire course/.test(text);
  const qty = /(?:qty|quantity)\s*[:#]?\s*(\d+)/.exec(text);
  if (untilGone && qty && doseQty && DOSES_PER_DAY[schedule]) {
    return Math.ceil(Number(qty[1]) / (doseQty * DOSES_PER_DAY[schedule]));
  }
  return 0;
}

function parseFood(text) {
  if (/empty stomach|before (meals|eating|breakfast|food)|(1|one) hour before/.test(text)) return "empty_stomach";
  if (/with (food|a meal|meals|breakfast|lunch|dinner)|after (meals|eating|food)/.test(text)) return "with_food";
  return "";
}

function findMedication(text, directions) {
  // Fuzzy-match words against the known drug list to survive OCR typos.
  let best = null;
  for (const word of text.match(/[A-Za-z][A-Za-z0-9-]{3,}/g) || []) {
    // OCR often swaps letters for look-alike digits ("IBUPR0FEN").
    const w = word.toLowerCase().replace(/0/g, "o").replace(/1/g, "l").replace(/5/g, "s");
    for (const drug of DRUGS) {
      if (Math.abs(drug.length - w.length) > 2) continue;
      const limit = drug.length >= 8 ? 2 : drug.length >= 6 ? 1 : 0;
      const d = levenshtein(w, drug);
      if (d <= limit && (!best || d < best.dist)) best = { dist: d, drug, word };
    }
  }

  const lines = text.split("\n");
  const notDirections = (l) => !directions || !directions.includes(l.trim());
  let name = "";
  let nameLine = null;
  if (best) {
    name = capitalize(best.drug);
    nameLine = lines.find((l) => l.includes(best.word));
  } else {
    // Fallback: the drug name usually sits right before the strength ("LISINOPRIL 10MG").
    nameLine = lines.find((l) => STRENGTH.test(l) && notDirections(l) && !METADATA_LINE.test(l));
    if (nameLine) {
      const before = nameLine.slice(0, nameLine.search(STRENGTH)).replace(/[^A-Za-z -]/g, " ").trim();
      name = capitalize(before.split(/\s+/).slice(-3).join(" "));
    }
  }

  let strength = "";
  const strengthSource = (nameLine && STRENGTH.exec(nameLine))
    || lines.filter((l) => notDirections(l) && !METADATA_LINE.test(l)).map((l) => STRENGTH.exec(l)).find(Boolean);
  if (strengthSource) strength = strengthSource[0].replace(/\s+/g, " ").trim();

  return { medication: name, strength, medicationKnown: Boolean(best) };
}

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

function capitalize(s) {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// Default reminder times for a schedule. "While awake" drops overnight doses.
// As-needed medicines get no scheduled reminders unless the user adds them.
function defaultTimes(schedule, whileAwake = false, asNeeded = false) {
  if (asNeeded) return [];
  const times = SCHEDULE_TIMES[schedule] || [];
  if (!whileAwake) return [...times];
  return times.filter((t) => t >= "07:00" && t <= "22:00");
}

// Lists what the parser could not determine, so the UI can ask the user to check.
function parseIssues(p) {
  const issues = [];
  if (p.ocrConfidence < 60) issues.push("The photo was hard to read");
  if (!p.medication) issues.push("Medication name");
  else if (!p.medicationKnown) issues.push("Medication name (not in our list - check spelling)");
  if (!p.doseQty) issues.push("Dose amount");
  if (p.schedule === "other") issues.push("How often to take it");
  if (p.multiStep) issues.push("Directions have more than one step - check the dose and days");
  return issues;
}

if (typeof module !== "undefined") {
  module.exports = { parseLabel, parseDirections, defaultTimes, parseIssues, SCHEDULE_TIMES, WARNING_PATTERNS };
}
