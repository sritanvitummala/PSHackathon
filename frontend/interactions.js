// Rule-based check for well-known interactions between the medicines a person
// has saved. It only covers common, well-documented combinations; it is a prompt
// to talk to a pharmacist, not a full interaction database.

// In Node (tests) the parser helpers are not globals.
if (typeof module !== "undefined") ({ findDrug, drugClass } = require("./parser.js"));

const OPIOIDS = ["hydrocodone", "oxycodone", "tramadol"];
const BENZOS = ["alprazolam", "clonazepam", "diazepam", "lorazepam"];
const NSAIDS = ["ibuprofen", "naproxen", "meloxicam"]; // aspirin is handled separately
const ANTICOAGULANTS = ["warfarin", "apixaban", "rivaroxaban"];
const ANTIPLATELETS = ["clopidogrel", "aspirin"];
const SSRI_SNRI = ["citalopram", "escitalopram", "fluoxetine", "paroxetine", "sertraline", "venlafaxine", "duloxetine"];
const ACE_ARB = ["lisinopril", "losartan", "valsartan"];
const DIURETICS = ["furosemide", "hydrochlorothiazide", "spironolactone"];
// Medicines that cause drowsiness or slow breathing.
const SEDATING = [...OPIOIDS, ...BENZOS, "zolpidem", "cyclobenzaprine", "methocarbamol", "tizanidine",
  "baclofen", "gabapentin", "pregabalin", "hydroxyzine", "promethazine", "meclizine", "quetiapine",
  "olanzapine", "mirtazapine", "trazodone"];
// Medicines that can lengthen the heart's QT interval.
const QT_DRUGS = ["azithromycin", "ciprofloxacin", "levofloxacin", "citalopram", "escitalopram",
  "ondansetron", "quetiapine"];

// Each rule fires when one medicine is in `a` and another is in `b`.
const PAIR_RULES = [
  { msg: "breathing", severity: "high", a: OPIOIDS, b: BENZOS },
  { msg: "bleeding", severity: "high", a: ANTICOAGULANTS, b: [...NSAIDS, ...ANTIPLATELETS] },
  { msg: "bleeding_warfarin", severity: "high", a: ["warfarin"],
    b: ["sulfamethoxazole", "trimethoprim", "metronidazole", "ciprofloxacin", "levofloxacin", "fluconazole"] },
  { msg: "bleeding_mild", severity: "moderate", a: SSRI_SNRI, b: [...NSAIDS, ...ANTICOAGULANTS, ...ANTIPLATELETS] },
  { msg: "bleeding_mild", severity: "moderate", a: ["aspirin"], b: NSAIDS },
  { msg: "serotonin", severity: "high", a: ["tramadol"], b: [...SSRI_SNRI, "trazodone", "mirtazapine"] },
  { msg: "serotonin", severity: "moderate", a: ["sumatriptan"], b: SSRI_SNRI },
  { msg: "potassium", severity: "high", a: ACE_ARB, b: ["spironolactone", "potassium"] },
  { msg: "potassium", severity: "high", a: ["spironolactone"], b: ["potassium"] },
  { msg: "nsaid_bp", severity: "moderate", a: NSAIDS, b: [...ACE_ARB, ...DIURETICS] },
  { msg: "lithium", severity: "high", a: ["lithium"], b: [...NSAIDS, ...ACE_ARB, ...DIURETICS] },
  { msg: "methotrexate", severity: "high", a: ["methotrexate"], b: [...NSAIDS, "sulfamethoxazole", "trimethoprim"] },
  { msg: "statin", severity: "moderate", a: ["simvastatin"], b: ["amlodipine", "diltiazem"] },
  { msg: "tizanidine", severity: "high", a: ["tizanidine"], b: ["ciprofloxacin"] },
  { msg: "clopidogrel_ppi", severity: "moderate", a: ["clopidogrel"], b: ["omeprazole", "esomeprazole"] },
  { msg: "low_bp", severity: "moderate", a: ["sildenafil"], b: ["tamsulosin"] },
  { msg: "acetaminophen", severity: "moderate", a: ["acetaminophen"], b: ["hydrocodone", "oxycodone"] },
];

// Each rule fires when two or more medicines from the same list are taken.
const GROUP_RULES = [
  { msg: "drowsy", severity: "moderate", drugs: SEDATING },
  { msg: "heart_rhythm", severity: "moderate", drugs: QT_DRUGS },
];

// Two different medicines of one of these types is worth double-checking.
// (Types like blood pressure or diabetes medicine are often combined on purpose.)
const DUPLICATE_CLASSES = ["pain_inflammation", "blood_thinner", "antidepressant", "sedative", "opioid",
  "stomach_acid", "cholesterol", "allergy", "sleep", "mood", "adhd", "steroid", "thyroid"];

