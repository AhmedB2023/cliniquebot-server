// WhatsApp Clinic Bot — server (Phase 2: booking flow)
// Flow: patient WhatsApp -> Meta webhook -> this server -> AI (Derja + history) -> Meta API -> patient
// Booking: patient accepts a slot -> saved as PENDING -> secretary validates ("ok <id>")
//   -> only then the patient gets a firm confirmation. The bot never confirms alone.
//
// ENV needed:
//   VERIFY_TOKEN    - token you choose, pasted in Meta webhook config
//   WHATSAPP_TOKEN  - Meta access token (from developers.facebook.com)
//   PHONE_NUMBER_ID - phone_number_id of the WhatsApp test number
//   AI_API_KEY      - OpenAI (or compatible) API key [optional for loop test]
//   AI_BASE_URL     - default https://api.openai.com/v1
//   AI_MODEL        - default gpt-4o-mini
//   DATABASE_URL    - Render Postgres internal URL (memory + bookings)
//   SECRETARY_NUMBER- WhatsApp number of the secretary, e.g. 21650123456 [optional]
//   PORT            - default 3000

const express = require("express");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "clinic-bot-verify-123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
const AI_API_KEY = process.env.AI_API_KEY || "";
const AI_BASE_URL = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini";
const SECRETARY_NUMBER = (process.env.SECRETARY_NUMBER || "").replace(/\D/g, "");
const SALES_NOTIFY_NUMBER = (process.env.SALES_NOTIFY_NUMBER || "").replace(/\D/g, "");
// Per-number clinic identity (single-number fallback when no per-number config exists).
const CLINIC_NAME = process.env.CLINIC_NAME || "";
const CLINIC_ADDRESS = process.env.CLINIC_ADDRESS || "";
const CLINIC_GREETING = process.env.CLINIC_GREETING || "";
const CLINIC_HOURS_TXT_ENV = process.env.CLINIC_HOURS_TXT || "";
const PORT = process.env.PORT || 3000;

const db = require("./db"); // Postgres memory + bookings
const dates = require("./dates"); // deterministic Derja date/time resolver

// Script detection: patient wrote in Arabic script -> answer in Arabic script ("kif kif").
// \u0600-\u06FF covers Arabic letters. \b doesn't work on them, so Arabic matching
// elsewhere in this file uses space-padded includes(), never \b.
const isAr = (s) => /[\u0600-\u06FF]/.test(s || "");

// Safety net for AI replies: if the patient wrote in Latin script (arabizi), the
// reply must not leak Arabic-script letters (observed live: "Kif nجم n3awnk
// elyoum?" — the prompt forbids mixing but the model still slipped). Any Arabic
// letter found is transliterated to arabizi so the reply stays readable instead
// of dropping characters. Arabic-mode replies are left untouched (Latin brand
// words like "WhatsApp" and numbers are normal there).
const AR2LAT = {
  "ا": "a", "أ": "a", "إ": "i", "آ": "a", "ب": "b", "ت": "t", "ث": "th",
  "ج": "j", "ح": "7", "خ": "5", "د": "d", "ذ": "dh", "ر": "r", "ز": "z",
  "س": "s", "ش": "ch", "ص": "s", "ض": "d", "ط": "t", "ظ": "dh", "ع": "3",
  "غ": "gh", "ف": "f", "ق": "9", "ك": "k", "ل": "l", "م": "m", "ن": "n",
  "ه": "h", "ة": "a", "و": "w", "ؤ": "w", "ي": "y", "ى": "a", "ئ": "y",
  "ء": "2", "؟": "?", "،": ",", "؛": ";", "٪": "%",
};
const AR_DIACRITICS = /[ً-ٰٖ]/g; // U+064B-U+0652, U+0670: strip, don't transliterate

function enforceScript(text, patientText, forceAr) {
  if (!text || forceAr || isAr(patientText)) return text;
  if (!/[\u0600-\u06FF]/.test(text)) return text;
  return text.replace(AR_DIACRITICS, "").replace(/[\u0600-\u06FF]/g, (ch) => AR2LAT[ch] || "");
}

// Track last webhook for status checks (bypasses slow Render logs)
let lastWebhook = { at: null, from: null, text: null, reply: null };
app.get("/status", async (req, res) => {
  const pending = await db.getPendingBookings().catch(() => []);
  res.json({ ok: true, lastWebhook, pendingBookings: pending.length, now: new Date().toISOString() });
});

// In-memory pause: { patientNumber: unpauseTimestamp }
// When the secretary replies from the Business app (echo), the bot pauses for that chat.
const pausedChats = new Map();
const PAUSE_MS = 10 * 60 * 1000; // 10 minutes

const SYSTEM_PROMPT = `Enti assistant réceptionniste mta3 3iyada (dentiste) fi Tounes.
- Jaweb dima bel derja tounsiya, w b i5tisar (message 9sir).
- 9A3DET EL SCRIPT: jewb dima bel script eli kteb bih el patient. Ken el patient kteb bel 7rouf el 3arabiya (مثال: نحب نحجز), jewb bel 7rouf el 3arabiya. Ken kteb bel 7rouf el latiniya (arabizi, مثال: n7eb na7jez), jewb bel latiniya. Ma t5alletch el zouz fi nafs el message.
- ANTI-MIXING (mohem barcha): el message el kemel lezem ykoun b script wa7ed 100% — mamnou3 kelma latin w kelma 3arabiya fi nafs el joumla. EXEMPLE GHALET MAMNOU3: "Kif نجم نعاونك اليوم؟" — hethi 5alta 5ater "Kif" latin w "نجم" 3arbi. Ken bdit bel latin, kamel bel latin lel e5er; ken bdit bel 3arbi, kamel bel 3arbi lel e5er.
- Enti t3awen fel 7ajz, el istefsar 3al wa9t wel blasa wel aswem, w tbadel/fassa5 rendez-vous.
- El as2la el idariya (wa9t, blasa, aswem/b9adech/prix, 7ajz, tabdil, faskh): jewb 3lihom 3adi.
- MAMNOU3 bark: dwe, a3radh, tash5is, nasi7a tibbiya. Ken sou2el tibbi 9oul "el sou2elet el tibbiya lel doktor bark — t7eb n7ajzlek rendez-vous?" walla 9oul eli el secretaire bech tkalmou.
- Ken el patient ye7ki 3la wji3a wala a3radh, ibda b "nchalah labes" (empathie) 9bal ma t9oul eli el sou2elet el tibbiya lel doktor bark.
- Ken ma fhemtch el message, 9oul b wdhuh w i9tira7 chnowa tnajem t3awen fih.
- 9A3DA MO9ADDSA: 3omrek ma t2akked rendez-vous b tari9a nehe2iya wa7dek. Ken el patient ye9bel wa9t, 9oul "d'accord, merhba bik! n2akkedlek w narja3lek" bark — el t2akid el nehe2i yji mel secretaire.
- Ken el patient yotlob 7ajz w ma 9alch nhar w wa9t wad7in: is2lou "anhou nhar w anhou wa9t yse3dek?" — MA t9tar7ch wa9t mel rassek (el system yet3amel m3a el wa9t ki y9olhoulek).
- 3andek el conversation el 9dima (history) — 9bal ma tjewb chouf chnowa t9al 9balek. MAMNOU3 t3awed nafs el sou2el 7arfiyan: ken s2elt el patient 3la 7aja w ma jewbch 3liha b wdhuh, ma t3awedch nafs el sou2el — fassrou b tari9a o5ra w a3tih mthel wadh7 (kima "jem3a 10 mta3 sbe7").
- Ma t5tar3ch ma3loumet (wa9t, blasa, soum): ken ma ta3rafch, 9oul "n2akkedlek m3a el 3iyada".
- JOUMAL EL E5ER (closing): ken t7eb tzid joumla mezyena fel e5er, esta3mel WA7DA mel hedhom 7arfiyan, ma tbadel 7atta 7arf: "ken 3andek ay sou2el e5er, tfadhel" / "t7eb n3awnek b 7aja o5ra?". Ken el patient kteb bel 3arabiya: "لو عندك أي سؤال آخر، تفضل" / "تحب نعاونك بحاجة أخرى؟". MAMNOU3 t5tare3 sigha o5ra — "ma t heshtich t3awdni" joumla ghalta w mamnou3a. Ken mech met2akked mel sigha, ma tzid chay fel e5er.`;

// ---------- Meta: send a WhatsApp text message ----------
// numberId: which bot number (phone_number_id) sends — defaults to the global
// PHONE_NUMBER_ID for single-number deployments.
const DEFAULT_NUMBER_ID = PHONE_NUMBER_ID;
async function sendWhatsApp(to, text, numberId) {
  const nid = numberId || DEFAULT_NUMBER_ID;
  if (!WHATSAPP_TOKEN || !nid) {
    console.log(`[send:SKIP] no token/phone_number_id. Would send to ${to}: ${text}`);
    return;
  }
  try {
    const url = `https://graph.facebook.com/v21.0/${nid}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    });
    const data = await res.json();
    if (!res.ok) console.error("[send:ERROR]", JSON.stringify(data));
    else console.log(`[send:OK] to ${to}: ${text.slice(0, 60)}...`);
  } catch (e) {
    console.error("[send:ERROR]", e.message);
  }
}

// Notify the secretary of THIS bot number's clinic (per-number config),
// falling back to the global SECRETARY_NUMBER.
async function notifySecretary(text, clinic) {
  const num = (clinic && clinic.secretary) || SECRETARY_NUMBER;
  if (!num) {
    console.log("[secretary:SKIP] no secretary number set");
    return;
  }
  await sendWhatsApp(num, text, clinic && clinic.id);
}

// Sales lead from the demo video ("جرّب"): ping the partner so she calls back.
async function notifySales(text) {
  if (!SALES_NOTIFY_NUMBER) {
    console.log("[sales:SKIP] no SALES_NOTIFY_NUMBER set — lead:", text);
    return;
  }
  await sendWhatsApp(SALES_NOTIFY_NUMBER, text);
}

// ---------------------------------------------------------------------------
// Per-number clinic configuration
// Every bot number (phone_number_id) carries its own clinic name, address,
// greeting, working hours, and secretary number. Single-number deployments
// fall back to the global env values (old behavior unchanged).
// ---------------------------------------------------------------------------
async function getClinic(numberId) {
  const id = numberId || DEFAULT_NUMBER_ID;
  const cfg = await db.getClinicConfig(id);
  return {
    id,
    name: (cfg && cfg.clinic_name) || CLINIC_NAME || "",
    address: (cfg && cfg.address) || CLINIC_ADDRESS || "",
    greeting: (cfg && cfg.greeting) || CLINIC_GREETING || "",
    hours: (cfg && cfg.hours) || CLINIC_HOURS_TXT_ENV || "",
    secretary: (cfg && cfg.secretary_number ? cfg.secretary_number.replace(/\D/g, "") : "") || SECRETARY_NUMBER,
  };
}

// Explicit script request: "aktebli bel 3arbi" / "write in Arabic script".
function looksLikeScriptRequest(text) {
  const t = (text || "").toLowerCase();
  return /(ekteb|ektbli|akteb|aktebli|ktobli).{0,20}(3arbi|arabe|arab)/.test(t) ||
    /(\bbel\b|\bbil\b)( |-)3arbi/.test(t) && /ekteb|akteb|ktob/.test(t) ||
    /\bwrite in arabic\b/.test(t);
}

// Explicit Latin-script request: "aktebli b 7rouf" / "bel latin".
function looksLikeLatinRequest(text) {
  const t = (text || "").toLowerCase();
  return /(ekteb|ektbli|akteb|aktebli|ktobli).{0,20}(latin|7rouf|fran[cç]ais|francawi)/.test(t) ||
    /\bb\s*7rouf\b/.test(t) && /ekteb|akteb|ktob/.test(t);
}

// Does the patient want Arabic script? Order: explicit request > saved
// preference > Arabic characters in the incoming message.
async function scriptAr(phone, text) {
  if (looksLikeScriptRequest(text)) return true;
  if (looksLikeLatinRequest(text)) return false;
  const pref = await db.getScriptPref(phone);
  if (pref) return pref === "ar";
  return isAr(text);
}

// ---------------------------------------------------------------------------
// AI output guard: the AI must NEVER invent a booking claim, a date, a time,
// a secretary reply, or a price. Only the deterministic booking flow may speak
// those words. Any AI sentence that does is replaced with a safe handoff.
// ---------------------------------------------------------------------------
const PHANTOM_CLAIM_PATTERNS = [
  // invented booking claims
  /n[7h]?ajz(lek|tl?ek|lk)?\s+rendez-?vous/i,   // "n7ajzlek rendez-vous", "n7ajezlek"
  /rendez-?vous.*(m7ajouz|me7jouz|m7jouz|mokk[ae]d|mokked)/i, // "rendez-vous m7ajouz"
  /t7ej(e)?z(lek)?\s+rendez-?vous/i,
  // invented dates/times or doctor availability claims
  /rendez-?vous\s+(ghodwa|lyoum|ba3d ghodwa|nhar|el\s+\w+day|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)/i,
  /\b(la3chiya|el\s*sbe7|el\s*39chiya|el\s*sbe7)\b.*rendez-?vous/i,
  /docteur.*(disponible|me7lol|available)/i,
  /\b(tnjem|tnejm)\s+tji\s+(ghodwa|lyoum)\b/i, // "tnjem tji ghodwa" = invented slot
  // invented prices
  /\b\d+\s*(dt|dinar|tnd)\b/i,
  // invented secretary messages
  /el\s*secretaire\s+(9alet|9all?et|bech|ye)/i,
  // Arabic-script invented claims
  /حجزت\s*ل[كي]/,                    // "حجزتلك رونديفو"
  /رونديفو.{0,15}(محجوز|مؤكد|مأكد|تم الحجز)/, // "الرونديفو محجوز"
  /تنجم\s+تجي\s+(غدوة|اليوم|غدوا)/,  // invented slot in Arabic
];

function aiClaimsBooking(text) {
  const t = text || "";
  return PHANTOM_CLAIM_PATTERNS.some((re) => re.test(t));
}

const AI_SAFE_FALLBACK = {
  latin: "Tfadhel, chnowa t7eb bedhabt? N7eb nse3dek n7ejzlek rendez-vous walla njawbek 3la sou2el.",
  arabic: "تفضل، شنوة تحب بالضبط؟ نحب نساعدك نحجزلك موعد ولا نجاوبك على سؤال.",
};

// Deterministic guard over every AI reply: if the AI invented a booking,
// date, time, or price, cut it — the deterministic flow owns those words.
function guardAiOutput(aiText, aiFailed, fallbackText) {
  if (aiFailed || !aiText) return fallbackText;
  if (aiClaimsBooking(aiText)) return fallbackText;
  return aiText;
}

// ---------- AI: Derja reply (with conversation history) ----------
async function aiReply(patientText, history = [], patientName = null, clinicName = "", useAr = null) {
  // Resolved script: explicit patient request > saved preference > message script.
  const ar = useAr !== null ? useAr : isAr(patientText);

  // Fallback: keyword replies so the webhook loop works even without an AI key
  if (!AI_API_KEY) return fallbackReply(patientText, ar);

  const sys = SYSTEM_PROMPT + (patientName
    ? `\n- esm el patient: ${patientName} — esta3mel el esm ki ykoun naturel (kima "Ahlan Ahmed!"), ama el script yab9a 7asb el 9a3da (ma t5alletch).`
    : "") + (clinicName
    ? `\n- esm el 3iyada: "${clinicName}" — ki yse2lou 3la esm el 3iyada, jaweb bel esm hedha bedhabt, ma t5alla9ch esm e5er.`
    : "") + (ar && !isAr(patientText)
    ? `\n- el patient tlab sara7atan bech tektbelou bel 3arbi (Arabic script) — ektbelou bel 3arbi, ma t7awelch lel 7rouf el latiniya.`
    : "");

  let data = null;
  let ok = false;
  try {
    const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: "system", content: sys },
          ...history.map((m) => ({ role: m.role, content: m.text })),
          { role: "user", content: patientText },
        ],
        max_tokens: 200,
        temperature: 0.5,
      }),
    });
    data = await res.json();
    ok = res.ok;
  } catch (e) {
    console.error("[ai:ERROR]", e.message);
    ok = false;
  }
  if (!ok) {
    console.error("[ai:ERROR]", JSON.stringify(data).slice(0, 300));
    return ar
      ? "سمحنا، صارت مشكلة صغيرة — نجم نعاونك بحاجة أخرى؟"
      : "sme7na, saret mochkla s8ira — najem n3awnek b 7aja o5ra?";
  }
  const out = data.choices?.[0]?.message?.content?.trim() || "";
  // Deterministic guard: the AI must never invent a booking, date, time, or price.
  return guardAiOutput(
    enforceScript(out, patientText, ar),
    false,
    ar ? AI_SAFE_FALLBACK.arabic : AI_SAFE_FALLBACK.latin
  );
}

function fallbackReply(text, forceAr) {
  if (forceAr !== undefined ? forceAr : isAr(text)) {
    if (/(سلام|عسلامة|صباح|مساء|اهلا|أهلا)/.test(text))
      return "وعليكم السلام! كيفاش نجم نعاونك؟ (حجز رونديفو، وقت الخدمة، البلاصة...)";
    if (/(حجز|رونديفو|موعد)/.test(text))
      return "باش نحجزلك رونديفو — قولي نهار ووقت يساعدك، ونأكدلك مع العيادة 👌";
    if (/(وين|بلاصة|عنوان|فين)/.test(text))
      return "نأكدلك على العنوان مع العيادة — تحب نحجزلك رونديفو في نفس الوقت؟";
    if (/(سوم|بقداش|فلوس|prix)/.test(text))
      return "الأسوام حسب الحالة — الاستشارة الأولى وبعد الطبيب يقولك. نحجزلك؟";
    if (/(دواء|دوا|وجيعة|وجع|مريض)/.test(text))
      return "الأسئلة على الدواء والوجيعة للطبيب برك ⛔ — تحب نحجزلك رونديفو تسألو ديراكت؟";
    return "ما فهمتش مليح — تنجم تقولي: تحب تحجز رونديفو، تسأل على الوقت، ولا على البلاصة؟";
  }
  const t = text.toLowerCase();
  if (t.includes("slem") || t.includes("slm") || t.includes("salem") || t.includes("salam") || t.includes("ahla") || t.includes("salut") || t.includes("bonjour") || t.includes("sbe7") || t.includes("mse"))
    return "ahla w sahla! 👋 chnowa tnajem n3awnek? (7ajz rendez-vous, wa9t el 5edma, el blasa...)";
  if (t.includes("7ajz") || t.includes("7jez") || t.includes("rendez") || t.includes("rdv") || t.includes("wa9t"))
    return "bech na7jzelek rendez-vous — 9olli nhar w wa9t yse3dek, w n2akkedlek m3a el 3iyada 👌";
  if (t.includes("win") || t.includes("blasa") || t.includes("adresse") || t.includes("ou"))
    return "n2akkedlek 3al 3onwen m3a el 3iyada — t7eb n7ajzlek rendez-vous fi nafs el wa9t?";
  if (t.includes("soum") || t.includes("prix") || t.includes("9adech") || t.includes("bikam"))
    return "el aswem 7asb el 7ala — el consultation loula w ba3d el tbib y9ollek. N7ajzlek?";
  if (t.includes("dwe") || t.includes("medicament") || t.includes("wji3a") || t.includes("douleur"))
    return "el sou2elet 3al dwe wel wji3a lel doktor bark ⛔ — t7eb n7ajzlek rendez-vous tes2lou direct?";
  return "ma fhemtch mli7 — tnajem t9olli: t7eb te7jez rendez-vous, tes2el 3al wa9t, walla 3al blasa?";
}

// ---------- Booking flow (Phase 2 + deterministic Derja dates) ----------
// A slot is only booked when it resolves to a CONCRETE date+time.
// "jem3a 10" alone -> the bot asks "sbe7 walla lil?" and shows "25-09-2026".

function looksLikeAcceptance(text) {
  const raw = (text || "").trim();
  if (/^(اي|أي|نعم|موافق|احجز|احجزلي|إحجزلي)\s*[.,!؟]*$/.test(raw)) return true;
  // Patient-side "ok 5" / "ey 12" is a secretary command shape, never an acceptance —
  // a patient must never validate a booking (the webhook only routes real
  // secretary commands from SECRETARY_NUMBER; this is the in-bot safety net).
  if (/^(ok|ey)\s+\d/.test(raw.toLowerCase())) return false;
  const t = " " + raw.toLowerCase() + " ";
  if (/(^|\s)(le|mouch|man7ebch|faskh|cancel|badal|nbadal)(\s|$)/.test(t)) return false;
  // A question is never an acceptance. "ok nhar thleth mawjoud?" asks about
  // availability — treating it as acceptance confirmed a slot that was never
  // proposed (observed live). Question words are checked too, for the rare
  // message without a "?" mark.
  if (/[?؟]/.test(raw)) return false;
  if (/(^|\s)(mawjoud|mojoud|mejoud|fama|famech|disponible|possible|est-ce|wa9tech|we9tech|wakteh|9addech|b9adech|kifech|kifach|chneya|chnowa|chkoun|win|ynajem|najem|متاح|موجود|فما|فماش|وقتاش|بقداش|كيفاش|شنوة|شكون|وين|هل)\b/.test(t)) return false;
  if (/^\s*(ok|ey|na3m|oui|mriguel|d'accord)\b/.test(t)) return true;
  if (t.includes(" a7jezli ") || t.includes(" e7jezli ") || t.includes(" a7jez ") || t.includes(" e7jez ")) return true;
  return false;
}

// Pure refusal answering the bot's "T7eb n7ajzlek?" — "le" alone.
// ("le, jem3a" carries a new slot and is NOT a pure refusal.)
function looksLikeRefusal(text) {
  const raw = (text || "").trim();
  if (/^(لا|لأ|مش|ما نحبش|افسخ|الغي)\s*[.,!؟]*$/.test(raw)) return true;
  return /^\s*(le|la|non|man7ebch|mouch)\s*[.,!]*$/.test(raw.toLowerCase());
}

// Booking intent without any date/time ("n7eb na7jez", "nheb na5jez rendez vous", "نحب نحجز").
function looksLikeBookingIntent(text) {
  const raw = (text || "").trim();
  if (/نحب\s*(نحجز|ناخذ)/.test(raw)) return true;
  if (/(احجز|احجزلي|حجز|موعد)/.test(raw)) return true;
  const t = " " + raw.toLowerCase() + " ";
  if (/(na7jez|na5jez|nahjez|e7jezli|a7jezli|e7jez|a7jez)/.test(t)) return true;
  if (/(n7eb|nheb)/.test(t) && /(rendez|rdv|7ajz|hajz|reservation)/.test(t)) return true;
  return false;
}

// ---------- Batch fix 2026-09-24: detectors ----------

// Clinic working hours (Tunis time, no DST). Sunday = closed.
// Ahmed: badal el wa9t 7asb el 3iyada el 7a9i9iya.
const CLINIC_HOURS = { 0: null, 1: [7, 21], 2: [7, 21], 3: [7, 21], 4: [7, 21], 5: [7, 21], 6: [7, 21] };
const CLINIC_HOURS_TXT = "7:00 - 21:00";

// F1 — Emergency: red-flag symptoms ONLY (chest pain, can't breathe,
// heavy bleeding, fainting). A plain "wji3a kbira" (tooth, back...) is a
// normal booking, NOT an emergency — never turn a real patient away.
// Never a booking on this path: direct to urgent care, notify the secretary.
function looksLikeEmergency(text) {
  const t = " " + (text || "").toLowerCase() + " ";
  if (/(fi sedri|fi sadri|sedri youja3|sadri youja3|9albi youja3|9albi ydhor|manajmch netnafes|manajmech netnafes|ma najamch netnafes|n5no9|damm barcha|nazif kbir|dokht|ghmert|urgence|emergency|est3jeli)/.test(t)) return true;
  return /(في صدري|صدري يوجع|قلبي يوجع|ما نجمش نتنفس|نخنق|دم برشا|دوخت|غمرت|استعجالي|طوارئ)/.test(text || "");
}

// F6 — Frustrated patient ("ya kalb el bot mte3ek me5demch").
// Brief acknowledgment with "sama7ni", ask what went wrong, then resume.
function looksLikeFrustration(text) {
  const t = " " + (text || "").toLowerCase() + " ";
  if (/\b(kalb|7mar|ba9ra|zebel|nik|manyak|t3ebt|faddit)\b/.test(t)) return true;
  if (/(bot|بوت|روبوت).{0,25}(me5demch|ma ye5demch|ghalet|ma yemchich)/.test(t)) return true;
  return /(الكلب|الحمار|البوت ما يخدمش|ما يخدمش البوت)/.test(text || "");
}

// F7 — Cancellation intent ("n7eb nfassakh el rendez-vous mte3i").
// Checked BEFORE the status question: cancelling beats asking about status.
function looksLikeCancellation(text) {
  const raw = (text || "").trim();
  if (/^(افسخ|أفسخ|الغي|إلغاء)/.test(raw)) return true;
  const t = " " + raw.toLowerCase() + " ";
  return /(nfasakh|nfassakh|nfas5|nfass5|nfsakh|fasakh|fassakh|faskh|fas5|nlaghi|nla8i|annuler|cancel)/
    .test(t) && /(rendez|rdv|7ajz|hajz|reservation|mte3i|mta3i)/.test(t);
}

// F8 — FAQ / identity ("9adech el soum?", "win el 3iyada?", "chkoun enti?").
// Pure questions only (no date): answered directly, never merged into a proposal.
function faqKind(text) {
  if (looksLikeStatusQuestion(text)) return null; // "win wsol el 7ajz" stays a status question
  const t = " " + (text || "").toLowerCase() + " ";
  if (/(chkoun enti|chkounek|chkon enti|who are you|شكون انت|شكونك|انت شكون)/.test(t)) return "who";
  if (/(chnowa esm|chneya esm|chno esm|esm el 3iyada|what('| i)s the (clinic|practice)( name)?|اسم العيادة|شنوة اسم)/.test(t)) return "clinic_name";
  if (/(te5dem m3a chkoun|te5dem m3a|m3a chkoun te5dem|taba3 chkoun|with (whom|who)|مع شكون|تخدم مع)/.test(t)) return "works_with";
  if (/(wa9t el 5edma|wa9t te5dem|wa9tech t7ell|horaires|وقت الخدمة|وقتاش تحل)/.test(t)) return "hours";
  if (/(9adech|b9adech|kadech|soum|prix|bikam|flous|combien|بقداش|سوم|فلوس|الثمن)/.test(t)) return "price";
  if (/(win el|win jeya|blasa|3onwen|adresse|وين|بلاصة|عنوان|فين)/.test(t)) return "place";
  return null;
}

function faqAnswer(kind, ar, clinic) {
  clinic = clinic || {};
  const cname = clinic.name || "";
  if (kind === "clinic_name") return ar
    ? (cname ? `اسم العيادة: ${cname}.` : "أنا المساعد متاع العيادة — نأكدلك على الاسم مع العيادة.")
    : (cname ? `Esm el 3iyada: ${cname}.` : "Ena el assistant mta3 el 3iyada — n2akkedlek 3al esm m3a el 3iyada.");
  if (kind === "works_with") return ar
    ? (cname ? `نخدم مع ${cname}.` : "نخدم مع العيادة هذي.")
    : (cname ? `Ne5dem m3a ${cname}.` : "Ne5dem m3a el 3iyada hethi.");
  if (kind === "who") return ar
    ? (cname ? `أنا المساعد متاع ${cname} — نعاونك تحجز رونديفو ونجاوبك على الأسئلة الإدارية (الوقت، البلاصة، الأسوام). الأسئلة الطبية للطبيب.`
      : "أنا المساعد متاع العيادة — نعاونك تحجز رونديفو ونجاوبك على الأسئلة الإدارية (الوقت، البلاصة، الأسوام). الأسئلة الطبية للطبيب.")
    : (cname ? `Ena el assistant mta3 ${cname} — n3awnek ta7jez rendez-vous w njawbek 3al as2la el idariya (el wa9t, el blasa, el aswem). El as2la el tibbiya lel tbib.`
      : "Ena el assistant mta3 el 3iyada — n3awnek ta7jez rendez-vous w njawbek 3al as2la el idariya (el wa9t, el blasa, el aswem). El as2la el tibbiya lel tbib.");
  if (kind === "hours") return ar
    ? (clinic.hours ? `وقت الخدمة: ${clinic.hours}.` : `نخدمو من الاثنين للسبت: ${CLINIC_HOURS_TXT}. نهار الأحد مسكرين.`)
    : (clinic.hours ? `Wa9t el 5edma: ${clinic.hours}.` : `Ne5dmou mel ethneyn lel sebt: ${CLINIC_HOURS_TXT}. Nhar el 7ad msakrin.`);
  if (kind === "price") return ar
    ? "الأسوام حسب الحالة — الاستشارة الأولى وبعد الطبيب يقولك. تحب نحجزلك رونديفو؟"
    : "El aswem 7asb el 7ala — el consultation loula w ba3d el tbib y9ollek. T7eb n7ajzlek rendez-vous?";
  return ar // place — the clinic verifies the address
    ? (clinic.address ? `العنوان: ${clinic.address} — تحب نحجزلك رونديفو في نفس الوقت؟`
      : "نأكدلك على العنوان مع العيادة — تحب نحجزلك رونديفو في نفس الوقت؟")
    : (clinic.address ? `El 3onwen: ${clinic.address} — t7eb n7ajzlek rendez-vous fi nafs el wa9t?`
      : "N2akkedlek 3al 3onwen m3a el 3iyada — t7eb n7ajzlek rendez-vous fi nafs el wa9t?");
}

// F11 — Walk-in ("n7eb nji tawa"): explain, offer a reserved time, no question loop.
function looksLikeWalkin(text) {
  const t = " " + (text || "").toLowerCase() + " ";
  return /\bnji\b/.test(t) && /\btawa\b/.test(t);
}

// F4 — Two appointments ("zouz rendez-vous, wa7ed liya w wa7ed l omi").
// Acknowledged, then processed one at a time — first one first.

// Explicit beneficiaries in a two-booking request ("wa7ed liya w wa7ed l omi").
// Never invent a beneficiary: without an explicit one, the bot must ask
// "el ouwel lchkoun?" instead of guessing ("wa7ed l ommek").
const BEN_AR = { lik: "ليك", ommek: "لأمك", o5tek: "لأختك", marti: "لمرتي", rajli: "لراجلي", weldi: "لولدي", benti: "لبنتي", baba: "لبابا", "5ouya": "لخويا", sa7bi: "لصاحبي", sa7ebti: "لصاحبتي" };
function detectExplicitBeneficiaries(text) {
  const t = " " + (text || "").toLowerCase().replace(/[.,!?;]/g, " ") + " ";
  const nouns = {
    liya: "lik", lia: "lik", lik: "lik",
    ommi: "ommek", omi: "ommek", ommek: "ommek",
    o5ti: "o5tek", o5t: "o5tek", o5tek: "o5tek",
    marti: "marti", rajli: "rajli", weldi: "weldi", benti: "benti",
    baba: "baba", bouya: "baba", "5ouya": "5ouya",
    sa7bi: "sa7bi", sa7ebti: "sa7ebti",
  };
  const found = [];
  const re = /\bwa7e?d\s+(?:li([a-z0-9]+)|l\s+([a-z0-9]+))/g;
  let m;
  while ((m = re.exec(t))) {
    const w = m[1] ? "li" + m[1] : m[2];
    const canon = nouns[w];
    if (canon && !found.includes(canon)) found.push(canon);
  }
  return found;
}
function looksLikeTwoAppointments(text) {
  const t = " " + (text || "").toLowerCase() + " ";
  return /zouz/.test(t) && /(rendez|rdv|7ajz|hajz)/.test(t);
}
const multiBooking = new Map(); // phone -> extra appointments still to book after the current one

// Rescheduling: the patient moves an EXISTING booking (no duplicate row).
function looksLikeReschedule(text) {
  const t = " " + (text || "").toLowerCase() + " ";
  if (/(nbadal|n7eb nbadal|nheb nbadel|nbadal el wa9t|n7eb nghayar|badal el rendez)/.test(t)) return true;
  return /(نبدل|نحب نبدل|نغير)/.test(text || "");
}
const rescheduling = new Map(); // phone -> bookingId being rescheduled

// F13 — Third-party status query ("el rendez-vous mta3 omi wa9tech?").
// Privacy: only this number's bookings are ever visible — never another number's.
function looksLikeThirdPartyQuery(text) {
  const t = " " + (text || "").toLowerCase() + " ";
  if (!/(rendez|rdv|7ajz|hajz|موعد|حجز|رونديفو)/.test(t)) return false;
  if (!/(wa9tech|wakteh|we9tech|win|3and|وقتاش|وين|فين|\?)/.test(t)) return false;
  // "3and omi ..." (mom has) vs "3andi ..." (I have) — the \s+ matters
  if (/3and\s+(ommi|omi|o5ti|o5t|marti|rajli|weldi|benti|baba|bouya|sa7bi|sa7ebti|5ouya)/.test(t)) return true;
  if (/(mta3|mte3|متاع)\s+(omi|ommi|o5ti|o5t|marti|rajli|weldi|benti|baba|bouya|sa7bi|sa7ebti|5ouya)/.test(t)) return true;
  return /(رونديفو|حجز|موعد).{0,10}(أمي|امي|أختي|اختي|مرتي|راجلي|ولدي|بنتي)/.test(text || "");
}

// F2 — Correction after "le"/"non": "le, 10 mta3 l3chiya" or "le le, après ghodwa".
// The new info wins: a new time keeps the old date, a new date keeps the old time.
// Old conflicting tokens are stripped from the proposal side so they can't win
// back (e.g. the old "sbe7" must not beat the new "l3chiya").
function stripCorrectionPrefix(text) {
  let corr = text || "", hadLe = false, m;
  // loop: "le le, après ghodwa" -> strip every leading le/la/non
  while ((m = /^\s*(le|la|non|mouch)\b[,\s.!?]+/i.exec(corr))) {
    hadLe = true;
    corr = corr.slice(m[0].length);
  }
  return { hadLe, corr };
}

function hasTimeSignal(s) {
  const t = " " + (s || "").toLowerCase() + " ";
  return /\d/.test(t) ||
    /\b(sbe7|sbah|3chiya|3chya|l3chiya|l3chya|la3chiya|la3chya|3vhiya|lil|nos)\b/.test(t) ||
    /(صباح|عشية|العشية|ليل|الليل)/.test(s || "");
}

function stripTimeTokens(s) {
  return (" " + (s || "").toLowerCase() + " ")
    .replace(/\b\d{1,2}(?::\d{2})?\b/g, " ")
    .replace(/\b(sbe7|sbah|3chiya|3chya|l3chiya|l3chya|la3chiya|la3chya|3vhiya|l3vhiya|la3vhiya|lil|nos|mta3|mte3|mt3|ta3|el)\b/g, " ")
    .replace(/\s+/g, " ").trim();
}

function stripDateTokens(s) {
  let out = " " + (s || "").toLowerCase() + " ";
  const words = ["ba3d ghodwa", "ba3d ghadwa", "apres ghodwa", "apres demain", "la7ad", "l7ad", "lahad", "el 7ad", "dimanche",
    "ethnin", "thnin", "tnin", "lundi", "thletha", "thleth", "tletha", "tlata", "mardi",
    "erb3a", "larb3a", "mercredi", "khmis", "5mis", "jeudi", "jem3a", "jom3a", "vendredi",
    "sebt", "sibt", "samedi", "ghodwa", "ghadwa", "demain", "demin", "lyoum", "elyoum", "bera7",
    "الأحد", "الاحد", "الاثنين", "الإثنين", "الثلاثاء", "الأربعاء", "الاربعاء",
    "الخميس", "الجمعة", "السبت", "غدوة", "غدوا", "بعد غدوة", "اليوم", "البارح", "البارحة"];
  for (const w of words) out = out.split(" " + w + " ").join(" ");
  out = out.replace(/\b\d{1,2}\s+(janvier|janfi|fevrier|fev|mars|avril|mai|juin|juillet|juil|aout|septembre|sept|octobre|oct|novembre|nov|decembre|dec)\b/g, " ");
  out = out.replace(/\b\d{1,2}[\/-]\d{1,2}\b/g, " ");
  return out.replace(/\s+/g, " ").trim();
}

// F10 — Clinic-hours gate. A concrete slot outside working hours (or on a closed
// day) is rejected with the next suitable open slot, saved as the new proposal.
function hoursCheck(r) {
  // r: concrete resolved slot (date + time, not past). null = inside hours.
  const open = CLINIC_HOURS[r.dow];
  const wall = new Date(Date.parse(r.iso) + 3600000); // Tunis wall time
  const h = wall.getUTCHours(), m = wall.getUTCMinutes();
  const inside = open && (h > open[0] || (h === open[0] && m >= 0)) && (h < open[1] || (h === open[1] && m === 0));
  if (inside) return null;
  return { reason: open ? "hours" : "closed" };
}

// Next suitable open slot: from the given start day, the first open day
// whose 09:00 is still in the future (real now, not the start day).
function suggestOpenSlot(fromDateUTC, ar) {
  // All timestamps here are shifted so getUTC*() reads Tunis wall time.
  const DAY = 86400000;
  const nowMs = dates.tunisNow().getTime();
  let dayStart = Math.floor(fromDateUTC / DAY) * DAY; // Tunis-wall midnight of the start day
  for (let i = 0; i < 8; i++) {
    const dow = new Date(dayStart).getUTCDay();
    if (CLINIC_HOURS[dow]) {
      const nineAM = dayStart + 9 * 3600000;
      if (nineAM > nowMs) return dates.slotDisplay(dayStart, 9, 0, ar);
    }
    dayStart += DAY;
  }
  return null;
}

// Next open DAY (for the needs-time branch on a closed day): date text only.
function suggestOpenDay(dateUTC, ar) {
  let d = dateUTC;
  for (let i = 0; i < 8; i++) {
    const dow = new Date(d).getUTCDay();
    if (CLINIC_HOURS[dow]) {
      return { dateUTC: d, dow, dateDisplay: dates.fmtDate(d, ar) };
    }
    d += 86400000;
  }
  return null;
}

function hoursRejectMsg(ar, reason, sugDisplay) {
  const hrs = CLINIC_HOURS_TXT;
  if (reason === "closed") return ar
    ? `النهار هذا العيادة مسكرة (نخدمو من الاثنين للسبت: ${hrs}). نقترح عليك: ${sugDisplay} — تحب نحجزلك؟ اكتب "اي".`
    : `El nhar hetha el 3iyada msakra (ne5dmou mel ethneyn lel sebt: ${hrs}). Ne9tar7oulek: ${sugDisplay} — t7eb n7ajzlek? Ekteb "ey".`;
  return ar
    ? `الوقت هذا خارج وقت الخدمة (${hrs}). نقترح عليك: ${sugDisplay} — تحب نحجزلك؟ اكتب "اي".`
    : `El wa9t hetha 5arej wa9t el 5edma (${hrs}). Ne9tar7oulek: ${sugDisplay} — t7eb n7ajzlek? Ekteb "ey".`;
}

// Bare hour in the patient's text ("10", "10:30") — for the time question.
function bareHour(text) {
  const cands = (text || "").match(/\b\d{1,2}(?::\d{2})?\b/g) || [];
  if (!cands.length) return null;
  const last = cands[cands.length - 1];
  const h = parseInt(last.split(":")[0], 10);
  return (h >= 1 && h <= 12) ? last : null;
}

// The "which hour?" question, shared by the slot branch and the bare-"ey"
// clarification repeat (F9) so both ask identically.
function timeQuestionMsg(ar, r, text) {
  const period = r.morning ? (ar ? "متاع الصباح" : "mta3 sbe7")
    : r.afternoon ? (ar ? "متاع العشية" : "mta3 l3chiya")
    : r.night ? (ar ? "متاع الليل" : "mta3 lil") : null;
  const hourStr = bareHour(text);
  if (ar) {
    if (period) return `${r.dateDisplay} ${period} — أنهو ساعة بالضبط؟ (اكتب كيما 10:30)`;
    if (hourStr) return `${r.dateDisplay} — الـ${hourStr} هاذي متاع الصباح ولا متاع العشية؟`;
    return `${r.dateDisplay} — قولي الوقت: متاع الصباح ولا متاع العشية؟ (ولا اكتب الوقت كيما 10:30)`;
  }
  if (period) return `${r.dateDisplay} ${period} — anhou se3a b dhabt? (ekteb kima 10:30)`;
  if (hourStr) return `${r.dateDisplay} — el ${hourStr} hethi mta3 sbe7 walla mta3 l3chiya?`;
  return `${r.dateDisplay} — 9olli el wa9t: mta3 sbe7 walla mta3 l3chiya? (walla ekteb el wa9t kima 10:30)`;
}

// ---------- Patient name capture (nom + prenom, asked AFTER slot acceptance) ----------

// Words that are never a name — the patient is reacting, not introducing themselves.
const NON_NAME = /^(ok|okay|ey|eyy|na3m|oui|non|no|yes|le|la|mriguel|d'accord|salam|slm|salem|ahla|salut|bonjour|merci|chokran|thanks|tfadhel|barcha|ca|za3ma)$/i;

function parsePatientName(text) {
  let t = (text || "").trim()
    .replace(/^(esmi|ana|je m'appelle|my name is)\s+/i, "")
    .replace(/^(اسمي|أنا|انا)\s+/, "")
    .trim();
  if (!t || t.length < 2) return null;
  if (/\d/.test(t)) return null;      // "b9adech", "10", phone numbers... not a name
  if (/[?؟!]/.test(t)) return null;    // questions aren't names
  if (NON_NAME.test(t)) return null;
  t = t.replace(/[^A-Za-z\u0600-\u06FF\s'\-]/g, "").replace(/\s+/g, " ").trim();
  if (t.length < 2 || NON_NAME.test(t)) return null;
  return t;
}

// Display helper: "ahmed ben salah" -> "Ahmed Ben Salah" (Arabic names unaffected).
function capName(s) {
  return (s || "").split(/\s+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function askNameMsg(ar, display) {
  return ar
    ? `داكور — ${display}. أعطيني الاسم واللقب متاعك؟`
    : `D'accord — ${display}. A3tini el esm wel la9ab mta3ek?`;
}

function askFamilyNameMsg(ar) {
  return ar ? `واللقب متاعك؟` : `Wel la9ab mta3ek?`;
}

// The patient is answering our name question (proposal.awaiting_name is set).
async function handleNameAnswer(phone, text, proposal, ar, clinic) {
  // Refusal -> drop the proposal, don't glue it to anything.
  if (looksLikeRefusal(text)) {
    await db.clearProposal(phone).catch(() => {});
    return say(phone, ar
      ? "داكور، فسخت الاقتراح. تحب وقت آخر؟ قولي نهار ووقت يساعدك."
      : "D'accord, l4it el i9tira7. T7eb wa9t e5er? 9olli nhar w wa9t yse3dek.");
  }
  // A new concrete slot mid-flow ("le, jem3a 11") -> update the slot, ask the name again.
  const r = dates.resolveSlot(text, ar);
  if (r.found && r.date && !r.needs && !r.past) {
    await db.saveProposal(phone, text, r.iso, r.display, true, null).catch(() => {});
    return say(phone, askNameMsg(isAr(text) || ar, r.display));
  }
  const name = parsePatientName(text);
  // Not a name (a question, chitchat...) -> let the AI answer, keep waiting for the name.
  if (!name) return { handled: false };
  const partial = proposal.partial_name;
  if (partial || name.split(/\s+/).length >= 2) {
    const full = partial ? `${partial} ${name}`.trim() : name;
    await db.savePatientName(phone, full).catch(() => {});
    return finishBooking(phone, proposal, full, clinic);
  }
  // Single word ("ahmed") -> remember it, ask for the family name.
  await db.saveProposal(phone, proposal.slot_text, proposal.slot_at, proposal.display, true, name).catch(() => {});
  return say(phone, askFamilyNameMsg(ar));
}

async function say(phone, reply) {
  await db.saveMessage(phone, "assistant", reply);
  return { handled: true, reply };
}

async function finishBooking(phone, p, name, clinic) {
  // p: { display, slot_at (ISO), slot_text }, name: "Ahmed Ben Salah" | null
  const dup = await db.findPendingBooking(phone, p.slot_at).catch(() => null);
  const ar = isAr(p.display); // the slot display carries the patient's script
  const first = capName((name || "").split(/\s+/).filter(Boolean)[0] || "");
  const shownName = capName(name);
  let reply;
  if (dup) {
    reply = ar
      ? `الرونديفو متاعك (${p.display}) مازال يستنى — نأكدلك ونرجعلك.`
      : `El rendez-vous mte3ek (${p.display}) deja pending — n2akkedlek w narja3lek.`;
  } else {
    const id = await db.saveBooking(phone, p.display, p.slot_at || null, name || null, clinic && clinic.id);
    console.log(`[booking] #${id} pending: ${phone} (${name || "sans nom"}) -> ${p.display}`);
    const hi = first
      ? (ar ? `داكور ${first}، مرحبا بيك!` : `D'accord ${first}, merhba bik!`)
      : (ar ? `داكور، مرحبا بيك!` : `D'accord, merhba bik!`);
    reply = ar
      ? `${hi} نأكدلك رونديفو (${p.display}) ونرجعلك.`
      : `${hi} n2akkedlek rendez-vous (${p.display}) w narja3lek.`;
    await notifySecretary(
      `⏳ Rendez-vous jdid mel bot:\nEsm: ${shownName || "(ma 3tach esmou)"}\nMel: ${phone}\nWa9t: ${p.display}\nBech tvalidih, ekteb: ok ${id}\nBech tl4ih, ekteb: le ${id}`,
      clinic
    );
  }
  // F4) two appointments: the first is booked — prompt for the second one.
  const extra = multiBooking.get(phone) || 0;
  if (extra > 0 && !dup) {
    if (extra <= 1) multiBooking.delete(phone); else multiBooking.set(phone, extra - 1);
    reply += ar ? "\nTawa ethani: anhou nhar w wa9t?" : "\nTawa ethani: anhou nhar w wa9t?";
  }
  await db.clearProposal(phone).catch(() => {});
  await db.saveMessage(phone, "assistant", reply);
  return { handled: true, reply };
}

// The patient asks about THEIR booking status ("ca y est?", "t2akked?").
// Answer from the DB's real status — never let the AI guess.
function looksLikeStatusQuestion(text) {
  const t = " " + (text || "").toLowerCase().trim() + " ";
  if (/(ca y est|t2akked|t2akad|win wsol|el 7ajz|7ajzi|rendez[ -]?vous mte3i|mon rendez|statut|el wa9t mte3i|est confir|confirm)/i.test(t))
    return true;
  return /(تأكد|تاكد|وين وصل|الحجز متاعي|حجزي|تم الحجز)/.test(text || "");
}

async function handleStatusQuestion(phone, text) {
  if (!looksLikeStatusQuestion(text)) return { handled: false };
  // "t2akkedli ghodwa 10" = new booking request, not a status question.
  try {
    if (dates.resolveSlot(text).found) return { handled: false };
  } catch (e) {}
  const b = await db.getLatestBooking(phone).catch(() => null);
  if (!b) return { handled: false }; // no booking -> let normal flow / AI answer
  const ar = isAr(text) || isAr(b.slot);
  const when = b.slot || "";
  let reply;
  if (b.status === "confirmed") {
    reply = ar
      ? `اي، تأكد! ✅ الرونديفو متاعك (${when}) مؤكد. نستناوك!`
      : `Ey, t2akked! ✅ Rendez-vous mte3ek (${when}) m2akked. Nestennewk!`;
  } else if (b.status === "cancelled") {
    reply = ar
      ? `سامحنا، الوقت ${when} ما عادش متاح. تحب وقت آخر؟`
      : `Sme7na, el wa9t ${when} ma 3adech disponible. T7eb na9tar7oulek wa9t e5er?`;
  } else {
    reply = ar
      ? `الرونديفو متاعك (${when}) مازال يستنى — نستناو في التأكيد من العيادة. نأكدلك ونرجعلك. ⏳`
      : `El rendez-vous mte3ek (${when}) mazel pending — nestanna el confirmation mel 3iyada. N2akkedlek w narja3lek. ⏳`;
  }
  return say(phone, reply);
}

// F7 — Cancel the patient's own booking (pending or confirmed), notify the secretary.
async function handleCancellation(phone, text, ar, clinic) {
  const b = await db.getLatestBooking(phone).catch(() => null);
  const active = b && (b.status === "pending" || b.status === "confirmed") ? b : null;
  await db.clearProposal(phone).catch(() => {});
  rescheduling.delete(phone);
  multiBooking.delete(phone);
  if (!active) {
    return say(phone, ar
      ? "ما لقيت حتى رونديفو محجوز بهالرقم. تحب نحجزلك واحد جديد؟"
      : "Ma l9it 7atta rendez-vous ma7jouz b hal numero. T7eb na7jzelek wa7ed jdid?");
  }
  await db.setBookingStatus(active.id, "cancelled").catch(() => {});
  await notifySecretary(`❌ Patient fassakh rendez-vous #${active.id}: ${active.phone} (${active.patient_name || "sans nom"}) — ${active.slot}`, clinic);
  return say(phone, ar
    ? `داكور، فسخت الرونديفو (${active.slot}). تحب وقت آخر؟`
    : `D'accord, fassakht el rendez-vous (${active.slot}). T7eb wa9t e5er?`);
}

// Rescheduling: move an EXISTING booking to a new slot — never a duplicate row.
async function handleRescheduleStart(phone, ar) {
  const b = await db.getLatestBooking(phone).catch(() => null);
  const active = b && (b.status === "pending" || b.status === "confirmed") ? b : null;
  await db.clearProposal(phone).catch(() => {});
  if (!active) {
    return say(phone, ar
      ? "ما لقيت حتى رونديفو باش نبدلوه. تحب نحجزلك واحد جديد؟"
      : "Ma l9it 7atta rendez-vous bech nbadlouh. T7eb na7jzelek wa7ed jdid?");
  }
  rescheduling.set(phone, active.id);
  return say(phone, ar
    ? `داكور — باش نبدلو الرونديفو (${active.slot}). قولي النهار والوقت الجديد.`
    : `D'accord — bech nbadlou el rendez-vous (${active.slot}). 9olli el nhar wel wa9t el jdid.`);
}

async function finishReschedule(phone, id, target, ar, clinic) {
  await db.updateBookingSlot(id, target.display, target.slot_at).catch(() => {});
  rescheduling.delete(phone);
  await db.clearProposal(phone).catch(() => {});
  const reply = ar
    ? `تبدل الرونديفو: ${target.display} — نأكدلك ونرجعلك.`
    : `Tbadal el rendez-vous: ${target.display} — n2akkedlek w narja3lek.`;
  await notifySecretary(`🔁 Patient badal rendez-vous #${id} (${phone}) -> ${target.display}`, clinic);
  await db.saveMessage(phone, "assistant", reply);
  return { handled: true, reply };
}

// Deterministic booking turn. Returns { handled, reply } or { handled: false }
// to let the AI answer normally.
async function handleBookingTurn(phone, text, history, clinic) {
  clinic = clinic || {};
  // Script: explicit patient request ("aktebli bel 3arbi") > saved preference
  // > Arabic characters in the message.
  const ar = await scriptAr(phone, text);

  // F1) Emergency — chest pain etc.: never a booking, direct to urgent care.
  if (looksLikeEmergency(text)) {
    await notifySecretary(`🚨 URGENCE? patient ${phone}: "${text}"`, clinic).catch(() => {});
    return say(phone, ar
      ? "الوجيعة هذي تستحق طبيب فيسع — ما تستناش رونديفو: امشي للاستعجالي توا ولا عيط لـ190. البوت ما ينجمش يعاونك في حالة كيما هذي."
      : "El wji3a hethi test7a9 tbib fissa3 — matestanech rendez-vous: emchi lel urgence tawa walla 3ayet lel 190. El bot maynajemch y3awnek fi 7ala kima hethi.");
  }

  // F6) Frustrated patient — brief "sama7ni", ask what went wrong, resume.
  if (looksLikeFrustration(text)) {
    return say(phone, ar
      ? "سامحني 🙏 شنوة صار بالضبط؟ قولي ونعاونك."
      : "Sama7ni 🙏 chnowa saret b dhabt? 9olli w n3awnek.");
  }

  // F7) Cancellation — before the status question: cancelling beats asking.
  if (looksLikeCancellation(text)) return handleCancellation(phone, text, ar, clinic);

  // F8) FAQ / identity — pure questions (no date): answer directly, never
  // swallowed into a stale proposal.
  const r0 = dates.resolveSlot(text, ar);
  const fk = !r0.date && faqKind(text);
  if (fk) return say(phone, faqAnswer(fk, ar, clinic));

  // F11) Walk-in ("n7eb nji tawa") — explain, offer a reserved time, no loop.
  if (looksLikeWalkin(text)) {
    await db.clearProposal(phone).catch(() => {});
    rescheduling.delete(phone);
    return say(phone, ar
      ? "تنجم تجي توا، أما الاستناة تنجم تطوال حسب الحالة — الأحسن نحجزلك وقت مضمون باش ما تستناش. تحب نحجزلك؟ قولي أنهو نهار وأنهو وقت."
      : "Tnjem tji tawa, ama el waiting ynajem ykoun twil 7asb el 7ala — el a7sen n7ajzlek wa9t mathmoun bech ma testa7melch. T7eb n7ajzlek? 9olli anhou nhar w anhou wa9t.");
  }

  // F4) Two appointments — acknowledge both, one at a time, first one first.
  // NEVER invent who the second is for: explicit beneficiaries are kept,
  // otherwise the bot asks "el ouwel lchkoun?".
  if (looksLikeTwoAppointments(text)) {
    await db.clearProposal(phone).catch(() => {});
    rescheduling.delete(phone);
    multiBooking.set(phone, 1);
    const ben = detectExplicitBeneficiaries(text);
    let msg;
    if (ben.length >= 2) {
      msg = ar
        ? `فهمتك — زوز رونديفو: واحد ${BEN_AR[ben[0]] || ben[0]} وواحد ${BEN_AR[ben[1]] || ben[1]}. نخدمو واحد بواحد: اللول، أنهو نهار وأنهو وقت يساعدك؟`
        : `Fhemtek — zouz rendez-vous: wa7ed ${ben[0]} w wa7ed ${ben[1]}. Ne5dmou wa7ed b wa7ed: el louwel, anhou nhar w anhou wa9t yse3dek?`;
    } else if (ben.length === 1) {
      msg = ar
        ? `فهمتك — زوز رونديفو: واحد ${BEN_AR[ben[0]] || ben[0]}. والثاني لشكون؟`
        : `Fhemtek — zouz rendez-vous: wa7ed ${ben[0]}. W el theni lchkoun?`;
    } else {
      msg = ar
        ? "فهمتك — زوز رونديفو. اللول لشكون؟"
        : "Fhemtek — zouz rendez-vous. El louwel lchkoun?";
    }
    return say(phone, msg);
  }

  // Reschedule intent — move the existing booking, never duplicate it.
  if (looksLikeReschedule(text)) return handleRescheduleStart(phone, ar);

  // F13) Third-party query — privacy: only this number's bookings are visible.
  if (looksLikeThirdPartyQuery(text)) {
    return say(phone, ar
      ? "سامحني — نجم نشوف كان الرونديفو المحجوز بالرقم هذا. كان الحجز تسجل باسم آخر، قولي الاسم ونتثبت مع العيادة."
      : "Sama7ni — najem nchouf ken el rendez-vous el ma7jouz b numero hetha. Ken el 7ajz tsajjel b esm e5er, 9olli el esm w nthabbet m3a el 3iyada.");
  }

  // A0) Status question — real DB status beats AI guessing.
  const st = await handleStatusQuestion(phone, text);
  if (st.handled) return st;

  // Patient-side "ok 5" — a secretary-command shape, never a validation.
  // (The webhook only routes real secretary commands from SECRETARY_NUMBER;
  // this is the in-bot safety net.)
  if (/^(ok|le|faskh|cancel)\s+\d+\s*$/.test(text.trim().toLowerCase())) {
    return say(phone, ar
      ? "هذي commande متاع العيادة — كان تحب تبدل ولا تفسخ الرونديفو متاعك، قولي."
      : "Hethi commande mta3 el 3iyada — ken t7eb tbadal walla tfassakh el rendez-vous mte3ek, 9olli.");
  }

  let proposal = await db.getProposal(phone).catch(() => null); // null if stale/absent
  const ar2 = ar || isAr(proposal && proposal.slot_text); // script sticks to the patient's own words

  // A-1) We asked for the patient's name — this message answers that.
  if (proposal && proposal.awaiting_name) {
    return handleNameAnswer(phone, text, proposal, ar2, clinic);
  }

  let r = dates.resolveSlot(text, ar);
  let slotText = text; // the phrase the proposal remembers — grows as follow-ups merge

  // F5) Fresh booking request wipes a stale proposal — never inherit old date/time.
  // Falls through to B0 below (rephrased nudge if we already asked, AI if first ask).
  if (!r.date && looksLikeBookingIntent(text)) {
    if (proposal) await db.clearProposal(phone).catch(() => {});
    proposal = null;
    rescheduling.delete(phone);
  }

  // R) pure refusal ("le") -> drop the proposal, don't glue it to the old slot.
  // Before the merge block: a refusal must never be merged into the proposal.
  if (proposal && proposal.slot_text && looksLikeRefusal(text)) {
    await db.clearProposal(phone).catch(() => {});
    return say(phone, ar2
      ? "داكور، فسخت الاقتراح. تحب وقت آخر؟ قولي نهار ووقت يساعدك."
      : "D'accord, l4it el i9tira7. T7eb wa9t e5er? 9olli nhar w wa9t yse3dek.");
  }

  // Merge follow-ups into a pending proposal — but never a pure acceptance:
  // "ey" must reach the acceptance branch below.
  if ((!r.found || !r.date) && proposal && proposal.slot_text && !looksLikeAcceptance(text)) {
    // F2) correction after "le"/"non": the new info wins — strip the old
    // conflicting tokens from the proposal side so they can't win back.
    const { hadLe, corr } = stripCorrectionPrefix(text);
    if (hadLe) {
      const rn = dates.resolveSlot(corr, ar);
      if (rn.found) {
        let propSide = proposal.slot_text;
        if (hasTimeSignal(corr)) propSide = stripTimeTokens(propSide);
        if (rn.date) propSide = stripDateTokens(propSide);
        const merged = dates.resolveSlot(corr + " " + propSide, ar);
        if (merged.found && merged.date) { r = merged; slotText = corr + " " + propSide; }
      }
    } else {
      // follow-up like "sbe7" or "10" -> merge with the previous slot phrase.
      // New text first, so a changed hour wins over the old one.
      const merged = dates.resolveSlot(text + " " + proposal.slot_text, ar);
      if (merged.found && merged.date) { r = merged; slotText = text + " " + proposal.slot_text; }
    }
  }

  // A) Pure acceptance ("ey") -> resolve WHICH slot, then the name gate.
  // A slot inside the acceptance text itself ("ey, jem3a 10") falls through to B.
  // Never invents a slot: bare "ey" on an incomplete proposal repeats the
  // pending clarification (F9); the old assistant-history fallback is gone.
  if (looksLikeAcceptance(text) && !(r.found && r.date)) {
    const reschedId = rescheduling.get(phone);
    let target = (proposal && proposal.slot_at && proposal.display) ? proposal : null;
    if (!target && proposal && !proposal.slot_at) {
      // F9) incomplete proposal: repeat the pending clarification, no invention.
      const rp = dates.resolveSlot(proposal.slot_text || "", ar2);
      if (rp.found && rp.date && !rp.past && rp.needs === "time") {
        return say(phone, timeQuestionMsg(ar2, rp, proposal.slot_text));
      }
      await db.clearProposal(phone).catch(() => {});
      return say(phone, ar2
        ? "داكور — أنهو نهار وأنهو وقت تحب؟"
        : "D'accord — anhou nhar w anhou wa9t t7eb?");
    }
    if (!target) {
      // No pending slot — but a booking may already exist (double "ey"):
      // remind instead of inventing a new one.
      const existing = await db.getLatestBooking(phone).catch(() => null);
      if (existing && (existing.status === "pending" || existing.status === "confirmed")) {
        return say(phone, ar2
          ? `عندك رونديفو deja pending: ${existing.slot} — نأكدلك ونرجعلك.`
          : `3andek rendez-vous deja pending: ${existing.slot} — n2akkedlek w narja3lek.`);
      }
      return { handled: false }; // no pending slot: let the AI answer
    }
    if (reschedId) return finishReschedule(phone, reschedId, target, ar2, clinic);
    // Name gate: nom + prenom are asked AFTER acceptance, remembered per number.
    const known = await db.getPatientName(phone).catch(() => null);
    if (known) return finishBooking(phone, target, known, clinic);
    await db.saveProposal(phone, target.slot_text || text, target.slot_at, target.display, true, null);
    return say(phone, askNameMsg(ar2, target.display));
  }

  // B0) Booking intent but no date/time — and we ALREADY asked for day/time.
  // Don't fall through to the AI just to repeat the same question: nudge
  // with a rephrased ask + a concrete example (conversation memory).
  if (!r.found && looksLikeBookingIntent(text)) {
    const lastAsst = [...history].reverse().find((m) => m.role === "assistant");
    if (lastAsst && /(nhar w anhou wa9t|anhou nhar|wa9t yse3dek|أنهو نهار|وقت يساعدك)/i.test(lastAsst.text)) {
      return say(phone, ar
        ? "فهمتك تحب تحجز — قولي أنهو نهار وأنهو وقت، كيما: الجمعة 10 متاع الصباح."
        : "Fhemtek t7eb ta7jez — 9olli anhou nhar w anhou wa9t, kima: jem3a 10 mta3 sbe7.");
    }
    return { handled: false }; // first time asking: let the AI do it
  }

  // B) Slot information (new request or clarification answer).
  if (!r.found) return { handled: false };
  if (!r.date) {
    // "jem3a jeya" = next WEEK (Tunisian usage), no specific day: ask which
    // day of next week, don't fall through to the generic question.
    if (r.nextWeek) {
      return say(phone, ar
        ? "أوك — الجمعة الجاية. أنهو نهار وأنهو وقت يساعدك؟"
        : "Ok, jem3a jeya — anhou nhar w anhou wa9t?");
    }
    // Time but no date, and the time is outside clinic hours ("nos el lil"
    // = midnight): reject it immediately — never ask for a day first.
    if (r.hour !== null && r.hour !== undefined) {
      const open = CLINIC_HOURS[new Date(dates.tunisNow().getTime()).getUTCDay()];
      const inside = open &&
        (r.hour > open[0] || (r.hour === open[0] && (r.minute || 0) >= 0)) &&
        (r.hour < open[1] || (r.hour === open[1] && (r.minute || 0) === 0));
      if (!inside) {
        const sug = suggestOpenSlot(dates.tunisNow().getTime(), ar);
        if (sug) await db.saveProposal(phone, sug.display, sug.iso, sug.display).catch(() => {});
        return say(phone, hoursRejectMsg(ar, open ? "hours" : "closed", sug ? sug.display : ""));
      }
    }
    return say(phone, ar
      ? "أنهو نهار بالضبط؟ (اكتب كيما: الجمعة، غدوة، 21 سبتمبر...)"
      : "Anhou nhar b dhabt? (ekteb kima: jem3a, ghodwa, 21 septembre...)");
  }
  if (r.past) {
    return say(phone, ar ? "الوقت هذا فات — أعطيني وقت آخر." : "El wa9t hedha fet — a3tini wa9t e5er.");
  }
  if (r.needs === "time") {
    // F10b) closed day (Sunday): redirect to the next open day — never ask a
    // time for a day the clinic is closed.
    if (r.dow !== null && !CLINIC_HOURS[r.dow]) {
      const sug = suggestOpenDay(r.dateUTC, ar2);
      await db.saveProposal(phone, sug.dateDisplay, null, sug.dateDisplay);
      return say(phone, ar2
        ? `نهار الأحد العيادة مسكرة (نخدمو من الاثنين للسبت: ${CLINIC_HOURS_TXT}). تحب ${sug.dateDisplay}؟ قولي الوقت.`
        : `Nhar el 7ad el 3iyada msakra (ne5dmou mel ethneyn lel sebt: ${CLINIC_HOURS_TXT}). T7eb ${sug.dateDisplay}? 9olli el wa9t.`);
    }
    await db.saveProposal(phone, slotText, null, r.dateDisplay);
    const q = timeQuestionMsg(ar2, r, text);
    // Memory: never send the identical question twice in a row — if the
    // patient just repeated the hour, rephrase with concrete 24h options.
    const hourStr = bareHour(text);
    const lastAsst = [...history].reverse().find((m) => m.role === "assistant");
    if (lastAsst && lastAsst.text === q && hourStr) {
      const parts = hourStr.split(":");
      const hh = parseInt(parts[0], 10);
      const mm = parts[1] || "00";
      const am = `${String(hh).padStart(2, "0")}:${mm}`;
      const pm = `${String(hh + 12).padStart(2, "0")}:${mm}`;
      return say(phone, ar2
        ? `${r.dateDisplay} — باش نتأكد: الـ${hourStr} هاذي ${am} متاع الصباح ولا ${pm} متاع العشية؟`
        : `${r.dateDisplay} — bech net2akked: el ${hourStr} hethi ${am} mta3 sbe7 walla ${pm} mta3 l3chiya?`);
    }
    return say(phone, q);
  }
  // F10) concrete slot outside clinic hours (or on a closed day): reject it and
  // offer the next suitable open slot, saved as the new proposal.
  const hc = hoursCheck(r);
  if (hc) {
    const sug = suggestOpenSlot(r.dateUTC, ar2);
    await db.saveProposal(phone, sug.display, sug.iso, sug.display);
    return say(phone, hoursRejectMsg(ar2, hc.reason, sug.display));
  }
  // concrete date+time -> propose it back, wait for "ey"
  await db.saveProposal(phone, slotText, r.iso, r.display);
  return say(phone, ar2
    ? `داكور — ${r.display}. تحب نحجزلك؟ اكتب "اي".`
    : `D'accord — ${r.display}. T7eb n7ajzlek? Ekteb "ey".`);
}

// ---------- Vendor (sales) mode: dentist wrote "جرّب" from the demo video ----------
// Exact trigger only — a patient never writes a bare "جرّب", so the booking
// flow is untouched. Once triggered, the sender stays in vendor mode until
// the handoff is done (secretary "fassa5 <numero>" resets it too).
function looksLikeVendorTrigger(text) {
  const t = (text || "").trim().replace(/[«»"']/g, "");
  return /^(جرّب|جرب|jareb|jarreb)$/i.test(t);
}

async function handleVendorTurn(phone, text, lead) {
  const ar = isAr(text);

  // Fresh trigger (or re-trigger after done): restart the pitch.
  if (!lead || (lead.stage === "done" && looksLikeVendorTrigger(text))) {
    await db.saveVendorLead(phone, "asked_clinic", null);
    return say(phone, ar
      ? "أهلا وسهلا! 👋 المساعد متاعنا يجاوب على واتساب العيادة بالدارجة التونسية، يحجز الـ rendez-vous وحدو حتى كي العيادة مسكّرة، والسكرتيرة متاعك تبقى هي اللي تقرّر الحجز النهائي. ما فمّاش اشتراك — تخلّص كان 2 دنانير على كل مريض يوصل، والشهر الأول بلاش. شنوّا اسم العيادة متاعك؟"
      : "Ahla w sahla! 👋 El assistant mte3na yjawb 3la WhatsApp el 3iyada b derja tounsiya, ya7jez el rendez-vous wa7dou 7atta ki el 3iyada msakra, w el secretaire mte3ek teb9a hiya eli t9arer el 7ajz el nihe2i. Ma fammech ichtirak — t5alles ken 2 dinars 3la kol mridh yousel, w el chhar elowel blech. Chnowa esm el 3iyada mte3ek?");
  }

  if (lead.stage === "asked_clinic") {
    const clinic = (text || "").trim().slice(0, 80) || "—";
    await db.saveVendorLead(phone, "asked_call", clinic);
    await notifySales(`🔔 Lead jdid (جرّب): 3iyada "${clinic}" — numero ${phone}`);
    return say(phone, ar
      ? `ممتاز، عيادة ${clinic}! 🎉 تحب نحكيو 10 دقايق باش نورّيك كيفاش يخدم على عيادتك؟ أنهو وقت يساعدك — اليوم ولا غدوة؟`
      : `Momtez, 3iyedet ${clinic}! 🎉 T7eb na7kiw 10 d9aye9 bech nwarik kifech ye5dem 3la 3iyedtek? Anhou wa9t yse3dek — lyoum walla ghodwa?`);
  }

  if (lead.stage === "asked_call") {
    const when = (text || "").trim().slice(0, 80) || "—";
    await db.saveVendorLead(phone, "done", lead.clinic_name);
    await notifySales(`📞 "${lead.clinic_name || "—"}" (${phone}) y7eb appel: "${when}"`);
    return say(phone, ar
      ? `داكور! ✅ باش نتصلو بيك ${when}. كان عندك أي سؤال اكتب هوني.`
      : `D'accord! ✅ Bech nettaslou bik ${when}. Ken 3andek ay sou2el ekteb houni.`);
  }

  // stage "done": handoff already made, stay quiet-ish.
  return say(phone, ar
    ? "شريكتنا باش تتصل بيك قريب. كان عندك سؤال آخر اكتب هوني."
    : "El charika bech tetassel bik 9rib. Ken 3andek sou2el e5er ekteb houni.");
}

// Bare greeting ("slm", "bonjour", "عسلامة") -> neutral reply only, no steering.
// The NEXT message decides: "جرّب" -> vendeur, booking talk -> réceptionniste.
// Pure greetings only — "sbe7"/"mse" stay out (ambiguous with time-of-day).
function looksLikePureGreeting(text) {
  const t = (text || "").trim().toLowerCase().replace(/[.,!؟?]/g, "");
  if (/^(سلام|عسلامة|صباح الخير|مساء الخير|اهلا|أهلا|مرحبا)$/.test(t)) return true;
  return /^(slm|slem|salem|salam|3aslema|3aslama|ahla|sahla|salut|bonjour|bjr|hello|hi|hey)$/.test(t);
}

// Shared by the WhatsApp webhook and the /test page.
async function processPatientText(phone, text, numberId) {
  const clinic = await getClinic(numberId);
  const history = await db.getHistory(phone); // last 15 messages
  await db.saveMessage(phone, "user", text);

  // Explicit script request ("aktebli bel 3arbi" / "aktebli b 7rouf"):
  // remembered per patient, honored from this message on.
  if (looksLikeScriptRequest(text)) await db.saveScriptPref(phone, "ar").catch(() => {});
  else if (looksLikeLatinRequest(text)) await db.saveScriptPref(phone, "latin").catch(() => {});

  // Vendor (sales) mode first: exact "جرّب" trigger, or an ongoing vendor lead.
  // Sticky: once a dentist, always vendor for that number (fassa5 resets).
  const vlead = await db.getVendorLead(phone).catch(() => null);
  if (looksLikeVendorTrigger(text) || vlead) {
    const v = await handleVendorTurn(phone, text, looksLikeVendorTrigger(text) ? null : vlead);
    if (v.handled) return v.reply;
  }

  // Neutral greeting: no vendeur pitch, no réceptionniste steering.
  // The next message decides the mode.
  if (looksLikePureGreeting(text)) {
    const ar = await scriptAr(phone, text);
    const g = await say(phone, clinic.greeting || (ar
      ? "وعليكم السلام! كيفاش نجم نعاونك؟"
      : "3alikom salam! Kifech n3awnek?"));
    return g.reply;
  }

  const booking = await handleBookingTurn(phone, text, history, clinic);
  if (booking.handled) return booking.reply;

  const pname = await db.getPatientName(phone).catch(() => null);
  const useAr = await scriptAr(phone, text);
  const reply = await aiReply(text, history, pname, clinic.name, useAr);
  await db.saveMessage(phone, "assistant", reply);
  return reply;
}

// Secretary commands: "ok <id>" / "le <id>" / "list"
async function processSecretaryText(text, clinic) {
  const t = (text || "").trim();
  let m = t.match(/^(ok|okay|na3m|ey)\s+(\d+)$/i);
  if (m) return settleBooking(parseInt(m[2], 10), true, clinic);
  m = t.match(/^(le|la|non|faskh|cancel)\s+(\d+)$/i);
  if (m) return settleBooking(parseInt(m[2], 10), false, clinic);
  if (/^(list|liste|pending|chouf)/i.test(t)) {
    const pending = await db.getPendingBookings();
    if (!pending.length) return "Ma fama 7atta rendez-vous pending. 👍";
    return "⏳ Pending:\n" + pending.map((b) => `#${b.id} — ${b.phone} — ${b.slot}`).join("\n");
  }
  m = t.match(/^(fassa5|effacer|delete)\s+(\d+)$/i);
  if (m) {
    const phone = m[2].replace(/\D/g, "");
    const n = await db.deleteConversation(phone).catch(() => 0);
    if (!n) return `Ma l9it 7atta conversation lel numero ${phone}.`;
    console.log(`[secretary] deleted conversation ${phone} (${n} messages)`);
    return `Tfass5et el conversation mta3 ${phone} (${n} messages). El rendez-vous el ma7jouza ma tfass5etch. ✅`;
  }
  return "Ekteb: 'ok <numero>' bech tvalidi, 'le <numero>' bech tl4i, 'list' bech tchouf el pending, 'fassa5 <numero>' bech tfassa5 conversation.";
}

async function settleBooking(id, approve, clinic) {
  const b = await db.getBooking(id).catch(() => null);
  if (!b) return `Ma l9it 7atta rendez-vous b numero ${id}.`;
  if (b.status !== "pending") return `Rendez-vous ${id} deja: ${b.status}.`;
  await db.setBookingStatus(id, approve ? "confirmed" : "cancelled");
  const ar = isAr(b.slot); // the slot display carries the patient's script
  const patientMsg = approve
    ? (ar ? `تأكد الرونديفو متاعك: ${b.slot}. نستناوك! 🌸` : `T2akked rendez-vous mte3ek: ${b.slot}. Nestennewk! 🌸`)
    : (ar ? `سامحنا، الوقت ${b.slot} ما عادش متاح. تحب وقت آخر؟` : `Sme7na, el wa9t ${b.slot} ma 3adech disponible. T7eb wa9t e5er?`);
  await db.saveMessage(b.phone, "assistant", patientMsg);
  // The patient hears back from the same bot number they wrote to.
  await sendWhatsApp(b.phone, patientMsg, (b.number_id) || (clinic && clinic.id));
  console.log(`[booking] #${id} ${approve ? "CONFIRMED" : "CANCELLED"}`);
  return approve
    ? `T2akked rendez-vous #${id} (${b.slot}) w tbe3ath lel patient. ✅`
    : `Tl4a rendez-vous #${id} (${b.slot}) w tbe3ath lel patient. ❌`;
}

// ---------- Webhook verification (Meta calls this once at setup) ----------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[webhook] verified OK");
    return res.status(200).send(challenge);
  }
  console.log("[webhook] verification FAILED");
  return res.sendStatus(403);
});