// meds: [{ name, strength }]. Returns alerts (serious first) plus the names that
// could not be checked because they are not in the drug list.
function checkInteractions(meds) {
  const known = [];
  const unknown = [];
  for (const m of meds) {
    const drug = findDrug(m.name);
    if (drug) known.push({ name: m.name, drug, cls: drugClass(m.name, m.strength) });
    else if (m.name) unknown.push(m.name);
  }

  const alerts = [];
  const covered = new Set(); // pairs already explained by a more specific alert
  const pairKey = (x, y) => [x.drug, y.drug].sort().join("+");
  const add = (alert, x, y) => { alerts.push(alert); covered.add(pairKey(x, y)); };

  for (let i = 0; i < known.length; i++) {
    for (let j = i + 1; j < known.length; j++) {
      if (known[i].drug === known[j].drug) {
        add({ msg: "same_drug", severity: "high", a: known[i].name, b: known[j].name }, known[i], known[j]);
      }
    }
  }

  for (const rule of PAIR_RULES) {
    for (const x of known) {
      for (const y of known) {
        if (x.drug === y.drug || !rule.a.includes(x.drug) || !rule.b.includes(y.drug)) continue;
        if (covered.has(pairKey(x, y)) && rule.severity !== "high") continue;
        add({ msg: rule.msg, severity: rule.severity, a: x.name, b: y.name }, x, y);
      }
    }
  }

  for (const rule of GROUP_RULES) {
    const members = known.filter((k, i) => rule.drugs.includes(k.drug)
      && known.findIndex((o) => o.drug === k.drug) === i);
    if (members.length < 2) continue;
    // Skip when every pair is already explained (e.g. opioid + benzo above).
    const uncovered = members.some((x, i) => members.slice(i + 1).some((y) => !covered.has(pairKey(x, y))));
    if (!uncovered) continue;
    alerts.push({
      msg: rule.msg, severity: rule.severity,
      a: members.slice(0, -1).map((m) => m.name).join(", "), b: members[members.length - 1].name,
    });
  }

  for (let i = 0; i < known.length; i++) {
    for (let j = i + 1; j < known.length; j++) {
      const x = known[i], y = known[j];
      if (x.drug === y.drug || x.cls !== y.cls || !DUPLICATE_CLASSES.includes(x.cls)) continue;
      if (covered.has(pairKey(x, y))) continue;
      add({ msg: "same_type", severity: "moderate", a: x.name, b: y.name }, x, y);
    }
  }

  alerts.sort((p, q) => (p.severity === q.severity ? 0 : p.severity === "high" ? -1 : 1));
  return { alerts, unknown, checked: known.length };
}

function interactionText(langKey, alert) {
  const T = INTERACTION_TEXT[langKey] || INTERACTION_TEXT.en;
  return T.msg[alert.msg].replace("{a}", alert.a).replace("{b}", alert.b);
}