// ---------- Webhook receiver ----------
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // ack fast, process async
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    if (!value) return;

    // 1) Staff replied from the WhatsApp Business app (coexistence echo) -> pause bot
    const echoes = value.smb_message_echoes || [];
    for (const echo of echoes) {
      const patient = echo.recipient || echo.to;
      if (patient) {
        pausedChats.set(patient, Date.now() + PAUSE_MS);
        console.log(`[echo] staff took over chat ${patient} -> bot paused 10min`);
      }
    }
    // also handle generic message echoes some providers send
    const msgEchoes = value.message_echoes || [];
    for (const echo of msgEchoes) {
      const patient = echo.recipient || echo.to;
      if (patient) {
        pausedChats.set(patient, Date.now() + PAUSE_MS);
        console.log(`[echo] staff took over chat ${patient} -> bot paused 10min`);
      }
    }

    // 2) Incoming messages
    // The bot number this message arrived on (multi-number routing).
    const numberId = value.metadata?.phone_number_id || DEFAULT_NUMBER_ID;
    const clinic = await getClinic(numberId);
    const messages = value.messages || [];
    for (const msg of messages) {
      const from = msg.from;
      if (msg.type !== "text" || !msg.text?.body) {
        console.log(`[msg] non-text from ${from} (${msg.type}) -> skipped`);
        continue;
      }
      const text = msg.text.body;

      // 2a) Secretary command (from her recognized number for this clinic)
      if (clinic.secretary && from === clinic.secretary) {
        console.log(`[secretary] ${from}: ${text}`);
        await db.saveMessage(from, "user", text);
        const reply = await processSecretaryText(text, clinic);
        lastWebhook = { at: new Date().toISOString(), from, text, reply };
        await sendWhatsApp(from, reply, numberId);
        await db.saveMessage(from, "assistant", reply);
        continue;
      }

      // 2b) Patient message
      const unpauseAt = pausedChats.get(from) || 0;
      if (Date.now() < unpauseAt) {
        console.log(`[msg] chat ${from} paused (staff active) -> bot stays silent`);
        continue;
      }
      console.log(`[msg] from ${from}: ${text}`);
      const reply = await processPatientText(from, text, numberId);
      lastWebhook = { at: new Date().toISOString(), from, text, reply };
      await sendWhatsApp(from, reply, numberId);
    }

    // 3) Status updates -> just log
    for (const st of value.statuses || []) {
      console.log(`[status] ${st.id}: ${st.status}`);
    }
  } catch (e) {
    console.error("[webhook:ERROR]", e.message);
  }
});