const INTERACTION_TEXT = {
  en: {
    title: "Interaction check", high: "Serious", moderate: "Use caution",
    none: "No known interactions found between these medicines.",
    note: "This checks common interactions only. Do not stop any medicine on your own. Ask your pharmacist or doctor.",
    notChecked: "Not checked (not in our list):",
    msg: {
      breathing: "{a} and {b} together can slow or stop your breathing. This is a serious combination.",
      drowsy: "{a} and {b} can all make you drowsy. Together they can cause severe sleepiness, falls, or slowed breathing.",
      bleeding: "{a} and {b} together raise the risk of serious bleeding.",
      bleeding_warfarin: "{b} can make {a} much stronger, which raises the risk of serious bleeding.",
      bleeding_mild: "{a} and {b} together can raise the risk of bleeding, such as stomach bleeding or easy bruising.",
      serotonin: "{a} and {b} together can cause serotonin syndrome: agitation, fever, sweating, fast heartbeat, or muscle twitching.",
      potassium: "{a} and {b} together can raise the potassium in your blood to dangerous levels.",
      nsaid_bp: "{a} can make {b} work less well and can harm the kidneys.",
      lithium: "{b} can raise lithium to toxic levels. Signs include shaking, confusion, and vomiting.",
      methotrexate: "{b} can raise methotrexate to toxic levels.",
      statin: "{b} can raise the level of {a}, which increases the risk of muscle pain and damage.",
      tizanidine: "{b} can raise {a} to dangerous levels, causing very low blood pressure and extreme drowsiness. These are usually not taken together.",
      clopidogrel_ppi: "{b} can make {a} work less well at preventing clots.",
      heart_rhythm: "{a} and {b} can each affect your heart rhythm. Together the risk is higher.",
      low_bp: "{a} and {b} together can lower blood pressure too much and cause dizziness or fainting.",
      acetaminophen: "Some {b} pills also contain acetaminophen. Taking them with {a} can mean too much acetaminophen, which can damage the liver.",
      same_drug: "{a} is in your list more than once. Check that you are not taking a double dose.",
      same_type: "{a} and {b} are the same type of medicine. Make sure your doctor knows you take both.",
    },
  },

  es: {
    title: "Revisión de interacciones", high: "Grave", moderate: "Precaución",
    none: "No se encontraron interacciones conocidas entre estos medicamentos.",
    note: "Esto revisa solo las interacciones comunes. No deje de tomar ningún medicamento por su cuenta. Pregunte a su farmacéutico o médico.",
    notChecked: "No revisados (no están en nuestra lista):",
    msg: {
      breathing: "{a} y {b} juntos pueden hacer más lenta o detener la respiración. Es una combinación grave.",
      drowsy: "{a} y {b} pueden causar sueño. Juntos pueden causar somnolencia intensa, caídas o respiración lenta.",
      bleeding: "{a} y {b} juntos aumentan el riesgo de sangrado grave.",
      bleeding_warfarin: "{b} puede hacer que {a} sea mucho más fuerte, lo que aumenta el riesgo de sangrado grave.",
      bleeding_mild: "{a} y {b} juntos pueden aumentar el riesgo de sangrado, como sangrado del estómago o moretones.",
      serotonin: "{a} y {b} juntos pueden causar síndrome serotoninérgico: agitación, fiebre, sudor, latidos rápidos o temblores musculares.",
      potassium: "{a} y {b} juntos pueden subir el potasio en la sangre a niveles peligrosos.",
      nsaid_bp: "{a} puede hacer que {b} funcione peor y puede dañar los riñones.",
      lithium: "{b} puede subir el litio a niveles tóxicos. Las señales incluyen temblores, confusión y vómitos.",
      methotrexate: "{b} puede subir el metotrexato a niveles tóxicos.",
      statin: "{b} puede subir el nivel de {a}, lo que aumenta el riesgo de dolor y daño muscular.",
      tizanidine: "{b} puede subir {a} a niveles peligrosos y causar presión muy baja y mucho sueño. Normalmente no se toman juntos.",
      clopidogrel_ppi: "{b} puede hacer que {a} funcione peor para prevenir coágulos.",
      heart_rhythm: "{a} y {b} pueden afectar el ritmo del corazón. Juntos el riesgo es mayor.",
      low_bp: "{a} y {b} juntos pueden bajar demasiado la presión y causar mareos o desmayos.",
      acetaminophen: "Algunas pastillas de {b} también contienen acetaminofén. Tomarlas con {a} puede ser demasiado acetaminofén, lo que puede dañar el hígado.",
      same_drug: "{a} está en su lista más de una vez. Asegúrese de no tomar una dosis doble.",
      same_type: "{a} y {b} son el mismo tipo de medicamento. Asegúrese de que su médico sepa que toma ambos.",
    },
  },

  zh: {
    title: "药物相互作用检查", high: "严重", moderate: "注意",
    none: "未发现这些药物之间的已知相互作用。",
    note: "此检查仅涵盖常见的相互作用。请勿自行停药，请咨询药剂师或医生。",
    notChecked: "未检查（不在我们的列表中）：",
    msg: {
      breathing: "{a} 与 {b} 同时服用可能使呼吸变慢甚至停止。这是严重的组合。",
      drowsy: "{a} 和 {b} 都会让人犯困。同时服用可能导致严重嗜睡、跌倒或呼吸变慢。",
      bleeding: "{a} 与 {b} 同时服用会增加严重出血的风险。",
      bleeding_warfarin: "{b} 可能使 {a} 的作用大大增强，从而增加严重出血的风险。",
      bleeding_mild: "{a} 与 {b} 同时服用可能增加出血风险，例如胃出血或容易淤青。",
      serotonin: "{a} 与 {b} 同时服用可能引起血清素综合征：烦躁、发烧、出汗、心跳加快或肌肉抽动。",
      potassium: "{a} 与 {b} 同时服用可能使血钾升高到危险水平。",
      nsaid_bp: "{a} 可能降低 {b} 的效果，并可能损伤肾脏。",
      lithium: "{b} 可能使锂升高到中毒水平。症状包括颤抖、意识混乱和呕吐。",
      methotrexate: "{b} 可能使甲氨蝶呤升高到中毒水平。",
      statin: "{b} 可能升高 {a} 的血药浓度，增加肌肉疼痛和损伤的风险。",
      tizanidine: "{b} 可能使 {a} 升高到危险水平，导致血压过低和极度嗜睡。通常不应同时服用。",
      clopidogrel_ppi: "{b} 可能降低 {a} 预防血栓的效果。",
      heart_rhythm: "{a} 和 {b} 都可能影响心律。同时服用风险更高。",
      low_bp: "{a} 与 {b} 同时服用可能使血压降得过低，导致头晕或晕倒。",
      acetaminophen: "有些 {b} 药片也含有对乙酰氨基酚。与 {a} 同服可能导致对乙酰氨基酚过量，损伤肝脏。",
      same_drug: "{a} 在您的列表中出现了不止一次。请确认您没有服用双倍剂量。",
      same_type: "{a} 和 {b} 是同一类药物。请确保医生知道您同时服用这两种药。",
    },
  },

  hi: {
    title: "दवाओं के आपसी असर की जाँच", high: "गंभीर", moderate: "सावधानी",
    none: "इन दवाओं के बीच कोई ज्ञात आपसी असर नहीं मिला।",
    note: "यह केवल आम आपसी असर की जाँच करता है। कोई भी दवा अपने आप बंद न करें। अपने फार्मासिस्ट या डॉक्टर से पूछें।",
    notChecked: "जाँच नहीं हुई (हमारी सूची में नहीं):",
    msg: {
      breathing: "{a} और {b} साथ लेने से साँस धीमी हो सकती है या रुक सकती है। यह गंभीर मेल है।",
      drowsy: "{a} और {b} से नींद आ सकती है। साथ लेने पर बहुत ज़्यादा नींद, गिरना या साँस धीमी होना हो सकता है।",
      bleeding: "{a} और {b} साथ लेने से गंभीर खून बहने का खतरा बढ़ता है।",
      bleeding_warfarin: "{b} से {a} का असर बहुत बढ़ सकता है, जिससे गंभीर खून बहने का खतरा बढ़ता है।",
      bleeding_mild: "{a} और {b} साथ लेने से खून बहने का खतरा बढ़ सकता है, जैसे पेट से खून आना या आसानी से नील पड़ना।",
      serotonin: "{a} और {b} साथ लेने से सेरोटोनिन सिंड्रोम हो सकता है: बेचैनी, बुखार, पसीना, तेज़ धड़कन या मांसपेशियों का फड़कना।",
      potassium: "{a} और {b} साथ लेने से खून में पोटैशियम खतरनाक स्तर तक बढ़ सकता है।",
      nsaid_bp: "{a} से {b} का असर कम हो सकता है और किडनी को नुकसान हो सकता है।",
      lithium: "{b} से लिथियम ज़हरीले स्तर तक बढ़ सकता है। लक्षणों में काँपना, भ्रम और उल्टी शामिल हैं।",
      methotrexate: "{b} से मेथोट्रेक्सेट ज़हरीले स्तर तक बढ़ सकता है।",
      statin: "{b} से {a} का स्तर बढ़ सकता है, जिससे मांसपेशियों में दर्द और नुकसान का खतरा बढ़ता है।",
      tizanidine: "{b} से {a} खतरनाक स्तर तक बढ़ सकता है, जिससे ब्लड प्रेशर बहुत कम हो सकता है और बहुत ज़्यादा नींद आ सकती है। इन्हें आमतौर पर साथ नहीं लिया जाता।",
      clopidogrel_ppi: "{b} से {a} का खून के थक्के रोकने का असर कम हो सकता है।",
      heart_rhythm: "{a} और {b} दोनों दिल की धड़कन की लय पर असर डाल सकती हैं। साथ लेने पर खतरा ज़्यादा है।",
      low_bp: "{a} और {b} साथ लेने से ब्लड प्रेशर बहुत कम हो सकता है, जिससे चक्कर या बेहोशी हो सकती है।",
      acetaminophen: "{b} की कुछ गोलियों में पैरासिटामोल (एसिटामिनोफेन) भी होता है। {a} के साथ लेने से पैरासिटामोल ज़्यादा हो सकता है, जिससे लिवर को नुकसान हो सकता है।",
      same_drug: "{a} आपकी सूची में एक से ज़्यादा बार है। पक्का करें कि आप दोगुनी खुराक नहीं ले रहे।",
      same_type: "{a} और {b} एक ही तरह की दवाएँ हैं। पक्का करें कि डॉक्टर को पता है कि आप दोनों लेते हैं।",
    },
  },

  te: {
    title: "మందుల పరస్పర ప్రభావం తనిఖీ", high: "తీవ్రమైనది", moderate: "జాగ్రత్త",
    none: "ఈ మందుల మధ్య తెలిసిన పరస్పర ప్రభావాలు ఏవీ కనబడలేదు.",
    note: "ఇది సాధారణ పరస్పర ప్రభావాలను మాత్రమే తనిఖీ చేస్తుంది. ఏ మందునూ మీ అంతట మీరే ఆపవద్దు. మీ ఫార్మసిస్ట్ లేదా డాక్టర్‌ను అడగండి.",
    notChecked: "తనిఖీ చేయలేదు (మా జాబితాలో లేవు):",
    msg: {
      breathing: "{a}, {b} కలిపి తీసుకుంటే శ్వాస నెమ్మదించవచ్చు లేదా ఆగిపోవచ్చు. ఇది ప్రమాదకరమైన కలయిక.",
      drowsy: "{a}, {b} మగత కలిగించవచ్చు. కలిపి తీసుకుంటే తీవ్రమైన మగత, పడిపోవడం లేదా శ్వాస నెమ్మదించడం జరగవచ్చు.",
      bleeding: "{a}, {b} కలిపి తీసుకుంటే తీవ్రమైన రక్తస్రావం ప్రమాదం పెరుగుతుంది.",
      bleeding_warfarin: "{b} వల్ల {a} ప్రభావం చాలా పెరిగి, తీవ్రమైన రక్తస్రావం ప్రమాదం పెరగవచ్చు.",
      bleeding_mild: "{a}, {b} కలిపి తీసుకుంటే కడుపులో రక్తస్రావం లేదా సులభంగా కమిలిపోవడం వంటి రక్తస్రావం ప్రమాదం పెరగవచ్చు.",
      serotonin: "{a}, {b} కలిపి తీసుకుంటే సెరటోనిన్ సిండ్రోమ్ రావచ్చు: ఆందోళన, జ్వరం, చెమట, గుండె వేగంగా కొట్టుకోవడం లేదా కండరాలు అదరడం.",
      potassium: "{a}, {b} కలిపి తీసుకుంటే రక్తంలో పొటాషియం ప్రమాదకర స్థాయికి పెరగవచ్చు.",
      nsaid_bp: "{a} వల్ల {b} సరిగా పనిచేయకపోవచ్చు, కిడ్నీలకు హాని కలగవచ్చు.",
      lithium: "{b} వల్ల లిథియం విషపూరిత స్థాయికి పెరగవచ్చు. వణుకు, గందరగోళం, వాంతులు దీని లక్షణాలు.",
      methotrexate: "{b} వల్ల మెథోట్రెక్సేట్ విషపూరిత స్థాయికి పెరగవచ్చు.",
      statin: "{b} వల్ల {a} స్థాయి పెరిగి, కండరాల నొప్పి, కండరాల నష్టం ప్రమాదం పెరగవచ్చు.",
      tizanidine: "{b} వల్ల {a} ప్రమాదకర స్థాయికి పెరిగి, బీపీ చాలా తగ్గడం, తీవ్రమైన మగత రావచ్చు. వీటిని సాధారణంగా కలిపి తీసుకోరు.",
      clopidogrel_ppi: "{b} వల్ల రక్తం గడ్డలను నివారించడంలో {a} సరిగా పనిచేయకపోవచ్చు.",
      heart_rhythm: "{a}, {b} రెండూ గుండె లయను ప్రభావితం చేయగలవు. కలిపి తీసుకుంటే ప్రమాదం ఎక్కువ.",
      low_bp: "{a}, {b} కలిపి తీసుకుంటే బీపీ చాలా తగ్గి కళ్ళు తిరగడం లేదా స్పృహ తప్పడం జరగవచ్చు.",
      acetaminophen: "కొన్ని {b} మాత్రల్లో పారాసెటమాల్ (ఎసిటమినోఫెన్) కూడా ఉంటుంది. {a}తో కలిపి తీసుకుంటే పారాసెటమాల్ ఎక్కువై కాలేయానికి హాని కలగవచ్చు.",
      same_drug: "{a} మీ జాబితాలో ఒకటి కంటే ఎక్కువసార్లు ఉంది. మీరు రెట్టింపు మోతాదు తీసుకోవడం లేదని నిర్ధారించుకోండి.",
      same_type: "{a}, {b} ఒకే రకమైన మందులు. మీరు రెండూ తీసుకుంటున్నారని డాక్టర్‌కు తెలుసని నిర్ధారించుకోండి.",
    },
  },

  ar: {
    title: "فحص التداخلات الدوائية", high: "خطير", moderate: "توخَّ الحذر",
    none: "لم يتم العثور على تداخلات معروفة بين هذه الأدوية.",
    note: "يفحص هذا التداخلات الشائعة فقط. لا توقف أي دواء من تلقاء نفسك. اسأل الصيدلي أو الطبيب.",
    notChecked: "لم يتم فحصها (ليست في قائمتنا):",
    msg: {
      breathing: "تناول {a} مع {b} قد يبطئ التنفس أو يوقفه. هذا مزيج خطير.",
      drowsy: "كل من {a} و{b} يسبب النعاس. معًا قد تسبب نعاسًا شديدًا أو سقوطًا أو بطء التنفس.",
      bleeding: "تناول {a} مع {b} يزيد خطر النزيف الخطير.",
      bleeding_warfarin: "قد يزيد {b} من مفعول {a} كثيرًا، مما يرفع خطر النزيف الخطير.",
      bleeding_mild: "تناول {a} مع {b} قد يزيد خطر النزيف، مثل نزيف المعدة أو سهولة ظهور الكدمات.",
      serotonin: "تناول {a} مع {b} قد يسبب متلازمة السيروتونين: هياج، حمى، تعرق، سرعة ضربات القلب، أو ارتعاش العضلات.",
      potassium: "تناول {a} مع {b} قد يرفع البوتاسيوم في الدم إلى مستوى خطير.",
      nsaid_bp: "قد يقلل {a} من فعالية {b} وقد يضر الكليتين.",
      lithium: "قد يرفع {b} الليثيوم إلى مستوى سام. من العلامات: الرعشة والتشوش والقيء.",
      methotrexate: "قد يرفع {b} الميثوتريكسات إلى مستوى سام.",
      statin: "قد يرفع {b} مستوى {a}، مما يزيد خطر ألم العضلات وتلفها.",
      tizanidine: "قد يرفع {b} مستوى {a} إلى حد خطير، مسببًا انخفاضًا شديدًا في الضغط ونعاسًا شديدًا. عادةً لا يؤخذان معًا.",
      clopidogrel_ppi: "قد يقلل {b} من فعالية {a} في منع الجلطات.",
      heart_rhythm: "كل من {a} و{b} قد يؤثر على نظم القلب. معًا يكون الخطر أكبر.",
      low_bp: "تناول {a} مع {b} قد يخفض ضغط الدم كثيرًا ويسبب الدوخة أو الإغماء.",
      acetaminophen: "بعض أقراص {b} تحتوي أيضًا على الباراسيتامول (أسيتامينوفين). تناولها مع {a} قد يعني جرعة زائدة من الباراسيتامول تضر الكبد.",
      same_drug: "{a} موجود في قائمتك أكثر من مرة. تأكد أنك لا تأخذ جرعة مضاعفة.",
      same_type: "{a} و{b} من نفس نوع الدواء. تأكد أن طبيبك يعلم أنك تأخذ الاثنين.",
    },
  },

  vi: {
    title: "Kiểm tra tương tác thuốc", high: "Nghiêm trọng", moderate: "Thận trọng",
    none: "Không tìm thấy tương tác đã biết giữa các thuốc này.",
    note: "Chỉ kiểm tra các tương tác thường gặp. Đừng tự ý ngưng thuốc. Hãy hỏi dược sĩ hoặc bác sĩ.",
    notChecked: "Chưa kiểm tra (không có trong danh sách):",
    msg: {
      breathing: "Dùng {a} cùng {b} có thể làm thở chậm lại hoặc ngừng thở. Đây là sự kết hợp nguy hiểm.",
      drowsy: "{a} và {b} đều gây buồn ngủ. Dùng cùng nhau có thể gây buồn ngủ nặng, té ngã hoặc thở chậm.",
      bleeding: "Dùng {a} cùng {b} làm tăng nguy cơ chảy máu nghiêm trọng.",
      bleeding_warfarin: "{b} có thể làm {a} mạnh hơn nhiều, tăng nguy cơ chảy máu nghiêm trọng.",
      bleeding_mild: "Dùng {a} cùng {b} có thể tăng nguy cơ chảy máu, như chảy máu dạ dày hoặc dễ bầm tím.",
      serotonin: "Dùng {a} cùng {b} có thể gây hội chứng serotonin: kích động, sốt, đổ mồ hôi, tim đập nhanh hoặc co giật cơ.",
      potassium: "Dùng {a} cùng {b} có thể làm kali trong máu tăng đến mức nguy hiểm.",
      nsaid_bp: "{a} có thể làm {b} kém tác dụng và có thể hại thận.",
      lithium: "{b} có thể làm lithi tăng đến mức gây độc. Dấu hiệu gồm run, lú lẫn và nôn.",
      methotrexate: "{b} có thể làm methotrexat tăng đến mức gây độc.",
      statin: "{b} có thể làm tăng nồng độ {a}, tăng nguy cơ đau và tổn thương cơ.",
      tizanidine: "{b} có thể làm {a} tăng đến mức nguy hiểm, gây huyết áp rất thấp và buồn ngủ nặng. Thường không dùng chung.",
      clopidogrel_ppi: "{b} có thể làm {a} kém tác dụng ngừa cục máu đông.",
      heart_rhythm: "{a} và {b} đều có thể ảnh hưởng nhịp tim. Dùng cùng nhau thì nguy cơ cao hơn.",
      low_bp: "Dùng {a} cùng {b} có thể làm huyết áp hạ quá thấp, gây chóng mặt hoặc ngất.",
      acetaminophen: "Một số viên {b} cũng chứa paracetamol (acetaminophen). Dùng cùng {a} có thể bị quá liều paracetamol, gây hại gan.",
      same_drug: "{a} có hơn một lần trong danh sách. Hãy chắc chắn bạn không uống gấp đôi liều.",
      same_type: "{a} và {b} là cùng một loại thuốc. Hãy chắc chắn bác sĩ biết bạn đang dùng cả hai.",
    },
  },

  ko: {
    title: "약물 상호작용 확인", high: "심각", moderate: "주의",
    none: "이 약들 사이에서 알려진 상호작용을 찾지 못했습니다.",
    note: "흔한 상호작용만 확인합니다. 임의로 약을 끊지 마시고 약사나 의사에게 문의하세요.",
    notChecked: "확인하지 못함(목록에 없음):",
    msg: {
      breathing: "{a} · {b} 함께 복용 시 호흡이 느려지거나 멈출 수 있습니다. 위험한 조합입니다.",
      drowsy: "{a} · {b} 모두 졸음을 유발합니다. 함께 복용 시 심한 졸음, 낙상, 호흡 저하가 생길 수 있습니다.",
      bleeding: "{a} · {b} 함께 복용 시 심각한 출혈 위험이 높아집니다.",
      bleeding_warfarin: "{b} 때문에 {a}의 작용이 크게 강해져 심각한 출혈 위험이 높아질 수 있습니다.",
      bleeding_mild: "{a} · {b} 함께 복용 시 위장 출혈이나 멍 같은 출혈 위험이 높아질 수 있습니다.",
      serotonin: "{a} · {b} 함께 복용 시 세로토닌 증후군(초조, 발열, 땀, 빠른 심장 박동, 근육 경련)이 생길 수 있습니다.",
      potassium: "{a} · {b} 함께 복용 시 혈중 칼륨이 위험한 수준까지 오를 수 있습니다.",
      nsaid_bp: "{a} 때문에 {b}의 효과가 떨어지고 신장이 손상될 수 있습니다.",
      lithium: "{b} 때문에 리튬이 독성 수준까지 오를 수 있습니다. 떨림, 혼란, 구토가 징후입니다.",
      methotrexate: "{b} 때문에 메토트렉세이트가 독성 수준까지 오를 수 있습니다.",
      statin: "{b} 때문에 {a}의 농도가 높아져 근육통과 근육 손상 위험이 커질 수 있습니다.",
      tizanidine: "{b} 때문에 {a}의 농도가 위험한 수준까지 올라 혈압이 매우 낮아지고 심한 졸음이 생길 수 있습니다. 보통 함께 복용하지 않습니다.",
      clopidogrel_ppi: "{b} 때문에 {a}의 혈전 예방 효과가 떨어질 수 있습니다.",
      heart_rhythm: "{a} · {b} 모두 심장 박동 리듬에 영향을 줄 수 있습니다. 함께 복용하면 위험이 더 큽니다.",
      low_bp: "{a} · {b} 함께 복용 시 혈압이 너무 낮아져 어지럼증이나 실신이 생길 수 있습니다.",
      acetaminophen: "일부 {b} 알약에는 아세트아미노펜도 들어 있습니다. {a} 복용과 겹치면 아세트아미노펜이 과다해져 간이 손상될 수 있습니다.",
      same_drug: "목록에 같은 약({a})이 두 번 이상 있습니다. 두 배로 복용하고 있지 않은지 확인하세요.",
      same_type: "{a} · {b}: 같은 종류의 약입니다. 두 약을 모두 복용한다는 것을 의사가 알고 있는지 확인하세요.",
    },
  },

  fr: {
    title: "Vérification des interactions", high: "Grave", moderate: "Prudence",
    none: "Aucune interaction connue trouvée entre ces médicaments.",
    note: "Cette vérification ne couvre que les interactions courantes. N’arrêtez aucun médicament de vous-même. Demandez à votre pharmacien ou médecin.",
    notChecked: "Non vérifiés (absents de notre liste) :",
    msg: {
      breathing: "{a} et {b} ensemble peuvent ralentir ou arrêter la respiration. C’est une association grave.",
      drowsy: "{a} et {b} peuvent tous endormir. Ensemble, ils peuvent causer une forte somnolence, des chutes ou une respiration ralentie.",
      bleeding: "{a} et {b} ensemble augmentent le risque de saignement grave.",
      bleeding_warfarin: "{b} peut rendre {a} beaucoup plus fort, ce qui augmente le risque de saignement grave.",
      bleeding_mild: "{a} et {b} ensemble peuvent augmenter le risque de saignement, comme un saignement de l’estomac ou des bleus.",
      serotonin: "{a} et {b} ensemble peuvent provoquer un syndrome sérotoninergique : agitation, fièvre, sueurs, cœur rapide ou contractions musculaires.",
      potassium: "{a} et {b} ensemble peuvent faire monter le potassium dans le sang à un niveau dangereux.",
      nsaid_bp: "{a} peut rendre {b} moins efficace et peut abîmer les reins.",
      lithium: "{b} peut faire monter le lithium à un niveau toxique. Signes : tremblements, confusion et vomissements.",
      methotrexate: "{b} peut faire monter le méthotrexate à un niveau toxique.",
      statin: "{b} peut augmenter le taux de {a}, ce qui augmente le risque de douleurs et de lésions musculaires.",
      tizanidine: "{b} peut faire monter {a} à un niveau dangereux, avec une tension très basse et une forte somnolence. Ils ne sont normalement pas pris ensemble.",
      clopidogrel_ppi: "{b} peut rendre {a} moins efficace pour prévenir les caillots.",
      heart_rhythm: "{a} et {b} peuvent chacun modifier le rythme du cœur. Ensemble, le risque est plus élevé.",
      low_bp: "{a} et {b} ensemble peuvent trop baisser la tension et causer des vertiges ou un évanouissement.",
      acetaminophen: "Certains comprimés de {b} contiennent aussi du paracétamol. Les prendre avec {a} peut faire trop de paracétamol, ce qui peut abîmer le foie.",
      same_drug: "{a} figure plusieurs fois dans votre liste. Vérifiez que vous ne prenez pas une double dose.",
      same_type: "{a} et {b} sont le même type de médicament. Assurez-vous que votre médecin sait que vous prenez les deux.",
    },
  },

  pt: {
    title: "Verificação de interações", high: "Grave", moderate: "Cuidado",
    none: "Nenhuma interação conhecida encontrada entre estes remédios.",
    note: "Esta verificação cobre apenas interações comuns. Não pare nenhum remédio por conta própria. Pergunte ao seu farmacêutico ou médico.",
    notChecked: "Não verificados (fora da nossa lista):",
    msg: {
      breathing: "{a} e {b} juntos podem deixar a respiração lenta ou fazê-la parar. É uma combinação grave.",
      drowsy: "{a} e {b} podem causar sono. Juntos podem causar sonolência forte, quedas ou respiração lenta.",
      bleeding: "{a} e {b} juntos aumentam o risco de sangramento grave.",
      bleeding_warfarin: "{b} pode deixar {a} muito mais forte, o que aumenta o risco de sangramento grave.",
      bleeding_mild: "{a} e {b} juntos podem aumentar o risco de sangramento, como sangramento no estômago ou manchas roxas.",
      serotonin: "{a} e {b} juntos podem causar síndrome serotoninérgica: agitação, febre, suor, coração acelerado ou tremores musculares.",
      potassium: "{a} e {b} juntos podem elevar o potássio no sangue a níveis perigosos.",
      nsaid_bp: "{a} pode fazer {b} funcionar pior e pode prejudicar os rins.",
      lithium: "{b} pode elevar o lítio a níveis tóxicos. Os sinais incluem tremores, confusão e vômitos.",
      methotrexate: "{b} pode elevar o metotrexato a níveis tóxicos.",
      statin: "{b} pode aumentar o nível de {a}, o que aumenta o risco de dor e lesão muscular.",
      tizanidine: "{b} pode elevar {a} a níveis perigosos, causando pressão muito baixa e sonolência extrema. Normalmente não são tomados juntos.",
      clopidogrel_ppi: "{b} pode fazer {a} funcionar pior na prevenção de coágulos.",
      heart_rhythm: "{a} e {b} podem afetar o ritmo do coração. Juntos, o risco é maior.",
      low_bp: "{a} e {b} juntos podem baixar demais a pressão e causar tontura ou desmaio.",
      acetaminophen: "Alguns comprimidos de {b} também contêm paracetamol. Tomá-los com {a} pode dar paracetamol demais, o que pode prejudicar o fígado.",
      same_drug: "{a} aparece mais de uma vez na sua lista. Confira se não está tomando dose dupla.",
      same_type: "{a} e {b} são o mesmo tipo de remédio. Garanta que seu médico saiba que você toma os dois.",
    },
  },

  ru: {
    title: "Проверка взаимодействий", high: "Серьёзно", moderate: "Осторожно",
    none: "Известных взаимодействий между этими лекарствами не найдено.",
    note: "Проверяются только частые взаимодействия. Не прекращайте приём лекарств самостоятельно. Спросите фармацевта или врача.",
    notChecked: "Не проверены (нет в нашем списке):",
    msg: {
      breathing: "{a} и {b} вместе могут замедлить или остановить дыхание. Это опасное сочетание.",
      drowsy: "{a} и {b} вызывают сонливость. Вместе они могут вызвать сильную сонливость, падения или замедленное дыхание.",
      bleeding: "{a} и {b} вместе повышают риск серьёзного кровотечения.",
      bleeding_warfarin: "{b} может сильно усилить действие препарата {a}, что повышает риск серьёзного кровотечения.",
      bleeding_mild: "{a} и {b} вместе могут повысить риск кровотечения, например желудочного, или появления синяков.",
      serotonin: "{a} и {b} вместе могут вызвать серотониновый синдром: возбуждение, жар, потливость, учащённое сердцебиение или подёргивания мышц.",
      potassium: "{a} и {b} вместе могут поднять уровень калия в крови до опасного.",
      nsaid_bp: "{a} может ослабить действие препарата {b} и навредить почкам.",
      lithium: "{b} может поднять уровень лития до токсичного. Признаки: дрожь, спутанность сознания и рвота.",
      methotrexate: "{b} может поднять уровень метотрексата до токсичного.",
      statin: "{b} может повысить уровень препарата {a}, что увеличивает риск боли и повреждения мышц.",
      tizanidine: "{b} может поднять уровень препарата {a} до опасного, вызывая очень низкое давление и сильную сонливость. Обычно их не принимают вместе.",
      clopidogrel_ppi: "{b} может ослабить защиту препарата {a} от тромбов.",
      heart_rhythm: "{a} и {b} могут влиять на ритм сердца. Вместе риск выше.",
      low_bp: "{a} и {b} вместе могут слишком сильно снизить давление и вызвать головокружение или обморок.",
      acetaminophen: "Некоторые таблетки {b} тоже содержат парацетамол. Вместе с препаратом {a} это может быть слишком много парацетамола, что вредно для печени.",
      same_drug: "{a} есть в вашем списке больше одного раза. Убедитесь, что вы не принимаете двойную дозу.",
      same_type: "{a} и {b} — лекарства одного типа. Убедитесь, что врач знает, что вы принимаете оба.",
    },
  },

  tl: {
    title: "Pagsusuri ng interaksyon ng gamot", high: "Seryoso", moderate: "Mag-ingat",
    none: "Walang nakitang kilalang interaksyon sa pagitan ng mga gamot na ito.",
    note: "Karaniwang interaksyon lamang ang sinusuri nito. Huwag ihinto ang anumang gamot nang mag-isa. Magtanong sa iyong parmasyutiko o doktor.",
    notChecked: "Hindi nasuri (wala sa aming listahan):",
    msg: {
      breathing: "Ang {a} at {b} nang magkasama ay maaaring magpabagal o magpahinto ng paghinga. Mapanganib ang kombinasyong ito.",
      drowsy: "Nakakaantok ang {a} at {b}. Kapag pinagsabay, maaaring magdulot ng matinding antok, pagkahulog, o mabagal na paghinga.",
      bleeding: "Ang {a} at {b} nang magkasama ay nagpapataas ng panganib ng malubhang pagdurugo.",
      bleeding_warfarin: "Maaaring palakasin nang husto ng {b} ang epekto ng {a}, kaya tumataas ang panganib ng malubhang pagdurugo.",
      bleeding_mild: "Ang {a} at {b} nang magkasama ay maaaring magpataas ng panganib ng pagdurugo, gaya ng pagdurugo sa sikmura o madaling pagpapasa.",
      serotonin: "Ang {a} at {b} nang magkasama ay maaaring magdulot ng serotonin syndrome: pagkabalisa, lagnat, pagpapawis, mabilis na tibok ng puso, o pagkibot ng kalamnan.",
      potassium: "Ang {a} at {b} nang magkasama ay maaaring magpataas ng potassium sa dugo sa mapanganib na antas.",
      nsaid_bp: "Maaaring pahinain ng {a} ang bisa ng {b} at makasama sa bato.",
      lithium: "Maaaring itaas ng {b} ang lithium sa nakalalasong antas. Kasama sa mga senyales ang panginginig, pagkalito, at pagsusuka.",
      methotrexate: "Maaaring itaas ng {b} ang methotrexate sa nakalalasong antas.",
      statin: "Maaaring itaas ng {b} ang antas ng {a}, kaya tumataas ang panganib ng pananakit at pinsala sa kalamnan.",
      tizanidine: "Maaaring itaas ng {b} ang {a} sa mapanganib na antas, na nagdudulot ng napakababang presyon ng dugo at matinding antok. Karaniwang hindi ito pinagsasabay.",
      clopidogrel_ppi: "Maaaring pahinain ng {b} ang bisa ng {a} sa pagpigil ng pamumuo ng dugo.",
      heart_rhythm: "Maaaring makaapekto sa ritmo ng puso ang {a} at {b}. Mas mataas ang panganib kapag pinagsabay.",
      low_bp: "Ang {a} at {b} nang magkasama ay maaaring magpababa nang sobra ng presyon ng dugo at magdulot ng hilo o pagkahimatay.",
      acetaminophen: "May ilang tableta ng {b} na may acetaminophen din. Kapag isinabay sa {a}, maaaring sumobra ang acetaminophen, na makasisira sa atay.",
      same_drug: "Higit sa isang beses nasa listahan mo ang {a}. Siguraduhing hindi ka umiinom ng dobleng dosis.",
      same_type: "Magkaparehong uri ng gamot ang {a} at {b}. Siguraduhing alam ng doktor mo na iniinom mo ang dalawa.",
    },
  },
};

if (typeof module !== "undefined") {
  module.exports = { checkInteractions, interactionText, INTERACTION_TEXT, PAIR_RULES };
}