app.get("/", (req, res) => res.send("clinic-bot server running 🤖"));

// ---------- Browser test chat: same brain, no WhatsApp ----------
// Open /test in a browser, enter the verify token as password, and chat.
// Every message goes through the exact same processPatientText() as the webhook.
// Prefix a message with "admin:" to simulate the secretary (e.g. "admin: ok 1").
const TEST_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bot test chat</title>
<style>
body{font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:12px;background:#f4f4f4}
h2{margin:6px 0} #badge{font-size:12px;padding:3px 8px;border-radius:10px;background:#ddd}
#log{border:1px solid #ccc;background:#fff;height:50vh;overflow-y:auto;padding:10px;border-radius:8px;margin:10px 0}
.me{text-align:right;margin:6px 0}.me span{background:#d1e7ff;padding:6px 10px;border-radius:12px;display:inline-block;max-width:80%}
.bot{margin:6px 0}.bot span{background:#e8e8e8;padding:6px 10px;border-radius:12px;display:inline-block;max-width:80%}
#row{display:flex;gap:6px}input{flex:1;padding:10px;border-radius:8px;border:1px solid #ccc;font-size:16px}
button{padding:10px 14px;border-radius:8px;border:0;background:#0b7;color:#fff;font-size:16px}
#pwrow{display:flex;gap:6px;margin-bottom:8px}
.hint{font-size:12px;color:#666;margin:6px 0}
a{color:#0b7}
</style></head><body>
<h2>Bot test <span id="badge">...</span></h2>
<div id="pwrow"><input id="pw" type="password" placeholder="password (verify token)"><button onclick="unlock()">OK</button></div>
<div id="whorow" style="display:flex;gap:6px;margin-bottom:8px"><input id="who" placeholder="chkoun enti? (ex: ahmed) — badlou bech tjareb patient e5er"></div>
<div id="log"></div>
<div id="row"><input id="msg" placeholder="ekteb houni..." onkeydown="if(event.key==='Enter')send()"><button onclick="send()">Send</button></div>
<p class="hint">Patient: ekteb 3adi. Secretaire: ibda b <b>admin:</b> (ex: <b>admin: ok 1</b>). Bech tjareb akther men patient: badel el esm fi el 5ana el fou9aniya w kamel. El wa9t lezem date 7a9i9iya (jem3a = 25-09-2026). <a href="/bookings">/bookings</a> tchouf el pending.</p>
<script>
let pw="";
function unlock(){pw=document.getElementById('pw').value;document.getElementById('pwrow').style.display='none';add('bot','mriguel! Ekteb ay message bech tjareb el bot.');}
function add(w,t){const d=document.createElement('div');d.className=w;const s=document.createElement('span');s.textContent=t;d.appendChild(s);document.getElementById('log').appendChild(d);document.getElementById('log').scrollTop=1e9;}
async function send(){const i=document.getElementById('msg');const t=i.value.trim();if(!t)return;i.value='';add('me',t);
const w=(document.getElementById('who').value.trim().toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,20))||'x';
try{const r=await fetch('/test/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw,text:t,who:w})});
const j=await r.json();
if(!r.ok){add('bot','⚠️ '+(j.error||'error'));return;}
document.getElementById('badge').textContent=j.ai?'AI':'fallback';document.getElementById('badge').style.background=j.ai?'#bfe8bf':'#f0d090';
add('bot',j.reply);}catch(e){add('bot','⚠️ mochkla fel connexion');}}
</script></body></html>`;

app.get("/test", (req, res) => res.send(TEST_PAGE));

app.post("/test/chat", async (req, res) => {
  const { password, text, who } = req.body || {};
  if (password !== VERIFY_TOKEN) return res.status(403).json({ error: "wrong password" });
  const clean = (text || "").trim().slice(0, 500);
  if (!clean) return res.status(400).json({ error: "empty message" });
  // "admin:" prefix simulates the secretary in the browser test
  if (/^admin:/i.test(clean)) {
    const reply = await processSecretaryText(clean.replace(/^admin:/i, "").trim());
    return res.json({ reply, ai: !!AI_API_KEY });
  }
  const ident = "webtest-" + (String(who || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "x");
  const reply = await processPatientText(ident, clean);
  res.json({ reply, ai: !!AI_API_KEY });
});

// ---------- /bookings: pending list + approve/reject (browser) ----------
const BOOKINGS_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pending bookings</title>
<style>
body{font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:12px;background:#f4f4f4}
.card{background:#fff;border:1px solid #ccc;border-radius:8px;padding:10px;margin:8px 0}
.row{display:flex;gap:6px;margin-top:8px}
button{padding:8px 12px;border-radius:8px;border:0;font-size:14px;color:#fff}
.ok{background:#0b7}.no{background:#c33}
#pwrow{display:flex;gap:6px;margin-bottom:8px}
input{flex:1;padding:10px;border-radius:8px;border:1px solid #ccc;font-size:16px}
</style></head><body>
<h2>⏳ Pending bookings</h2>
<div id="pwrow"><input id="pw" type="password" placeholder="password (verify token)"><button class="ok" onclick="load()">Load</button></div>
<div id="list"></div>
<script>
let pw="";
async function load(){pw=document.getElementById('pw').value;
const r=await fetch('/api/bookings?password='+encodeURIComponent(pw));const j=await r.json();
const el=document.getElementById('list');
if(!r.ok){el.innerHTML='<p>⚠️ '+(j.error||'error')+'</p>';return;}
if(!j.bookings.length){el.innerHTML='<p>Ma fama 7atta pending. 👍</p>';return;}
el.innerHTML=j.bookings.map(b=>'<div class="card"><b>#'+b.id+'</b> — '+b.phone+(b.patient_name?'<br>👤 '+b.patient_name:'')+'<br>📅 '+b.slot+'<br><small>'+b.created_at+'</small><div class="row"><button class="ok" onclick="settle('+b.id+',1)">Valider</button><button class="no" onclick="settle('+b.id+',0)">Refuser</button></div></div>').join('');}
async function settle(id,approve){const r=await fetch('/api/bookings/'+id+'/'+(approve?'approve':'reject'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
const j=await r.json();alert(j.reply||j.error||'done');load();}
</script></body></html>`;

app.get("/bookings", (req, res) => res.send(BOOKINGS_PAGE));

app.get("/api/bookings", async (req, res) => {
  if (req.query.password !== VERIFY_TOKEN) return res.status(403).json({ error: "wrong password" });
  const bookings = await db.getPendingBookings().catch(() => []);
  res.json({ bookings });
});

app.post("/api/bookings/:id/:action", async (req, res) => {
  if ((req.body || {}).password !== VERIFY_TOKEN) return res.status(403).json({ error: "wrong password" });
  const id = parseInt(req.params.id, 10);
  const approve = req.params.action === "approve";
  if (!id || !["approve", "reject"].includes(req.params.action))
    return res.status(400).json({ error: "bad request" });
  const reply = await settleBooking(id, approve);
  res.json({ reply });
});

// ---------- Conversations dashboard: view + forget ----------
const MESSAGES_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conversations</title>
<style>body{font-family:sans-serif;max-width:700px;margin:0 auto;padding:12px;background:#f5f5f5}
.card{background:#fff;border:1px solid #ccc;border-radius:8px;padding:10px;margin:8px 0}
.row{display:flex;gap:6px;margin-top:8px}
button{padding:8px 12px;border-radius:8px;border:0;font-size:14px;color:#fff;cursor:pointer}
.ok{background:#0b7}.no{background:#c33}.back{background:#888}
#pwrow{display:flex;gap:6px;margin-bottom:8px}
input{flex:1;padding:10px;border-radius:8px;border:1px solid #ccc;font-size:16px}
.msg{padding:6px 10px;border-radius:10px;margin:4px 0;max-width:85%;font-size:14px;overflow-wrap:break-word}
.user{background:#dcf8c6;margin-left:auto;text-align:right}
.assistant{background:#fff;border:1px solid #ddd}
.who{font-size:11px;color:#888}
</style></head><body>
<h2>💬 Conversations</h2>
<div id="pwrow"><input id="pw" type="password" placeholder="password (verify token)"><button class="ok" onclick="load()">Load</button></div>
<div id="list"></div>
<div id="conv" style="display:none"></div>
<script>
let pw="";
function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
async function load(){pw=document.getElementById('pw').value;
const r=await fetch('/api/conversations?password='+encodeURIComponent(pw));const j=await r.json();
const el=document.getElementById('list');document.getElementById('conv').style.display='none';
if(!r.ok){el.innerHTML='<p>⚠️ '+(j.error||'error')+'</p>';return;}
if(!j.conversations.length){el.innerHTML='<p>Ma fama 7atta conversation. 👍</p>';return;}
el.innerHTML=j.conversations.map(c=>'<div class="card"><b>'+esc(c.phone)+'</b> — '+c.count+' messages<br><small>'+esc(c.last_at||'')+'</small><div class="row"><button class="ok" onclick="viewConv(\\''+esc(c.phone)+'\\')">Chouf</button><button class="no" onclick="delConv(\\''+esc(c.phone)+'\\')">Fassa5</button></div></div>').join('');}
async function viewConv(phone){const r=await fetch('/api/conversations/'+encodeURIComponent(phone)+'?password='+encodeURIComponent(pw));const j=await r.json();
const el=document.getElementById('conv');el.style.display='block';
if(!r.ok){el.innerHTML='<p>⚠️ '+(j.error||'error')+'</p>';return;}
el.innerHTML='<div class="row"><button class="back" onclick="back()">← Erja3</button><button class="no" onclick="delConv(\\''+esc(phone)+'\\')">Fassa5 el conversation</button></div><h3>'+esc(phone)+'</h3>'+
(j.messages.map(m=>'<div class="msg '+m.role+'"><span class="who">'+(m.role==='user'?'Patient':'Bot')+'</span><br>'+esc(m.text)+'</div>').join('')||'<p>Faragh.</p>');}
function back(){document.getElementById('conv').style.display='none';}
async function delConv(phone){if(!confirm('Tfassa5 el conversation mta3 '+phone+'? El bot bech yenseha jemla.'))return;
const r=await fetch('/api/conversations/'+encodeURIComponent(phone)+'/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
const j=await r.json();alert(j.deleted!=null?('Tfass5et ('+j.deleted+' messages). El bot nseh jemla. 👍'):(j.error||'error'));load();}
</script></body></html>`;

app.get("/messages", (req, res) => res.send(MESSAGES_PAGE));

app.get("/api/conversations", async (req, res) => {
  if (req.query.password !== VERIFY_TOKEN) return res.status(403).json({ error: "wrong password" });
  const conversations = await db.getConversations().catch(() => []);
  res.json({ conversations });
});

app.get("/api/conversations/:phone", async (req, res) => {
  if (req.query.password !== VERIFY_TOKEN) return res.status(403).json({ error: "wrong password" });
  const phone = (req.params.phone || "").replace(/\D/g, "");
  if (!phone) return res.status(400).json({ error: "bad phone" });
  const messages = await db.getFullHistory(phone).catch(() => []);
  res.json({ messages });
});

app.post("/api/conversations/:phone/delete", async (req, res) => {
  if ((req.body || {}).password !== VERIFY_TOKEN) return res.status(403).json({ error: "wrong password" });
  const phone = (req.params.phone || "").replace(/\D/g, "");
  if (!phone) return res.status(400).json({ error: "bad phone" });
  const deleted = await db.deleteConversation(phone).catch(() => 0);
  console.log(`[conversations] deleted ${deleted} messages for ${phone} (forgotten)`);
  res.json({ deleted });
});

// ---------- /formulaire: public signup page for doctors ----------
function validateSignup(d) {
  const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const name = clean(d.name, 100);
  const phone = clean(d.phone, 30);
  const clinic_name = clean(d.clinic_name, 150);
  const city = clean(d.city, 100);
  if (!name || !phone) return { error: "3ammer el esm w numero el telephone." };
  const digits = phone.replace(/\D/g, "");
  // Lenient: any plausible phone number (7-15 digits). Ahmed filters the
  // signups himself — no country restriction here.
  if (digits.length < 7 || digits.length > 15)
    return { error: "Numero el telephone ghalet — 7ot numero s7i7." };
  return { name, phone, clinic_name, city };
}

const FORMULAIRE_PAGE = `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>مساعد الاستقبال الذكي لعيادتك</title>
<style>
body{font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:16px;background:#f4f4f4;color:#222}
.card{background:#fff;border:1px solid #ddd;border-radius:12px;padding:18px;margin-bottom:14px}
h1{font-size:22px;margin:4px 0 10px}
ul{padding-right:18px;line-height:1.9;font-size:15px}
label{display:block;font-size:14px;margin:12px 0 4px;font-weight:600}
input{width:100%;padding:12px;border-radius:8px;border:1px solid #ccc;font-size:16px;box-sizing:border-box}
button{width:100%;padding:14px;border-radius:10px;border:0;background:#0b7;color:#fff;font-size:18px;font-weight:700;margin-top:16px;cursor:pointer}
button:disabled{background:#999}
#msg{margin-top:12px;font-size:15px;text-align:center}
.ok-msg{color:#0b7;font-weight:700}.err-msg{color:#c33;font-weight:700}
.price{color:#0b7;font-weight:700}
video{width:100%;border-radius:10px;background:#000;display:block}
.trust{font-size:15px;line-height:2}
</style></head><body>
<div class="card">
<video src="/demo.mp4" controls playsinline preload="metadata"></video>
</div>
<div class="card">
<h1>مساعد الاستقبال الذكي 🤖</h1>
<p>عيادتك تخدم وحدها حتى كي تكون مسكّرة:</p>
<ul>
<li>يجاوب على رسائل المرضى بالدارجة التونسية، 24/7</li>
<li>يحجز المواعيد حتى كي تكون العيادة مسكّرة</li>
<li>السكرتيرة تبقى هي الي تقرّر الحجز النهائي</li>
<li>التركيب في 5 دقايق، والمريض يستعمل واتساب عادي</li>
<li>الشهر الأول <span class="price">بلاش</span>، وبعد <span class="price">2 دينار فقط</span> على كل مريض يوصل</li>
</ul>
</div>
<div class="card trust">
<p><b>كيفاش تخدم؟</b></p>
<p>1️⃣ تعمّر الاسم والنمر<br>2️⃣ نتّصلو بيك ونتفاهمو<br>3️⃣ نركّبولك البوت على نمر العيادة في 5 دقايق</p>
<p>💰 ما تخلّص <b>حتّى فرنك</b> كان المريض ما يوصلش</p>
</div>
<div class="card">
<label for="name">الاسم الكامل</label>
<input id="name" placeholder="مثال: محمد بن علي" autocomplete="name">
<label for="phone">رقم الهاتف</label>
<input id="phone" placeholder="مثال: 21650123456" inputmode="tel" autocomplete="tel">
<button id="btn" onclick="send()">اطلب تجربة بلاش</button>
<div id="msg"></div>
</div>
<script>
async function send(){const b=document.getElementById('btn');b.disabled=true;
const m=document.getElementById('msg');m.className='';m.textContent='...';
const data={name:document.getElementById('name').value,phone:document.getElementById('phone').value};
try{const r=await fetch('/api/signups',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
const j=await r.json();
if(r.ok&&j.ok){m.className='ok-msg';m.textContent='تمّ! وصلنا طلبك، باش نتّصلو بيك قريب. 👍';b.textContent='تبعث ✅';}
else{m.className='err-msg';m.textContent=j.error||'صار خطأ، جرّب مرة أخرى.';b.disabled=false;}
}catch(e){m.className='err-msg';m.textContent='مشكلة في الاتصال، جرّب مرة أخرى.';b.disabled=false;}}
</script></body></html>`;

app.get("/demo.mp4", (req, res) => res.sendFile(__dirname + "/demo.mp4"));
app.get("/formulaire", (req, res) => res.send(FORMULAIRE_PAGE));

app.post("/api/signups", async (req, res) => {
  const v = validateSignup(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const id = await db.saveSignup(v.name, v.phone, v.clinic_name, v.city);
    console.log(`[signup] #${id} ${v.name} — ${v.clinic_name} (${v.city}) ${v.phone}`);
    await notifySales(`📝 Formulaire jdid: ${v.name} — ${v.phone}`);
    res.json({ ok: true });
  } catch (e) {
    console.error("[signup:ERROR]", e.message);
    res.status(500).json({ error: "ma najjemtech nsajjel taw. 3awed ba3d chwaya." });
  }
});

// ---------- /api/clinics: per-number clinic configuration (admin) ----------
// password = VERIFY_TOKEN (same as /test). Every bot number (phone_number_id)
// carries its own clinic name, address, greeting, hours, and secretary number.
app.get("/api/clinics", async (req, res) => {
  if (req.query.password !== VERIFY_TOKEN) return res.status(403).json({ error: "wrong password" });
  const rows = await db.listClinicConfigs().catch(() => []);
  res.json({ ok: true, clinics: rows });
});

app.post("/api/clinics", async (req, res) => {
  const b = req.body || {};
  if (b.password !== VERIFY_TOKEN) return res.status(403).json({ error: "wrong password" });
  const numberId = String(b.phone_number_id || "").trim();
  if (!numberId) return res.status(400).json({ error: "phone_number_id lezem." });
  await db.saveClinicConfig(numberId, {
    clinic_name: String(b.clinic_name || "").slice(0, 150),
    address: String(b.address || "").slice(0, 300),
    greeting: String(b.greeting || "").slice(0, 500),
    hours: String(b.hours || "").slice(0, 200),
    secretary_number: String(b.secretary_number || "").replace(/\D/g, "").slice(0, 20),
  });
  res.json({ ok: true });
});

// ---------- /signups: admin list of doctors who filled the form ----------
const SIGNUPS_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signups</title>
<style>body{font-family:sans-serif;max-width:560px;margin:0 auto;padding:12px;background:#f5f5f5}
.card{background:#fff;border:1px solid #ccc;border-radius:8px;padding:10px;margin:8px 0}
.row{display:flex;gap:6px;margin-top:8px}
button{padding:8px 12px;border-radius:8px;border:0;font-size:14px;color:#fff;cursor:pointer}
.ok{background:#0b7}.no{background:#c33}
#pwrow{display:flex;gap:6px;margin-bottom:8px}
input{flex:1;padding:10px;border-radius:8px;border:1px solid #ccc;font-size:16px}
</style></head><body>
<h2>📝 Signups</h2>
<div id="pwrow"><input id="pw" type="password" placeholder="password (verify token)"><button class="ok" onclick="load()">Load</button></div>
<div id="list"></div>
<script>
let pw="";
function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
async function load(){pw=document.getElementById('pw').value;
const r=await fetch('/api/signups?password='+encodeURIComponent(pw));const j=await r.json();
const el=document.getElementById('list');
if(!r.ok){el.innerHTML='<p>⚠️ '+(j.error||'error')+'</p>';return;}
if(!j.signups.length){el.innerHTML='<p>Ma fama 7atta wa7ed 3ammer. 👍</p>';return;}
el.innerHTML=j.signups.map(s=>'<div class="card"><b>'+esc(s.name)+'</b> — '+esc(s.phone)+'<br>🏥 '+esc(s.clinic_name)+' — '+esc(s.city)+'<br><small>'+esc(s.created_at||'')+'</small><div class="row"><button class="no" onclick="del('+s.id+')">Fassa5</button></div></div>').join('');}
async function del(id){if(!confirm('Tfassa5 el signup #'+id+'?'))return;
const r=await fetch('/api/signups/'+id+'/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
const j=await r.json();if(!r.ok)alert(j.error||'error');load();}
</script></body></html>`;

app.get("/signups", (req, res) => res.send(SIGNUPS_PAGE));

app.get("/api/signups", async (req, res) => {
  if (req.query.password !== VERIFY_TOKEN) return res.status(403).json({ error: "wrong password" });
  const signups = await db.getSignups().catch(() => []);
  res.json({ signups });
});

app.post("/api/signups/:id/delete", async (req, res) => {
  if ((req.body || {}).password !== VERIFY_TOKEN) return res.status(403).json({ error: "wrong password" });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "bad id" });
  const deleted = await db.deleteSignup(id).catch(() => 0);
  res.json({ deleted });
});

app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  db.initDb(); // create tables if needed (memory + bookings)
  console.log(`AI: ${AI_API_KEY ? AI_MODEL + " via " + AI_BASE_URL : "FALLBACK mode (no AI_API_KEY)"}`);
  console.log(`WhatsApp: ${WHATSAPP_TOKEN && PHONE_NUMBER_ID ? "configured" : "NOT configured (set WHATSAPP_TOKEN + PHONE_NUMBER_ID)"}`);
  console.log(`Secretary: ${SECRETARY_NUMBER ? SECRETARY_NUMBER + " recognized" : "NOT set (set SECRETARY_NUMBER)"}`);
});

// Exported for the local regression test (test-local.js). No effect on the running server.
module.exports = { processPatientText, processSecretaryText, dates, looksLikeAcceptance, looksLikeStatusQuestion, looksLikeRefusal, SYSTEM_PROMPT, isAr, enforceScript, validateSignup,
  // batch fix 2026-09-24 detectors (exported for the regression test)
  looksLikeEmergency, looksLikeFrustration, looksLikeCancellation, faqKind, looksLikeWalkin,
  looksLikeTwoAppointments, looksLikeReschedule, looksLikeThirdPartyQuery, looksLikeBookingIntent,
  stripCorrectionPrefix, hasTimeSignal, stripTimeTokens, stripDateTokens, hoursCheck, CLINIC_HOURS,
  // batch fix 2026-09-25 (exported for the regression test)
  getClinic, scriptAr, looksLikeScriptRequest, looksLikeLatinRequest,
  aiClaimsBooking, guardAiOutput, AI_SAFE_FALLBACK, detectExplicitBeneficiaries, faqAnswer };
