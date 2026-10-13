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
const crypto = require("crypto");
const app = express();
// Capture the raw body: Meta's webhook signature is an HMAC of the raw bytes.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "clinic-bot-verify-123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
const AI_API_KEY = process.env.AI_API_KEY || "";
const AI_BASE_URL = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini";
const SECRETARY_NUMBER = (process.env.SECRETARY_NUMBER || "").replace(/\D/g, "");
// 2026-10-09: Global admin (Ahmed) — can send supervisor commands to ANY clinic
// without removing the clinic's own supervisor.
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || "17174204057").replace(/\D/g, "");
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
- Ma t5tar3ch ma3loumet (wa9t, blasa, soum): ken ma ta3rafch el jewb, a3redh bech tes2el el tbib BEL LUGHA MTA3 EL PATIENT, 7arfiyan b wa7da mel hedhom 7asb lughet el mou7adtha: bel derja: "Ma 3andich el ma3louma hethi. T7eb nes2el el tbib w narja3lek? Ekteb ey." — bel 3arbi: "ما عنديش المعلومة هذي. تحب نسأل الطبيب ونرجعلك؟ اكتب اي." — bel francais: "Je n'ai pas cette information. Voulez-vous que je demande au docteur ? Écrivez oui." (MAMNOU3 tekteb "n2akkedlek m3a el 3iyada" wa7dou — dima a3redh el sou2el 3al tbib b "ey"/"oui"/"اي" 7asb el lugha.)
- EL GREETING: ki t7el el conversation b t7iya (3aslema/slem...), 9oul 7arfiyan: "3aslema! Ena l'assistant mta3 {CLINIC_NAME} — Kifech najmou n3awnouk?" (badel {CLINIC_NAME} b esm el 3iyada eli 3tithoulek mel fou9). Ken el patient kteb bel 3arabiya: "عسلامة! أنا مساعد {CLINIC_NAME} — كيفاش نجمو نعاونوك؟". MAMNOU3: ma tzidch "kif int"/"kifek"/"labes"/"chnowa 7alek" — ma tes2elch 3la 7al el patient, od5el direct fel moudhou3. MAMNOU3 sigha o5ra — "chnowa n9dar n3awnek" ghalta, w "Nchalllah" ghalta (es7i7a: "Nchallah").
- JOUMAL EL E5ER (closing): ken t7eb tzid joumla mezyena fel e5er, esta3mel WA7DA mel hedhom 7arfiyan, ma tbadel 7atta 7arf: "ken 3andek ay sou2el e5er, tfadhel" / "t7eb n3awnek b 7aja o5ra?". Ken el patient kteb bel 3arabiya: "لو عندك أي سؤال آخر، تفضل" / "تحب نعاونك بحاجة أخرى؟". MAMNOU3 t5tare3 sigha o5ra — "ma t heshtich t3awdni" joumla ghalta w mamnou3a. Ken mech met2akked mel sigha, ma tzid chay fel e5er.`;

// ---------- Salon vertical (2026-10-01) ----------
// Persona for the salon demo number (53 180 566, in the Meta ad): a DEMO
// WhatsApp assistant for beauty salons in Tunisia. The audience is salon
// OWNERS trying the demo + clients playing along. Zero dental/medical
// vocabulary — this prompt must never mention 3iyada, tbib, mridh, dwe,
// wji3a, secretaire or consultation.
const SALON_SYSTEM_PROMPT = `Enti "Assistant Salon" — assistant WhatsApp lel les salons de beauté fi Tounes (nos5a lel tajrba).
- Jaweb dima bel derja tounsiya, w b i5tisar (message 9sir).
- 9A3DET EL SCRIPT: jewb dima bel script eli kteb bih el 7arif. Ken kteb bel 7rouf el 3arabiya, jewb bel 3arabiya. Ken kteb bel latiniya (arabizi), jewb bel latiniya. Ma t5alletch el zouz fi nafs el message.
- ANTI-MIXING (mohem barcha): el message el kemel lezem ykoun b script wa7ed 100% — mamnou3 kelma latin w kelma 3arabiya fi nafs el joumla.
- MAMNOU3 kelmet "robot" w "demo" — 9oul dima "assistant" w "tajrba" (ex: "assistant WhatsApp", "7ajz tajrba", "prix mthel").
- Enti TWARI chnowa ynajem ya3mel el assistant: les services (coiffure, brushing, chignon, maquillage, manucure, pédicure, épilation, soins visage), el prix (mthel lel tajrba), w el 7ajz (tajrba).
- ECHAFIYA (transparency): enti nos5a lel tajrba, mouch salon 7a9i9i. Ken 7ad yes2el "hedha vrai?", 9oul b wdhuh: "ena nos5a lel tajrba bech tchouf kifech ye5dem el assistant — fel salon el 7a9i9i el 7ajz yousal lel salon direct."
- El 7ajz houni SIMULÉ bark (tajrba) — ma fama 7atta 7ajz 7a9i9i w ma t2akked 7atta 7ajz b tari9a nehe2iya.
- MAMNOU3: ay kelma tibbiya (3iyada, tbib, mridh, dwe, wji3a, secretaire...). Ken 7ad yes2el 3la tbib wala wji3a, 9oul: "ena mte3 salon bark 💅 — hetha numero tajrba mte3 assistant el salons."
- PRIX (mthel lel tajrba — lezem dima t9oul "prix mthel", el prix el s7a7 tet7at mel salon el 7a9i9i): brushing 25 DT, coupe + brushing 45 DT, chignon 60 DT, maquillage 80 DT, manucure 30 DT, pédicure 35 DT, épilation (jambes) 40 DT, soins visage 70 DT, coloration 90 DT.
- Ken el moula y7eb el assistant lel salon mte3ou ("n7eb lel salon mte3i" walla ay sigha o5ra), ra7eb bih w 9ollou: "super! Ekteb «n7eb lel salon mte3i» bech n7adhrouhoulek" — el system yet3amel m3a el b9iya.
- Ken ma fhemtch el message, 9oul b wdhuh w i9tira7: les services, el prix, 7ajz tajrba ("n7eb na7jez"), walla "n7eb lel salon mte3i" ken 3andou salon.
- Ma t5tar3ch ma3loumet: ken ma ta3rafch 7aja, 9oul "fel tajrba hethi ma 3andich el ma3louma — fel salon el 7a9i9i el assistant ykoun m3abbi b les infos mte3ek."
- Ken el 7arifa met9al9a, ibda b "sama7ni" 9bal ma tkemel.`;

// ---------- Meta: send a WhatsApp text message ----------
// numberId: which bot number (phone_number_id) sends — defaults to the global
// PHONE_NUMBER_ID for single-number deployments.
const DEFAULT_NUMBER_ID = PHONE_NUMBER_ID;
async function sendWhatsApp(to, text, numberId) {
  const nid = numberId || DEFAULT_NUMBER_ID;
  if (!WHATSAPP_TOKEN || !nid) {
    console.log(`[send:SKIP] no token/phone_number_id. Would send to ${to}: ${text}`);
    return false;
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
    if (!res.ok) { console.error("[send:ERROR]", JSON.stringify(data)); return false; }
    console.log(`[send:OK] to ${to}: ${text.slice(0, 60)}...`);
    return true;
  } catch (e) {
    console.error("[send:ERROR]", e.message);
    return false;
  }
}

// ---------- Supervisor PDF report ("rapport") — 2026-10-08 ----------
// The supervisor (per-number config) sends "rapport" -> the bot builds a PDF
// with today's bookings for THIS clinic number and sends it back as a WhatsApp
// document. Shared code: works on every line, each with its own supervisor.
function todayInTunis() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tunis", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// Pure: builds the PDF, no network. Exported for the regression test.
function buildRapportPdf({ clinicName, dateLabel, bookings }) {
  const PDFDocument = require("pdfkit");
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(20).text("Rapport du jour", { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(12).text(String(clinicName || "Clinique"));
    doc.text("Date: " + String(dateLabel || ""));
    doc.moveDown();
    const list = Array.isArray(bookings) ? bookings : [];
    doc.fontSize(14).text(`Rendez-vous: ${list.length}`);
    doc.moveDown(0.5);
    if (!list.length) {
      doc.fontSize(12).fillColor("gray").text("Ma fama 7atta rendez-vous lyoum.");
    } else {
      doc.fontSize(12).fillColor("black");
      for (const b of list) {
        const when = b.slot_at
          ? new Intl.DateTimeFormat("fr-FR", { timeZone: "Africa/Tunis", hour: "2-digit", minute: "2-digit" }).format(new Date(b.slot_at))
          : (b.slot || "");
        const who = b.patient_name || b.phone || "";
        // Display status in French for the PDF (2026-10-08): pending -> en cours.
        const stFr = { pending: "en cours", confirmed: "confirmé", cancelled: "annulé" }[b.status] || b.status || "";
        doc.text(`  ${when} — ${who} (${stFr})`);
      }
    }
    doc.moveDown();
    doc.fontSize(10).fillColor("gray").text("Genere par l'assistant — " + new Date().toISOString().slice(0, 10));
    doc.end();
  });
}

// Uploads a PDF to Meta media endpoint, then sends it as a WhatsApp document.
async function sendWhatsAppDocument(to, pdfBuffer, filename, caption, numberId) {
  const nid = numberId || DEFAULT_NUMBER_ID;
  if (!WHATSAPP_TOKEN || !nid) {
    console.log(`[sendDoc:SKIP] no token/phone_number_id. Would send PDF to ${to}`);
    return false;
  }
  try {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", new Blob([pdfBuffer], { type: "application/pdf" }), filename || "rapport.pdf");
    const up = await fetch(`https://graph.facebook.com/v21.0/${nid}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      body: form,
    });
    const upData = await up.json();
    if (!up.ok || !upData.id) { console.error("[sendDoc:UPLOAD_ERROR]", JSON.stringify(upData)); return false; }
    const res = await fetch(`https://graph.facebook.com/v21.0/${nid}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: { id: upData.id, filename: filename || "rapport.pdf", caption: caption || "" },
      }),
    });
    const data = await res.json();
    if (!res.ok) { console.error("[sendDoc:ERROR]", JSON.stringify(data)); return false; }
    console.log(`[sendDoc:OK] PDF to ${to}`);
    return true;
  } catch (e) {
    console.error("[sendDoc:ERROR]", e.message);
    return false;
  }
}

// ---------- Template messages (2026-10-09) ----------
// Templates bypass the 24h customer-service window: they always deliver,
// even when the recipient hasn't messaged the bot recently. Used for
// supervisor notifications (notif_booking, notif_question, rapport) and
// doctor->patient messages (message_docteur).
// bodyParams: {param_name: value} for named params, or [v1, v2...] positional.
// opts.headerDocument: {buffer, filename} -> uploaded, sent as document header.
// opts.dateParams: [names...] -> those named params sent as date_time type.
// opts.language: template language code (default "fr").
async function uploadMedia(buffer, filename, numberId) {
  const nid = numberId || DEFAULT_NUMBER_ID;
  if (!WHATSAPP_TOKEN || !nid) return null;
  try {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", new Blob([buffer], { type: "application/pdf" }), filename || "file.pdf");
    const up = await fetch(`https://graph.facebook.com/v21.0/${nid}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      body: form,
    });
    const data = await up.json();
    if (!up.ok || !data.id) { console.error("[uploadMedia:ERROR]", JSON.stringify(data)); return null; }
    return data.id;
  } catch (e) { console.error("[uploadMedia:ERROR]", e.message); return null; }
}

async function sendTemplate(to, templateName, bodyParams, opts, numberId) {
  const nid = numberId || DEFAULT_NUMBER_ID;
  if (!WHATSAPP_TOKEN || !nid) {
    console.log(`[template:SKIP] no token/phone_number_id. Would send ${templateName} to ${to}`);
    return false;
  }
  // 2026-10-09: Jrad's WABA templates use NUMBERED params ({{1}}, {{2}}) because
  // Meta's UI rejects named params. Convert named -> positional for his number.
  // Other WABAs (with API-created named-param templates) are untouched.
  const JRAD_ID = "1445223932002571";
  let params = bodyParams;
  let o = opts || {};
  let tName = templateName;
  if (nid === JRAD_ID) {
    // notif_booking was rejected; recreated as notif_booking7.
    if (tName === "notif_booking") tName = "notif_booking7";
    // notif_booking7 uses NAMED params ({{patient_name}} etc. — "Type of variable: Name"
    // in Meta UI). Keep them named; Meta rejects positional for this template.
    // Other Jrad templates use numbered params → convert those to positional.
    if (tName !== "notif_booking7" && bodyParams && !Array.isArray(bodyParams)) {
      params = Object.values(bodyParams);
      // date_time params don't work positional; send as text.
      o = { ...o, dateParams: [] };
    }
  }
  try {
    const components = [];
    if (o && o.headerDocument) {
      const mediaId = await uploadMedia(o.headerDocument.buffer, o.headerDocument.filename, nid);
      if (!mediaId) return false;
      components.push({
        type: "header",
        parameters: [{ type: "document", document: { id: mediaId, filename: o.headerDocument.filename || "rapport.pdf" } }],
      });
    }
    const dateParams = new Set((o && o.dateParams) || []);
    const bodyParameters = [];
    if (Array.isArray(params)) {
      for (const v of params) bodyParameters.push({ type: "text", text: String(v) });
    } else {
      for (const [k, v] of Object.entries(params || {})) {
        if (dateParams.has(k)) bodyParameters.push({ type: "date_time", parameter_name: k, date_time: { fallback_value: String(v) } });
        else bodyParameters.push({ type: "text", parameter_name: k, text: String(v) });
      }
    }
    if (bodyParameters.length) components.push({ type: "body", parameters: bodyParameters });
    const res = await fetch(`https://graph.facebook.com/v21.0/${nid}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: { name: tName, language: { code: (o && o.language) || "fr" }, components },
      }),
    });
    const data = await res.json();
    if (!res.ok) { console.error("[template:ERROR]", tName, JSON.stringify(data)); return false; }
    console.log(`[template:OK] ${tName} to ${to}`);
    return true;
  } catch (e) {
    console.error("[template:ERROR]", tName, e.message);
    return false;
  }
}

// Supervisor number for THIS clinic (per-number config), falling back to global.
function supervisorNumber(clinic) {
  return (clinic && clinic.secretary) || SECRETARY_NUMBER || null;
}

// ---------- ONE supervisor-notification mechanism (Fix S, 2026-10-13) ----------
// The smart hybrid, implemented exactly once: if the supervisor messaged
// this bot number <24h ago, a free-form message delivers (and is free);
// otherwise a template is required — a free-form send outside the 24h
// window fails with Meta error 131047 (seen live 2026-10-13: Dr Jrad
// never received a patient's forwarded question because that branch sent
// free-form unconditionally, while the booking notification already had
// the hybrid inline). Every supervisor-bound notification goes through
// here. Callers pass templateName=null when NO template exists for their
// message: free-form is then sent as before (best effort — outside the
// window it can still fail; that gap is flagged, never silently invented).
async function notifySupervisor(clinic, freeFormText, templateName, templateParams) {
  const sup = supervisorNumber(clinic);
  if (!sup) {
    console.log("[notify:SKIP] no supervisor number set");
    return false;
  }
  const nid = clinic && clinic.id;
  if (templateName) {
    const lastSupMsg = await db.getLastSupervisorMessageTime(sup, nid).catch(() => null);
    const windowOpen = lastSupMsg && (Date.now() - new Date(lastSupMsg).getTime()) < 24 * 60 * 60 * 1000;
    if (!windowOpen) {
      return sendTemplate(sup, templateName, templateParams || {}, {}, nid).catch(() => false);
    }
  }
  if (freeFormText) return sendWhatsApp(sup, freeFormText, nid).catch(() => false);
  return sendTemplate(sup, templateName, templateParams || {}, {}, nid).catch(() => false);
}

// Normalize a phone for comparison: strip the country code so "+1 717..." and
// "717..." (or "+216 98..." and "98...") always match. General rule, not per-number.
function normPhoneForCompare(s) {
  let d = String(s || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("216")) d = d.slice(3); // TN -> 8 digits
  else if (d.length === 11 && d.startsWith("1")) d = d.slice(1); // US -> 10 digits
  return d;
}
function samePhone(a, b) {
  const x = normPhoneForCompare(a), y = normPhoneForCompare(b);
  return !!x && !!y && x === y;
}

// ---------- Agenda photo -> bookings (2026-10-08) ----------
// The supervisor photographs the paper agenda -> the bot reads it (vision AI),
// lists what it found, and saves on "ey". One photo a day, no typing.
// Shared code: works on every line, each with its own supervisor.
const pendingAgenda = new Map(); // supervisorPhone -> [{name, date, time, unsure}]

// ---------- Hard-question escalation (2026-10-09) ----------
// The bot offers "T7eb nes2el el tbib? Ekteb ey." -> patient "ey" forwards the
// question to the supervisor via the notif_question template (bypasses 24h).
// The supervisor's next free-text reply becomes the doctor's answer to the patient.
const pendingQuestion = new Map(); // patientPhone -> {question, clinicId, ts}
const pendingDoctorAnswer = new Map(); // clinicId -> {patientPhone, question, ts}
const QUESTION_TTL_MS = 30 * 60 * 1000; // patient offer expires after 30 min
const ANSWER_TTL_MS = 2 * 3600 * 1000; // doctor answer window: 2h

async function downloadWhatsAppMedia(mediaId) {
  if (!WHATSAPP_TOKEN || !mediaId) return null;
  try {
    const meta = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    const j = await meta.json();
    if (!j.url) { console.error("[agenda:MEDIA_URL_ERROR]", JSON.stringify(j).slice(0, 200)); return null; }
    const dl = await fetch(j.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    if (!dl.ok) return null;
    return Buffer.from(await dl.arrayBuffer());
  } catch (e) {
    console.error("[agenda:DOWNLOAD_ERROR]", e.message);
    return null;
  }
}

async function extractAgendaFromImage(buffer) {
  if (!AI_API_KEY || !buffer) return null;
  const today = todayInTunis().split("-").reverse().join("-"); // DD-MM-YYYY
  const prompt =
    "Tu lis un agenda papier d'une clinique. Extrais tous les rendez-vous visibles. " +
    "Reponds UNIQUEMENT avec un JSON array, sans texte autour: " +
    '[{"name":"nom du patient","date":"DD-MM-YYYY","time":"HH:MM","unsure":false}]. ' +
    `Si la date n'est pas visible, utilise ${today}. ` +
    "Si un nom ou une heure est illisible, mets unsure:true. " +
    "Si aucun rendez-vous visible, reponds [].";
  try {
    const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [{ role: "user", content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${buffer.toString("base64")}` } },
        ] }],
        max_tokens: 1000,
        temperature: 0,
      }),
    });
    const j = await res.json();
    return j.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.error("[agenda:VISION_ERROR]", e.message);
    return null;
  }
}

// Pure: parses the vision model's JSON (tolerates markdown fences). Exported for tests.
function parseAgendaJson(text) {
  if (!text || typeof text !== "string") return [];
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((it) => it && (it.name || it.time))
      .map((it) => ({
        name: String(it.name || "").slice(0, 80),
        date: /^\d{2}-\d{2}-\d{4}$/.test(it.date || "") ? it.date : todayInTunis().split("-").reverse().join("-"),
        time: /^\d{1,2}:\d{2}$/.test(it.time || "") ? it.time : "",
        unsure: !!it.unsure,
      }));
  } catch {
    return [];
  }
}

function agendaItemSlot(it) {
  // it.date = DD-MM-YYYY, it.time = HH:MM -> display + ISO (Tunis, UTC+1 no DST)
  const [dd, mm, yyyy] = it.date.split("-");
  const [hh, mi] = (it.time || "09:00").split(":");
  const p = (s) => String(s).padStart(2, "0");
  return {
    display: `${p(dd)}-${p(mm)}-${yyyy}, ${p(hh)}:${p(mi)}`,
    iso: `${yyyy}-${p(mm)}-${p(dd)}T${p(hh)}:${p(mi)}:00+01:00`,
  };
}

async function processSupervisorImage(from, mediaId, clinic, numberId) {
  const buf = await downloadWhatsAppMedia(mediaId);
  if (!buf) return "Ma najjamtch n7ell el taswira. 3awed ab3athha. ❌";
  const raw = await extractAgendaFromImage(buf);
  if (!raw) return "Ma najjamtch na9ra el taswira tawa (AI). 3awed ba3d chwaya. ❌";
  const items = parseAgendaJson(raw);
  if (!items.length) return "Ma l9it 7atta rendez-vous fi el taswira. 📷";
  pendingAgenda.set(from, items);
  const lines = items.map((it, i) => {
    const s = agendaItemSlot(it);
    return `${i + 1}. ${it.name || "?"} — ${s.display}${it.unsure ? " (?) " : ""}`;
  });
  const unsure = items.filter((it) => it.unsure).length;
  console.log(`[agenda] ${items.length} items from ${from} (${unsure} unsure)`);
  return `L9it ${items.length} rendez-vous fi el taswira:\n${lines.join("\n")}\n` +
    (unsure ? `⚠️ ${unsure} mech wadh7in — thabbet fihom.\n` : "") +
    `Nsajelhom? (ey / le)`;
}

// ---------- French voice note (REMOVED 2026-09-29) ----------
// The French TTS voice note was removed: French is now text-only.
// The bot still understands French and replies in French text when the
// patient explicitly asks ("jewbni bel français"). Derja behavior unchanged.

// Notify the secretary of THIS bot number's clinic (per-number config),
// falling back to the global SECRETARY_NUMBER.
async function notifySecretary(text, clinic) {
  // Via the shared supervisor helper (Fix S). No template exists for these
  // free-text alerts (cancellation / reschedule / emergency / other-doctor),
  // so templateName=null: free-form, exactly as before.
  await notifySupervisor(clinic, text, null, null);
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
// Seed configs: built-in per-number defaults so a freshly deployed server
// works out of the box. A row in clinic_configs (set via POST /api/clinics)
// always wins over the seed — the partner's corrections go there, no ZIP
// needed. booking_hours format: "dow:start-end;..." e.g. "1:8-16;6:8-13"
// (dow 0=Sunday). other_doctor: name of another doctor sharing the clinic —
// patients asking for them are handed to the secretary, never booked by bot.
// Shared VIXA sales greeting (used by the id seed and the display-number
// seed below — one source of truth so they can never drift apart).
const VIXA_GREETING =
  "Ahla w sahla! 👋 Ena Assistant VIXA — n3awen les cliniques fi Tounes bech yjewbou 3la les patients mte3hom 3la WhatsApp.\n" +
  "Enti tbib walla 3andek 3iyada/cabinet? (ey / le)";
const VIXA_GREETING_AR =
  "أهلا وسهلا! 👋 أنا مساعد VIXA — نعاون العيادات في تونس باش يجاوبو على المرضى متاعهم على واتساب.\n" +
  "انتي طبيب ولا عندك عيادة؟ (أي / لا)";

const SEED_CLINICS = {};
// DENTIST PILOT (2026-10-07): Dr Issam Mahjoub's config, shared by the
// phone_number_id seed and the display-number seed below (one source of
// truth). +216 52 150 093 answers as his Derja receptionist.
const SEED_MAHJOUB = {
  vertical: "dentist",
  clinic_name: "Cabinet Dr Issam Mahjoub",
  address: "4ème étage, Immeuble Ghannouchi, Rue Tarek Ibn Zied - Sousse",
  greeting:
    "Ahla w sahla! 👋 Ena l'assistant mta3 Cabinet Dr Issam Mahjoub 🦷\n" +
    "T7eb ta7jez rendez-vous? 9olli nhar w wa9et, w ena nchouflek el disponibilité.",
  greeting_ar:
    "أهلا وسهلا! 👋 أنا مساعد عيادة الدكتور عصام محجوب 🦷\n" +
    "تحب تحجز موعد؟ قولي نهار ووقت، وأنا نشوفلك المواعيد المتاحة.",
  hours: "Thenin lel Jom3a: 08:30 - 17:30, Sebt: 08:30 - 13:00, Ahad: msakker",
  booking_hours: "1:8-17;2:8-17;3:8-17;4:8-17;5:8-17;6:8-13",
  secretary_number: "98800749",
  other_doctor: "",
};
SEED_CLINICS["1364750653386950"] = SEED_MAHJOUB;
// Display-number seed (no phone_number_id needed): the pilot identity
// resolves even when only the display number is known.
const SEED_DENTIST_BY_NUMBER = { "52150093": SEED_MAHJOUB };

// ---------- Dr Marwen Jrad (Djerba) — 2nd pilot, 2026-10-09 ----------
// +216 94 032 352, phone_number_id 1445223932002571, dentist.
const SEED_JRAD = {
  vertical: "dentist",
  clinic_name: "Cabinet Dr Marwen Jrad",
  address: "Av. Habib Bourguiba, Houmt Souk, 4180 Djerba",
  greeting:
    "Ahla w sahla! 👋 Ena l'assistant mta3 Cabinet Dr Marwen Jrad 🦷 — kifech najmou n3awnouk?",
  greeting_ar:
    "أهلا وسهلا! 👋 أنا مساعد عيادة الدكتور مروان جراد 🦷 — كيفاش نجمو نعاونوك؟",
  hours: "Thenin lel 5mis: 09:00 - 16:00, Jom3a w Sebt: 09:00 - 14:00, Ahad: msakker",
  booking_hours: "1:9-16;2:9-16;3:9-16;4:9-16;5:9-14;6:9-14",
  secretary_number: "28192232",
  other_doctor: "",
};
SEED_CLINICS["1445223932002571"] = SEED_JRAD;
SEED_DENTIST_BY_NUMBER["94032352"] = SEED_JRAD;

// Parse "1:8-16;2:8-16;6:8-13" into {1:[8,16],2:[8,16],6:[8,13]}.
// Returns null on empty/invalid input (caller falls back to CLINIC_HOURS).
function parseBookingHours(str) {
  if (!str || typeof str !== "string") return null;
  const out = {};
  for (const part of str.split(";")) {
    const m = part.trim().match(/^([0-6]):(\d{1,2})-(\d{1,2})$/);
    if (!m) return null;
    const dow = parseInt(m[1], 10), s = parseInt(m[2], 10), e = parseInt(m[3], 10);
    if (!(s >= 0 && s < e && e <= 24)) return null;
    out[dow] = [s, e];
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// Verticals (2026-10-01, +vixa 2026-10-06): "dentist" (default — the full
// clinic behavior below) vs "salon" (demo/sales bot for beauty-salon owners)
// vs "vixa" (SALES bot for clinic owners — assign via VIXA_NUMBERS env var,
// was on +216 52 150 093 until 2026-10-07, now Dr Mahjoub's dentist pilot).
// A bot number's vertical resolves per message, in this order:
//   1. explicit DB row (POST /api/clinics, field "vertical": "salon"|"vixa"|"dentist")
//   2. display-number seed (salon/vixa ad numbers — no phone_number_id needed)
//   3. phone_number_id seed (SEED_CLINICS)
//   4. "dentist" (default — current behavior 100% unchanged)
// ---------------------------------------------------------------------------
// Normalize a WhatsApp display number to the Tunisian local form (8 digits):
// "21653180566", "+216 53 180 566" and "53180566" all -> "53180566".
function localNumber(s) {
  let d = String(s || "").replace(/\D/g, "");
  if (d.length > 8 && d.startsWith("216")) d = d.slice(3);
  return d;
}
// Salon demo numbers: the ad number is seeded; more can be added without a
// code change via SALON_NUMBERS="53180566,52123456".
const SALON_SEED_NUMBERS = new Set(
  ["53180566", ...String(process.env.SALON_NUMBERS || "").split(",").map(localNumber)].filter(Boolean)
);
function isSalonDisplayNumber(displayNumber) {
  return SALON_SEED_NUMBERS.has(localNumber(displayNumber));
}

// Seed config for the salon demo number, keyed by LOCAL number (not
// phone_number_id — Ahmed never has to dig that up). A DB row for the
// number's phone_number_id always wins over this seed.
const SEED_SALON_BY_NUMBER = {
  "53180566": {
    vertical: "salon",
    clinic_name: "Assistant Salon (Demo)",
    address: "",
    greeting:
      "Ahla w sahla! 💇‍♀️ Ena Assistant Salon — assistant WhatsApp lel les salons de beauté fi Tounes.\n" +
      "Jarbni kima 7arifa: 9olli «chnowa el services?» walla «n7eb na7jez» 💅\n" +
      "W ken 3andek salon w t7eb wa7ed kifou, ekteb «n7eb lel salon mte3i».",
    greeting_ar:
      "أهلا وسهلا! 💇‍♀️ أنا مساعد الصالون — مساعد واتساب لصالونات التجميل في تونس.\n" +
      "جرّبني كيما حريفة: قولي «شنوة الخدمات؟» ولا «نحب نحجز» 💅\n" +
      "وكان عندك صالون وتحب واحد كيفو، اكتب «نحب للصالون متاعي».",
    hours: "",
    booking_hours: "",
    secretary_number: "",
    other_doctor: "",
  },
};

// Seed config for the VIXA sales number, keyed by LOCAL number (not
// phone_number_id — Ahmed never has to dig that up). More sales numbers can
// be added without a code change via VIXA_NUMBERS="52150093,...".
// (2026-10-07: 52150093 moved back to dentist pilot for Dr Mahjoub — the set
// is empty until the next sales number is assigned.)
const VIXA_SEED_NUMBERS = new Set(
  [...String(process.env.VIXA_NUMBERS || "").split(",").map(localNumber)].filter(Boolean)
);
function isVixaDisplayNumber(displayNumber) {
  return VIXA_SEED_NUMBERS.has(localNumber(displayNumber));
}
const SEED_VIXA_BY_NUMBER = {
  // (2026-10-07: 52150093 entry removed — back to dentist pilot.
  // Future sales numbers get their entry here.)
};
// Default identity for VIXA sales numbers added via VIXA_NUMBERS env var
// (no hardcoded entry): vertical vixa + VIXA name/greeting.
const SEED_VIXA_DEFAULT = {
  vertical: "vixa",
  clinic_name: "VIXA",
  address: "",
  greeting: VIXA_GREETING,
  greeting_ar: VIXA_GREETING_AR,
  hours: "",
  booking_hours: "",
  secretary_number: "17174204057",
  other_doctor: "",
};
// Direct seed by phone_number_id (2026-10-08): does not depend on the
// VIXA_NUMBERS env var or on the display-number format — the ID never changes.
// 53 = VIXA sales line, supervisor = Ahmed.
const SEED_VIXA_BY_ID = {
  "1322286220971446": SEED_VIXA_DEFAULT,
};

async function getClinic(numberId, displayNumber) {
  const id = numberId || DEFAULT_NUMBER_ID;
  const cfg = await db.getClinicConfig(id);
  const seed = SEED_CLINICS[id] || {};
  const dispSeed = SEED_VIXA_BY_ID[id] ||
    SEED_SALON_BY_NUMBER[localNumber(displayNumber)] ||
    SEED_DENTIST_BY_NUMBER[localNumber(displayNumber)] ||
    SEED_VIXA_BY_NUMBER[localNumber(displayNumber)] ||
    (isVixaDisplayNumber(displayNumber) ? SEED_VIXA_DEFAULT : {}) || {};
  // A DB row wins over the seed. ?? (not ||) so the partner can CLEAR a
  // seed value by saving "" — only null/undefined fall back to the seed.
  const pick = (k, fb) => (cfg && cfg[k] != null ? cfg[k] : dispSeed[k] ?? seed[k] ?? fb ?? "");
  // Vertical: explicit DB value > display-number seed > id seed > dentist.
  // "" counts as unset (old DB rows) — only "salon"/"vixa"/"dentist" are real.
  const vOf = (o) => (o && (o.vertical === "salon" || o.vertical === "vixa" || o.vertical === "dentist") ? o.vertical : null);
  const vertical = isVixaDisplayNumber(displayNumber) ? "vixa" : (vOf(cfg) || vOf(dispSeed) || vOf(seed) || "dentist");
  const out = {
    id,
    vertical,
    name: pick("clinic_name", CLINIC_NAME),
    address: pick("address", CLINIC_ADDRESS),
    greeting: pick("greeting", CLINIC_GREETING),
    greetingAr: pick("greeting_ar", ""),
    hours: pick("hours", CLINIC_HOURS_TXT_ENV),
    bookingHours: parseBookingHours(pick("booking_hours", "")) || null,
    otherDoctor: pick("other_doctor", ""),
    // Viewer PIN (2026-10-09): DB-only, never in seeds. Empty = no PIN required.
    viewer_pin: (cfg && cfg.viewer_pin) || "",
    // Secretary: an empty DB value falls back to the seed (a missing supervisor
    // is never intentional — without it no supervisor command can ever run).
    // 2026-10-08: 53/VIXA seed carries Ahmed's number so "rapport" works there.
    secretary: (() => {
      const fromDb = (cfg && cfg.secretary_number != null ? String(cfg.secretary_number) : "").replace(/\D/g, "");
      if (fromDb) return fromDb;
      const fromSeed = String(dispSeed.secretary_number || seed.secretary_number || "").replace(/\D/g, "");
      return fromSeed || SECRETARY_NUMBER;
    })(),
  };
  // VIXA sales guard (kept for future sales numbers): the "Cabinet Dr Ines"
  // pilot identity must NEVER leak into a VIXA sales reply (e.g. via a stale
  // DB row) — force the VIXA identity when vertical is vixa.
  if (out.vertical === "vixa") {
    if (/ines/i.test(out.name)) out.name = "VIXA";
    if (/ines/i.test(out.greeting)) out.greeting = VIXA_GREETING;
    if (/إيناس|ايناس/i.test(out.greetingAr)) out.greetingAr = VIXA_GREETING_AR;
  }
  return out;
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

// ---------- Central conversation language (Fix S, 2026-10-13) ----------
// ONE resolver for every patient-facing reply: 'ar' | 'fr' | 'az'.
// Language handling used to be scattered (scriptAr's binary Arabic-vs-Latin
// at ~9 call sites + a separate French detection in the booking flow), so a
// reply branch with only Arabic/Arabizi variants answered a French patient
// in Arabizi (Prignol incident, 2026-10-13). Every reply path now resolves
// the conversation language HERE and picks its wording from the MSG catalog.
// Priority: explicit request in this message > Arabic script in this message
// > saved preference > this message's own markers > sticky context (pending
// proposal's words, then the patient's recent messages) > AI semantic check
// (opt-in, booking path) > Derja default. A short reply ("oui", "ey", "ok",
// a name) carries no marker, so it falls through to the sticky context and
// can never flip or reset the conversation language.
function langOfText(text) {
  if (isAr(text)) return "ar";
  if (hasDerjaMarker(text)) return "az";
  if (looksLikeFrenchAuto(text)) return "fr";
  return null; // neutral: digits, names, "oui", "ok"...
}

async function resolveLang(phone, text, opts = {}) {
  // 1) Explicit requests in THIS message win (and are persisted by the
  //    caller, exactly like the old script-pref saves).
  if (looksLikeFrenchRequest(text)) return "fr";
  if (looksLikeScriptRequest(text)) return "ar";
  if (looksLikeLatinRequest(text)) return "az";
  // 2) Arabic script anywhere in the message wins over French.
  if (isAr(text)) return "ar";
  // 3) Saved preference (set by an explicit request earlier).
  const pref = await db.getScriptPref(phone).catch(() => null);
  if (pref === "ar") return "ar";
  if (pref === "fr") return "fr";
  // 4) This message's own markers.
  const own = langOfText(text);
  if (own) return own;
  // 5) Sticky context — SHORT replies only ("oui", "ey", "ok", a name):
  // a full sentence in another language is a language switch, not a
  // follow-up, and must win on its own (regression: a Derja availability
  // question after one French message is answered in Derja). Pending
  // proposal's words first, then the patient's recent messages.
  const wordCount = (text || "").trim().split(/\s+/).filter((w) => /[a-zà-ÿ\u0600-\u06FF]/i.test(w)).length;
  if (wordCount <= 3) {
    if (opts.proposalText) {
      const pl = langOfText(opts.proposalText);
      if (pl) return pl;
    }
    const hist = opts.history || [];
    for (let i = hist.length - 1; i >= 0; i--) {
      if (!hist[i] || hist[i].role !== "user") continue;
      const hl = langOfText(hist[i].text);
      if (hl) return hl;
    }
  }
  if (pref === "latin") return "az";
  // 6) Semantic fallback (AI) — only where the caller opts in: the booking
  //    path historically asked the AI when the word lists were unsure.
  if (opts.aiCheck && await aiLangIsFrench(text)) return "fr";
  return "az";
}

// Legacy binary view of the resolver (salon/VIXA sales flows and older call
// sites only ever asked "Arabic script or not?"). New patient-path code
// must use resolveLang + the MSG catalog instead.
async function scriptAr(phone, text) {
  return (await resolveLang(phone, text)) === "ar";
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

// Deterministic guard over every AI reply (2026-10-07): the AI must never
// invent a booking, date, time, or price — the deterministic flow owns those
// words. But it strips ONLY the invented sentence(s) and keeps the true
// answer: "Nsakrou el 17:30. T7eb n7ajzlek rendez-vous ghodwa?"
// -> "Nsakrou el 17:30." (Before: the whole reply was nuked and the patient
// got the dumb "Tfadhel, chnowa t7eb bedhabt?" fallback.)
function stripPhantomSentences(text) {
  const parts = String(text || "").split(/(?<=[.!?؟])\s+/);
  const kept = parts.filter((s) => !aiClaimsBooking(s));
  return kept.join(" ").trim();
}

function guardAiOutput(aiText, aiFailed, fallbackText) {
  if (aiFailed || !aiText) return fallbackText;
  if (!aiClaimsBooking(aiText)) return fixKnownTypos(aiText);
  const stripped = stripPhantomSentences(aiText);
  return stripped ? fixKnownTypos(stripped) : fallbackText;
}

// Deterministic typo guard (2026-10-01): the AI keeps inventing "Nchalllah"
// despite the EL GREETING prompt rule (seen live: "3aslema! Nchalllah labes").
// Prompts are words, not law — fix it in code, on every AI reply.
// Only the triple-l typo is rewritten; a correct "nchallah" is left alone,
// and the original case (N/n) is preserved.
function fixKnownTypos(s) {
  return String(s || "").replace(/nchall{2,}ah/gi, (m) =>
    (m[0] === m[0].toUpperCase() ? "Nchallah" : "nchallah"));
}

// ---------- AI: Derja reply (with conversation history) ----------
async function aiReply(patientText, history = [], patientName = null, clinicName = "", useAr = null, extraSys = "", sysOverride = null, clinicAddress = "", clinicHours = "") {
  // Resolved script: explicit patient request > saved preference > message script.
  const ar = useAr !== null ? useAr : isAr(patientText);

  // Fallback: keyword replies so the webhook loop works even without an AI key
  if (!AI_API_KEY) return fallbackReply(patientText, ar, clinicName, clinicAddress);

  // sysOverride (French test): full replacement — never layered on SYSTEM_PROMPT.
  // {CLINIC_NAME} in any prompt is replaced with the real clinic name (greeting).
  let sys = sysOverride || (SYSTEM_PROMPT + (patientName
    ? `\n- esm el patient: ${patientName} — esta3mel el esm ki ykoun naturel (kima "Ahlan Ahmed!"), ama el script yab9a 7asb el 9a3da (ma t5alletch).`
    : "") + (clinicName
    ? `\n- esm el 3iyada: "${clinicName}" — ki yse2lou 3la esm el 3iyada, jaweb bel esm hedha bedhabt, ma t5alla9ch esm e5er.`
    : "") + (ar && !isAr(patientText)
    ? `\n- el patient tlab sara7atan bech tektbelou bel 3arbi (Arabic script) — ektbelou bel 3arbi, ma t7awelch lel 7rouf el latiniya.`
    : "") + extraSys);
  sys = sys.split("{CLINIC_NAME}").join(clinicName || "el 3iyada");
  // True clinic facts in EVERY AI call (2026-10-07): the AI used to invent
  // address/hours because it never knew them — the guard then nuked the whole
  // reply. With the real facts in the prompt, FAQ answers are truthful and
  // the guard has nothing to block. French prompt -> French facts.
  const fr = !!sysOverride;
  if (clinicAddress) sys += fr
    ? `\n- Adresse de la clinique : "${clinicAddress}" — si on vous demande l'adresse, donnez exactement celle-ci, n'en inventez jamais d'autre.`
    : `\n- 3onwen el 3iyada: "${clinicAddress}" — ki yse2lou 3la el blasa wel 3onwen, jaweb bel 3onwen hedha bedhabt, ma t5alla9ch 3onwen e5er.`;
  // Fix W: the hours fact handed to the AI is rendered in the
  // conversation's language first — the prompt orders the AI to quote it
  // exactly, so the raw (Arabizi-authored) config string would otherwise
  // be quoted verbatim to a French or Arabic patient.
  const hoursFact = renderHoursText(clinicHours, ar ? "ar" : fr ? "fr" : "az") || clinicHours;
  if (hoursFact) sys += fr
    ? `\n- Horaires de la clinique : "${hoursFact}" — si on vous demande les horaires, donnez exactement ceux-ci, n'en inventez jamais d'autres.`
    : `\n- wa9t el 5edma: "${hoursFact}" — ki yse2lou 3la el wa9t, jaweb b hedha bedhabt, ma t5alla9ch wa9t e5er.`;

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
    return msg("ai_error", ar ? "ar" : fr ? "fr" : "az");
  }
  const out = data.choices?.[0]?.message?.content?.trim() || "";
  // Deterministic guard: the AI must never invent a booking, date, time, or price.
  return guardAiOutput(
    enforceScript(out, patientText, ar),
    false,
    msg("ai_safe_fallback", ar ? "ar" : fr ? "fr" : "az")
  );
}

function fallbackReply(text, forceAr, clinicName = "", clinicAddress = "") {
  // Fix V: the lenient detector counts too — the strict looksLikeFrench
  // vetoes any text containing " le " (a Derja negation), which silently
  // routed ordinary French sentences ("...le docteur...") to the Arabizi
  // fb_unknown menu. looksLikeFrenchAuto still vetoes real Derja first
  // (hasDerjaMarker), so Derja routing is unchanged.
  if (looksLikeFrench(text) || looksLikeFrenchAuto(text)) return frenchFallback(text, clinicName, clinicAddress);
  // Fix S: wording from the MSG catalog (fb_* keys); detection order unchanged.
  const lang = (forceAr !== undefined ? forceAr : isAr(text)) ? "ar" : "az";
  const ctx = { clinicName, address: clinicAddress };
  // Red line first (Fix T, X9): medication/dosage wording is a medical
  // hand-off, never the price FAQ — "9adech" must not hijack it.
  if (looksLikeMedicalQuestion(text)) return msg("fb_medical", lang, ctx);
  if (lang === "ar") {
    if (/(سلام|عسلامة|صباح|مساء|اهلا|أهلا)/.test(text)) return msg("fb_greeting", lang, ctx);
    if (/(حجز|رونديفو|موعد)/.test(text)) return msg("fb_booking", lang, ctx);
    if (/(وين|بلاصة|عنوان|فين)/.test(text)) return msg("fb_place", lang, ctx);
    if (/(سوم|بقداش|فلوس|prix)/.test(text)) return msg("fb_price", lang, ctx);
    if (/(دواء|دوا|وجيعة|وجع|مريض)/.test(text)) return msg("fb_medical", lang, ctx);
    return msg("fb_unknown", lang, ctx);
  }
  const t = text.toLowerCase();
  if (t.includes("slem") || t.includes("slm") || t.includes("salem") || t.includes("salam") || t.includes("ahla") || t.includes("salut") || t.includes("bonjour") || t.includes("sbe7") || t.includes("mse"))
    return msg("fb_greeting", lang, ctx);
  if (t.includes("7ajz") || t.includes("7jez") || t.includes("rendez") || t.includes("rdv") || t.includes("wa9t"))
    return msg("fb_booking", lang, ctx);
  if (t.includes("win") || t.includes("blasa") || t.includes("adresse") || t.includes("ou"))
    return msg("fb_place", lang, ctx);
  if (t.includes("soum") || t.includes("prix") || t.includes("9adech") || t.includes("bikam"))
    return msg("fb_price", lang, ctx);
  if (t.includes("dwe") || t.includes("medicament") || t.includes("wji3a") || t.includes("douleur"))
    return msg("fb_medical", lang, ctx);
  return msg("fb_unknown", lang, ctx);
}

// ---------- Booking flow (Phase 2 + deterministic Derja dates) ----------
// A slot is only booked when it resolves to a CONCRETE date+time.
// "jem3a 10" alone -> the bot asks "sbe7 walla lil?" and shows "25-09-2026".

function looksLikeAcceptance(text) {
  const raw = (text || "").trim();
  // Fix X (ED5): a lone thumbs-up answers a proposal like "ey" does.
  // Anchored to the WHOLE message — "😀👍🙏" stays chitchat.
  if (/^👍\s*[.!]*$/.test(raw)) return true;
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

// French refusal of a pending proposal ("Non, pas ce jour-là") — a short
// non/pas opener with NO new slot in it. A digit means the message carries
// a new date/time ("non, le 6 à 10h") and the correction merge owns it.
// Only applied when the conversation is already French (fr2) — in Derja a
// leading "non" is not a standalone refusal form.
function looksLikeFrenchRefusal(text) {
  const t = (text || "").trim().toLowerCase();
  if (!/^(non|pas)\b/.test(t)) return false;
  if (/\d/.test(t)) return false;
  return t.length <= 40;
}

// ---------- Root-based intent matching ----------
// Tunisian verbs keep their consonant root across spelling variants:
//   f-s-5 (فسخ): fasa5, fas5, nfasa5, tafsa5li, yefsa5, nefsakh
//   7-j-z (حجز): na7jez, ne7jez, te7jez, e7jezli, a7jez
//   b-d-l (بدل): nbadal, nbadel, badal, ybadel
// rootRe("fs5") → /f[aeiou]*s[aeiou]*5/ — one pattern catches every vowel
// spelling, so adding or dropping a letter no longer breaks detection.
function rootRe(root) {
  return new RegExp(root.split("").join("[aeiou]*"));
}

// Booking intent without any date/time ("n7eb na7jez", "nheb na5jez rendez vous", "نحب نحجز").
function looksLikeBookingIntent(text) {
  const raw = (text || "").trim();
  if (/نحب\s*(نحجز|ناخذ)/.test(raw)) return true;
  if (/(احجز|احجزلي|حجز|موعد)/.test(raw)) return true;
  const t = " " + raw.toLowerCase() + " ";
  // Verb root 7-j-z (حجز), any vowel spelling, with person prefix
  // (n/t/y/a/e): na7jez, ne7jez, te7jez, ye7jez, a7jez, e7jezli…
  // The prefix requirement keeps the bare noun "7ajz" (my booking WHEN?)
  // from matching — that's a status question, not a booking intent.
  if (/[ntyae][aeiou]*[75][aeiou]*j[aeiou]*z/.test(t)) return true;
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
  if (/(fi sedri|fi sadri|sedri youja3|sadri youja3|9albi youja3|9albi ydhor|manajmch netnafes|manajmech netnafes|ma najamch netnafes|n5no9|damm barcha|nazif kbir|dokht|ghmert)/.test(t)) return true;
  // Fix T (X6): the same red flags in French — a French bleeding emergency
  // ("je saigne beaucoup…") must escalate exactly like the Derja one
  // instead of falling into the French chat path's generic greeting.
  if (/(saigne|saignement|hémorragie|hemorragie|évanoui|evanoui|perdu connaissance|poitrine|n'arrive pas à respirer|n'arrive pas a respirer|difficulté à respirer|difficulte a respirer|je m'étouffe|je m'etouffe)/.test(t)) return true;
  // Fix U (BIZ12): a bare "urgent / urgence / est3jeli" is a scheduling
  // word ("c'est urgent, je pars en voyage"), not a symptom — it escalates
  // ONLY with a pain/symptom anchor in the same message ("c'est urgent,
  // je souffre beaucoup" still escalates, test-french F15).
  // Fix X (MD12): fainting with the frequent variant spellings — "do5"
  // (5 = kh) and "ghemret" (vowel before the t) matched neither anchor.
  // Token-anchored so "da5el" (inside) can never fire it.
  if (/(^|\s)(do5|da5|do5t|da5t|do5et|ghemret|ghmret)(\s|$|[,.!?،])/.test(t)) return true;
  // Fix X (MD3/MD4): ingestion / poisoning. A child (or anyone) who
  // SWALLOWED a product or a medicine is an emergency in every language —
  // not a routine medication question. Bleach/products by name; a French
  // swallow verb near a product word; a Derja swallow verb near a
  // medicine word ONLY with a child or distress anchor ("chrabt dwe
  // mte3i w nheb na7jez" — took my meds, want to book — stays a booking
  // conversation, never an emergency).
  if (/(javel|antipoison|intoxication|empoisonn)/.test(t)) return true;
  if (/(avalé|avale|ingéré|ingere|a bu|bu de|bu du)\b[^.!?]{0,40}(produit|médicament|medicament|comprimé|comprime|détergent|detergent|javel|poison)/.test(t)) return true;
  if (/(enfant|fils|fille|bébé|bebe)\b[^.!?]{0,30}(avalé|avale|ingéré|ingere|a bu)/.test(t)) return true;
  if (/(chrab|chrabet|charbet|bela3|bla3)\b[^.!?]{0,30}(dwe|dawa|javel|produit)/.test(t) &&
      /(waldi|weldi|benti|bentek|waldek|sghir|sghira|tfol|chna3mel|kifech na3mel)/.test(t)) return true;
  if (/(تسمم|ابتلع|بلع).{0,25}(دواء|دوا|سم|جافيل|منظف|حبوب|مبيد)/.test(text || "")) return true;
  if (/(ولدي|ابني|بنتي|طفلي|طفل).{0,25}(شرب|بلع|ابتلع|اكل|أكل).{0,20}(دواء|دوا|سم|جافيل|منظف|حبوب)/.test(text || "")) return true;
  if (/(أغمي|اغمي|غمي علي)/.test(text || "")) return true;
  if (/(urgent|urgence|emergency|est3jeli)/.test(t) &&
      /(\bmal\b|douleur|souffre|souffrance|wji3a|youja3|youdhar|damm|nazif)/.test(t)) return true;
  if (/(استعجالي|طوارئ)/.test(text || "") &&
      /(وجع|ألم|يوجع|صدري|قلبي|دم|نزيف|نتنفس)/.test(text || "")) return true;
  return /(في صدري|صدري يوجع|قلبي يوجع|ما نجمش نتنفس|نخنق|دم برشا|دوخت|غمرت)/.test(text || "");
}

// F6 — Frustrated patient ("ya kalb el bot mte3ek me5demch").
// Brief acknowledgment with "sama7ni", ask what went wrong, then resume.
function looksLikeFrustration(text) {
  const t = " " + (text || "").toLowerCase() + " ";
  if (/\b(kalb|7mar|ba9ra|zebel|nik|manyak|t3ebt|faddit)\b/.test(t)) return true;
  if (/(bot|بوت|روبوت).{0,25}(me5demch|ma ye5demch|ghalet|ma yemchich)/.test(t)) return true;
  // French frustration ("ça fait trois fois que je demande !") — same brief
  // apology path as Derja; the caller's fr branch answers in French.
  if (/(ça fait|ca fait)\s+(trois|plusieurs|\d+)\s+fois/.test(t)) return true;
  if (/(je répète|je repete|vous ne comprenez pas|ça ne marche pas|ca ne marche pas)/.test(t)) return true;
  return /(الكلب|الحمار|البوت ما يخدمش|ما يخدمش البوت)/.test(text || "");
}

// F7 — Cancellation intent ("n7eb nfassakh el rendez-vous mte3i").
// Checked BEFORE the status question: cancelling beats asking about status.
//
// Root-based: the verb roots f-s-5 / f-s-kh (فسخ) are UNAMBIGUOUS — in
// Derja they can only mean "cancel". So any spelling counts on its own,
// with or without the appointment noun or a pronoun:
// fasa5, fas5, nfasa5, fasa5 tawa, fasa5 sil te plait, tafsakh…
function looksLikeCancellation(text) {
  const raw = (text || "").trim();
  if (/فسخ/.test(raw)) return true; // Arabic root: افسخ، تفسخلي، نفسخ…
  if (/^(الغي|إلغاء|الغاء)/.test(raw)) return true;
  const t = " " + raw.toLowerCase() + " ";
  // Fix X (round-3 cluster A): the doubled-s spelling "fassa5" /
  // "nfassa5" — the secretary command's own spelling — matched neither
  // pattern (rootRe allows only ONE s). Doubled s included — EXCEPT the
  // secretary's own command shape "fassa5 <number>" (delete-conversation
  // syntax): fired by a PATIENT it must not cancel anything (round-2
  // CHA17 interdiction).
  if (/f[aeiou]*s+[aeiou]*5/.test(t) && !/^\s*(fassa5|fassakh|nfassa5|nfassakh)\s+\d+\s*$/.test(raw)) return true;
  if (/f[aeiou]*s+[aeiou]*kh/.test(t)) return true; // kh-spelling: fassakh, nafsakh…
  // Pronoun-carrying "cancel it": anulih/anuliha/anulha.
  if (/(^|\s)(anulih|anuliha|anulha)(\s|$)/.test(t)) return true;
  // Fix U (MEM6): bare French imperative + demonstrative ("Annule celui
  // de samedi") — no appointment noun, but unmistakably a cancel order in
  // a booking conversation (patients without bookings get cancel_none).
  if (/^\s*(annule|annulez|annuler)\s+(celui|le|la|mon|ma)\b/.test(t)) return true;
  // Vaguer forms still need the appointment noun as anchor.
  // Fix U (MEM5/MEM6): French imperative "annule" ("Annule mon rendez-vous
  // de vendredi") — "annuler" alone never matched it.
  return /(nlaghi|nla8i|annuler|annule|cancel)/
    .test(t) && /(rendez|rdv|7ajz|hajz|reservation|mte3i|mta3i)/.test(t);
}

// F8 — FAQ / identity ("9adech el soum?", "win el 3iyada?", "chkoun enti?").
// Pure questions only (no date): answered directly, never merged into a proposal.
// A question is NEVER booking info. "?" / "؟" or a leading question word
// (derja / French / Arabic script). Protects the proposal merge: a question
// asked while a proposal is pending is answered, never merged into the slot.
// (2026-10-07: "win mawjouda el3iyeda?" was merged and the bot re-sent the
// proposal without answering — one general rule, no more whack-a-mole.)
function looksLikeQuestion(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (t.includes("?") || t.includes("؟")) return true;
  return /^(win|wen|winech|chkoun|chkon|chnowa|chneya|chno|9adech|kadech|b9adech|kifech|kif |wakteh|wa9tech|3lech|alech|où|comment|combien|quel|quelle|quels|quelles|est-ce|شنوة|شكون|وين|كيفاش|قداش|وقتاش|علاش|هل |شنهي)/i.test(t);
}

// Medication / dosage wording — the medical red line ("idari = bot,
// tibbi = insen"): drug names, prescription words and "how many times a
// day" questions belong to the human hand-off, never to a FAQ answer.
function looksLikeMedicalQuestion(text) {
  const raw = text || "";
  const t = " " + raw.toLowerCase() + " ";
  if (/(paracétamol|paracetamol|doliprane|ibuprofène|ibuprofene|antibiotique|médicament|medicament|ordonnance|posologie|dosage)/.test(t)) return true;
  if (/(دواء|أدوية|علاج|جرعة)/.test(raw)) return true;
  if (/\b(dwe|dawa)\b/.test(t)) return true;
  if (/(9adech|قداش|combien de fois).{0,25}(marra|مرة|fois)/.test(t)) return true; // dosage frequency
  return false;
}

function faqKind(text) {
  if (looksLikeStatusQuestion(text)) return null; // "win wsol el 7ajz" stays a status question
  const t = " " + (text || "").toLowerCase() + " ";
  if (/(chkoun enti|chkounek|chkon enti|who are you|شكون انت|شكونك|انت شكون)/.test(t)) return "who";
  // Fix U (BIZ2/BIZ3): "are you a robot?" in Derja / Arabic / French is the
  // same identity question — answered by faq_who ("assistant", never "bot").
  if (/(enti|inta|انت|أنت)\s+(robot|روبوت|بوت|bot)/.test(t) || /(êtes-vous|etes-vous|tu es|vous êtes)\s+(un\s+)?(robot|bot)/.test(t) || /(are you|is this)\s+(a\s+)?(robot|bot)/.test(t)) return "who";
  if (/(chnowa esm|chneya esm|chno esm|esm el 3iyada|what('| i)s the (clinic|practice)( name)?|comment s'appelle|nom du cabinet|nom de la clinique|اسم العيادة|شنوة اسم)/.test(t)) return "clinic_name";
  if (/(te5dem m3a chkoun|te5dem m3a|m3a chkoun te5dem|taba3 chkoun|with (whom|who)|مع شكون|تخدم مع)/.test(t)) return "works_with";
  // "te5dem el sabt?" (Fix T, H11): working verb + a weekday = hours question.
  if (/(wa9t el 5edma|wa9t te5dem|wa9tech t7ell|wa9tech tsakrou|tsakrou|tsekrou|sakrou|ysakrou|7atta wa9tech|ma7loul|horaires|fermez|fermeture|ouvrez|ouverture|وقت الخدمة|وقتاش تحل|وقتاش تسكر)/.test(t)
    || /(te5dem|te5dmou|ye5dem|t5dem)\s+(el\s+)?(sebt|sabt|la7ad|ethnin|thenin|thleth|erb3a|khmis|5mis|jem3a|jom3a|samedi|dimanche|lundi|mardi|mercredi|jeudi|vendredi)/.test(t)
    // Fix X (LT9): day-then-verb order is just as natural ("w el sabt
    // te5dmou?", "samedi ouvert ?") — the verb-first pattern alone let
    // the bare day name fall into the booking machinery. ("5mis" is the
    // common Arabizi spelling of Thursday — dates.js always knew it,
    // this detector didn't.)
    || /(sebt|sabt|la7ad|ethnin|thenin|thleth|erb3a|khmis|5mis|jem3a|jom3a|samedi|dimanche|lundi|mardi|mercredi|jeudi|vendredi)\s+(te5dem|te5dmou|ye5dem|t5dem|t7ell|t7ellou|ouvert|ouverte|ouvrez|ferme|fermé|fermée)/.test(t)) return "hours";
  // Fix T (X9): medical wording beats the price FAQ — "9adech men marra
  // ne5ou el paracétamol" is a dosage question, not "9adech el soum".
  if (looksLikeMedicalQuestion(text)) return null;
  // Fix X (MN2): "la première consultation est-elle gratuite ?" is a
  // price question — "gratuit(e)" joins the price vocabulary.
  if (/(9adech|b9adech|kadech|soum|prix|bikam|flous|combien|tarif|gratuit|بقداش|سوم|فلوس|الثمن)/.test(t)) return "price";
  // Fix X (LT6): unaccented French place questions ("Vous etes ou
  // exactement ?") matched nothing — "etes ou" is the place shape.
  if (/(win |win mawjouda|blasa|3onwen|adresse|o[uù] se trouve|se situe|c'est o[uù]|elle est o[uù]|feyn|feya |vous (etes|êtes) ou|etes-vous ou|êtes-vous ou|وين|بلاصة|عنوان|فين|وين موجودة)/.test(t)) return "place";
  return null;
}

function faqAnswer(kind, ar, clinic, fr) {
  clinic = clinic || {};
  // Fix S: wording lives in the MSG catalog (faq_* keys); this function only
  // maps the FAQ kind + clinic facts onto it. Signature unchanged (tests).
  const key = { clinic_name: "faq_clinic_name", works_with: "faq_works_with", who: "faq_who", hours: "faq_hours", price: "faq_price" }[kind] || "faq_place";
  const lang = lang3(ar, fr);
  return msg(key, lang, {
    clinicName: clinic.name || "",
    // Fix W: the hours fact is rendered in the patient's language, never
    // the stored config string pasted raw under a translated label.
    hours: renderHoursText(clinic.hours, lang) || clinic.hours || "",
    address: clinic.address || "",
  });
}

// ---------- French test path (2026-09-27) ----------
// Detect French so the bot can reply in French text.
// Derja wins on conflict: a Derja marker anywhere means it's Derja, not French.
// ("rendez-vous" counts as Derja — Tunisians write it in Derja constantly.)
function looksLikeFrench(text) {
  const raw = text || "";
  if (/[êëàâçîïôûùœæ]/i.test(raw)) return true; // French diacritics never appear in Arabizi
  const t = " " + raw.toLowerCase() + " ";
  if (/(n7eb|na7jez|nheb|chnowa|chneya|9adech|kadech|win el|wa9t|ghodwa|lyoum|jem3a|barcha|mriguel|tfadhel|3aslema|ahla|rendez-vous|\brdv\b|ey | le |slem|slm)/.test(t)) return false;
  const fr = /\b(bonjour|bonsoir|vous|votre|disponible|pouvez|voulez|auriez|pourriez|comment|combien|avec|quel|quelle|où|je veux|je voudrais|merci beaucoup|s'il vous|svp|plait)\b/g;
  const hits = (t.match(fr) || []).length;
  if (hits >= 2) return true;
  // One unambiguous French opener is enough ("Bonjour" alone = French test).
  return /\b(bonjour|bonsoir|combien)\b/.test(t);
}

// Lenient French detector for french_auto clinics (2026-10-01).
// Same idea as looksLikeFrench, but "rendez-vous"/"rdv"/"ey"/"le" don't veto:
// a French tourist writes "Bonjour, je voudrais un rendez-vous" — real Derja
// still carries an unmistakable marker (n7eb, chnowa, 9adech...). For tourism
// clinics a wrong-French reply to a Tunisian beats a wrong-Derja reply to a
// French tourist.
function looksLikeFrenchAuto(text) {
  const raw = text || "";
  if (/[êëàâçîïôûùœæ]/i.test(raw)) return true; // French diacritics never appear in Arabizi
  const t = " " + raw.toLowerCase() + " ";
  if (hasDerjaMarker(text)) return false;
  // Fix V: "est-ce / docteur / dentiste / fait" added — ordinary French
  // questions about the doctor ("Est-ce que le docteur fait les implants ?")
  // scored a single hit ("est") and were read as Derja, so every fallback
  // answered them in Arabizi. None of these words occur in Arabizi, and
  // hasDerjaMarker above still vetoes real Derja first.
  // Fix W: "horaires / quels / sont / vos" added on the same basis — the
  // most standard French hours question ("Quels sont vos horaires ?")
  // scored zero hits and resolved as Derja in the deterministic layer, so
  // the (now localized) hours answer still came out in Arabizi.
  const fr = /\b(bonjour|bonsoir|vous|votre|vos|disponible|pouvez|voulez|auriez|pourriez|comment|combien|avec|quel|quelle|quels|quelles|où|je|j'ai|aux|est|sont|est-ce|docteur|médecin|medecin|dentiste|fait|faites|horaire|horaires|s'appelle|cabinet|je veux|je voudrais|j'ai besoin|je cherche|je souhaite|j'aimerais|merci beaucoup|s'il vous|svp|plait|premier|première|gratuit|gratuite|ouvrez|fermez|ouvert|ouverte|samedi|dimanche|lundi|mardi|mercredi|jeudi|vendredi)\b/g;
  const hits = (t.match(fr) || []).length;
  if (hits >= 2) return true;
  // One unambiguous French opener is enough ("Bonjour" alone = French).
  return /\b(bonjour|bonsoir|combien)\b/.test(t);
}

// Derja markers: ANY of these in a message means Derja, full stop.
function hasDerjaMarker(text) {
  const t = " " + (text || "").toLowerCase() + " ";
  // "baddel"/"a7sen" added for Fix T (L2): a full Derja correction sentence
  // ("le, baddel — el sabt el 10 a7sen liya") carries no older marker, so
  // the conversation language never switched off the French proposal.
  return /(n7eb|na7jez|nheb|chnowa|chneya|9adech|kadech|win el|wa9t|ghodwa|lyoum|jem3a|barcha|mriguel|tfadhel|3aslema|ahla|slem|slm|baddel|a7sen)/.test(t);
}

// Semantic fallback (2026-10-01): the word-list detector can't know every
// French sentence — it matches words, it doesn't understand meaning. When it
// is UNSURE (no Derja markers, weak/no French hits), ask the AI itself whether
// the message is standard French. Clear cases never reach the API: Derja
// markers -> Derja, strong French signal -> French, no extra call, no latency.
// Skipped without an AI key (local tests) -> Derja default.
async function aiLangIsFrench(text) {
  if (!AI_API_KEY) return false;
  const raw = String(text || "");
  if (!raw.trim()) return false;
  if (/[\u0600-\u06FF]/.test(raw)) return false; // Arabic script -> never French
  if (hasDerjaMarker(raw)) return false; // sure: Derja
  if (looksLikeFrenchAuto(raw)) return true; // sure: French
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
          { role: "system", content: "Tu es un détecteur de langue. Le message suivant est-il écrit en FRANÇAIS standard ? Réponds par un seul mot : OUI si c'est du français, NON si c'est de la derja tunisienne (arabe dialectal en lettres latines), de l'arabe, ou autre chose." },
          { role: "user", content: raw },
        ],
        max_tokens: 5,
        temperature: 0,
      }),
    });
    const data = await res.json();
    const ans = (data.choices?.[0]?.message?.content || "").trim().toUpperCase();
    return ans.startsWith("OUI");
  } catch (e) {
    console.error("[ai:langDetect]", e.message);
    return false;
  }
}

// Explicit French request (revised 2026-09-27): the bot answers in French
// ONLY when the patient explicitly asks — no auto-detect.
// ("jewbni bel français", "ektebli bel français", "parle en français", "en français")
function looksLikeFrenchRequest(text) {
  const t = " " + (text || "").toLowerCase().replace(/ç/g, "c") + " ";
  if (/(jewbni|jewb|ektebli|ekteb|a7ki|e7ki|parle|parlez|repond)[^.?!]*francais/.test(t)) return true;
  return /\ben francais\b/.test(t);
}

// Standalone system prompt for the French test (2026-09-27, fixed after live
// test): REPLACES the Derja base prompt entirely. Appending caused a conflict
// and the AI answered "je ne peux répondre qu'en derja..." — prompt layering
// is not a guardrail, so French gets its own prompt.
const FRENCH_SYSTEM_PROMPT = `Vous êtes l'assistant réceptionniste d'une clinique (dentiste) en Tunisie.
- Répondez TOUJOURS EN FRANÇAIS, jamais en derja ni en arabe. Messages courts et polis.
- ACCUEIL : si le patient vous salue (bonjour/salut...), dites exactement : "Bonjour ! Je suis l'assistant de {CLINIC_NAME} — comment puis-je vous aider ?" (remplacez {CLINIC_NAME} par le nom de la clinique). INTERDIT de demander "comment allez-vous" — allez droit au but.
- Vous aidez pour : prise de rendez-vous, horaires, adresse, prix.
- INTERDIT : médicaments, symptômes, diagnostic, conseil médical. Pour une question médicale, dites : "Pour les questions médicales, seul le docteur peut répondre — voulez-vous prendre rendez-vous ?"
- N'inventez jamais d'informations (heure, adresse, prix) : si vous ne savez pas, dites exactement : "Je ne sais pas. Voulez-vous que je demande au docteur ? Écrivez oui." (INTERDIT de dire "je vérifie" seul — proposez toujours de demander au docteur avec "oui".)
- Ne confirmez jamais un rendez-vous définitivement seul : si le patient accepte un créneau, dites "D'accord, je vous confirme et je reviens vers vous" — la confirmation finale vient de la secrétaire.
- Ne vous excusez jamais de parler français : le patient vous a écrit en français. Répondez directement et utilement.`;

// No-AI-key fallback in French (used by the local test; production has the AI key).
// Fix S: wording from the MSG catalog — greeting -> fb_greeting, else the
// generic French fallback (fb_booking's fr variant is that same text).
function frenchFallback(text, clinicName = "", clinicAddress = "") {
  const t = (text || "").toLowerCase();
  // Red line first (Fix T, X8): a medication question is handed to the
  // doctor, never answered with the generic menu — and it never names a
  // drug itself. The "je demande au docteur" wording arms the escalation
  // offer in processPatientText, exactly like the Derja path.
  if (/(médicament|medicament|antibiotique|ordonnance|paracétamol|paracetamol|doliprane|ibuprofène|ibuprofene|douleur)/.test(t))
    return msg("fb_medical", "fr", { clinicName });
  if (/bonjour|bonsoir|salut/.test(t))
    return msg("fb_greeting", "fr", { clinicName });
  // Fix X (LT6): a French place question gets the place answer (with the
  // real address), not the generic menu.
  if (/(adresse|vous etes ou|etes-vous ou|où se trouve|ou se trouve|vous trouver|localisation)/.test(t))
    return msg("fb_place", "fr", { clinicName, address: clinicAddress });
  return msg("fb_booking", "fr", { clinicName });
}

// F11 — Walk-in ("n7eb nji tawa"): explain, offer a reserved time, no question loop.
function looksLikeWalkin(text) {
  const t = " " + (text || "").toLowerCase() + " ";
  if (/\bnji\b/.test(t) && /\btawa\b/.test(t)) return true;
  // French walk-in: "je peux venir sans rendez-vous ?", "venir maintenant".
  return /(sans rendez-vous|venir maintenant|venir directement|passer directement|passer maintenant)/.test(t);
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
  // French beneficiaries ("un pour moi et un pour ma fille") — same canon
  // keys as Derja; the reply layer translates them per language (BEN_FR).
  const frBen = [
    [/pour\s+moi\b/, "lik"], [/pour\s+ma\s+fille\b/, "benti"], [/pour\s+mon\s+fils\b/, "weldi"],
    [/pour\s+ma\s+femme\b/, "marti"], [/pour\s+mon\s+mari\b/, "rajli"],
    [/pour\s+ma\s+m[èe]re\b/, "ommek"], [/pour\s+mon\s+p[èe]re\b/, "baba"],
    [/pour\s+ma\s+s(?:œ|oe)ur\b/, "o5tek"], [/pour\s+mon\s+fr[èe]re\b/, "5ouya"],
  ];
  for (const [re, key] of frBen) if (re.test(t) && !found.includes(key)) found.push(key);
  return found;
}
// French labels for the canon beneficiary keys (reply layer only).
const BEN_FR = { lik: "pour vous", ommek: "pour votre mère", o5tek: "pour votre sœur", marti: "pour votre femme", rajli: "pour votre mari", weldi: "pour votre fils", benti: "pour votre fille", baba: "pour votre père", "5ouya": "pour votre frère", sa7bi: "pour votre ami", sa7ebti: "pour votre amie" };
function looksLikeTwoAppointments(text) {
  const t = " " + (text || "").toLowerCase() + " ";
  if (/zouz/.test(t) && /(rendez|rdv|7ajz|hajz)/.test(t)) return true;
  // French: "deux rendez-vous" / "2 rendez-vous".
  if (/(deux|2)\s+rendez/.test(t)) return true;
  // Fix X (OT2): "un rendez-vous pour moi... et un autre pour ma femme"
  // is the same two-appointment shape without the word "deux".
  return /(un|une)\s+autre\s+(rendez|pour)/.test(t);
}

// Fix T (B5/B6): the FIRST appointment's segment of a two-appointments
// message — the text up to the SECOND beneficiary marker, with the
// beneficiary phrases and the "(zouz|deux) rendez-vous" phrase stripped:
// their number words ("zouz" -> 2, "wa7ed" -> 1) would poison the hour
// search, and the second appointment's slot must not leak into the first.
function firstSlotSegment(text) {
  const raw = text || "";
  const marks = [];
  const reD = /\bwa7e?d\s+(?:li[a-z0-9]+|l\s+[a-z0-9]+)/g;
  const reF = /\bun(?:e)?\s+pour\s+(?:moi|ma\s+\w+|mon\s+\w+)/gi;
  let m;
  while ((m = reD.exec(raw))) marks.push(m.index);
  while ((m = reF.exec(raw))) marks.push(m.index);
  marks.sort((a, b) => a - b);
  const seg = marks.length >= 2 ? raw.slice(0, marks[1]) : raw;
  return seg
    .replace(/\bwa7e?d\s+(?:li[a-z0-9]+|l\s+[a-z0-9]+)/gi, " ")
    .replace(/\bun(?:e)?\s+pour\s+(?:moi|ma\s+\w+|mon\s+\w+)/gi, " ")
    .replace(/(zouz|deux|2)\s+rendez[-\s]?vous/gi, " ")
    .trim();
}
const multiBooking = new Map(); // phone -> extra appointments still to book after the current one
// Fix X (OT2): phone -> true when the SECOND appointment of a
// two-appointment request was explicitly for someone else ("...et un
// autre pour ma femme"). The first booking consumes the marker path;
// this flag survives it so the second booking ALSO goes through the
// name gate instead of silently inheriting the caller's remembered name.
const beneficiaryNext = new Map();
// Fix X (uncertainty rule): phone -> the bare number the bot just asked
// a day-or-hour clarification about. Consumed (and cleared) on the very
// next patient turn, whatever it contains.
const bareNumClarify = new Map();

// Rescheduling: the patient moves an EXISTING booking (no duplicate row).
function looksLikeReschedule(text) {
  const t = " " + (text || "").toLowerCase() + " ";
  // Verb roots b-d-l (بدل) and gh-y-r (غير), any vowel spelling, with
  // person prefix (n/t/y): nbadal, nbadel, badal, ybadel, nghayar…
  // Fix U (CHA2): doubled-letter spellings ("nbaddel", "nbaddlou") carry a
  // shadda — d+ / y+ or the commonest Derja spelling never matches and the
  // "reschedule" silently became a second booking.
  if (/(^|\s)(n|t|y)?b[aeiou]*d+[aeiou]*l/.test(t)) return true;
  if (/(^|\s)(n|t|y)?gh[aeiou]*y+[aeiou]*r/.test(t)) return true;
  if (/(نبدل|نحب نبدل|نغير)/.test(text || "")) return true;
  // French: déplacer / reporter are unambiguous on their own; changer /
  // modifier need the appointment noun as anchor ("changer mon rendez-vous").
  if (/d[ée]placer|reporter/.test(t)) return true;
  return /(changer|modifier)/.test(t) && /(rendez|rdv)/.test(t);
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
  const words = ["ba3d ghodwa", "ba3d ghadwa", "apres ghodwa", "apres demain", "apres-demain", "la7ad", "l7ad", "lahad", "el 7ad", "dimanche",
    "ethnin", "thnin", "tnin", "thenin", "lundi", "thletha", "thleth", "tletha", "tlata", "mardi",
    "erb3a", "larb3a", "mercredi", "khmis", "5mis", "jeudi", "jem3a", "jom3a", "vendredi",
    "sebt", "sibt", "sabt", "samedi", "ghodwa", "ghadwa", "demain", "demin", "lyoum", "elyoum", "bera7",
    "الأحد", "الاحد", "الاثنين", "الإثنين", "الثلاثاء", "الأربعاء", "الاربعاء",
    "الخميس", "الجمعة", "السبت", "غدوة", "غدوا", "بعد غدوة", "اليوم", "البارح", "البارحة"];
  for (const w of words) out = out.split(" " + w + " ").join(" ");
  out = out.replace(/\b\d{1,2}\s+(janvier|janfi|fevrier|fev|mars|avril|mai|juin|juillet|juil|aout|septembre|sept|octobre|oct|novembre|nov|decembre|dec)\b/g, " ");
  out = out.replace(/\b\d{1,2}[\/-]\d{1,2}\b/g, " ");
  return out.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// MSG — the ONE catalog of deterministic patient-facing replies (Fix S).
// Every key carries ALL THREE variants (ar / fr / az); reply sites ask
// msg(key, resolvedLang, ctx) instead of hand-writing per-site ternaries.
// Variants are the wordings that already existed in the code (moved here
// verbatim); a French variant was written ONLY where a branch genuinely
// had none (escalation confirm/decline, settle confirmations, finishBooking
// second-appointment prompt, AI fallbacks, greeting default).
// test-lang.js enumerates this catalog mechanically: a key missing any
// variant fails the suite, so this class of bug cannot ship silently again.
// ctx fields are read defensively (missing -> "").
// ---------------------------------------------------------------------------
function lang3(ar, fr) { return fr ? "fr" : ar ? "ar" : "az"; }

const MSG = {
  // ----- doctor-question escalation (the Prignol incident branch) -----
  esc_asked_doctor: {
    ar: "تمام، سألت الطبيب — نرجعلك بالجواب.",
    fr: "D'accord, j'ai demandé au docteur — je reviens vers vous avec sa réponse.",
    az: "D'accord, s2elt el tbib — narja3lek bel jewb.",
  },
  esc_declined: {
    ar: "Ok، ما مشكلة.",
    fr: "D'accord, pas de problème.",
    // Fix U (QUE4): unmistakably Derja wording ("ma mochkla" kept verbatim
    // for test-local S23) — the old three-word text read as French.
    az: "Ok, ma mochkla — ken t7eb nes2elou el tbib marra o5ra, 9olli.",
  },
  // ----- deterministic doctor-question offer (Fix T: no-AI-key path) -----
  doc_q_offer: {
    ar: "ما عنديش المعلومة هذي. تحب نسأل الطبيب ونرجعلك؟ اكتب اي.",
    fr: "Je n'ai pas cette information. Voulez-vous que je demande au docteur ? Écrivez oui.",
    az: "Ma 3andich el ma3louma hethi. T7eb nes2el el tbib w narja3lek? Ekteb ey.",
  },
  // ----- greeting default (only when the clinic config has none) -----
  greeting_default: {
    ar: "وعليكم السلام! كيفاش نجمو نعاونوك؟",
    fr: "Bonjour ! Comment puis-je vous aider ?",
    az: "3alikom salam! Kifech najmou n3awnouk?",
  },
  // ----- other-doctor handoff (shared clinic) -----
  other_doctor: {
    ar: (c) => `الدكتور ${c.doctor} يخدم في نفس العيادة — باش نوصلو طلبك للسكرتيرة وهي ترجعلك. تحب نحجزلك في ${c.clinicName}؟`,
    fr: (c) => `Le Dr ${c.doctor} travaille dans le même cabinet — je transmets votre demande à la secrétaire, qui vous recontactera. Voulez-vous un rendez-vous au ${c.clinicName} ?`,
    az: (c) => `Dr ${c.doctor} ye5dem fi nafs el 3iyada — bech nwaslou talbek lel secretaire w hiya tarja3lek. T7eb n7ajzlek fi ${c.clinicName}?`,
  },
  // ----- booking flow: intents before the slot machinery -----
  emergency: {
    ar: "الوجيعة هذي تستحق طبيب فيسع — ما تستناش رونديفو: امشي للاستعجالي توا ولا عيط لـ190. البوت ما ينجمش يعاونك في حالة كيما هذي.",
    fr: "Cette douleur nécessite un médecin rapidement — n'attendez pas un rendez-vous : allez aux urgences dès maintenant ou appelez le 190. L'assistant ne peut pas vous aider dans une situation comme celle-ci.",
    az: "El wji3a hethi test7a9 tbib fissa3 — matestanech rendez-vous: emchi lel urgence tawa walla 3ayet lel 190. El bot maynajemch y3awnek fi 7ala kima hethi.",
  },
  frustration: {
    ar: "سامحني 🙏 شنوة صار بالضبط؟ قولي ونعاونك.",
    fr: "Pardonnez-moi 🙏 Que s'est-il passé exactement ? Dites-moi et je vous aide.",
    az: "Sama7ni 🙏 chnowa saret b dhabt? 9olli w n3awnek.",
  },
  walkin: {
    ar: "تنجم تجي توا، أما الاستناة تنجم تطوال حسب الحالة — الأحسن نحجزلك وقت مضمون باش ما تستناش. تحب نحجزلك؟ قولي أنهو نهار وأنهو وقت.",
    fr: "Vous pouvez venir maintenant, mais l'attente peut être longue selon l'affluence — le mieux est que je vous réserve un créneau garanti pour ne pas attendre. Voulez-vous que je vous réserve ? Dites-moi quel jour et quelle heure.",
    az: "Tnjem tji tawa, ama el waiting ynajem ykoun twil 7asb el 7ala — el a7sen n7ajzlek wa9t mathmoun bech ma testa7melch. T7eb n7ajzlek? 9olli anhou nhar w anhou wa9t.",
  },
  two_rdv_two_ben: {
    ar: (c) => `فهمتك — زوز رونديفو: واحد ${c.ben1} وواحد ${c.ben2}. نخدمو واحد بواحد: اللول، أنهو نهار وأنهو وقت يساعدك؟`,
    fr: (c) => `D'accord — deux rendez-vous : un ${c.ben1} et un ${c.ben2}. Nous les faisons un par un : le premier, quel jour et quelle heure vous conviennent ?`,
    az: (c) => `Fhemtek — zouz rendez-vous: wa7ed ${c.ben1} w wa7ed ${c.ben2}. Ne5dmou wa7ed b wa7ed: el louwel, anhou nhar w anhou wa9t yse3dek?`,
  },
  two_rdv_one_ben: {
    ar: (c) => `فهمتك — زوز رونديفو: واحد ${c.ben1}. والثاني لشكون؟`,
    fr: (c) => `D'accord — deux rendez-vous : un ${c.ben1}. Et le deuxième, c'est pour qui ?`,
    az: (c) => `Fhemtek — zouz rendez-vous: wa7ed ${c.ben1}. W el theni lchkoun?`,
  },
  two_rdv_none: {
    ar: "فهمتك — زوز رونديفو. اللول لشكون؟",
    fr: "D'accord — deux rendez-vous. Le premier, c'est pour qui ?",
    az: "Fhemtek — zouz rendez-vous. El louwel lchkoun?",
  },
  // ----- two appointments, first slot given up-front (Fix T: B5/B6) -----
  two_rdv_first_two: {
    ar: (c) => `فهمتك — زوز رونديفو: واحد ${c.ben1} وواحد ${c.ben2}. نخدمو واحد بواحد: اللول، ${c.display} — تحب نحجزلك؟ اكتب "اي".`,
    fr: (c) => `D'accord — deux rendez-vous : un ${c.ben1} et un ${c.ben2}. Nous les faisons un par un : le premier, ${c.display} — voulez-vous que je vous le réserve ? Écrivez "oui".`,
    az: (c) => `Fhemtek — zouz rendez-vous: wa7ed ${c.ben1} w wa7ed ${c.ben2}. Ne5dmou wa7ed b wa7ed: el louwel, ${c.display} — t7eb n7ajzlek? Ekteb "ey".`,
  },
  two_rdv_first_any: {
    ar: (c) => `فهمتك — زوز رونديفو. نخدمو واحد بواحد: اللول، ${c.display} — تحب نحجزلك؟ اكتب "اي".`,
    fr: (c) => `D'accord — deux rendez-vous. Nous les faisons un par un : le premier, ${c.display} — voulez-vous que je vous le réserve ? Écrivez "oui".`,
    az: (c) => `Fhemtek — zouz rendez-vous. Ne5dmou wa7ed b wa7ed: el louwel, ${c.display} — t7eb n7ajzlek? Ekteb "ey".`,
  },
  third_party: {
    ar: "سامحني — نجم نشوف كان الرونديفو المحجوز بالرقم هذا. كان الحجز تسجل باسم آخر، قولي الاسم ونتثبت مع العيادة.",
    fr: "Pardonnez-moi — je ne peux voir que les rendez-vous réservés avec ce numéro. Si la réservation a été faite sous un autre nom, dites-moi le nom et je vérifie avec la clinique.",
    az: "Sama7ni — najem nchouf ken el rendez-vous el ma7jouz b numero hetha. Ken el 7ajz tsajjel b esm e5er, 9olli el esm w nthabbet m3a el 3iyada.",
  },
  sec_cmd_hint: {
    ar: "هذي commande متاع العيادة — كان تحب تبدل ولا تفسخ الرونديفو متاعك، قولي.",
    fr: "Ceci est une commande de la clinique — si vous voulez changer ou annuler votre rendez-vous, dites-le-moi.",
    az: "Hethi commande mta3 el 3iyada — ken t7eb tbadal walla tfassakh el rendez-vous mte3ek, 9olli.",
  },
  proposal_dropped: {
    ar: "داكور، فسخت الاقتراح. تحب وقت آخر؟ قولي نهار ووقت يساعدك.",
    fr: "D'accord, j'ai annulé la proposition. Voulez-vous un autre horaire ? Dites-moi un jour et une heure qui vous conviennent.",
    az: "D'accord, l4it el i9tira7. T7eb wa9t e5er? 9olli nhar w wa9t yse3dek.",
  },
  ask_day_time: {
    ar: "داكور — أنهو نهار وأنهو وقت تحب؟",
    fr: "D'accord — quel jour et quelle heure souhaitez-vous ?",
    az: "D'accord — anhou nhar w anhou wa9t t7eb?",
  },
  already_pending: {
    ar: (c) => `عندك رونديفو مازال يستنى: ${c.slot} — نأكدلك ونرجعلك.`,
    fr: (c) => `Vous avez déjà un rendez-vous en attente : ${c.slot} — je vous confirme et je reviens vers vous.`,
    az: (c) => `3andek rendez-vous deja yestanna: ${c.slot} — n2akkedlek w narja3lek.`,
  },
  reask_proposal: {
    ar: (c) => `تحب نحجزلك ${c.disp}؟ اكتب "اي".`,
    fr: (c) => `Voulez-vous que je vous réserve le ${c.disp} ? Écrivez "oui".`,
    az: (c) => `T7eb n7ajzlek ${c.disp}? Ekteb "ey".`,
  },
  booking_nudge: {
    ar: "فهمتك تحب تحجز — قولي أنهو نهار وأنهو وقت، كيما: الجمعة 10 متاع الصباح.",
    fr: "Je comprends, vous voulez réserver — dites-moi quel jour et quelle heure, par exemple : vendredi à 10h du matin.",
    az: "Fhemtek t7eb ta7jez — 9olli anhou nhar w anhou wa9t, kima: jem3a 10 mta3 sbe7.",
  },
  next_week_ask: {
    ar: "أوك — الجمعة الجاية. أنهو نهار وأنهو وقت يساعدك؟",
    fr: "D'accord — la semaine prochaine. Quel jour et quelle heure vous conviennent ?",
    az: "Ok, jem3a jeya — anhou nhar w anhou wa9t?",
  },
  ask_day_exact: {
    ar: "أنهو نهار بالضبط؟ (اكتب كيما: الجمعة، غدوة، 21 سبتمبر...)",
    fr: "Quel jour exactement ? (écrivez par exemple : vendredi, demain, le 21 septembre...)",
    az: "Anhou nhar b dhabt? (ekteb kima: jem3a, ghodwa, 21 septembre...)",
  },
  past_slot: {
    ar: "الوقت هذا فات — أعطيني وقت آخر.",
    fr: "Ce créneau est déjà passé — donnez-moi un autre horaire.",
    az: "El wa9t hedha fet — a3tini wa9t e5er.",
  },
  bad_hour: {
    ar: (c) => `"${c.badHour}" موش وقت صحيح — عاود اكتب الوقت (مثال: 10:30).`,
    fr: (c) => `"${c.badHour}" n'est pas une heure valide — réécrivez l'heure (exemple : 10:30).`,
    az: (c) => `"${c.badHour}" mech wa9t s7i7 — 3awed ekteb el wa9t (mthel: 10:30).`,
  },
  closed_day: {
    ar: (c) => `نهار الأحد العيادة مسكرة (نخدمو ${c.range}). تحب ${c.sugDay}؟ قولي الوقت.`,
    fr: (c) => `Le dimanche, la clinique est fermée (nous travaillons ${c.range}). Voulez-vous le ${c.sugDay} ? Dites-moi l'heure.`,
    az: (c) => `Nhar el 7ad el 3iyada msakra (ne5dmou ${c.range}). T7eb ${c.sugDay}? 9olli el wa9t.`,
  },
  afternoon_closed: {
    ar: (c) => `${c.dateDisplay} العشية مسكرة (نخدمو ${c.hrs}). تحب صباحية؟ قولي الوقت (مثال: 10:30).`,
    fr: (c) => `${c.dateDisplay} l'après-midi, la clinique est fermée (nous travaillons ${c.hrs}). Voulez-vous le matin ? Dites-moi l'heure (exemple : 10:30).`,
    az: (c) => `${c.dateDisplay} l3echiya msakra (ne5dmou ${c.hrs}). T7eb sbe7? 9olli el wa9t (mthel: 10:30).`,
  },
  confirm_24h: {
    ar: (c) => `${c.dateDisplay} — باش نتأكد: الـ${c.hourStr} هاذي ${c.am} متاع الصباح ولا ${c.pm} متاع العشية؟`,
    fr: (c) => `${c.dateDisplay} — pour confirmer : ${c.hourStr}h, c'est ${c.am} le matin ou ${c.pm} l'après-midi ?`,
    az: (c) => `${c.dateDisplay} — bech net2akked: el ${c.hourStr} hethi ${c.am} mta3 sbe7 walla ${c.pm} mta3 l3chiya?`,
  },
  propose_slot: {
    ar: (c) => `داكور — ${c.display}. تحب نحجزلك؟ اكتب "اي".`,
    fr: (c) => `D'accord — ${c.display}. Voulez-vous que je vous le réserve ? Écrivez "oui".`,
    az: (c) => `D'accord — ${c.display}. T7eb n7ajzlek? Ekteb "ey".`,
  },
  // ----- condolence line (Fix X, OT3): a booking request that mentions
  // a death gets one empathy line before the proposal, never a bare
  // cheerful slot offer.
  condolence: {
    ar: "الله يرحمو — البركة فيكم. 🤲",
    fr: "Toutes mes condoléances. 🤲",
    az: "Allah yarhmou — el baraka fikom. 🤲",
  },
  // ----- bare-number clarification (Fix X, Ahmed's uncertainty rule):
  // a bare "15" that could be the day OR the hour is never guessed —
  // one short question, in the patient's language.
  clarify_day_or_hour: {
    ar: (c) => `تقصد يوم ${c.n} ولا الساعة ${c.n}:00؟`,
    fr: (c) => `Vous voulez dire le ${c.n} (le jour) ou ${c.n}h (l'heure) ?`,
    az: (c) => `T7eb t9oul nhar ${c.n} walla el sa3a ${c.n}:00?`,
  },
  hours_reject_closed: {
    ar: (c) => `النهار هذا العيادة مسكرة (نخدمو من الاثنين للسبت: ${c.hrs}). نقترح عليك: ${c.sug} — تحب نحجزلك؟ اكتب "اي".`,
    fr: (c) => `Ce jour-là, la clinique est fermée (nous travaillons du lundi au samedi : ${c.hrs}). Je vous propose : ${c.sug} — voulez-vous que je vous réserve ce créneau ? Écrivez "oui".`,
    az: (c) => `El nhar hetha el 3iyada msakra (ne5dmou mel ethneyn lel sebt: ${c.hrs}). Ne9tar7oulek: ${c.sug} — t7eb n7ajzlek? Ekteb "ey".`,
  },
  hours_reject_hours: {
    ar: (c) => `الوقت هذا خارج وقت الخدمة (${c.hrs}). نقترح عليك: ${c.sug} — تحب نحجزلك؟ اكتب "اي".`,
    fr: (c) => `Cet horaire est en dehors des heures de travail (${c.hrs}). Je vous propose : ${c.sug} — voulez-vous que je vous réserve ce créneau ? Écrivez "oui".`,
    az: (c) => `El wa9t hetha 5arej wa9t el 5edma (${c.hrs}). Ne9tar7oulek: ${c.sug} — t7eb n7ajzlek? Ekteb "ey".`,
  },
  // ----- the "which hour?" question (timeQuestionMsg) -----
  tq_period: {
    ar: (c) => `${c.dateDisplay} ${c.period === "morning" ? "متاع الصباح" : c.period === "afternoon" ? "متاع العشية" : "متاع الليل"} — أنهو ساعة بالضبط؟ (اكتب كيما 10:30)`,
    fr: (c) => `${c.dateDisplay} ${c.period === "morning" ? "le matin" : c.period === "afternoon" ? "l'après-midi" : "le soir"} — à quelle heure exactement ? (écrivez par exemple 10:30)`,
    az: (c) => `${c.dateDisplay} ${c.period === "morning" ? "mta3 sbe7" : c.period === "afternoon" ? "mta3 l3chiya" : "mta3 lil"} — anhou se3a b dhabt? (ekteb kima 10:30)`,
  },
  tq_hour: {
    ar: (c) => `${c.dateDisplay} — الـ${c.hourStr} هاذي متاع الصباح ولا متاع العشية؟`,
    fr: (c) => `${c.dateDisplay} — à ${c.hourStr}h, c'est le matin ou l'après-midi ?`,
    az: (c) => `${c.dateDisplay} — el ${c.hourStr} hethi mta3 sbe7 walla mta3 l3chiya?`,
  },
  tq_plain: {
    ar: (c) => `${c.dateDisplay} — قولي الوقت: متاع الصباح ولا متاع العشية؟ (ولا اكتب الوقت كيما 10:30)`,
    fr: (c) => `${c.dateDisplay} — dites-moi l'heure : le matin ou l'après-midi ? (ou écrivez l'heure, par exemple 10:30)`,
    az: (c) => `${c.dateDisplay} — 9olli el wa9t: mta3 sbe7 walla mta3 l3chiya? (walla ekteb el wa9t kima 10:30)`,
  },
  // ----- name capture -----
  ask_name: {
    ar: (c) => `داكور — ${c.display}. أعطيني الاسم واللقب متاعك؟`,
    fr: (c) => `D'accord — ${c.display}. Quel est votre nom et votre prénom ?`,
    az: (c) => `D'accord — ${c.display}. A3tini el esm wel la9ab mta3ek?`,
  },
  ask_family_name: {
    ar: "واللقب متاعك؟",
    fr: "Et votre nom de famille ?",
    az: "Wel la9ab mta3ek?",
  },
  // ----- booking completion (finishBooking) -----
  book_dup_pending: {
    ar: (c) => `الرونديفو متاعك (${c.display}) مازال يستنى — نأكدلك ونرجعلك.`,
    fr: (c) => `Votre rendez-vous (${c.display}) est déjà en attente — je vous confirme et je reviens vers vous.`,
    az: (c) => `El rendez-vous mte3ek (${c.display}) deja yestanna — n2akkedlek w narja3lek.`,
  },
  book_done: {
    ar: (c) => `${c.first ? `داكور ${c.first}، مرحبا بيك!` : "داكور، مرحبا بيك!"} نأكدلك رونديفو (${c.display}) ونرجعلك.`,
    fr: (c) => `${c.first ? `D'accord ${c.first}, bienvenue !` : "D'accord, bienvenue !"} Je vous confirme le rendez-vous (${c.display}) et je reviens vers vous.`,
    az: (c) => `${c.first ? `D'accord ${c.first}, merhba bik!` : "D'accord, merhba bik!"} n2akkedlek rendez-vous (${c.display}) w narja3lek.`,
  },
  book_second_prompt: {
    ar: "\nوالثاني: أنهو نهار ووقت؟",
    fr: "\nEt le deuxième : quel jour et quelle heure ?",
    az: "\nTawa ethani: anhou nhar w wa9t?",
  },
  // ----- status question -----
  status_confirmed: {
    ar: (c) => `اي، تأكد! ✅ الرونديفو متاعك (${c.when}) مؤكد. نستناوك!`,
    fr: (c) => `Oui, c'est confirmé ! ✅ Votre rendez-vous (${c.when}) est confirmé. Nous vous attendons !`,
    az: (c) => `Ey, t2akked! ✅ Rendez-vous mte3ek (${c.when}) m2akked. Nestennewk!`,
  },
  status_cancelled: {
    // Fix U (MEM7): the status must SAY the booking was cancelled — the old
    // "slot no longer available" wording presented a rejected booking as a
    // mere scheduling problem. The az variant keeps "ma 3adech disponible"
    // (asserted verbatim by test-local flow9).
    ar: (c) => `سامحنا، الرونديفو (${c.when}) تلغى. تحب وقت آخر؟`,
    fr: (c) => `Pardon, votre rendez-vous (${c.when}) a été annulé. Voulez-vous un autre horaire ?`,
    az: (c) => `Sme7na, el rendez-vous (${c.when}) tlagha — el wa9t ma 3adech disponible. T7eb na9tar7oulek wa9t e5er?`,
  },
  // ----- voice-note placeholder (Fix U: CHA13) -----
  voice_note: {
    ar: "سامحني، ما نجمش نسمع الرسائل الصوتية — اكتبلي سؤالك كنص ونعاونك.",
    fr: "Pardon, je ne peux pas écouter les messages vocaux — écrivez-moi votre demande en texte et je vous aide.",
    az: "Sme7ni, ma najemch nesma3 el messages vocales — ektebli talabek ka texte w n3awnek.",
  },
  // ----- price asked for ANOTHER named doctor (Fix U: BIZ1) -----
  other_doctor_price: {
    ar: (c) => `الأسوام اللي نجم نقولك عليهم هما متاع ${c.clinicName || "العيادة هذي"} برك — ما نعرفش أسوام طبيب آخر. تحب نحجزلك رونديفو لهنا؟`,
    fr: (c) => `Les prix que je peux vous donner sont uniquement ceux de ${c.clinicName || "cette clinique"} — je ne connais pas les tarifs d'un autre docteur. Voulez-vous un rendez-vous ici ?`,
    az: (c) => `El aswem elli najem n9ollek 3lihom houma mta3 ${c.clinicName || "el 3iyada hethi"} bark — ma na3refch aswem tbib e5er. T7eb na7jzelek rendez-vous lehna?`,
  },
  status_pending: {
    ar: (c) => `الرونديفو متاعك (${c.when}) مازال يستنى — نستناو في التأكيد من العيادة. نأكدلك ونرجعلك. ⏳`,
    fr: (c) => `Votre rendez-vous (${c.when}) est encore en attente — nous attendons la confirmation de la clinique. Je vous confirme et je reviens vers vous. ⏳`,
    az: (c) => `El rendez-vous mte3ek (${c.when}) mazel yestanna — nestanna el confirmation mel 3iyada. N2akkedlek w narja3lek. ⏳`,
  },
  // ----- cancellation / reschedule -----
  cancel_none: {
    ar: "ما لقيت حتى رونديفو محجوز بهالرقم. تحب نحجزلك واحد جديد؟",
    fr: "Je n'ai trouvé aucun rendez-vous réservé avec ce numéro. Voulez-vous que je vous en réserve un nouveau ?",
    az: "Ma l9it 7atta rendez-vous ma7jouz b hal numero. T7eb na7jzelek wa7ed jdid?",
  },
  cancel_done: {
    ar: (c) => `داكور، فسخت الرونديفو (${c.slot}). تحب وقت آخر؟`,
    fr: (c) => `D'accord, j'ai annulé le rendez-vous (${c.slot}). Voulez-vous un autre horaire ?`,
    az: (c) => `D'accord, fassakht el rendez-vous (${c.slot}). T7eb wa9t e5er?`,
  },
  resched_none: {
    ar: "ما لقيت حتى رونديفو باش نبدلوه. تحب نحجزلك واحد جديد؟",
    fr: "Je n'ai trouvé aucun rendez-vous à déplacer. Voulez-vous que je vous en réserve un nouveau ?",
    az: "Ma l9it 7atta rendez-vous bech nbadlouh. T7eb na7jzelek wa7ed jdid?",
  },
  resched_ask: {
    ar: (c) => `داكور — باش نبدلو الرونديفو (${c.slot}). قولي النهار والوقت الجديد.`,
    fr: (c) => `D'accord — nous allons déplacer le rendez-vous (${c.slot}). Dites-moi le nouveau jour et la nouvelle heure.`,
    az: (c) => `D'accord — bech nbadlou el rendez-vous (${c.slot}). 9olli el nhar wel wa9t el jdid.`,
  },
  resched_done: {
    ar: (c) => `تبدل الرونديفو: ${c.display} — نأكدلك ونرجعلك.`,
    fr: (c) => `Rendez-vous déplacé : ${c.display} — je vous confirme et je reviens vers vous.`,
    az: (c) => `Tbadal el rendez-vous: ${c.display} — n2akkedlek w narja3lek.`,
  },
  // ----- post-booking name correction (Fix T: B16) -----
  name_corrected: {
    ar: (c) => `داكور، صلحت الاسم: ${c.name || ""}.`,
    fr: (c) => `D'accord, j'ai corrigé le nom : ${c.name || ""}.`,
    az: (c) => `D'accord, tsalla7 el esm: ${c.name || ""}.`,
  },
  // ----- secretary settle -> patient confirmation -----
  settle_confirmed: {
    ar: (c) => `تأكد الرونديفو متاعك: ${c.slot}. نستناوك! 🌸`,
    fr: (c) => `Votre rendez-vous est confirmé : ${c.slot}. Nous vous attendons ! 🌸`,
    az: (c) => `T2akked rendez-vous mte3ek: ${c.slot}. Nestennewk! 🌸`,
  },
  settle_cancelled: {
    ar: (c) => `سامحنا، الوقت ${c.slot} ما عادش متاح. تحب وقت آخر؟`,
    fr: (c) => `Pardon, le créneau ${c.slot} n'est plus disponible. Voulez-vous un autre horaire ?`,
    az: (c) => `Sme7na, el wa9t ${c.slot} ma 3adech disponible. T7eb wa9t e5er?`,
  },
  // ----- FAQ (faqAnswer) -----
  faq_clinic_name: {
    ar: (c) => c.clinicName ? `اسم العيادة: ${c.clinicName}.` : "أنا المساعد متاع العيادة — نأكدلك على الاسم مع العيادة.",
    fr: (c) => c.clinicName ? `Le nom de la clinique : ${c.clinicName}.` : "Je suis l'assistant de la clinique — je vous confirme le nom avec la clinique.",
    az: (c) => c.clinicName ? `Esm el 3iyada: ${c.clinicName}.` : "Ena el assistant mta3 el 3iyada — n2akkedlek 3al esm m3a el 3iyada.",
  },
  faq_works_with: {
    ar: (c) => c.clinicName ? `نخدم مع ${c.clinicName}.` : "نخدم مع العيادة هذي.",
    fr: (c) => c.clinicName ? `Je travaille avec ${c.clinicName}.` : "Je travaille avec cette clinique.",
    az: (c) => c.clinicName ? `Ne5dem m3a ${c.clinicName}.` : "Ne5dem m3a el 3iyada hethi.",
  },
  faq_who: {
    ar: (c) => c.clinicName ? `أنا المساعد متاع ${c.clinicName} — نعاونك تحجز رونديفو ونجاوبك على الأسئلة الإدارية (الوقت، البلاصة، الأسوام). الأسئلة الطبية للطبيب.` : "أنا المساعد متاع العيادة — نعاونك تحجز رونديفو ونجاوبك على الأسئلة الإدارية (الوقت، البلاصة، الأسوام). الأسئلة الطبية للطبيب.",
    fr: (c) => c.clinicName ? `Je suis l'assistant de ${c.clinicName} — je vous aide à prendre rendez-vous et je réponds aux questions administratives (horaires, adresse, prix). Les questions médicales sont pour le docteur.` : "Je suis l'assistant de la clinique — je vous aide à prendre rendez-vous et je réponds aux questions administratives (horaires, adresse, prix). Les questions médicales sont pour le docteur.",
    az: (c) => c.clinicName ? `Ena el assistant mta3 ${c.clinicName} — n3awnek ta7jez rendez-vous w njawbek 3al as2la el idariya (el wa9t, el blasa, el aswem). El as2la el tibbiya lel tbib.` : "Ena el assistant mta3 el 3iyada — n3awnek ta7jez rendez-vous w njawbek 3al as2la el idariya (el wa9t, el blasa, el aswem). El as2la el tibbiya lel tbib.",
  },
  faq_hours: {
    ar: (c) => c.hours ? `وقت الخدمة: ${c.hours}.` : `نخدمو من الاثنين للسبت: ${CLINIC_HOURS_TXT}. نهار الأحد مسكرين.`,
    fr: (c) => c.hours ? `Horaires de travail : ${c.hours}.` : `Nous travaillons du lundi au samedi : ${CLINIC_HOURS_TXT}. Le dimanche, nous sommes fermés.`,
    az: (c) => c.hours ? `Wa9t el 5edma: ${c.hours}. Ken t7eb n7ajzlek rendez-vous, 9olli.` : `Ne5dmou mel ethneyn lel sebt: ${CLINIC_HOURS_TXT}. Nhar el 7ad msakrin. Ken t7eb n7ajzlek rendez-vous, 9olli.`,
  },
  faq_price: {
    ar: "الأسوام حسب الحالة — الاستشارة الأولى وبعد الطبيب يقولك. تحب نحجزلك رونديفو؟",
    fr: "Les prix dépendent du cas — d'abord la consultation, ensuite le docteur vous dira. Voulez-vous que je vous réserve un rendez-vous ?",
    az: "El aswem 7asb el 7ala — el consultation loula w ba3d el tbib y9ollek. T7eb n7ajzlek rendez-vous?",
  },
  faq_place: {
    ar: (c) => c.address ? `العنوان: ${c.address} — تحب نحجزلك رونديفو في نفس الوقت؟` : "نأكدلك على العنوان مع العيادة — تحب نحجزلك رونديفو في نفس الوقت؟",
    fr: (c) => c.address ? `L'adresse : ${c.address} — voulez-vous que je vous réserve un rendez-vous en même temps ?` : "Je vous confirme l'adresse avec la clinique — voulez-vous que je vous réserve un rendez-vous en même temps ?",
    az: (c) => c.address ? `El 3onwen: ${c.address} — t7eb n7ajzlek rendez-vous fi nafs el wa9t?` : "N2akkedlek 3al 3onwen m3a el 3iyada — t7eb n7ajzlek rendez-vous fi nafs el wa9t?",
  },
  // ----- no-AI-key fallbacks (fallbackReply / frenchFallback) -----
  fb_greeting: {
    ar: "وعليكم السلام! كيفاش نجم نعاونك؟ (حجز رونديفو، وقت الخدمة، البلاصة...)",
    fr: (c) => `Bonjour ! 👋 Je suis l'assistant de ${c.clinicName || "la clinique"} — comment puis-je vous aider ? (rendez-vous, horaires, adresse...)`,
    az: "ahla w sahla! 👋 chnowa tnajem n3awnek? (7ajz rendez-vous, wa9t el 5edma, el blasa...)",
  },
  fb_booking: {
    ar: "باش نحجزلك رونديفو — قولي نهار ووقت يساعدك، ونأكدلك مع العيادة 👌",
    fr: (c) => `Bonjour ! Je suis l'assistant de ${c.clinicName || "la clinique"} — je peux vous aider pour un rendez-vous, les horaires ou l'adresse. Comment puis-je vous aider ?`,
    az: "bech na7jzelek rendez-vous — 9olli nhar w wa9t yse3dek, w n2akkedlek m3a el 3iyada 👌",
  },
  fb_place: {
    ar: "نأكدلك على العنوان مع العيادة — تحب نحجزلك رونديفو في نفس الوقت؟",
    // Fix X (LT6): the fr variant was a copy-paste of the GREETING — it
    // never answered the question. It now gives the real address when
    // the clinic config carries one (frenchFallback threads it through).
    fr: (c) => c.address ? `L'adresse : ${c.address} — voulez-vous que je vous réserve un rendez-vous en même temps ?` : "Je vous confirme l'adresse avec la clinique — voulez-vous que je vous réserve un rendez-vous en même temps ?",
    az: "n2akkedlek 3al 3onwen m3a el 3iyada — t7eb n7ajzlek rendez-vous fi nafs el wa9t?",
  },
  fb_price: {
    ar: "الأسوام حسب الحالة — الاستشارة الأولى وبعد الطبيب يقولك. نحجزلك؟",
    fr: (c) => `Bonjour ! Je suis l'assistant de ${c.clinicName || "la clinique"} — je peux vous aider pour un rendez-vous, les horaires ou l'adresse. Comment puis-je vous aider ?`,
    az: "el aswem 7asb el 7ala — el consultation loula w ba3d el tbib y9ollek. N7ajzlek?",
  },
  fb_medical: {
    ar: "الأسئلة على الدواء والوجيعة للطبيب برك ⛔ — تحب نحجزلك رونديفو تسألو ديراكت؟",
    fr: "Les questions sur les médicaments et la douleur sont pour le docteur uniquement ⛔ — voulez-vous que je demande au docteur ? Écrivez oui.",
    az: "el sou2elet 3al dwe wel wji3a lel tbib bark ⛔ — el doktor howa elli yjewb 3lihom. T7eb n7ajzlek rendez-vous tes2lou direct?",
  },
  fb_unknown: {
    ar: "ما فهمتش مليح — تنجم تقولي: تحب تحجز رونديفو، تسأل على الوقت، ولا على البلاصة؟",
    fr: (c) => `Bonjour ! Je suis l'assistant de ${c.clinicName || "la clinique"} — je peux vous aider pour un rendez-vous, les horaires ou l'adresse. Comment puis-je vous aider ?`,
    az: "ma fhemtch mli7 — tnajem t9olli: t7eb te7jez rendez-vous, tes2el 3al wa9t, walla 3al blasa?",
  },
  // ----- AI-path fallbacks (aiReply) -----
  ai_error: {
    ar: "سمحنا، صارت مشكلة صغيرة — نجم نعاونك بحاجة أخرى؟",
    fr: "Pardon, un petit problème technique — puis-je vous aider autrement ?",
    az: "sme7na, saret mochkla s8ira — najem n3awnek b 7aja o5ra?",
  },
  ai_safe_fallback: {
    ar: AI_SAFE_FALLBACK.arabic,
    fr: "Pardon, je n'ai pas bien compris — voulez-vous prendre un rendez-vous ou poser une question ?",
    az: AI_SAFE_FALLBACK.latin,
  },
};

function msg(key, lang, ctx) {
  const e = MSG[key];
  if (!e) return "";
  const v = e[lang] !== undefined ? e[lang] : e.az;
  return typeof v === "function" ? v(ctx || {}) : v;
}

// Displayed closing time per weekday, parsed from the clinic's free-text
// hours ("Thenin lel Jom3a: 08:30 - 17:30, Sebt: 08:30 - 13:00, Ahad:
// msakker"). Needed to tell a LAST bookable start (Mahjoub weekdays:
// bookings end 17:00 but the clinic closes 17:30 — 17:00 is inside) from
// a slot starting AT the real close (Jrad 16:00, Mahjoub Saturday 13:00),
// which can never begin. Null when the text doesn't parse — callers then
// keep the plain booking-hours rule.
function displayedCloseMap(hoursTxt) {
  if (!hoursTxt || typeof hoursTxt !== "string") return null;
  const DAYW = { la7ad: 0, a7ad: 0, dimanche: 0, ethnin: 1, thenin: 1, thnin: 1, lundi: 1,
    thleth: 2, thletha: 2, mardi: 2, erb3a: 3, larb3a: 3, mercredi: 3,
    "5mis": 4, khmis: 4, khemis: 4, jeudi: 4, jom3a: 5, jem3a: 5, vendredi: 5,
    sebt: 6, sabt: 6, samedi: 6 };
  const out = {};
  let any = false;
  for (const seg of hoursTxt.split(",")) {
    const tm = seg.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
    if (!tm) continue; // "Ahad: msakker" — no range, nothing to learn
    const close = parseInt(tm[3], 10) * 60 + parseInt(tm[4], 10);
    const dayPart = " " + seg.slice(0, tm.index).toLowerCase().replace(/:/g, " ") + " ";
    const found = [];
    for (const w of Object.keys(DAYW)) if (dayPart.includes(" " + w + " ")) found.push(DAYW[w]);
    if (!found.length) continue;
    if (/ lel /.test(dayPart) && found.length >= 2) {
      for (let d = Math.min(...found); d <= Math.max(...found); d++) { out[d] = close; any = true; }
    } else {
      for (const d of found) { out[d] = close; any = true; }
    }
  }
  return any ? out : null;
}

// Fix W — parse the clinic's free-text hours into a per-weekday schedule
// ({ dow: [openMin, closeMin] | null(closed) }) so patient answers can be
// RENDERED in the patient's language instead of pasting the stored string
// verbatim (live 2026-10-13: a French patient got "Horaires de travail :
// Thenin lel 5mis: 09:00 - 16:00, Jom3a w Sebt: ..., Ahad: msakker" — a
// French label over the Arabizi config text). Same segment/day-word
// approach as displayedCloseMap, but it also keeps the OPEN time and the
// explicit closed days, and it is strict: a segment naming a weekday with
// neither a time range nor a closed marker fails the whole parse, so
// callers fall back to the stored text instead of rendering a partial —
// possibly invented — schedule. `kinds` records which day-name vocabulary
// the text was authored in (az Arabizi / ar Arabic / fr French).
function parseHoursText(hoursTxt) {
  if (!hoursTxt || typeof hoursTxt !== "string") return null;
  const DAYSETS = [
    ["az", { la7ad: 0, a7ad: 0, ahad: 0, ethnin: 1, thenin: 1, thnin: 1, thleth: 2, thletha: 2, erb3a: 3, larb3a: 3, "5mis": 4, khamis: 4, khmis: 4, khemis: 4, jom3a: 5, jem3a: 5, sebt: 6, sabt: 6 }],
    ["fr", { dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6 }],
    ["ar", { "الأحد": 0, "الاحد": 0, "الاثنين": 1, "الإثنين": 1, "الثلاثاء": 2, "الأربعاء": 3, "الاربعاء": 3, "الخميس": 4, "الجمعة": 5, "السبت": 6 }],
  ];
  const days = {};
  const kinds = { az: 0, ar: 0, fr: 0 };
  let ranged = 0;
  for (const seg of hoursTxt.split(",")) {
    const tm = seg.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
    const dayPart = " " + (tm ? seg.slice(0, tm.index) : seg).toLowerCase().replace(/:/g, " ") + " ";
    const found = new Map(); // dow -> authoring kind
    for (const [kind, words] of DAYSETS) {
      for (const w of Object.keys(words)) {
        if (dayPart.includes(" " + w + " ")) found.set(words[w], kind);
      }
    }
    if (!found.size) continue; // a note naming no weekday: nothing to learn
    for (const k of new Set(found.values())) kinds[k]++;
    if (tm) {
      const open = parseInt(tm[1], 10) * 60 + parseInt(tm[2], 10);
      const close = parseInt(tm[3], 10) * 60 + parseInt(tm[4], 10);
      const dows = [...found.keys()];
      if (/( lel | au | إلى | الى )/.test(dayPart) && dows.length >= 2) {
        for (let d = Math.min(...dows); d <= Math.max(...dows); d++) days[d] = [open, close];
      } else {
        for (const d of dows) days[d] = [open, close];
      }
      ranged++;
    } else if (/(msakker|msaker|مسكر|مسكرة|مغلق|ferm)/i.test(seg)) {
      for (const d of found.keys()) days[d] = null;
    } else {
      return null; // weekday named with neither hours nor "closed": unsafe
    }
  }
  if (!ranged) return null;
  return { days, kinds };
}

// Fix W — render the stored hours in the patient's language. Facts come
// only from parseHoursText (same days, same times); when the text was
// authored in the patient's own language it IS the rendering (every
// current config is authored in Arabizi, so Derja answers stay
// byte-identical), and when the parse fails the stored text is returned
// as-is — the patient always gets an answer, never silence.
const HOURS_RENDER = {
  fr: { names: ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"],
    lower: ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"],
    closed: "fermé", sep: " : ", join: ", ",
    range: (a, b, n) => (n === 2 ? `${a} et ${b}` : `${a} à ${b}`) },
  ar: { names: ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"],
    lower: null, closed: "مسكر", sep: ": ", join: "، ",
    range: (a, b, n) => (n === 2 ? `${a} و${b}` : `من ${a} إلى ${b}`) },
  az: { names: ["Ahad", "Thenin", "Thleth", "Larb3a", "5mis", "Jom3a", "Sebt"],
    lower: ["a7ad", "thenin", "thleth", "larb3a", "5mis", "jom3a", "sebt"],
    closed: "msakker", sep: ": ", join: ", ",
    range: (a, b, n) => (n === 2 ? `${a} w ${b}` : `${a} lel ${b}`) },
};

function renderHoursText(hoursTxt, lang) {
  if (!hoursTxt || typeof hoursTxt !== "string") return null;
  const p = parseHoursText(hoursTxt);
  if (!p) return hoursTxt;
  const others = ["az", "ar", "fr"].filter((k) => k !== lang);
  if (p.kinds[lang] > 0 && others.every((k) => p.kinds[k] === 0)) return hoursTxt;
  const R = HOURS_RENDER[lang] || HOURS_RENDER.az;
  const fmt = (mins) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  const order = [1, 2, 3, 4, 5, 6, 0]; // Monday first, Sunday last
  const seen = order.filter((d) => Object.prototype.hasOwnProperty.call(p.days, d));
  if (!seen.length) return hoursTxt;
  const groups = [];
  for (const d of seen) {
    const v = p.days[d];
    const key = v ? `${v[0]}-${v[1]}` : "closed";
    const last = groups[groups.length - 1];
    if (last && last.key === key && order.indexOf(d) === order.indexOf(last.days[last.days.length - 1]) + 1) last.days.push(d);
    else groups.push({ key, val: v, days: [d] });
  }
  return groups.map((g) => {
    const first = R.names[g.days[0]];
    const lastName = (R.lower || R.names)[g.days[g.days.length - 1]];
    const label = g.days.length === 1 ? first : R.range(first, lastName, g.days.length);
    const val = g.val ? `${fmt(g.val[0])} - ${fmt(g.val[1])}` : R.closed;
    return `${label}${R.sep}${val}`;
  }).join(R.join);
}

// F10 — Clinic-hours gate. A concrete slot outside working hours (or on a closed
// day) is rejected with the next suitable open slot, saved as the new proposal.
function hoursCheck(r, hours, closeMap) {
  // r: concrete resolved slot (date + time, not past). null = inside hours.
  // hours: per-number booking hours (from the clinic config); falls back to
  // the global CLINIC_HOURS when the number has no override.
  const bh = hours || CLINIC_HOURS;
  const open = bh[r.dow];
  const wall = new Date(Date.parse(r.iso) + 3600000); // Tunis wall time
  const h = wall.getUTCHours(), m = wall.getUTCMinutes();
  // Fix T (H1/H2/H3): a start exactly at the booking end stays inside ONLY
  // when the clinic's displayed close is later than the booking end (the
  // slot still fits before the real close). When the displayed close IS
  // the booking end, a start at closing can never begin — outside hours.
  const closeMin = closeMap ? closeMap[r.dow] : null;
  const atEndOk = !open || closeMin === null || closeMin === undefined || open[1] * 60 < closeMin;
  const inside = open && (h > open[0] || (h === open[0] && m >= 0)) && (h < open[1] || (h === open[1] && m === 0 && atEndOk));
  if (inside) return null;
  return { reason: open ? "hours" : "closed" };
}

// Next suitable open slot: from the given start day, the first open day
// whose 09:00 is still in the future (real now, not the start day).
function suggestOpenSlot(fromDateUTC, ar, hours) {
  // All timestamps here are shifted so getUTC*() reads Tunis wall time.
  const bh = hours || CLINIC_HOURS;
  const DAY = 86400000;
  const nowMs = dates.tunisNow().getTime();
  let dayStart = Math.floor(fromDateUTC / DAY) * DAY; // Tunis-wall midnight of the start day
  for (let i = 0; i < 8; i++) {
    const dow = new Date(dayStart).getUTCDay();
    if (bh[dow]) {
      const nineAM = dayStart + 9 * 3600000;
      if (nineAM > nowMs) return dates.slotDisplay(dayStart, 9, 0, ar);
    }
    dayStart += DAY;
  }
  return null;
}

// Next open DAY (for the needs-time branch on a closed day): date text only.
function suggestOpenDay(dateUTC, ar, hours) {
  const bh = hours || CLINIC_HOURS;
  let d = dateUTC;
  for (let i = 0; i < 8; i++) {
    const dow = new Date(d).getUTCDay();
    if (bh[dow]) {
      return { dateUTC: d, dow, dateDisplay: dates.fmtDate(d, ar) };
    }
    d += 86400000;
  }
  return null;
}

function hoursRejectMsg(ar, reason, sugDisplay, hoursTxt, fr) {
  // Fix S: wording from the MSG catalog (hours_reject_* keys).
  // Fix W: the hours payload is rendered in the patient's language.
  const lang = lang3(ar, fr);
  return msg(reason === "closed" ? "hours_reject_closed" : "hours_reject_hours",
    lang, { hrs: renderHoursText(hoursTxt, lang) || hoursTxt || CLINIC_HOURS_TXT, sug: sugDisplay });
}

// Date substrings must never leak into the time question: in "27/10/2026"
// the "10" is the MONTH, not an hour (live incident 2026-10-13: the bot
// asked a French patient about "el 10"). Strip numeric dates (27/10/2026,
// 27-10-2026, 27.10.26) and written dates ("27 octobre", "27 أكتوبر",
// "octobre 27") before scanning for a bare hour. Same month vocab as dates.js.
const FR_MONTH_RE = "janvier|janfi|fevrier|fev|mars|avril|mai|juin|juillet|juil|aout|septembre|sept|octobre|oct|novembre|nov|decembre|dec";
const AR_MONTH_RE = "جانفي|فيفري|مارس|أفريل|افريل|ماي|جوان|جويلية|أوت|اوت|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر";
function stripDateSubstrings(text) {
  return (text || "")
    .replace(/\b\d{1,2}[\/.\-]\d{1,2}([\/.\-]\d{2,4})?\b/g, " ") // 27/10/2026, 27-10, 27.10.26
    .replace(new RegExp(`\\b\\d{1,2}\\s+(${FR_MONTH_RE})\\b`, "gi"), " ") // "27 octobre"
    .replace(new RegExp(`\\b(${FR_MONTH_RE})\\s+\\d{1,2}\\b`, "gi"), " ") // "octobre 27"
    .replace(new RegExp(`\\d{1,2}\\s+(${AR_MONTH_RE})`, "g"), " ") // "27 أكتوبر"
    // Fix Y: date-OFFSET expressions — their number is a day count, never
    // an hour candidate for bareHour ("dans 10 jours" must not turn the
    // time question into "à 10h, matin ou après-midi ?").
    .replace(/\bdans\s+(\d{1,2}|une?|deux|trois|quatre|cinq|six|sept)\s+(jours?|semaines?)\b/gi, " ")
    .replace(/\bba3d\s+\d{1,2}\s+(ayam|ayem|nharat|nhar)\b/gi, " ")
    .replace(/(?:\bba3d|بعد)\s+\d{1,2}\s+(?:أيام|ايام|أيّام)/g, " ");
}

// Bare hour in the patient's text ("10", "10:30", French "10h" / "10h30")
// — for the time question. The h-forms are normalized to the colon shape.
function bareHour(text) {
  const cands = stripDateSubstrings(text).match(/\b\d{1,2}:\d{2}\b|\b\d{1,2}h\d{2}\b|\b\d{1,2}h\b|\b\d{1,2}\b/g) || [];
  if (!cands.length) return null;
  const last = cands[cands.length - 1].replace(/h(\d{2})$/, ":$1").replace(/h$/, "");
  const h = parseInt(last.split(":")[0], 10);
  return (h >= 1 && h <= 12) ? last : null;
}

// The "which hour?" question, shared by the slot branch and the bare-"ey"
// clarification repeat (F9) so both ask identically.
// Fix S: wording from the MSG catalog (tq_* keys).
function timeQuestionMsg(ar, r, text, fr) {
  const period = r.morning ? "morning" : r.afternoon ? "afternoon" : r.night ? "night" : null;
  const hourStr = bareHour(text);
  const ctx = { dateDisplay: r.dateDisplay, period, hourStr };
  if (period) return msg("tq_period", lang3(ar, fr), ctx);
  if (hourStr) return msg("tq_hour", lang3(ar, fr), ctx);
  return msg("tq_plain", lang3(ar, fr), ctx);
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
  // Fix X (ED4): a bracketed placeholder ("[voice message]", "[sticker]",
  // "(audio)") is never a name — the old cleaner stripped the brackets
  // and the two leftover words passed as a two-word name.
  if (/[\[(]/.test(t)) return null;
  // Pure numbers ("10", phone numbers) aren't names — but Arabizi names carry
  // digit-letters ("Fola7i", "Naje7"), so only reject when there are no letters.
  if (!/[A-Za-z\u0600-\u06FF]/.test(t)) return null;
  if (/\b(b?9adech|ch7al|combien|kadech)\b/i.test(t)) return null; // quantity words aren't names
  if (/[?؟!]/.test(t)) return null;    // questions aren't names
  if (vixaLooksLikeSentence(t)) return null; // "juste nes2el" isn't a name
  if (NON_NAME.test(t)) return null;
  // Fix X (OT10): at the gate the patient may answer for someone else —
  // "le sa7bi Karim Haddad, numero mte3ou 55123456". Keep the NAME:
  // drop a trailing phone clause ("numero ..."), drop standalone long
  // digit tokens (the number itself), and strip the beneficiary intro.
  t = t.split(/\b(numero|num|téléphone|telephone|tel)\b/i)[0];
  t = t.replace(/\b\d{5,}\b/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/^(le|lel|pour)\s+(sa7bi|sa7ebti|marti|rajli|weldi|benti|ommi|omi|baba|bouya|5ouya|o5ti)\s+/i, "");
  t = t.replace(/[^A-Za-z0-9\u0600-\u06FF\s'\-]/g, "").replace(/\s+/g, " ").trim();
  if (t.length < 2 || NON_NAME.test(t)) return null;
  // Fix X (OT9): TWO names at the gate ("Ahmed Ben Salah w martou
  // Sonia") must not glue into one stored name — keep the FIRST person
  // (the second gets their own gate on their own booking).
  const cutW = t.search(/\s+w\s+(martou|marti|rajli|weldi|benti|ommi|o5ti|baba|5ouya|sa7bi|sa7ebti)\b/i);
  if (cutW > 0 && t.slice(0, cutW).trim().split(/\s+/).length >= 2) t = t.slice(0, cutW).trim();
  const cutEt = t.search(/\s+et\s+(sa|son)\s+(femme|mari|fille|fils)\b/i);
  if (cutEt > 0 && t.slice(0, cutEt).trim().split(/\s+/).length >= 2) t = t.slice(0, cutEt).trim();
  if (t.length < 2) return null;
  // Placeholder words that survive cleaning are not names either.
  if (/^(voice|audio|vocal|sticker|image|photo|video|location|note|message)(\s+(message|note|vocal|vocale))?$/i.test(t)) return null;
  return t;
}

// Display helper: "ahmed ben salah" -> "Ahmed Ben Salah" (Arabic names unaffected).
function capName(s) {
  return (s || "").split(/\s+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Post-booking name correction (Fix T, B16): "el esm ghalet — el esm el
// sa7i7 howa Karim Ben Ammar". Both markers are required (a name word AND a
// wrongness word), then the corrected name is what follows the
// "el sa7i7 / correct / vrai" part (after "howa" when present).
function parseNameCorrection(text) {
  const raw = (text || "").trim();
  if (!/(esm|ism|اسم|nom)/i.test(raw)) return null;
  if (!/(ghalet|ghalat|ghalt|غلط|faux|incorrect|wrong)/i.test(raw)) return null;
  const parts = raw.split(/sa7i7|sa7ih|s7i7|صحيح|vrai|correct/i);
  if (parts.length < 2) return null;
  const tail = parts[parts.length - 1];
  const m = tail.match(/(?:howa|houwa|huwa|هو|est)\s*[:：]?\s*(.+)$/i) || tail.match(/^\s*[:：—–-]?\s*(.+)$/);
  if (!m) return null;
  return parsePatientName(m[1].trim());
}

// Fix X (OT6): beneficiary SWAP after a booking exists — "el rendez-vous
// hedha le marti Amina Ben Ali, mech liya ena" / "...est pour ma femme
// Sonia Ben Salah, pas pour moi". Requires BOTH the "not for me" marker
// and a beneficiary relation followed by a name; returns the parsed
// beneficiary name or null. The caller's remembered name is NOT touched —
// only the booking's attribution changes.
function parseBeneficiarySwap(text) {
  const raw = (text || "").trim();
  if (!/(mech|mouch|mou)\s+(liya|leya|lia)\b/i.test(raw) && !/pas\s+pour\s+moi/i.test(raw) && !/(مش|موش)\s+(ليا|ليّا)/.test(raw)) return null;
  const m = raw.match(/(?:lel?|pour)\s+(?:ma\s+|mon\s+)?(?:marti|rajli|weldi|benti|ommi|omi|baba|bouya|5ouya|o5ti|sa7bi|sa7ebti|femme|mari|fils|fille|m[èe]re|p[èe]re)\s+([^,.;!?]+)/i);
  if (!m) return null;
  return parsePatientName(m[1].trim());
}

function askNameMsg(ar, display, fr) {
  return msg("ask_name", lang3(ar, fr), { display });
}

function askFamilyNameMsg(ar, fr) {
  return msg("ask_family_name", lang3(ar, fr));
}

// The patient is answering our name question (proposal.awaiting_name is set).
async function handleNameAnswer(phone, text, proposal, ar, clinic, fr) {
  // French sticks from the proposal's own words if this short answer isn't
  // detectably French on its own ("Dupont" carries no French marker).
  const frHere = fr || (!ar && !isAr(text) && looksLikeFrenchAuto(proposal.slot_text || ""));
  // Refusal -> drop the proposal, don't glue it to anything.
  if (looksLikeRefusal(text)) {
    await db.clearProposal(phone).catch(() => {});
    return say(phone, msg("proposal_dropped", lang3(ar, frHere)), clinic);
  }
  // A new concrete slot mid-flow ("le, jem3a 11") -> update the slot, ask the name again.
  const r = dates.resolveSlot(text, ar);
  if (r.found && r.date && !r.needs && !r.past) {
    await db.saveProposal(phone, text, r.iso, r.display, true, null).catch(() => {});
    return say(phone, askNameMsg(isAr(text) || ar, r.display, frHere), clinic);
  }
  const name = parsePatientName(text);
  // Not a name (a question, chitchat...) -> let the AI answer, keep waiting for the name.
  if (!name) return { handled: false };
  const partial = proposal.partial_name;
  if (partial || name.split(/\s+/).length >= 2) {
    const full = partial ? `${partial} ${name}`.trim() : name;
    await db.savePatientName(phone, full).catch(() => {});
    return finishBooking(phone, proposal, full, clinic, frHere);
  }
  // Single word ("ahmed") -> remember it, ask for the family name.
  await db.saveProposal(phone, proposal.slot_text, proposal.slot_at, proposal.display, true, name).catch(() => {});
  return say(phone, askFamilyNameMsg(ar, frHere), clinic);
}

async function say(phone, reply, clinic) {
  await db.saveMessage(phone, "assistant", reply, clinic && clinic.id);
  return { handled: true, reply };
}

async function finishBooking(phone, p, name, clinic, fr) {
  // p: { display, slot_at (ISO), slot_text }, name: "Ahmed Ben Salah" | null
  const dup = await db.findPendingBooking(phone, p.slot_at).catch(() => null);
  const ar = isAr(p.display); // the slot display carries the patient's script
  // The display is numeric in every language, so French comes from the caller
  // (or from the proposal's own words when called without it).
  const frHere = !ar && (fr || looksLikeFrenchAuto(p.slot_text || ""));
  const first = capName((name || "").split(/\s+/).filter(Boolean)[0] || "");
  const shownName = capName(name);
  let reply;
  if (dup) {
    reply = msg("book_dup_pending", lang3(ar, frHere), { display: p.display });
  } else {
    const id = await db.saveBooking(phone, p.display, p.slot_at || null, name || null, clinic && clinic.id);
    console.log(`[booking] #${id} pending: ${phone} (${name || "sans nom"}) -> ${p.display}`);
    reply = msg("book_done", lang3(ar, frHere), { first, display: p.display });
    // Supervisor notification via the ONE shared helper (Fix S): smart
    // hybrid — free-form while the supervisor's 24h window is open,
    // "notif_booking" template otherwise (always delivers).
    {
      const notifMsg = `⏳ Rendez-vous jdid mel bot: Esm: ${shownName || phone}, Mel: ${phone}, Wa9t: ${p.display}. Bech tvalidih, ekteb: ok ${id}. Bech tl4ih, ekteb: le ${id} bark.`;
      await notifySupervisor(clinic, notifMsg, "notif_booking", {
        patient_name: shownName || phone,
        patient_phone: phone,
        slot: p.display,
        ok_id: id,
        le_id: id,
      });
    }
  }
  // F4) two appointments: the first is booked — prompt for the second one.
  const extra = multiBooking.get(phone) || 0;
  if (extra > 0 && !dup) {
    if (extra <= 1) multiBooking.delete(phone); else multiBooking.set(phone, extra - 1);
    reply += msg("book_second_prompt", lang3(ar, frHere));
  }
  await db.clearProposal(phone).catch(() => {});
  await db.saveMessage(phone, "assistant", reply, clinic && clinic.id);
  return { handled: true, reply };
}

// The patient asks about THEIR booking status ("ca y est?", "t2akked?").
// Answer from the DB's real status — never let the AI guess.
function looksLikeStatusQuestion(text) {
  const t = " " + (text || "").toLowerCase().trim() + " ";
  if (/(ca y est|t2akked|t2akad|win wsol|el 7ajz|7ajzi|rendez[ -]?vous mte3i|mon rendez|statut|el wa9t mte3i|est confir|confirm)/i.test(t))
    return true;
  // Fix U (LNG8): English status forms ("when is my appointment?"). "my
  // appointment" only — a booking request ("book an appointment") never
  // matches, and handleStatusQuestion's resolveSlot guard double-protects.
  if (/(when('s| is) my appointment|my appointment|do i have an appointment|appointment status)/i.test(t))
    return true;
  // Fix U (MEM3): Arabic "متى موعدي؟" and its Derja-script cousins.
  return /(تأكد|تاكد|وين وصل|الحجز متاعي|حجزي|تم الحجز|موعدي|الموعد متاعي|متى موعدي|رونديفوي|الرونديفو متاعي)/.test(text || "");
}

async function handleStatusQuestion(phone, text, clinic, history) {
  if (!looksLikeStatusQuestion(text)) return { handled: false };
  // "t2akkedli ghodwa 10" = new booking request, not a status question.
  try {
    if (dates.resolveSlot(text).found) return { handled: false };
  } catch (e) {}
  const b = await db.getLatestBooking(phone).catch(() => null);
  if (!b) return { handled: false }; // no booking -> let normal flow / AI answer
  // Fix U (MEM4): with TWO active bookings the latest-only answer hid the
  // second appointment — report every active booking, one line each. A
  // cancelled LATEST booking keeps the single cancelled answer (flow9).
  let actives = [];
  if (typeof db.getBookingsByPhone === "function") {
    const all = await db.getBookingsByPhone(phone).catch(() => []);
    actives = (all || []).filter((x) => x.status === "pending" || x.status === "confirmed");
  }
  // Fix S: language from the central resolver (sticky via history); the
  // booking's own slot display still forces Arabic when it is Arabic-script
  // (the legacy signal for this branch).
  const hist = history || await db.getHistory(phone).catch(() => []);
  let lang = await resolveLang(phone, text, { history: hist });
  if (lang !== "ar" && isAr(b.slot)) lang = "ar";
  const when = b.slot || "";
  let reply;
  if (actives.length >= 2 && b.status !== "cancelled") {
    reply = actives
      .map((x) => msg(x.status === "confirmed" ? "status_confirmed" : "status_pending", lang, { when: x.slot || "" }))
      .join("\n");
  } else if (b.status === "confirmed") {
    reply = msg("status_confirmed", lang, { when });
  } else if (b.status === "cancelled") {
    reply = msg("status_cancelled", lang, { when });
  } else {
    reply = msg("status_pending", lang, { when });
  }
  return say(phone, reply, clinic);
}

// F7 — Cancel the patient's own booking (pending or confirmed), notify the secretary.
async function handleCancellation(phone, text, ar, clinic, fr) {
  // Fix U (MEM6): with several active bookings, cancel the one whose slot
  // matches a date named in the message ("annule celui de samedi") —
  // falling back to the latest active booking as before.
  let actives = [];
  if (typeof db.getBookingsByPhone === "function") {
    const all = await db.getBookingsByPhone(phone).catch(() => []);
    actives = (all || []).filter((x) => x.status === "pending" || x.status === "confirmed");
  }
  if (!actives.length) {
    const b = await db.getLatestBooking(phone).catch(() => null);
    if (b && (b.status === "pending" || b.status === "confirmed")) actives = [b];
  }
  await db.clearProposal(phone).catch(() => {});
  rescheduling.delete(phone);
  multiBooking.delete(phone);
  beneficiaryNext.delete(phone);
  bareNumClarify.delete(phone);
  if (!actives.length) {
    return say(phone, msg("cancel_none", lang3(ar, fr)), clinic);
  }
  let active = actives[actives.length - 1];
  if (actives.length > 1) {
    const rs = dates.resolveSlot(text, ar);
    if (rs.found && rs.dateDisplay) {
      const m = actives.find((x) => (x.slot || "").includes(rs.dateDisplay));
      if (m) active = m;
    }
  }
  await db.setBookingStatus(active.id, "cancelled").catch(() => {});
  await notifySecretary(`❌ Patient fassakh rendez-vous #${active.id}: ${active.phone} (${active.patient_name || "sans nom"}) — ${active.slot}`, clinic);
  let reply = msg("cancel_done", lang3(ar, fr), { slot: active.slot });
  // Fix U (CHA7): a question riding along with the cancellation ("…w
  // 9adech el consultation?") still gets its answer in the same reply.
  // faqKind vetoes status-shaped texts ("…el rendez-vous mte3i…"), so the
  // price pattern is re-checked directly (medical veto still applies).
  let fkq = faqKind(text);
  if (!fkq && !looksLikeMedicalQuestion(text)
      && /(9adech|b9adech|kadech|soum|prix|combien|tarif|بقداش|سوم|الثمن)/.test(" " + (text || "").toLowerCase() + " ")) {
    fkq = "price";
  }
  if (fkq) reply += "\n" + faqAnswer(fkq, ar, clinic, fr);
  return say(phone, reply, clinic);
}

// Rescheduling: move an EXISTING booking to a new slot — never a duplicate row.
async function handleRescheduleStart(phone, ar, clinic, fr) {
  const b = await db.getLatestBooking(phone).catch(() => null);
  const active = b && (b.status === "pending" || b.status === "confirmed") ? b : null;
  await db.clearProposal(phone).catch(() => {});
  if (!active) {
    return say(phone, msg("resched_none", lang3(ar, fr)), clinic);
  }
  rescheduling.set(phone, active.id);
  return say(phone, msg("resched_ask", lang3(ar, fr), { slot: active.slot }), clinic);
}

async function finishReschedule(phone, id, target, ar, clinic, fr) {
  await db.updateBookingSlot(id, target.display, target.slot_at).catch(() => {});
  rescheduling.delete(phone);
  await db.clearProposal(phone).catch(() => {});
  const reply = msg("resched_done", lang3(ar, fr), { display: target.display });
  await notifySecretary(`🔁 Patient badal rendez-vous #${id} (${phone}) -> ${target.display}`, clinic);
  await db.saveMessage(phone, "assistant", reply, clinic && clinic.id);
  return { handled: true, reply };
}

// Fix U (MEM8): the proposal is FOR someone else ("...l marti", "pour ma
// femme", "لولدي") — the booking must carry the BENEFICIARY's name, never
// silently the remembered caller name. Deliberately narrow: a relation
// word right after l/li/lel, "pour ma/mon + relation", or the Arabic
// attached forms. "pour moi" / "liya" are the caller, not a beneficiary.
function hasBeneficiaryMarker(text) {
  const t = " " + (text || "").toLowerCase() + " ";
  // Fix X (LT8): "le marti" — the French-shaped article "le" before a
  // Derja relation word is the same beneficiary marker as l/li/lel.
  if (/\b(l|li|lel|le)\s+(marti|rajli|weldi|benti|ommi|omi|o5ti|5ouya|baba|bouya|sa7bi|sa7ebti|zawjti|zawji)\b/.test(t)) return true;
  if (/\bpour\s+(ma|mon)\s+(femme|mari|fille|fils|mère|mere|père|pere|épouse|epouse|époux|epoux)\b/.test(t)) return true;
  return /(لمرتي|لراجلي|لولدي|لبنتي|لأمي|لامي|لأختي|لاختي|لخويا|لزوجتي|لزوجي|لابني)/.test(text || "");
}

// Deterministic booking turn. Returns { handled, reply } or { handled: false }
// to let the AI answer normally.
async function handleBookingTurn(phone, text, history, clinic) {
  clinic = clinic || {};
  // Per-number booking hours (pilot clinic override) + display text for messages.
  const bh = clinic.bookingHours || CLINIC_HOURS;
  // Displayed closing per weekday (Fix T, H1/H2/H3): tells a last bookable
  // start from a start at the real close, inside hoursCheck.
  const closeMap = displayedCloseMap(clinic.hours);
  // Fix W: each language's range text is the rendered schedule, not the
  // stored string (the az render of an Arabizi-authored text is the text
  // itself, so Derja wording is unchanged).
  const rangeTxt = clinic.hours ? (renderHoursText(clinic.hours, "az") || clinic.hours) : `mel ethneyn lel sebt: ${CLINIC_HOURS_TXT}`;
  const rangeTxtAr = clinic.hours ? (renderHoursText(clinic.hours, "ar") || clinic.hours) : `من الاثنين للسبت: ${CLINIC_HOURS_TXT}`;
  const rangeTxtFr = clinic.hours ? (renderHoursText(clinic.hours, "fr") || clinic.hours) : `du lundi au samedi : ${CLINIC_HOURS_TXT}`;
  // Language (Fix S): ONE central resolver for the whole booking flow —
  // explicit request in this message > Arabic script > saved preference >
  // this message's own markers > sticky context (pending proposal, then
  // history) > AI semantic check > Derja. A short follow-up ("oui", "ey")
  // can never flip the conversation language. `ar`/`fr` stay as booleans
  // for the legacy (ar, fr) helper signatures used below.
  const _prop0 = await db.getProposal(phone).catch(() => null);
  const lang = await resolveLang(phone, text, {
    history, proposalText: _prop0 && _prop0.slot_text, aiCheck: true,
  });
  const ar = lang === "ar";
  const fr = lang === "fr";

  // F1) Emergency — chest pain etc.: never a booking, direct to urgent care.
  if (looksLikeEmergency(text)) {
    await notifySecretary(`🚨 URGENCE? patient ${phone}: "${text}"`, clinic).catch(() => {});
    return say(phone, msg("emergency", lang), clinic);
  }

  // F6) Frustrated patient — brief "sama7ni", ask what went wrong, resume.
  if (looksLikeFrustration(text)) {
    return say(phone, msg("frustration", lang), clinic);
  }

  // F7) Cancellation — before the status question: cancelling beats asking.
  if (looksLikeCancellation(text)) return handleCancellation(phone, text, ar, clinic, fr);

  // Fix T (B16) — name correction on an EXISTING booking: update the name
  // on the booking row (and the remembered patient name), never rebook.
  const corrName = parseNameCorrection(text);
  if (corrName) {
    const bCorr = await db.getLatestBooking(phone).catch(() => null);
    if (bCorr && (bCorr.status === "pending" || bCorr.status === "confirmed")) {
      if (typeof db.updateBookingName === "function") await db.updateBookingName(bCorr.id, corrName).catch(() => {});
      await db.savePatientName(phone, corrName).catch(() => {});
      return say(phone, msg("name_corrected", lang, { name: capName(corrName) }), clinic);
    }
  }

  // Fix X (OT6) — beneficiary swap on an EXISTING booking ("hedha le
  // marti Amina Ben Ali, mech liya"): re-attribute the booking to the
  // named beneficiary. Never a second booking, never a rename of the
  // caller's remembered name.
  const swapName = parseBeneficiarySwap(text);
  if (swapName) {
    const bSwap = await db.getLatestBooking(phone).catch(() => null);
    if (bSwap && (bSwap.status === "pending" || bSwap.status === "confirmed")) {
      if (typeof db.updateBookingName === "function") await db.updateBookingName(bSwap.id, swapName).catch(() => {});
      return say(phone, msg("name_corrected", lang, { name: capName(swapName) }), clinic);
    }
  }

  // Fix X (MD1/ED7) — the MEDICAL GATE, before any slot resolution: a
  // medication/dosage question carrying a digit or a date word ("...طفل
  // عمره 6 سنوات؟", "...ghodwa... el doliprane 9adech marra ne5dou?")
  // used to be captured by the slot machinery (the "6" became an hour)
  // because looksLikeMedicalQuestion was only consulted in the fallback
  // and as a faqKind veto. The red line (tibbi = insen) is a hand-off —
  // fb_medical, never an answer, never a booking. A pending proposal is
  // left untouched and resumes on the next message.
  if (looksLikeMedicalQuestion(text)) {
    return say(phone, msg("fb_medical", lang), clinic);
  }

  // F8) FAQ / identity — pure questions (no date): answer directly, never
  // swallowed into a stale proposal.
  const r0 = dates.resolveSlot(text, ar);
  const fk0 = faqKind(text);
  // Fix T (H10/H11/H12): a pure question ABOUT a weekday ("Vous ouvrez le
  // samedi ?", "Vous fermez à quelle heure le jeudi ?", "te5dem el sabt?")
  // resolves a date with no concrete time, so the old !r0.date gate
  // swallowed it into the slot flow and "answered" with a proposal. A
  // question with no concrete time and no booking intent is a FAQ.
  // Fix V: the looksLikeQuestion test is GONE from the second clause —
  // it only knows "?" and start-anchored question words, so the same
  // question without punctuation ("Vous fermez a quelle heure le jeudi",
  // live 2026-10-13) failed it, fell past this gate into the name gate /
  // AI fallthrough, and came back as an Arabizi non-answer. An FAQ kind
  // with no concrete time and no booking intent IS the question shape.
  const fk = fk0 && (!r0.date || (r0.needs === "time" && !looksLikeBookingIntent(text))) ? fk0 : null;
  // Fix U (BIZ1): price asked for ANOTHER named doctor ("9adech el
  // consultation 3and Dr Jrad?" on the Mahjoub line) — never quote or leak
  // the other clinic; answer for THIS clinic only. Naming THIS clinic's own
  // doctor keeps the normal price FAQ.
  if (fk === "price") {
    const dm = (text || "").match(/\b(?:dr|docteur|dentiste)\.?\s+([a-zà-ÿ-]+)/i);
    if (dm && !(clinic.name || "").toLowerCase().includes(dm[1].toLowerCase())) {
      return say(phone, msg("other_doctor_price", lang, { clinicName: clinic.name || "" }), clinic);
    }
  }
  if (fk) return say(phone, faqAnswer(fk, ar, clinic, fr), clinic);

  // F11) Walk-in ("n7eb nji tawa") — explain, offer a reserved time, no loop.
  if (looksLikeWalkin(text)) {
    await db.clearProposal(phone).catch(() => {});
    rescheduling.delete(phone);
    return say(phone, msg("walkin", lang), clinic);
  }

  // F4) Two appointments — acknowledge both, one at a time, first one first.
  // NEVER invent who the second is for: explicit beneficiaries are kept,
  // otherwise the bot asks "el ouwel lchkoun?".
  if (looksLikeTwoAppointments(text)) {
    await db.clearProposal(phone).catch(() => {});
    rescheduling.delete(phone);
    multiBooking.set(phone, 1);
    const ben = detectExplicitBeneficiaries(text);
    // Fix X (OT2): when the LAST-named beneficiary is someone else, the
    // second booking must go through the name gate too (see the flag's
    // declaration). Caller-first order is the only shape the flag arms.
    if (ben.length >= 2 && ben[ben.length - 1] !== "lik") beneficiaryNext.set(phone, true);
    else beneficiaryNext.delete(phone);
    // Beneficiary names are localized with the same resolved language.
    const benName = (b) => lang === "fr" ? (BEN_FR[b] || b) : lang === "ar" ? (BEN_AR[b] || b) : b;
    // Fix T (B5/B6): a slot given up-front belongs to the FIRST appointment
    // — propose it right away instead of re-asking the day. Only a
    // concrete, future, in-hours slot qualifies; anything else keeps the
    // ask-day acknowledgement below.
    const seg = firstSlotSegment(text);
    let rFirst = null;
    if (seg) {
      const rr = dates.resolveSlot(seg, ar);
      if (rr.found && rr.date && !rr.needs && !rr.past && !hoursCheck(rr, bh, closeMap)) rFirst = rr;
    }
    let reply;
    if (rFirst) {
      await db.saveProposal(phone, seg, rFirst.iso, rFirst.display);
      reply = msg(ben.length >= 2 ? "two_rdv_first_two" : "two_rdv_first_any", lang, {
        ben1: ben.length ? benName(ben[0]) : "",
        ben2: ben.length > 1 ? benName(ben[1]) : "",
        display: rFirst.display,
      });
    } else if (ben.length >= 2) {
      reply = msg("two_rdv_two_ben", lang, { ben1: benName(ben[0]), ben2: benName(ben[1]) });
    } else if (ben.length === 1) {
      reply = msg("two_rdv_one_ben", lang, { ben1: benName(ben[0]) });
    } else {
      reply = msg("two_rdv_none", lang);
    }
    return say(phone, reply, clinic);
  }

  // Reschedule intent — move the existing booking, never duplicate it.
  if (looksLikeReschedule(text)) {
    // Fix U (CHA2): the machinery engages ONLY with an active booking to
    // move. With none, the word is a correction inside a booking
    // conversation ("le, baddel — el sabt el 10 a7sen liya" on a pending
    // PROPOSAL, test-deep B3/L2) and must fall through to the paths below
    // instead of dying on resched_none.
    const bRes = await db.getLatestBooking(phone).catch(() => null);
    const activeRes = bRes && (bRes.status === "pending" || bRes.status === "confirmed") ? bRes : null;
    if (activeRes) {
      // Fix T (B9): the new slot given INSIDE the request ("déplacer à
      // jeudi 11h") is used directly — proposed for confirmation; the
      // patient's acceptance then finishes the move (finishReschedule via
      // the rescheduling marker), instead of the slot being re-asked.
      if (r0.date && !r0.needs && !r0.past && !hoursCheck(r0, bh, closeMap)) {
        rescheduling.set(phone, activeRes.id);
        await db.saveProposal(phone, text, r0.iso, r0.display);
        return say(phone, msg("propose_slot", lang, { display: r0.display }), clinic);
      }
      return handleRescheduleStart(phone, ar, clinic, fr);
    }
  }

  // F13) Third-party query — privacy: only this number's bookings are visible.
  if (looksLikeThirdPartyQuery(text)) {
    return say(phone, msg("third_party", lang), clinic);
  }

  // A0) Status question — real DB status beats AI guessing.
  const st = await handleStatusQuestion(phone, text, clinic, history);
  if (st.handled) return st;

  // Patient-side "ok 5" — a secretary-command shape, never a validation.
  // (The webhook only routes real secretary commands from SECRETARY_NUMBER;
  // this is the in-bot safety net.)
  if (/^(ok|le|faskh|cancel)\s+\d+\s*$/.test(text.trim().toLowerCase())) {
    return say(phone, msg("sec_cmd_hint", lang), clinic);
  }

  let proposal = _prop0; // fetched once above for the resolver (null if stale/absent)
  // Fix T (L2): the message's OWN detected language beats proposal
  // stickiness — a full Derja sentence after a French proposal switches
  // the reply to Derja; only a neutral follow-up ("oui", "sbe7") sticks.
  const ownLang = langOfText(text);
  const ar2 = ar || (ownLang !== "fr" && isAr(proposal && proposal.slot_text)); // script sticks to the patient's own words
  // French sticks the same way: a short follow-up ("oui", "le matin") carries
  // no French marker, but the pending proposal's own words do.
  const fr2 = fr || (!ar2 && ownLang !== "az" && ownLang !== "ar" && !!proposal && looksLikeFrenchAuto(proposal.slot_text || ""));
  const lang2 = lang3(ar2, fr2); // proposal-sticky language for the sites below

  // A-1) We asked for the patient's name — this message answers that.
  if (proposal && proposal.awaiting_name) {
    return handleNameAnswer(phone, text, proposal, ar2, clinic, fr2);
  }

  // Fix X (item D addendum + Ahmed's uncertainty rule, 2026-10-13): a
  // BARE number while a slot decision is pending. Born from a live
  // test: the bot proposed "vendredi 16-10 09:00", the patient answered
  // "15" (the day) and the old proposal came back untouched. When the
  // bot is NOT SURE, it asks ONE short question instead of guessing:
  //  - concrete proposal pending (the bot asked "confirm?"): a number
  //    that reads as BOTH a day and an hour (1-23) gets the
  //    clarification question; 24-31 can only be a day -> direct.
  //  - an hour question (date-only proposal, slot_at null) never lands
  //    here: the merge machinery further down reads the number as the
  //    hour, directly, exactly like before.
  if (bareNumClarify.has(phone)) {
    const pendN = bareNumClarify.get(phone);
    bareNumClarify.delete(phone);
    if (proposal && proposal.slot_at) {
      const shiftedC = new Date(new Date(proposal.slot_at).getTime() + 3600000);
      const hhmmC = String(shiftedC.getUTCHours()).padStart(2, "0") + ":" + String(shiftedC.getUTCMinutes()).padStart(2, "0");
      const ansT = (text || "").trim().toLowerCase();
      // Clarification answers are SHORT ("le jour", "nhar", "l'heure"):
      // a longer message is a new instruction, never an answer.
      if (ansT.split(/\s+/).filter(Boolean).length <= 4) {
        const wantsDay = /(jour|nhar|يوم|نهار)/.test(ansT) || /^le\s+\d{1,2}\s*[.!]?$/.test(ansT);
        const wantsHour = /(heure|sa3a|saa3a|ساعة)/.test(ansT) || /^\d{1,2}\s*h/.test(ansT);
        if (wantsDay && !wantsHour) text = "le " + pendN + " " + hhmmC;
        else if (wantsHour && !wantsDay) {
          const dm = (proposal.display || "").match(/(\d{2}-\d{2}-\d{4})/);
          if (dm) text = dm[1] + " " + pendN + ":00";
        } else if (/^\d{1,2}\s*[.!]?$/.test(ansT)) {
          // Asked once and the same bare number came back: the pending
          // proposal is about the slot — take it as the day.
          text = "le " + pendN + " " + hhmmC;
        }
      }
      // Anything else: the flag is already cleared; normal flow decides.
    }
  }
  if (proposal && proposal.slot_at) {
    const bareDom = (text || "").match(/^\s*(\d{1,2})\s*[.!]?\s*$/);
    if (bareDom) {
      const domN = parseInt(bareDom[1], 10);
      if (domN >= 24 && domN <= 31) {
        // Day-only range: no hour reads "24"-"31" — resolve directly,
        // keeping the proposed time.
        const shifted = new Date(new Date(proposal.slot_at).getTime() + 3600000);
        const hhmm = String(shifted.getUTCHours()).padStart(2, "0") + ":" + String(shifted.getUTCMinutes()).padStart(2, "0");
        text = "le " + domN + " " + hhmm;
      } else if (domN >= 1 && domN <= 23) {
        bareNumClarify.set(phone, domN);
        return say(phone, msg("clarify_day_or_hour", lang2, { n: domN }), clinic);
      }
    }
  }

  let r = dates.resolveSlot(text, ar);
  let slotText = text; // the phrase the proposal remembers — grows as follow-ups merge

  // Fix X (DT14) — a self-correction INSIDE one message ("nheb na7jez el
  // jom3a el 10, le ghalat el sabt el 10"): the corrected tail wins over
  // the first-mentioned date. stripCorrectionPrefix only handles a
  // LEADING "le", so resolve the text after the LAST correction marker
  // and use it when it carries the date (a day-only tail inherits the
  // time stated before the marker).
  {
    const corrRe = /(le\s+ghalat|ghalat|ghalet|ghalt|غلطت|غلط|je corrige|plutôt|plutot)/gi;
    let cm = null, lastCorr = null;
    while ((cm = corrRe.exec(text))) lastCorr = cm;
    if (lastCorr) {
      const tail = text.slice(lastCorr.index + lastCorr[0].length).trim();
      if (tail && tail !== text) {
        let rc = dates.resolveSlot(tail, ar);
        if (rc.found && rc.date && rc.needs === "time" && r.found && r.date && !r.needs) {
          const mergedC = dates.resolveSlot(tail + " " + stripDateTokens(text.slice(0, lastCorr.index)), ar);
          if (mergedC.found && mergedC.date && !mergedC.needs) rc = mergedC;
        }
        if (rc.found && rc.date) { r = rc; slotText = tail; }
      }
    }
  }

  // F5) Fresh booking request wipes a stale proposal — never inherit old date/time.
  // Falls through to B0 below (rephrased nudge if we already asked, AI if first ask).
  if (!r.date && looksLikeBookingIntent(text)) {
    if (proposal) await db.clearProposal(phone).catch(() => {});
    proposal = null;
    rescheduling.delete(phone);
    beneficiaryNext.delete(phone);
    bareNumClarify.delete(phone);
  }

  // R) pure refusal ("le") -> drop the proposal, don't glue it to the old slot.
  // Before the merge block: a refusal must never be merged into the proposal.
  // French form ("Non, pas ce jour-là") counts too — in a French conversation.
  if (proposal && proposal.slot_text && (looksLikeRefusal(text) || (fr2 && looksLikeFrenchRefusal(text)))) {
    await db.clearProposal(phone).catch(() => {});
    return say(phone, msg("proposal_dropped", lang2), clinic);
  }

  // Q) Question during a pending proposal — THE GENERAL RULE: a question is
  // NEVER booking info. Answer it, keep the proposal alive, re-present it.
  // One rule covers every phrasing — no more whack-a-mole per message.
  // (2026-10-07, seen live: "win mawjouda el3iyeda?" was merged into the slot
  // and the bot re-sent the proposal without answering.)
  if (proposal && proposal.slot_text && !proposal.awaiting_name
      && looksLikeQuestion(text) && !looksLikeAcceptance(text) && !looksLikeRefusal(text)) {
    const rq = dates.resolveSlot(text, ar);
    if (!rq.date && !looksLikeBookingIntent(text)) {
      const fkq = faqKind(text);
      const pname = await db.getPatientName(phone).catch(() => null);
      const disp = proposal.display || proposal.slot_text;
      if (fkq) {
        // Known FAQ (address, hours, price...) — deterministic answer with the
        // real clinic data; the proposal stays pending for the "ey".
        return say(phone, faqAnswer(fkq, ar2, clinic, fr2), clinic);
      }
      // Unknown question -> the AI answers with the real clinic data in its
      // prompt (address/hours — never invented), then re-presents the pending
      // proposal so the booking thread isn't lost.
      const reAsk = msg("reask_proposal", lang2, { disp });
      const extraSys = fr2
        ? `\n- Vous avez une proposition de rendez-vous en attente : "${disp}" — après avoir répondu à la question, terminez par une seule phrase : "${reAsk}"`
        : `\n- 3andek proposal mta3 rendez-vous pending: "${disp}" — ba3d ma tjewb 3al sou2el, kamel b joumla wa7da: "${reAsk}"`;
      const ans = await aiReply(text, history, pname, clinic.name, ar2, extraSys, fr2 ? FRENCH_SYSTEM_PROMPT : null, clinic.address, clinic.hours);
      return say(phone, ans, clinic);
    }
  }

  // Fix T (B3/L2) — refuse + counter-propose in ONE message ("le, ma
  // yse3ednich el jom3a — nheb el sabt el 10", "le, baddel — el sabt el 10
  // a7sen liya"): the patient rejects the proposed day and names a better
  // one. The plain merge below glues the message onto the proposal text,
  // where the REJECTED weekday is named first and wins the parse (and an
  // unparseable new day used to vanish the same way). Here the rejected
  // weekday is stripped from the correction before resolving, so the
  // wished day wins.
  if (proposal && proposal.slot_text && !proposal.awaiting_name && proposal.slot_at) {
    const { hadLe, corr } = stripCorrectionPrefix(text);
    if (hadLe && /(nheb|n7eb|a7sen|ahsen|baddel|je préfère|je prefere|plutôt|plutot|mieux)/i.test(corr)) {
      const propR = dates.resolveSlot(proposal.slot_text, ar2);
      // Weekday names grouped by JS day number — the rejected day is the
      // proposal's own day.
      const DOW_WORDS = {
        0: ["la7ad", "l7ad", "lahad", "dimanche", "الأحد", "الاحد"],
        1: ["ethnin", "ethinin", "thnin", "tnin", "thenin", "lundi", "الاثنين", "الإثنين"],
        2: ["thletha", "thleth", "tletha", "tlata", "mardi", "الثلاثاء"],
        3: ["erb3a", "larb3a", "lerb3a", "mercredi", "الأربعاء", "الاربعاء"],
        4: ["khmis", "5mis", "khemis", "khamis", "kmis", "jeudi", "الخميس"],
        5: ["jem3a", "jom3a", "vendredi", "الجمعة"],
        6: ["sebt", "sibt", "sabt", "samedi", "السبت"],
      };
      const words = propR.dow !== null && propR.dow !== undefined ? (DOW_WORDS[propR.dow] || []) : [];
      let cleaned = " " + corr.toLowerCase() + " ";
      for (const w of words) cleaned = cleaned.split(" " + w + " ").join(" ");
      cleaned = cleaned.replace(/\s+/g, " ").trim();
      let rw = dates.resolveSlot(cleaned, ar2);
      if (rw.found && rw.date && rw.needs === "time") {
        // The correction names a day but no time: keep the proposal's time.
        const mergedW = dates.resolveSlot(cleaned + " " + stripDateTokens(proposal.slot_text), ar2);
        if (mergedW.found && mergedW.date && !mergedW.needs) rw = mergedW;
      }
      if (rw.found && rw.date && !rw.needs && !rw.past && rw.dateUTC !== propR.dateUTC) {
        r = rw; slotText = cleaned;
      }
    }
  }

  // Merge follow-ups into a pending proposal — but never a pure acceptance:
  // "ey" must reach the acceptance branch below.
  if ((!r.found || !r.date) && proposal && proposal.slot_text && !looksLikeAcceptance(text)) {
    // F2) correction after "le"/"non": the new info wins — strip the old
    // conflicting tokens from the proposal side so they can't win back.
    // BUT a leading "le" is not always Derja "no": in French it is the
    // article ("le matin" answering the time question). If the stripped
    // "correction" resolves to nothing, fall back to the plain follow-up
    // merge below instead of dropping the message (2026-10-13).
    const { hadLe, corr } = stripCorrectionPrefix(text);
    let corrected = false;
    if (hadLe) {
      const rn = dates.resolveSlot(corr, ar);
      if (rn.found) {
        let propSide = proposal.slot_text;
        if (hasTimeSignal(corr)) propSide = stripTimeTokens(propSide);
        if (rn.date) propSide = stripDateTokens(propSide);
        const merged = dates.resolveSlot(corr + " " + propSide, ar);
        if (merged.found && merged.date) { r = merged; slotText = corr + " " + propSide; corrected = true; }
      }
    }
    if (!corrected) {
      // follow-up like "sbe7" or "10" -> merge with the previous slot phrase.
      // New text first, so a changed hour wins over the old one.
      const merged = dates.resolveSlot(text + " " + proposal.slot_text, ar);
      if (merged.found && merged.date) { r = merged; slotText = text + " " + proposal.slot_text; }
    }
  }

  // 2026-10-10 Bug 5+6: time-only follow-up with NO proposal (the AI answered
  // the day message, so nothing was saved). Look back at recent user messages
  // for a day, merge it with the time. Only when the current text looks like
  // a time (digits or time words) — never for questions or other content.
  const _looksLikeTime = /(\d\s*[:h]\s*\d|\b\d{1,2}\b.*(sbe7|sbeh|3chiya|mta3|صباح|مساء)|^(9:30|10|11|12|13|14|15|16|17)$)/i.test(text);
  if (_looksLikeTime && (!r.found || !r.date) && !looksLikeAcceptance(text) && !looksLikeRefusal(text) && !looksLikeQuestion(text)) {
    const recentUser = [...history].reverse()
      .filter(m => m.role === "user")
      .slice(0, 3)
      .map(m => m.text || "");
    for (const um of recentUser) {
      if (!um || um === text) continue;
      const dr = dates.resolveSlot(um, ar);
      if (dr.found && dr.date) {
        const merged = dates.resolveSlot(text + " " + um, ar);
        if (merged.found && merged.date) { r = merged; slotText = text + " " + um; break; }
      }
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
        return say(phone, timeQuestionMsg(ar2, rp, proposal.slot_text, fr2), clinic);
      }
      await db.clearProposal(phone).catch(() => {});
      return say(phone, msg("ask_day_time", lang2), clinic);
    }
    if (!target) {
      // Don't hijack "ey" answers to non-booking questions (address info,
      // cancellation confirm, ...): let the AI answer with history context.
      const lastAsst = [...history].reverse().find((m) => m.role === "assistant");
      const lastText = (lastAsst && lastAsst.text) || "";
      if (/(address|adresse|عنوان|tfassakh|nfassakh|fassakh|فسخ|نفسخ|annuler|cancel)/i.test(lastText)) {
        return { handled: false };
      }
      // No pending slot — but a booking may already exist (double "ey"):
      // remind instead of inventing a new one.
      const existing = await db.getLatestBooking(phone).catch(() => null);
      if (existing && (existing.status === "pending" || existing.status === "confirmed")) {
        return say(phone, msg("already_pending", lang2, { slot: existing.slot }), clinic);
      }
      return { handled: false }; // no pending slot: let the AI answer
    }
    if (reschedId) return finishReschedule(phone, reschedId, target, ar2, clinic, fr2);
    // Fix U (MEM8): a beneficiary proposal ("...l marti") goes to the name
    // gate even when the caller's name is remembered — the name captured
    // next is the beneficiary's, and finishBooking books under it.
    if (hasBeneficiaryMarker((target.slot_text || "") + " " + text)) {
      await db.saveProposal(phone, target.slot_text || text, target.slot_at, target.display, true, null);
      return say(phone, askNameMsg(ar2, target.display, fr2), clinic);
    }
    // Fix X (OT2): the pending booking is the second half of a
    // two-appointment request whose beneficiary was named up-front —
    // the name gate applies even though the caller's name is remembered.
    if (beneficiaryNext.has(phone)) {
      beneficiaryNext.delete(phone);
      await db.saveProposal(phone, target.slot_text || text, target.slot_at, target.display, true, null);
      return say(phone, askNameMsg(ar2, target.display, fr2), clinic);
    }
    // Name gate: nom + prenom are asked AFTER acceptance, remembered per number.
    const known = await db.getPatientName(phone).catch(() => null);
    if (known) return finishBooking(phone, target, known, clinic, fr2);
    await db.saveProposal(phone, target.slot_text || text, target.slot_at, target.display, true, null);
    return say(phone, askNameMsg(ar2, target.display, fr2), clinic);
  }

  // B0) Booking intent but no date/time — and we ALREADY asked for day/time.
  // Don't fall through to the AI just to repeat the same question: nudge
  // with a rephrased ask + a concrete example (conversation memory).
  if (!r.found && looksLikeBookingIntent(text)) {
    const lastAsst = [...history].reverse().find((m) => m.role === "assistant");
    if (lastAsst && /(nhar w anhou wa9t|anhou nhar|wa9t yse3dek|أنهو نهار|وقت يساعدك|quel jour et quelle heure)/i.test(lastAsst.text)) {
      return say(phone, msg("booking_nudge", lang), clinic);
    }
    return { handled: false }; // first time asking: let the AI do it
  }

  // B) Slot information (new request or clarification answer).
  if (!r.found) return { handled: false };
  if (!r.date) {
    // "jem3a jeya" = next WEEK (Tunisian usage), no specific day: ask which
    // day of next week, don't fall through to the generic question.
    if (r.nextWeek) {
      return say(phone, msg("next_week_ask", lang), clinic);
    }
    // Time but no date, and the time is outside clinic hours ("nos el lil"
    // = midnight): reject it immediately — never ask for a day first.
    if (r.hour !== null && r.hour !== undefined) {
      const open = bh[new Date(dates.tunisNow().getTime()).getUTCDay()];
      const inside = open &&
        (r.hour > open[0] || (r.hour === open[0] && (r.minute || 0) >= 0)) &&
        (r.hour < open[1] || (r.hour === open[1] && (r.minute || 0) === 0));
      if (!inside) {
        const sug = suggestOpenSlot(dates.tunisNow().getTime(), ar, bh);
        if (sug) await db.saveProposal(phone, sug.display, sug.iso, sug.display).catch(() => {});
        return say(phone, hoursRejectMsg(ar, open ? "hours" : "closed", sug ? sug.display : "", clinic.hours || "", fr), clinic);
      }
    }
    return say(phone, msg("ask_day_exact", lang), clinic);
  }
  if (r.past) {
    return say(phone, msg("past_slot", lang), clinic);
  }
  if (r.needs === "time") {
    // Explicit invalid time ("ghodwa 25", "10:99"): flag it, never clarify around it.
    if (r.badHour) {
      return say(phone, msg("bad_hour", lang2, { badHour: r.badHour }), clinic);
    }
    // F10b) closed day (Sunday): redirect to the next open day — never ask a
    // time for a day the clinic is closed.
    if (r.dow !== null && !bh[r.dow]) {
      const sug = suggestOpenDay(r.dateUTC, ar2, bh);
      await db.saveProposal(phone, sug.dateDisplay, null, sug.dateDisplay);
      return say(phone, msg("closed_day", lang2, {
        range: lang2 === "fr" ? rangeTxtFr : lang2 === "ar" ? rangeTxtAr : rangeTxt,
        sugDay: sug.dateDisplay,
      }), clinic);
    }
    // Fix X (DT9): "à la première heure" / "awel wa9t" asks for the
    // day's OPENING time — propose it instead of asking "which time?".
    // Only when that opening slot is still in the future.
    if (/(premi[èe]re\s+heure|awel\s+wa9t|awwal\s+wa9t|أول\s+وقت)/i.test(text) && r.dow !== null && bh[r.dow]) {
      const openF = bh[r.dow][0];
      const openH = Math.floor(openF), openM = Math.round((openF % 1) * 60);
      if (r.dateUTC + openH * 3600000 + openM * 60000 > dates.tunisNow().getTime()) {
        const sug9 = dates.slotDisplay(r.dateUTC, openH, openM, ar2);
        await db.saveProposal(phone, slotText, sug9.iso, sug9.display);
        return say(phone, msg("propose_slot", lang2, { display: sug9.display }), clinic);
      }
    }
    // F10c) "afternoon" requested but the day closes at/before 14:00 (e.g. Saturday
    // 09:00-14:00): afternoon is outside hours — say so, suggest morning instead.
    if (r.afternoon && r.dow !== null && bh[r.dow] && bh[r.dow][1] <= 14) {
      const open = bh[r.dow];
      const hrs = `${String(open[0]).padStart(2, "0")}:00 - ${String(open[1]).padStart(2, "0")}:00`;
      await db.saveProposal(phone, slotText, null, r.dateDisplay);
      return say(phone, msg("afternoon_closed", lang2, { dateDisplay: r.dateDisplay, hrs }), clinic);
    }
    await db.saveProposal(phone, slotText, null, r.dateDisplay);
    const q = timeQuestionMsg(ar2, r, text, fr2);
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
      return say(phone, msg("confirm_24h", lang2, { dateDisplay: r.dateDisplay, hourStr, am, pm }), clinic);
    }
    return say(phone, q, clinic);
  }
  // F10) concrete slot outside clinic hours (or on a closed day): reject it and
  // offer the next suitable open slot, saved as the new proposal.
  const hc = hoursCheck(r, bh, closeMap);
  if (hc) {
    const sug = suggestOpenSlot(r.dateUTC, ar2, bh);
    await db.saveProposal(phone, sug.display, sug.iso, sug.display);
    return say(phone, hoursRejectMsg(ar2, hc.reason, sug.display, clinic.hours || "", fr2), clinic);
  }
  // concrete date+time -> propose it back, wait for "ey"
  await db.saveProposal(phone, slotText, r.iso, r.display);
  // Fix X (OT3): a request that mentions a death ("...howa twafa el
  // esbou3 elli fet allah yarhmou") gets one condolence line BEFORE the
  // proposal — never a bare cheerful slot offer for a deceased person.
  const deathMention = /(twafa|twaffa|allah\s+yarham|yarhmou|yarhamha|décédé|decede|décès|توفي|توفى|الله يرحم)/i.test(text || "");
  const proposeTxt = msg("propose_slot", lang2, { display: r.display });
  return say(phone, deathMention ? msg("condolence", lang2) + "\n" + proposeTxt : proposeTxt, clinic);
}

// ---------- Vendor (sales) mode: dentist wrote "جرّب" from the demo video ----------
// Exact trigger only — a patient never writes a bare "جرّب", so the booking
// flow is untouched. Once triggered, the sender stays in vendor mode until
// the handoff is done (secretary "fassa5 <numero>" resets it too).
function looksLikeVendorTrigger(text) {
  const t = (text || "").trim().replace(/[«»"']/g, "");
  return /^(جرّب|جرب|jareb|jarreb)$/i.test(t);
}

async function handleVendorTurn(phone, text, lead, clinic) {
  const ar = isAr(text);

  // Fresh trigger (or re-trigger after done): restart the pitch.
  if (!lead || (lead.stage === "done" && looksLikeVendorTrigger(text))) {
    await db.saveVendorLead(phone, "asked_clinic", null);
    return say(phone, ar
      ? "أهلا وسهلا! 👋 المساعد متاعنا يجاوب على واتساب العيادة بالدارجة التونسية، يحجز الـ rendez-vous وحدو حتى كي العيادة مسكّرة، والسكرتيرة متاعك تبقى هي اللي تقرّر الحجز النهائي. ما فمّاش اشتراك — تخلّص كان 2 دنانير على كل مريض يوصل، والشهر الأول بلاش. شنوّا اسم العيادة متاعك؟"
      : "Ahla w sahla! 👋 El assistant mte3na yjawb 3la WhatsApp el 3iyada b derja tounsiya, ya7jez el rendez-vous wa7dou 7atta ki el 3iyada msakra, w el secretaire mte3ek teb9a hiya eli t9arer el 7ajz el nihe2i. Ma fammech ichtirak — t5alles ken 2 dinars 3la kol mridh yousel, w el chhar elowel blech. Chnowa esm el 3iyada mte3ek?", clinic);
  }

  if (lead.stage === "asked_clinic") {
    const clinic = (text || "").trim().slice(0, 80) || "—";
    await db.saveVendorLead(phone, "asked_call", clinic);
    await notifySales(`🔔 Lead jdid (جرّب): 3iyada "${clinic}" — numero ${phone}`);
    return say(phone, ar
      ? `ممتاز، عيادة ${clinic}! 🎉 تحب نحكيو 10 دقايق باش نورّيك كيفاش يخدم على عيادتك؟ أنهو وقت يساعدك — اليوم ولا غدوة؟`
      : `Momtez, 3iyedet ${clinic}! 🎉 T7eb na7kiw 10 d9aye9 bech nwarik kifech ye5dem 3la 3iyedtek? Anhou wa9t yse3dek — lyoum walla ghodwa?`, clinic);
  }

  if (lead.stage === "asked_call") {
    const when = (text || "").trim().slice(0, 80) || "—";
    await db.saveVendorLead(phone, "done", lead.clinic_name);
    await notifySales(`📞 "${lead.clinic_name || "—"}" (${phone}) y7eb appel: "${when}"`);
    return say(phone, ar
      ? `داكور! ✅ باش نتصلو بيك ${when}. كان عندك أي سؤال اكتب هوني.`
      : `D'accord! ✅ Bech nettaslou bik ${when}. Ken 3andek ay sou2el ekteb houni.`, clinic);
  }

  // stage "done": handoff already made, stay quiet-ish.
  return say(phone, ar
    ? "شريكتنا باش تتصل بيك قريب. كان عندك سؤال آخر اكتب هوني."
    : "El charika bech tetassel bik 9rib. Ken 3andek sou2el e5er ekteb houni.", clinic);
}

// ---------------------------------------------------------------------------
// SALON VERTICAL — deterministic layer (2026-10-01)
// Runs ONLY for numbers whose vertical resolves to "salon" (see getClinic).
// The dentist path below is untouched: these detectors are never consulted
// for dentist numbers, so no dentist pattern can break.
// ---------------------------------------------------------------------------

// Salon services (demo list). canonical latin name per service.
const SALON_SERVICES = [
  { keys: ["brushing", "broshing", "broching"], name: "brushing" },
  { keys: ["chignon", "shinyon", "chinyon"], name: "chignon" },
  { keys: ["maquillage", "makiyaj", "makeup", "make-up"], name: "maquillage" },
  { keys: ["manucure", "manikur", "manucur"], name: "manucure" },
  { keys: ["pedicure", "pédicure", "pedikur"], name: "pédicure" },
  { keys: ["epilation", "épilation", "epilasyon"], name: "épilation" },
  { keys: ["soin", "visage", "nettoyage"], name: "soins visage" },
  { keys: ["coupe", "9assa", "9asa"], name: "coupe" },
  { keys: ["coloration", "sibgha", "sib8a", "colora"], name: "coloration" },
  { keys: ["coiffure", "kwafir", "coiffeur"], name: "coiffure" },
];

function parseSalonService(text) {
  const t = " " + (text || "").toLowerCase() + " ";
  for (const s of SALON_SERVICES)
    if (s.keys.some((k) => t.includes(k))) return s.name;
  return null;
}

// Demo price list — ALWAYS labelled "prix demo" in replies. The real prices
// come from the salon itself when it subscribes.
const SALON_DEMO_PRICES = [
  ["brushing", "25 DT"],
  ["coupe + brushing", "45 DT"],
  ["chignon", "60 DT"],
  ["maquillage", "80 DT"],
  ["manucure", "30 DT"],
  ["pédicure", "35 DT"],
  ["épilation (jambes)", "40 DT"],
  ["soins visage", "70 DT"],
  ["coloration", "90 DT"],
];

// The commercial offer (from the salon ad video): 15 days free, then
// 3 TND per confirmed appointment — pay only per result.
const SALON_OFFER_LATIN = "El offre: 15 jours blech 🎁, ba3d 3 DT 3la kol rendez-vous m2akked — ma t5alles ken ki el 7arifa tji lel salon mte3ek.";
const SALON_OFFER_AR = "العرض: 15 يوم بلاش 🎁، وبعد 3 دنانير على كل موعد مؤكد — ما تخلص كان كي الحريفة تجي للصالون متاعك.";

// Short intro (no question) — shared by the qualify "who" and mid-lead-flow info interrupts.
const SALON_INTRO_AR = "أنا مساعد الصالون 💇‍♀️ — مساعد واتساب يجاوب على حريفات الصالون، يحجزلهم، ويفكرهم بالمواعيد.";
const SALON_INTRO_LATIN = "Ena Assistant Salon 💇‍♀️ — assistant WhatsApp yjewb 3la 7orfa el salon, ye7jzelhom, w yfakarhom bel rendez-vous.";
const SALON_INTRO_FR = "Je suis Assistant Salon — un assistant WhatsApp pour les salons de beauté en Tunisie.";

function salonFaqKind(text) {
  const raw = text || "";
  const t = " " + raw.toLowerCase() + " ";
  if (/(chkoun enti|chkounek|chkon enti|who are you|what is this|شكون انت|شكونك|انت شكون|معلومات|معلومة|ma3loum|more info|en savoir plus|à ce sujet|a ce sujet|c'est quoi|c quoi|شنوة هذا|شنيا هذي|شنو هذا|شنوه هذا|ça sert à quoi|ca sert a quoi|kifech ye5dem|كيفاش يخدم|chnowa hedha|chneya hedhi|plus d.info)/.test(t)) return "who";
  if (/(n7eb lel salon|salon mte3i|salon mta3i|kifech nechri|kifech neshri|ichtirak|abonnement|نحب للصالون|نشري)/.test(t)) return "subscribe";
  if (/(9adech|b9adech|kadech|soum|prix|combien|بقداش|سوم|بكام)/.test(t)) return "prix";
  if (/(service|les services|chnowa el services|chnowa ta3ml|chnowa ta3mel|الخدمات|شنوة الخدمات)/.test(t)) return "services";
  if (parseSalonService(raw)) return "services";
  return null;
}

function salonFaqAnswer(kind, ar, service) {
  const priceList = SALON_DEMO_PRICES.map(([s, p]) => `• ${s}: ${p}`).join("\n");
  if (kind === "who") return ar
    ? SALON_INTRO_AR + "\nعندك صالون؟"
    : SALON_INTRO_LATIN + "\n3andek salon?";
  if (kind === "services") {
    const intro = service
      ? (ar ? `أي، نعملو ${service} 💅` : `Ey, na3mlou ${service} 💅`)
      : (ar ? "الخدمات 💅" : "El services 💅");
    return ar
      ? `${intro}:\n${priceList}\nهذوما أسوام مثال برك — الصالون الحقيقي يحط أسوامو. تحب تحجز؟ اكتب «نحب نحجز».`
      : `${intro}:\n${priceList}\nHedhom aswem mthel bark — el salon el 7a9i9i y7ott aswemou. T7eb ta7jez? Ekteb «n7eb na7jez».`;
  }
  if (kind === "prix") return ar
    ? `الأسوام 💅:\n${priceList}\nهذوما مثال برك — الصالون الحقيقي يحط أسوامو. تحب تحجز؟ اكتب «نحب نحجز».`
    : `El aswem 💅:\n${priceList}\nHedhom mthel bark — el salon el 7a9i9i y7ott aswemou. T7eb ta7jez? Ekteb «n7eb na7jez».`;
  // subscribe
  return ar ? SALON_OFFER_AR + "\nتحب نبداو؟ اكتب «نحب للصالون متاعي» ونحضرولك!"
    : SALON_OFFER_LATIN + "\nT7eb nebdew? Ekteb «n7eb lel salon mte3i» w n7adhroulek!";
}

// ---------- Salon demo booking (SIMULATED — never a real booking) ----------
// Demo bookings are saved with status='demo': they never appear in the
// secretary's pending list (/bookings, getPendingBookings) and never mix
// with real clinic bookings (pending/confirmed/cancelled).
const salonDemo = new Map(); // phone -> { stage, service, slot_at, display }

function looksLikeCustomService(text) {
  const t = (text || "").trim();
  if (!t || t.length > 30) return null;
  if (/[?؟]/.test(t)) return null;
  if (/\d/.test(t)) return null; // "ghodwa 10" is a slot, not a service
  return t;
}

function salonAskServiceMsg(ar) {
  return ar
    ? "أنهو service تحب؟ 💅 (brushing، chignon، maquillage، manucure...)"
    : "Anhou service t7eb? 💅 (brushing, chignon, maquillage, manucure...)";
}
function salonAskSlotMsg(ar, service) {
  const s = service ? ` (${service})` : "";
  return ar
    ? `تمام${s}! أنهو نهار ووقت يساعدك؟ (مثال: غدوة 10 متاع الصباح)`
    : `Tmem${s}! Anhou nhar w wa9t yse3dek? (mthel: ghodwa 10 mta3 sbe7)`;
}

async function salonSimulateBooking(phone, st, ar, clinic) {
  salonDemo.delete(phone);
  const svc = st.service || "service";
  const display = st.display || "";
  try {
    const id = await db.saveBooking(
      phone, `DEMO salon: ${svc} — ${display}`, st.slot_at || null, null, clinic && clinic.id);
    if (id) await db.setBookingStatus(id, "demo"); // tagged: never pending
  } catch (e) { console.error("[salon:demo]", e.message); }
  return say(phone, ar
    ? `✅ تم الحجز: ${svc} — ${display}.\nهذي تجربة برك! 🎭 في الصالون الحقيقي، الحجز يوصل للصالون ديراكت ويتأكد معاك. تحب واحد كيفو لصالونك؟ اكتب «نحب للصالون متاعي».`
    : `✅ T7ajzet: ${svc} — ${display}.\nHedhi tajrba bark! 🎭 Fel salon el 7a9i9i, el 7ajz yousal lel salon direct w yet2akked m3ak. T7eb wa7ed kifou lel salon mte3ek? Ekteb «n7eb lel salon mte3i».`, clinic);
}

async function handleSalonDemoBooking(phone, text, ar, clinic) {
  // Cancel mid-demo: drop the state, stay friendly.
  if (looksLikeRefusal(text) || looksLikeCancellation(text)) {
    salonDemo.delete(phone);
    return say(phone, ar
      ? "داكور، لغيت التجربة. تحب حاجة أخرى؟"
      : "D'accord, l4it el tajrba. T7eb 7aja o5ra?", clinic);
  }
  const st = salonDemo.get(phone) || {};
  const r = dates.resolveSlot(text, ar);
  const concrete = r.found && r.date && !r.needs && !r.past;

  // Continuing: waiting for the service.
  if (st.stage === "service") {
    const svc = parseSalonService(text) || looksLikeCustomService(text);
    if (!svc) return say(phone, salonAskServiceMsg(ar), clinic);
    st.service = svc;
    if (st.slot_at) return salonSimulateBooking(phone, st, ar, clinic);
    st.stage = "slot";
    salonDemo.set(phone, st);
    return say(phone, salonAskSlotMsg(ar, svc), clinic);
  }
  // Continuing: waiting for the slot.
  if (st.stage === "slot") {
    if (r.past) return say(phone, ar
      ? "الوقت هذا تعدى — قولي نهار ووقت آخر."
      : "El wa9t hetha 3adda — 9olli nhar w wa9t e5er.", clinic);
    if (concrete) {
      st.slot_at = r.iso; st.display = r.display;
      return salonSimulateBooking(phone, st, ar, clinic);
    }
    if (r.date && r.needs) return say(phone, timeQuestionMsg(ar, r, text), clinic);
    return say(phone, salonAskSlotMsg(ar, st.service), clinic);
  }
  // Fresh trigger: grab whatever the message already carries.
  const svc = parseSalonService(text);
  if (svc && concrete) return salonSimulateBooking(phone, { service: svc, slot_at: r.iso, display: r.display }, ar, clinic);
  if (svc) {
    salonDemo.set(phone, { stage: "slot", service: svc });
    return say(phone, salonAskSlotMsg(ar, svc), clinic);
  }
  if (concrete) {
    salonDemo.set(phone, { stage: "service", slot_at: r.iso, display: r.display });
    return say(phone, salonAskServiceMsg(ar), clinic);
  }
  salonDemo.set(phone, { stage: "service" });
  return say(phone, salonAskServiceMsg(ar), clinic);
}

// ---------- Salon lead capture (owner wants the bot for their salon) ----------
// Stages live in vendor_leads under "salon_*" — the dentist "جرّب" flow uses
// other stage names and never touches these. Flow data rides in the
// clinic_name column as JSON (name -> salon -> city -> phone -> done).
function salonLeadTrigger(text) {
  const t = " " + (text || "").toLowerCase() + " ";
  const raw = text || "";
  if (/(n7eb|nheb|n7ebb).{0,40}(lel salon|salon mte3i|salon mta3i|wa7ed kifou|wa7da kifha)/.test(t)) return true;
  if (/(nechri|neshri|ne5ou|nabonni|neshtarek).{0,20}(robot|service|hedha|hedhi)/.test(t)) return true;
  if (/(kifech|kifach|kifeh|kifah).{0,25}(nechri|neshri|ne5ou|nabda|nbadal|nbadel)/.test(t)) return true;
  if (/(b9adech|9adech|prix|soum).{0,25}(ichtirak|abonnement|robot|el service hedha)/.test(t)) return true;
  if (/\bsubscribe\b/i.test(t)) return true;
  return /(نحب).{0,20}(للصالون|نشري)/.test(raw);
}

function salonLeadData(lead) {
  try { return JSON.parse((lead && lead.clinic_name) || "{}"); }
  catch { return {}; }
}

// Pending question per lead stage — used when an info question interrupts
// the flow: answer it, then return to the pending question (stage unchanged).
function salonLeadPendingQ(stage, lang, ar, phone) {
  if (stage === "salon_ask_name")
    return lang === "fr" ? "Quel est votre nom ?"
      : ar ? "شنوة اسمك؟ (اكتب اسمك)" : "Chnowa esmek? (ekteb esmek)";
  if (stage === "salon_ask_salon")
    return lang === "fr" ? "Quel est le nom de votre salon ?"
      : ar ? "شنوة اسم الصالون؟" : "Chnowa esm el salon?";
  if (stage === "salon_ask_city")
    return lang === "fr" ? "Dans quelle ville se trouve-t-il ?"
      : ar ? "في أنهو مدينة؟" : "Fi anhou mdina?";
  if (stage === "salon_ask_phone")
    return lang === "fr"
      ? `On vous appelle sur ce numéro (${phone}) ? Ou vous en avez un autre ? (écrivez « pareil » ou le numéro)`
      : ar ? `باش نكلموك على النومرو هذا (${phone})؟ ولا عندك نومرو آخر؟ (اكتب «نفسو» ولا النومرو)`
      : `Bech nkallemouk 3al numero hetha (${phone})? Walla 3andek numero e5er? (ekteb «nafsou» walla el numero)`;
  return "";
}

async function handleSalonLeadTurn(phone, text, lead, ar, clinic) {
  // Cancel mid-flow: drop the lead state.
  if (looksLikeRefusal(text) || looksLikeCancellation(text)) {
    await db.clearVendorLead(phone).catch(() => {});
    return say(phone, ar
      ? "داكور، لغيت الطلب. كان بدلت رايك اكتب «نحب للصالون متاعي»."
      : "D'accord, l4it el demande. Ken badelt rayek ekteb «n7eb lel salon mte3i».", clinic);
  }
  const d = salonLeadData(lead);
  const stage = lead.stage;
  const lang = d.lang || (ar ? "ar" : "latin");
  // Info question mid-flow: answer it, then return to the pending question
  // (stage unchanged). "who" here = short intro only — they already said yes.
  const fkInfo = salonFaqKind(text);
  if (fkInfo === "who" || fkInfo === "services" || fkInfo === "prix") {
    const ans = fkInfo === "who"
      ? (lang === "fr" ? SALON_INTRO_FR : lang === "ar" ? SALON_INTRO_AR : SALON_INTRO_LATIN)
      : salonFaqAnswer(fkInfo, ar, parseSalonService(text));
    return say(phone, ans + "\n" + salonLeadPendingQ(stage, lang, ar, phone), clinic);
  }

  if (stage === "salon_ask_name") {
    const name = parsePatientName(text);
    if (!name) return say(phone, ar ? "شنوة اسمك؟ (اكتب اسمك)" : "Chnowa esmek? (ekteb esmek)", clinic);
    await db.saveVendorLead(phone, "salon_ask_salon", JSON.stringify({ ...d, name }));
    const cn = capName(name);
    return say(phone, ar
      ? `متشرفين ${cn}! 🌸 شنوة اسم الصالون متاعك؟`
      : `Mitcharfin ${cn}! 🌸 Chnowa esm el salon mte3ek?`, clinic);
  }

  if (stage === "salon_ask_salon") {
    const salon = (text || "").trim().slice(0, 80);
    if (!salon || salon.length < 2 || /[?؟]/.test(salon))
      return say(phone, ar ? "شنوة اسم الصالون؟" : "Chnowa esm el salon?", clinic);
    await db.saveVendorLead(phone, "salon_ask_city", JSON.stringify({ ...d, salon }));
    return say(phone, ar
      ? `الصالون "${salon}" — في أنهو مدينة؟`
      : `El salon "${salon}" — fi anhou mdina?`, clinic);
  }

  if (stage === "salon_ask_city") {
    const city = (text || "").trim().slice(0, 60);
    if (!city || city.length < 2 || /[?؟]/.test(city))
      return say(phone, ar ? "في أنهو مدينة؟" : "Fi anhou mdina?", clinic);
    await db.saveVendorLead(phone, "salon_ask_phone", JSON.stringify({ ...d, city }));
    return say(phone, ar
      ? `ممتاز! باش نكلموك على النومرو هذا (${phone})؟ ولا عندك نومرو آخر؟ (اكتب «نفسو» ولا النومرو)`
      : `Momtez! Bech nkallemouk 3al numero hetha (${phone})? Walla 3andek numero e5er? (ekteb «nafsou» walla el numero)`, clinic);
  }

  if (stage === "salon_ask_phone") {
    const t = (text || "").trim().toLowerCase();
    let finalPhone = phone;
    if (!/^(nafsou|nafs|nafsu|ey|ok|na3m|oui|نفسو|اي|أي)\s*[.,!؟]*$/.test(t)) {
      const digits = (text || "").replace(/\D/g, "");
      if (digits.length < 8) return say(phone, ar
        ? "النومرو هذا ما يبانش صحيح — عاود اكتبو (8 أرقام على الأقل) ولا اكتب «نفسو»."
        : "El numero hetha ma ybench s7i7 — 3awed ekteb (8 ar9am lel a9al) walla ekteb «nafsou».", clinic);
      finalPhone = digits;
    }
    const name = d.name || "—", salon = d.salon || "—", city = d.city || "—";
    await db.saveSignup(capName(name), finalPhone, salon, city, "salon");
    await notifySales(`🏪 Lead SALON jdid: ${capName(name)} — salon "${salon}" (${city}) — numero ${finalPhone}`);
    await db.saveVendorLead(phone, "salon_done", JSON.stringify(d));
    const cn = capName(name);
    return say(phone, ar
      ? `داكور ${cn}! ✅ باش نتصلو بيك قريب باش نحضرولك المساعد للصالون "${salon}" (${city}). شكرا! 🙏`
      : `D'accord ${cn}! ✅ Bech nettaslou bik 9rib bech n7adhroulek el assistant lel salon "${salon}" (${city}). Merci! 🙏`, clinic);
  }

  // stage "salon_done": handoff made, stay quiet-ish.
  return say(phone, ar
    ? "الطلب متاعك وصل — باش نتصلو بيك قريب. كان عندك سؤال آخر اكتب هوني."
    : "El demande mte3ek woslet — bech nettaslou bik 9rib. Ken 3andek sou2el e5er, ekteb houni.", clinic);
}

// French on the salon number: a short salon fallback — NEVER the dentist
// FRENCH_SYSTEM_PROMPT (it would pitch a dental clinic).
function salonFrenchFallback() {
  return "Salut ! 💇‍♀️ Je suis Assistant Salon — un assistant WhatsApp pour les salons de beauté en Tunisie.\n" +
    "Vous avez un salon ? (oui/non)";
}

function salonOwnerPitchFr() {
  return "Cet assistant travaille sur le WhatsApp de votre salon : il répond à vos clientes, " +
    "prend leurs rendez-vous et leur envoie des rappels — sans que vous fassiez rien.\n" +
    "L'offre : 15 jours gratuits 🎁, puis 3 DT par rendez-vous confirmé — " +
    "vous ne payez que si la cliente vient au salon.\n" +
    "On vous le prépare ? Quel est votre nom ?";
}

// No-AI-key fallback for the salon vertical (production has the AI key;
// the local test drives this path).
function salonFallbackReply(text, ar) {
  const useAr = ar || isAr(text);
  if (useAr) {
    if (/(خدمات|شنوة|شنو)/.test(text))
      return "الخدمات: brushing، chignon، maquillage، manucure، pédicure، épilation، soins visage. تحب تحجز؟ اكتب «نحب نحجز».";
    if (/(سوم|بقداش|فلوس|prix)/.test(text))
      return "هذوما أسوام مثال: brushing بـ25 DT، chignon بـ60 DT، maquillage بـ80 DT. الأسوام الحقيقية تتحط من الصالون متاعك.";
    if (/(حجز|رونديفو|موعد|نحجز)/.test(text))
      return "باش تجرب الحجز: قولي أنهو service وأنهو نهار ووقت — مثال «نحب نحجز brushing غدوة 10 متاع الصباح».";
    return "أنا مساعد الصالون 💇‍♀️ — تنجم تسألني على الخدمات، الأسوام، ولا تقولي «نحب نحجز» باش تشوف الحجز. وكان عندك صالون اكتب «نحب للصالون متاعي».";
  }
  const t = (text || "").toLowerCase();
  if (t.includes("service") || t.includes("chnowa"))
    return "El services: brushing, chignon, maquillage, manucure, pédicure, épilation, soins visage. T7eb ta7jez? Ekteb «n7eb na7jez».";
  if (/(soum|prix|9adech|b9adech)/.test(t))
    return "Hedhom aswem mthel: brushing 25 DT, chignon 60 DT, maquillage 80 DT. El prix el s7a7 yet7attou mel salon mte3ek.";
  if (/(7ajz|7jez|rendez|na7jez)/.test(t))
    return "Bech tjareb el 7ajz: 9olli anhou service w anhou nhar w wa9t — mthel «n7eb na7jez brushing ghodwa 10 mta3 sbe7».";
  return "Ena Assistant Salon 💇‍♀️ — tnajem tes2elni 3al services, el aswem, walla t9olli «n7eb na7jez» bech tchouf el 7ajz. W ken 3andek salon ekteb «n7eb lel salon mte3i».";
}

// Salon router: demo + lead capture. Returns { handled:false } when nothing
// matched — the caller then falls back to the salon AI prompt (never the
// dentist booking flow or the dentist French prompt).
async function handleSalonTurn(phone, text, clinic) {
  const ar = await scriptAr(phone, text);
  // 1) qualify stage (info-seeker: "3andek salon?") — branches before lead flow.
  const vqual = await db.getVendorLead(phone).catch(() => null);
  if (vqual && vqual.stage === "salon_qualify")
    return handleSalonQualifyTurn(phone, text, ar, clinic, vqual);
  // 2) lead flow in progress (stages "salon_*").
  const vlead = vqual;
  if (vlead && vlead.stage && vlead.stage.indexOf("salon_") === 0)
    return handleSalonLeadTurn(phone, text, vlead, ar, clinic);
  // 3) lead trigger.
  if (salonLeadTrigger(text)) {
    salonDemo.delete(phone); // explicit new intent wins over a stale demo
    await db.saveVendorLead(phone, "salon_ask_name", "{}");
    return say(phone, ar
      ? "ممتاز! 🎉 باش نحضرولك المساعد للصالون متاعك. شنوة اسمك؟"
      : "Super! 🎉 Bech n7adhroulek el assistant lel salon mte3ek. Chnowa esmek?", clinic);
  }
  // 4) demo booking in progress.
  if (salonDemo.has(phone)) return handleSalonDemoBooking(phone, text, ar, clinic);
  // 5) demo booking trigger.
  if (looksLikeBookingIntent(text)) return handleSalonDemoBooking(phone, text, ar, clinic);
  // 6) French -> short qualify (never the dentist French prompt).
  if (looksLikeFrenchRequest(text) || looksLikeFrenchAuto(text)) {
    await db.saveVendorLead(phone, "salon_qualify", JSON.stringify({ lang: "fr" }));
    return say(phone, salonFrenchFallback(), clinic);
  }
  // 7) pure greeting -> the salon demo greeting (from the number's config).
  if (looksLikePureGreeting(text))
    return say(phone, ar
      ? (clinic.greetingAr || clinic.greeting || "وعليكم السلام! كيفاش نجمو نعاونوك؟")
      : (clinic.greeting || "3alikom salam! Kifech najmou n3awnouk?"), clinic);
  // 8) salon FAQ (services / prix / subscribe). "who" (info-seeking) goes to
  // the qualify flow: short intro + "3andek salon?" instead of the AI.
  const fk = salonFaqKind(text);
  if (fk === "who") {
    await db.saveVendorLead(phone, "salon_qualify", JSON.stringify({ lang: ar ? "ar" : "latin" }));
    return say(phone, ar ? SALON_INTRO_AR + "\nعندك صالون؟" : SALON_INTRO_LATIN + "\n3andek salon?", clinic);
  }
  if (fk) return say(phone, salonFaqAnswer(fk, ar, parseSalonService(text)), clinic);
  return { handled: false };
}

// ---------- Salon qualify: info-seeker -> "3andek salon?" -> branch ----------
// "ey" (salon owner)  -> pitch (pitch + prix + CTA) -> lead flow (salon_ask_name).
// "le" (7arifa)        -> demo booking trial, nothing sold, transparency first.
function salonYesNo(text) {
  const raw = (text || "").trim().toLowerCase().replace(/[.,!؟?]/g, "");
  const t = " " + raw + " ";
  // "no" first: "3andi" is a substring of "3andich", so the negative wins.
  if (/(ma 3andich|ma3andich|m3andich|ma3andish|je n.ai pas|i don.t have|dont have|ما عنديش)/.test(t)) return "no";
  if (/^(le|le2|non|no|لا)$/.test(raw)) return "no";
  if (/(3andi salon|andi salon|j.ai un salon|j ai un salon|yes i have|3andi|نعم عندي)/.test(t)) return "yes";
  if (/^(ey|eyy|oui|yes|ok|na3m|aye|نعم|اي|أي|اه)$/.test(raw)) return "yes";
  return null;
}

function salonOwnerPitch(ar) {
  return ar
    ? "المساعد هذا يخدم على واتساب الصالون متاعك: يجاوب على حريفاتك، يحجزلهم، ويفكرهم بالمواعيد — وانتي ما تعمل شي.\n" +
      SALON_OFFER_AR + "\nتحب نحضروهولك؟ شنوة اسمك؟"
    : "El assistant hedha ye5dem 3la WhatsApp mte3 el salon mte3ek: yjeweb 3la 7orfa9ek, ye7jzelhom, w yfakarhom bel rendez-vous — w enti ma ta3mel chay.\n" +
      SALON_OFFER_LATIN + "\nT7eb n7adhrouhoulk? Chnowa esmek?";
}

async function handleSalonQualifyTurn(phone, text, ar, clinic, lead) {
  // The qualify question's language rides in the lead data ("oui"/"non" alone
  // are not detectable as French by the word-list detector).
  const lang = (lead && salonLeadData(lead).lang) || (ar ? "ar" : "latin");
  const fr = lang === "fr";
  // yes/no first: "le" here answers "3andek salon?" (no), it is not a cancel.
  const yn = salonYesNo(text);
  if (yn === "yes") {
    // Salon owner -> pitch + prix + CTA, straight into the lead flow (lang rides along).
    await db.saveVendorLead(phone, "salon_ask_name", JSON.stringify({ lang }));
    return say(phone, fr ? salonOwnerPitchFr() : salonOwnerPitch(ar), clinic);
  }
  if (yn === "no") {
    // 7arifa -> demo booking trial only, nothing sold, transparency first.
    await db.clearVendorLead(phone).catch(() => {});
    salonDemo.set(phone, { stage: "service" });
    if (fr) return say(phone,
      "D'accord ! La réservation ici est juste un essai, pas une vraie réservation.\n" +
      "Quel service vous intéresse ? 💅 (brushing, chignon, maquillage, manucure...)", clinic);
    return say(phone, (ar
      ? "داكور! الحجز هوني للتجربة برك (موش حجز حقيقي).\n"
      : "D'accord! El 7ajz houni lel tajrba bark (mouch 7ajz 7a9i9i).\n") + salonAskServiceMsg(ar), clinic);
  }
  if (looksLikeRefusal(text) || looksLikeCancellation(text)) {
    await db.clearVendorLead(phone).catch(() => {});
    return say(phone,
      fr ? "D'accord, pas de problème." :
      ar ? "داكور، ما فما حتى مشكل." : "D'accord, ma fama 7atta mochkla.", clinic);
  }
  // Unclear -> ask again, simply.
  return say(phone,
    fr ? "Vous avez un salon ? (oui/non)" :
    ar ? "عندك صالون؟ (أي / لا)" : "3andek salon? (ey / le)", clinic);
}

// ---------------------------------------------------------------------------
// VIXA SALES VERTICAL (2026-10-06) — +216 52 150 093, Meta ad destination.
// Sales assistant for CLINIC OWNERS (dentists, GPs, ophthalmologists...).
// Runs ONLY when vertical === "vixa". NEVER the dentist receptionist flow,
// NEVER "Cabinet Dr Ines", NEVER the AI (0-token deterministic, like salon).
// RED LINES: never answer medical questions (redirect, idari=bot/tibbi=insen);
// never claim reminders/follow-up are live on the doctor's OWN number before
// they subscribe; price = BLECH — no price mentioned, ever (Ahmed 2026-10-06).
// ---------------------------------------------------------------------------

// Short intro (no question) — shared by qualify "who" and mid-lead-flow info interrupts.
const VIXA_INTRO_AR = "أنا مساعد VIXA 🏥 — مساعد واتساب للعيادات: يجاوب على المرضى، يحجزلهم، ويفكرهم بالمواعيد.";
const VIXA_INTRO_LATIN = "Ena Assistant VIXA 🏥 — assistant WhatsApp lel les cliniques: yjewb 3la les patients, ye7jzelhom, w yfakarhom bel rendez-vous.";
const VIXA_INTRO_FR = "Je suis Assistant VIXA 🏥 — un assistant WhatsApp pour les cliniques : il répond aux patients, prend les rendez-vous et envoie les rappels.";

// The commercial offer: BLECH. No price, no subscription, no per-patient fee
// — Ahmed's rule 2026-10-06 (free until 3-5 doctors subscribe; #6+ pays, TBD).
const VIXA_OFFER_LATIN = "El offre: blech! 🎁";
const VIXA_OFFER_AR = "العرض: بلاش! 🎁";
const VIXA_OFFER_FR = "L'offre : gratuit ! 🎁";

// Medical questions: NEVER answered on this number — redirect, always.
const VIXA_MEDICAL_LATIN = "Ena assistant VIXA lel les cliniques — ma njewbch 3la as2la tibbiya 🙂 Ken 3andek mochkla sa7iya, lazem tchouf tbib 7a9i9i. Ken enti tbib w t7eb el assistant lel 3iyada mte3ek, 9olli!";
const VIXA_MEDICAL_AR = "أنا مساعد VIXA للعيادات — ما نجاوبش على أسئلة طبية 🙂 كان عندك مشكلة صحية، لازم تشوف طبيب حقيقي. وكان انتي طبيب وتحب المساعد للعيادة متاعك، قولي!";
const VIXA_MEDICAL_FR = "Je suis l'assistant VIXA pour les cliniques — je ne réponds pas aux questions médicales 🙂 Pour un problème de santé, consultez un vrai médecin. Si vous êtes médecin et voulez l'assistant pour votre clinique, dites-le-moi !";

// Not a clinic owner (patient messaging by mistake): brief redirect.
const VIXA_NOTOWNER_LATIN = "El numero hetha mte3 les propriétaires des cliniques (bech yjarbou el assistant VIXA) 🙂 Ken enti patient, lazem tetassel bel 3iyada mte3ek direct.";
const VIXA_NOTOWNER_AR = "النومرو هذا مخصص لأصحاب العيادات (باش يجربو مساعد VIXA) 🙂 كان انتي مريض، لازم تتصل بالعيادة متاعك ديراكت.";
const VIXA_NOTOWNER_FR = "Ce numéro est réservé aux propriétaires de cliniques (pour découvrir l'assistant VIXA) 🙂 Si vous êtes patient, contactez directement votre clinique.";

function vixaFaqKind(text) {
  const raw = text || "";
  const t = " " + raw.toLowerCase() + " ";
  // Medical FIRST (red line): never answer, always redirect.
  if (/(wji3a|wjaa|وجع|وجيعة|dwe|دواء|medicament|ordonnance|mardh|mridh|مرض|مريض|symptome|اعراض|أعراض|diagnostic|تشخيص|douleur|malade|maladie)/.test(t)) return "medical";
  if (/(chkoun enti|chkounek|chkon enti|who are you|what is this|vixa|شكون انت|شكونك|انت شكون|معلومات|معلومة|ma3loum|more info|en savoir plus|à ce sujet|a ce sujet|c'est quoi|c quoi|شنوة هذا|شنيا هذي|شنو هذا|ça sert à quoi|ca sert a quoi|kifech ye5dem|كيفاش يخدم|chnowa hedha|chneya hedhi|plus d.info)/.test(t)) return "who";
  // prix before subscribe: "b9adech el ichtirak?" is a price question -> blech.
  if (/(9adech|b9adech|kadech|soum|prix|combien|بقداش|سوم|بكام|flous|gratuit|blech|بلاش)/.test(t)) return "prix";
  if (/(n7eb lel 3iyada|3iyada mte3i|3iyada mta3i|n7eb wa7ed kifou|kifech nechri|kifech neshri|kifech nabda|nechri|neshri|nabda m3akom|nabda m3ak|ichtirak|abonnement|نحب للعيادة|نشري|نبدا)/.test(t)) return "subscribe";
  if (/(chnowa ta3ml|chnowa ta3mel|chnowa ye5dem|features|الخدمات|شنوة الخدمات|chnowa el services|chnowa ya3mel)/.test(t)) return "services";
  return null;
}

function vixaServicesText(ar) {
  return ar
    ? "شنوة يعمل المساعد؟ 🏥\n• يجاوب على المرضى بالدارجة والعربي والفرنسي، 24/7\n• يحجز رونديفو (والسكرتيرة هي اللي تأكد)\n• يفكرهم قبل بنهار\n• يبعث notification للسكرتيرة\n• يعمل suivi بعد الـ visite"
    : "Chnowa ya3mel el assistant? 🏥\n• Yjewb 3la les patients bel derja wel 3arbi wel français, 24/7\n• Ye7jez rendez-vous (w el secretaire hiya eli t2akked)\n• Yfakarhom 9bal b nhar\n• Yeb3ath notification lel secretaire\n• Ya3mel suivi ba3d el visite";
}

function vixaFaqAnswer(kind, ar) {
  if (kind === "who") return ar
    ? VIXA_INTRO_AR + "\nانتي طبيب ولا عندك عيادة؟ (أي / لا)"
    : VIXA_INTRO_LATIN + "\nEnti tbib walla 3andek 3iyada? (ey / le)";
  if (kind === "services") return vixaServicesText(ar) + "\n" + (ar ? VIXA_OFFER_AR : VIXA_OFFER_LATIN);
  if (kind === "prix") return ar
    ? VIXA_OFFER_AR + " ما فما حتى سوم — العرض بلاش."
    : VIXA_OFFER_LATIN + " Ma fama 7atta soum — el offre blech.";
  // subscribe is handled by the lead flow; this is the fallback answer.
  return ar ? VIXA_OFFER_AR + "\nتحب نحضروهولك؟ شنوة اسمك؟"
    : VIXA_OFFER_LATIN + "\nT7eb n7adhrouhoulek? Chnowa esmek?";
}

// Owner pitch (Ahmed's words, short chat form): what it does + blech + CTA.
// Describes the PRODUCT (like the salon pitch) — never claims the features
// are already live on the doctor's own number before they subscribe.
function vixaOwnerPitch(ar) {
  const body = ar
    ? "المساعد هذا يخدم على واتساب العيادة متاعك: يجاوب على المرضى متاعك بالدارجة والعربي والفرنسي 24/7، يحجزلهم رونديفو (والسكرتيرة هي اللي تأكد)، ويفكرهم قبل بنهار — وانتي ما تعمل شي."
    : "El assistant hedha ye5dem 3la WhatsApp mte3 el 3iyada mte3ek: yjewb 3la les patients mte3ek bel derja wel 3arbi wel français 24/7, ye7jzelhom rendez-vous (w el secretaire hiya eli t2akked), w yfakarhom 9bal b nhar — w enti ma ta3mel chay.";
  const offer = ar ? VIXA_OFFER_AR : VIXA_OFFER_LATIN;
  const cta = ar ? "تحب نحضروهولك للعيادة متاعك؟ شنوة اسمك؟" : "T7eb n7adhrouhoulek lel 3iyada mte3ek? Chnowa esmek?";
  return body + "\n" + offer + "\n" + cta;
}

function vixaOwnerPitchFr() {
  return "Cet assistant travaille sur le WhatsApp de votre clinique : il répond à vos patients " +
    "en derja, arabe et français 24/7, prend leurs rendez-vous (votre secrétaire valide), " +
    "et leur envoie des rappels — sans que vous fassiez rien.\n" +
    VIXA_OFFER_FR + "\n" +
    "On vous le prépare ? Quel est votre nom ?";
}

function vixaFrenchFallback() {
  return "Salut ! 🏥 Je suis Assistant VIXA — un assistant WhatsApp pour les cliniques en Tunisie.\n" +
    "Vous êtes médecin / vous avez une clinique ? (oui/non)";
}

// ---------- VIXA lead capture (clinic owner wants the assistant) ----------
// Stages live in vendor_leads under "vixa_*" — the salon "salon_*" and dentist
// vendor stages never touch these. Flow data rides in the clinic_name column
// as JSON (name -> clinic -> phone -> time -> done).
function vixaLeadTrigger(text) {
  const t = " " + (text || "").toLowerCase() + " ";
  const raw = text || "";
  if (/(n7eb|nheb).{0,40}(lel 3iyada|3iyada mte3i|3iyada mta3i|wa7ed kifou|assistant)/.test(t)) return true;
  if (/(nechri|neshri|ne5ou|nabda|nbadal).{0,25}(hedha|hedhi|m3akom|m3ak|service)/.test(t)) return true;
  if (/(kifech|kifach|kifeh).{0,25}(nechri|neshri|ne5ou|nabda|njarreb|n7adher)/.test(t)) return true;
  if (/\bsubscribe\b/i.test(t)) return true;
  return /(نحب).{0,20}(للعيادة|نشري|نبدا)/.test(raw);
}

function vixaLeadData(lead) {
  try { return JSON.parse((lead && lead.clinic_name) || "{}"); }
  catch { return {}; }
}

// Pending question per lead stage — used when an info question interrupts
// the flow: answer it, then return to the pending question (stage unchanged).
function vixaLeadPendingQ(stage, lang, ar, phone) {
  if (stage === "vixa_ask_name")
    return lang === "fr" ? "Quel est votre nom ?"
      : ar ? "شنوة اسمك؟ (اكتب اسمك)" : "Chnowa esmek? (ekteb esmek)";
  if (stage === "vixa_ask_clinic")
    return lang === "fr" ? "Quel est le nom de votre clinique ? (et la spécialité — ex : dentiste)"
      : ar ? "شنوة اسم العيادة متاعك؟ (والاختصاص — مثال: dentiste)" : "Chnowa esm el 3iyada mte3ek? (w el e5tisas — mthel: dentiste)";
  if (stage === "vixa_ask_phone")
    return lang === "fr"
      ? `On vous appelle sur ce numéro (${phone}) ? Ou vous en avez un autre ? (écrivez « pareil » ou le numéro)`
      : ar ? `باش نكلموك على النومرو هذا (${phone})؟ ولا عندك نومرو آخر؟ (اكتب «نفسو» ولا النومرو)`
      : `Bech nkallemouk 3al numero hetha (${phone})? Walla 3andek numero e5er? (ekteb «nafsou» walla el numero)`;
  if (stage === "vixa_ask_time")
    return lang === "fr" ? "Quel moment vous arrange pour un appel de 10 minutes ? (ex : demain 10h)"
      : ar ? "أنهو وقت يساعدك للمكالمة متاع 10 دقايق؟ (مثال: غدوة 10 متاع الصباح)"
      : "Anhou wa9t yse3dek lel appel mta3 10 d9aye9? (mthel: ghodwa 10 mta3 sbe7)";
  return "";
}

// General off-script handler for the VIXA flow ("kifech ye5dem" logic, 2026-10-07):
// the deterministic layer keeps ALL decisions (stages, prices, medical red
// line); the AI only phrases the nudge — acknowledge briefly in the user's
// language, then ask pendingQ. No per-message regex needed anymore.
// "I don't need a call" (embedded refusal, any stage) -> graceful close.
// Deterministic decision: never notify sales about someone who refused.
function vixaRefusesCall(text) {
  const t = " " + (text || "").toLowerCase() + " ";
  const neg = /(ma7ajtich|ma 7ajtich|manich|ma nich|man7ebch|ma n7ebch|mouch lezem|mech lezem|pas besoin|ne veux pas|veux pas|don't want|no need|ma nest7a9ch)/;
  const callw = /(appel|call|tklm|tekalm|tassel|titsel|t3aytel|y3aytel|yotlob|totlob)/;
  return neg.test(t) && callw.test(t);
}

// A name/clinic answer is a noun phrase. Verb phrases, hedges and questions
// ("juste nes2el", "nheb na3ref akther", "chnowa el prix?") are never names —
// accepting them as names is what makes the bot "not understand Derja".
function vixaLooksLikeSentence(text) {
  const t = " " + (text || "").toLowerCase().replace(/[.,!؟?]/g, "") + " ";
  if (/\b(juste|nes2el|nes2l|nse2el|na3ref|naaref|nheb|n7eb|nlawej|nefhem|3andi sou2el|andi sou2el)\b/.test(t)) return true;
  if (/\b(je suis|j'ai|je veux|je cherche|je voudrais|c'est|il y a)\b/.test(t)) return true;
  return /\b(chnowa|chniya|chneya|kifech|9adech|b9adech|win|wa9tech|3lech|chkoun|chkounek|quel|quelle|comment|pourquoi|combien)\b/.test(t);
}

// "ma3andich clinique" is a denial, never a clinic name.
function vixaDeniesClinic(text) {
  const t = " " + (text || "").toLowerCase() + " ";
  return /(ma ?3andich|ma ?andich|i don'?t have( a clinic)?|no clinic|pas de clinique|n'?ai pas de clinique)/.test(t);
}

async function vixaAiNudge(phone, text, pendingQ, ar, clinic) {
  if (!AI_API_KEY) return say(phone, pendingQ, clinic); // tests / no key: old behavior
  const replyLang = ar ? "ar"
    : (looksLikeFrenchRequest(text) || looksLikeFrenchAuto(text)) ? "fr" : "latin";
  const langName = replyLang === "ar" ? "Arabic script"
    : replyLang === "fr" ? "French" : "Tunisian Derja in Latin script (arabizi)";
  const sys =
    `You are VIXA, a friendly WhatsApp assistant for clinics in Tunisia, mid-conversation with a doctor or clinic owner. ` +
    `Reply in ${langName}. ` +
    `Acknowledge what they just wrote in ONE short warm sentence, then ask EXACTLY this question: "${pendingQ}" ` +
    `Rules: never invent prices, offers, discounts or promises (the offer is free: blech/gratuit); ` +
    `never answer medical questions — say a doctor must answer those; keep it under 40 words.`;
  let r = null;
  try { r = await aiReply(text, [], null, "", replyLang === "ar", "", sys); }
  catch (e) { r = null; }
  return say(phone, (r && String(r).trim()) || pendingQ, clinic);
}

// General dismissal ("manheb chay tawa", "sayeb 3laya", "ma7ajtich", ...):
// at ANY stage this is a refusal, never an answer (name/clinic/phone/time).
function vixaDismissal(text) {
  const t = " " + (text || "").toLowerCase().replace(/[.,!؟?]/g, "") + " ";
  return /(\bmanheb\b|\bma nheb\b|\bman7ebch\b|\bma7ajtich\b|\bma nest7a9ch\b|\bsayeb\b|\bmouch lezem\b|\bmech lezem\b|\bmouch wa9tou\b|\bma yse3ednich\b|\bje ne veux pas\b|\bnon merci\b|\bno thanks\b|\bnot interested\b)/.test(t);
}

async function handleVixaLeadTurn(phone, text, lead, ar, clinic) {
  // Cancel mid-flow: drop the lead state.
  if (looksLikeRefusal(text) || looksLikeCancellation(text)) {
    await db.clearVendorLead(phone).catch(() => {});
    return say(phone, ar
      ? "داكور، لغيت الطلب. كان بدلت رايك اكتب «نحب للعيادة متاعي»."
      : "D'accord, l4it el demande. Ken badelt rayek ekteb «n7eb lel 3iyada mte3i».", clinic);
  }
  const d = vixaLeadData(lead);
  const stage = lead.stage;
  const lang = d.lang || (ar ? "ar" : "latin");
  // "ma7ajtich b appel" (call-specific) first -> nicer message.
  if (vixaRefusesCall(text)) {
    await db.clearVendorLead(phone).catch(() => {});
    return say(phone, lang === "fr" ? "D'accord, pas d'appel. 👍 Si vous changez d'avis, écrivez « je veux un assistant »."
      : lang === "ar" ? "داكور، بلا مكالمة. 👍 كان بدلت رايك اكتب «نحب للعيادة متاعي»."
      : "D'accord, blech appel. 👍 Ken badelt rayek ekteb «n7eb lel 3iyada mte3i».", clinic);
  }
  // General dismissal ("manheb chay tawa", "sayeb 3laya") at any stage -> cancel.
  if (vixaDismissal(text)) {
    await db.clearVendorLead(phone).catch(() => {});
    return say(phone, ar
      ? "داكور، لغيت الطلب. كان بدلت رايك اكتب «نحب للعيادة متاعي»."
      : "D'accord, l4it el demande. Ken badelt rayek ekteb «n7eb lel 3iyada mte3i».", clinic);
  }
  // Info question mid-flow: answer it, then return to the pending question
  // (stage unchanged). Medical mid-flow: redirect, never answer.
  const fkInfo = vixaFaqKind(text);
  if (fkInfo === "medical") {
    const redir = lang === "fr" ? VIXA_MEDICAL_FR : lang === "ar" ? VIXA_MEDICAL_AR : VIXA_MEDICAL_LATIN;
    return say(phone, redir + "\n" + vixaLeadPendingQ(stage, lang, ar, phone), clinic);
  }
  if (fkInfo === "who" || fkInfo === "services" || fkInfo === "prix") {
    const ans = fkInfo === "who"
      ? (lang === "fr" ? VIXA_INTRO_FR : lang === "ar" ? VIXA_INTRO_AR : VIXA_INTRO_LATIN)
      : vixaFaqAnswer(fkInfo, ar);
    return say(phone, ans + "\n" + vixaLeadPendingQ(stage, lang, ar, phone), clinic);
  }

  if (stage === "vixa_ask_name") {
    const name = parsePatientName(text);
    if (!name) return vixaAiNudge(phone, text, vixaLeadPendingQ(stage, lang, ar, phone), ar, clinic);
    await db.saveVendorLead(phone, "vixa_ask_clinic", JSON.stringify({ ...d, name, lang }));
    const cn = capName(name);
    return say(phone, lang === "fr" ? `Enchanté ${cn} ! 🏥 Quel est le nom de votre clinique ? (et la spécialité — ex : dentiste)`
      : ar ? `متشرفين ${cn}! 🏥 شنوة اسم العيادة متاعك؟ (والاختصاص — مثال: dentiste)`
      : `Mitcharfin ${cn}! 🏥 Chnowa esm el 3iyada mte3ek? (w el e5tisas — mthel: dentiste)`, clinic);
  }

  if (stage === "vixa_ask_clinic") {
    // "ma3andich clinique" -> not an owner after all: same redirect as "le".
    if (vixaDeniesClinic(text)) {
      await db.clearVendorLead(phone).catch(() => {});
      return say(phone, lang === "fr" ? VIXA_NOTOWNER_FR : lang === "ar" ? VIXA_NOTOWNER_AR : VIXA_NOTOWNER_LATIN, clinic);
    }
    const cn2 = (text || "").trim().slice(0, 80);
    if (!cn2 || cn2.length < 2 || /[?؟]/.test(cn2) || vixaLooksLikeSentence(text))
      return vixaAiNudge(phone, text, vixaLeadPendingQ(stage, lang, ar, phone), ar, clinic);
    await db.saveVendorLead(phone, "vixa_ask_phone", JSON.stringify({ ...d, clinic: cn2, lang }));
    return say(phone, vixaLeadPendingQ("vixa_ask_phone", lang, ar, phone), clinic);
  }

  if (stage === "vixa_ask_phone") {
    const t = (text || "").trim().toLowerCase();
    let finalPhone = phone;
    // "nafsou", "nafs enoumrou", "nafs el numero", "le même" ... -> same number.
    const sameNumber = /\bnafs/.test(t) || /\bm[eê]me\b/.test(t)
      || /^(ey|ok|na3m|oui|pareil|نفسو|اي|أي)\s*[.,!؟]*$/.test(t);
    if (!sameNumber) {
      const digits = (text || "").replace(/\D/g, "");
      if (digits.length < 8) return vixaAiNudge(phone, text,
        "El numero hetha ma ybench s7i7 — 3awed ekteb (8 ar9am lel a9al) walla ekteb «nafsou».", ar, clinic);
      finalPhone = digits;
    }
    await db.saveVendorLead(phone, "vixa_ask_time", JSON.stringify({ ...d, finalPhone, lang }));
    return say(phone, vixaLeadPendingQ("vixa_ask_time", lang, ar, phone), clinic);
  }

  if (stage === "vixa_ask_time") {
    // The answer must look like a time; gibberish ("xyz") or anything else
    // goes through the AI nudge instead of being confirmed blindly.
    // NOTE: bare [0-9] is too loose in Arabizi ("3aslema", "ma3neha" carry
    // digit-letters) — only count standalone time-like numbers.
    const tl = (text || "").toLowerCase();
    const hasTimeNum = /(^|[^\w\d])\d{1,2}\s*([h:]|$|[^\w])/.test(tl);
    const hm = tl.match(/(^|[^\w\d])(\d{1,2})\s*([h:]|$|[^\w])/);
    const badVixaHour = hm && parseInt(hm[2], 10) > 23; // "ghodwa 25" is never a time
    const timeish = hasTimeNum || /ghodwa|demain|lyoum|aujourd|today|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|sebt|sebte|7ad|tnen|tlet|tlath|arb3a|5mis|jem3a|sbe7|sbeh|3chiya|achiya|lil|matin|soir|morning|evening|weekend|d9i9a|minute|wa9tech|kif ma|comme|quand/.test(tl);
    if (badVixaHour || !timeish) return vixaAiNudge(phone, text, vixaLeadPendingQ("vixa_ask_time", lang, ar, phone), ar, clinic);
    const when = (text || "").trim().slice(0, 80) || "—";
    const name = d.name || "—", cn3 = d.clinic || "—", finalPhone = d.finalPhone || phone;
    await db.saveSignup(capName(name), finalPhone, cn3, "", "clinic");
    await notifySales(`🏥 Lead CLINIQUE jdid: ${capName(name)} — 3iyada "${cn3}" — numero ${finalPhone} — y7eb appel: ${when}`);
    await db.saveVendorLead(phone, "vixa_done", JSON.stringify(d));
    const cnd = capName(name);
    return say(phone, lang === "fr" ? `D'accord ${cnd} ! ✅ On vous appellera ${when} pour préparer l'assistant pour la clinique "${cn3}". Merci ! 🙏`
      : ar ? `داكور ${cnd}! ✅ باش نتصلو بيك ${when} باش نحضرولك المساعد للعيادة "${cn3}". شكرا! 🙏`
      : `D'accord ${cnd}! ✅ Bech nettaslou bik ${when} bech n7adhroulek el assistant lel 3iyada "${cn3}". Merci! 🙏`, clinic);
  }

  // stage "vixa_done": handoff made, stay quiet-ish.
  return say(phone, ar
    ? "الطلب متاعك وصل — باش نتصلو بيك قريب. كان عندك سؤال آخر اكتب هوني."
    : "El demande mte3ek woslet — bech nettaslou bik 9rib. Ken 3andek sou2el e5er, ekteb houni.", clinic);
}

// ---------- VIXA qualify: "3andek 3iyada?" -> branch ----------
// "ey" (clinic owner) -> pitch (blech, no price) -> lead flow (vixa_ask_name).
// "le" (patient by mistake) -> redirect to their own clinic, nothing sold.
// Unclear -> re-ask. Refusal -> polite close.
function vixaYesNo(text) {
  const raw = (text || "").trim().toLowerCase().replace(/[.,!؟?]/g, "");
  const t = " " + raw + " ";
  // "no" first: "3andi" is a substring of "3andich", so the negative wins.
  if (/(ma 3andich|ma3andich|m3andich|ma3andish|mani tbib|mani toubib|je n.ai pas|i don.t have|dont have|ما عنديش|ماني طبيب)/.test(t)) return "no";
  if (/^(le|le2|non|no|لا)$/.test(raw)) return "no";
  if (/(3andi 3iyada|3andi cabinet|andi 3iyada|ena tbib|ana tbib|ena dentiste|ena docteur|j.ai une clinique|j ai une clinique|je suis (un |une )?(dentiste|m[eé]decin|docteur|doctor|chirurgien)|yes i have|3andi|نعم عندي|أنا طبيب|انا طبيب)/.test(t)) return "yes";
  // Standalone profession in the qualify context ("3andek 3iyada?" -> "dentiste" = "I'm a dentist" = yes).
  if (/^(dentiste|m[eé]decin|docteur|doctor|chirurgien( dentiste)?|طبيب|دكتور)$/.test(raw)) return "yes";
  if (/^(ey|eyy|oui|yes|ok|na3m|aye|نعم|اي|أي|اه)$/.test(raw)) return "yes";
  return null;
}

async function handleVixaQualifyTurn(phone, text, ar, clinic, lead) {
  // The qualify question's language rides in the lead data ("oui"/"non" alone
  // are not detectable as French by the word-list detector).
  const lang = (lead && vixaLeadData(lead).lang) || (ar ? "ar" : "latin");
  const fr = lang === "fr";
  // yes/no first: "le" here answers "3andek 3iyada?" (no), it is not a cancel.
  const yn = vixaYesNo(text);
  if (yn === "yes") {
    // Clinic owner -> pitch (blech, no price) -> straight into the lead flow.
    // If the yes came in French ("je suis un dentiste"), pitch in French too.
    const yesFr = fr || looksLikeFrenchRequest(text) || /je suis|dentiste|m[eé]decin|docteur/i.test(text);
    const lang2 = yesFr ? "fr" : lang;
    await db.saveVendorLead(phone, "vixa_ask_name", JSON.stringify({ lang: lang2 }));
    return say(phone, yesFr ? vixaOwnerPitchFr() : vixaOwnerPitch(ar), clinic);
  }
  if (yn === "no") {
    // Patient by mistake -> redirect, nothing sold.
    await db.clearVendorLead(phone).catch(() => {});
    return say(phone, fr ? VIXA_NOTOWNER_FR : ar ? VIXA_NOTOWNER_AR : VIXA_NOTOWNER_LATIN, clinic);
  }
  if (looksLikeRefusal(text) || looksLikeCancellation(text)) {
    await db.clearVendorLead(phone).catch(() => {});
    return say(phone,
      fr ? "D'accord, pas de problème." :
      ar ? "داكور، ما فما حتى مشكل." : "D'accord, ma fama 7atta mochkla.", clinic);
  }
  // Unclear -> AI nudge (acknowledge + re-ask), no per-message regex.
  const vqq = fr ? "Vous êtes médecin / vous avez une clinique ? (oui/non)"
    : ar ? "انتي طبيب ولا عندك عيادة؟ (أي / لا)" : "Enti tbib walla 3andek 3iyada? (ey / le)";
  return vixaAiNudge(phone, text, vqq, ar, clinic);
}

// VIXA router: qualify + lead capture. Returns { handled:false } when nothing
// matched — the caller then funnels into the deterministic qualify (no AI).
async function handleVixaTurn(phone, text, clinic) {
  const ar0 = await scriptAr(phone, text);
  // 1) qualify stage ("3andek 3iyada?") — branches before lead flow.
  const vqual = await db.getVendorLead(phone).catch(() => null);
  if (vqual && vqual.stage === "vixa_qualify")
    return handleVixaQualifyTurn(phone, text, ar0, clinic, vqual);
  // 2) lead flow in progress (stages "vixa_*").
  if (vqual && vqual.stage && vqual.stage.indexOf("vixa_") === 0)
    return handleVixaLeadTurn(phone, text, vqual, ar0, clinic);
  // 3) explicit lead trigger ("n7eb lel 3iyada mte3i" ...).
  if (vixaLeadTrigger(text)) {
    await db.saveVendorLead(phone, "vixa_ask_name", JSON.stringify({ lang: ar0 ? "ar" : "latin" }));
    return say(phone, ar0
      ? "ممتاز! 🎉 باش نحضرولك المساعد للعيادة متاعك. شنوة اسمك؟"
      : "Super! 🎉 Bech n7adhroulek el assistant lel 3iyada mte3ek. Chnowa esmek?", clinic);
  }
  // 4) medical question -> redirect, NEVER answered (red line).
  if (vixaFaqKind(text) === "medical") {
    const fr = looksLikeFrenchRequest(text) || looksLikeFrenchAuto(text);
    const arx = !fr && ar0;
    return say(phone, fr ? VIXA_MEDICAL_FR : arx ? VIXA_MEDICAL_AR : VIXA_MEDICAL_LATIN, clinic);
  }
  // 5) French -> short French qualify (never the dentist French prompt).
  if (looksLikeFrenchRequest(text) || looksLikeFrenchAuto(text)) {
    await db.saveVendorLead(phone, "vixa_qualify", JSON.stringify({ lang: "fr" }));
    return say(phone, vixaFrenchFallback(), clinic);
  }
  // 6) pure greeting -> the VIXA greeting (from the number's config) + qualify.
  if (looksLikePureGreeting(text)) {
    await db.saveVendorLead(phone, "vixa_qualify", JSON.stringify({ lang: ar0 ? "ar" : "latin" }));
    return say(phone, ar0
      ? (clinic.greetingAr || clinic.greeting || VIXA_GREETING_AR)
      : (clinic.greeting || VIXA_GREETING), clinic);
  }
  // 7) VIXA FAQ. "who" (info-seeking) goes to the qualify flow: short intro +
  // "3andek 3iyada?" — the pitch only comes after they say ey/oui.
  const fk = vixaFaqKind(text);
  if (fk === "who") {
    await db.saveVendorLead(phone, "vixa_qualify", JSON.stringify({ lang: ar0 ? "ar" : "latin" }));
    return say(phone, vixaFaqAnswer("who", ar0), clinic);
  }
  if (fk === "subscribe") {
    await db.saveVendorLead(phone, "vixa_ask_name", JSON.stringify({ lang: ar0 ? "ar" : "latin" }));
    return say(phone, vixaFaqAnswer("subscribe", ar0), clinic);
  }
  if (fk) return say(phone, vixaFaqAnswer(fk, ar0), clinic);
  return { handled: false };
}

// Bare greeting ("slm", "bonjour", "عسلامة") -> neutral reply only, no steering.
// The NEXT message decides: "جرّب" -> vendeur, booking talk -> réceptionniste.
// Pure greetings only — "sbe7"/"mse" stay out (ambiguous with time-of-day).
// 2026-10-01: trailing small-talk ("cv", "ça va", "labes") still counts as a
// greeting — "salut cv" must NOT fall through to the AI (it invented the
// "Nchalllah" typo there). Anything with real content (booking words etc.)
// is not a greeting.
function looksLikePureGreeting(text) {
  const t = (text || "").trim().toLowerCase().replace(/[.,!؟?]/g, "");
  if (/^(سلام|عسلامة|صباح الخير|مساء الخير|اهلا|أهلا|مرحبا)( لباس| لاباس)?$/.test(t)) return true;
  return /^(slm|slem|salem|salam|3aslema|3aslama|ahla|sahla|salut|bonjour|bjr|hello|hi|hey)( cv| ca va| ça va| cava| comment cava| comment ca va| comment ça va| labes| labas| lebes| ch3andek)?$/.test(t);
}

// A question FOR THE DOCTOR ("j'ai une question pour le docteur",
// "nheb nes2el el tbib", "عندي سؤال للطبيب") — the escalation flow's
// natural entry point. Doctor-anchored on purpose: an ordinary question
// (prices, hours) is NOT one of these.
function looksLikeDoctorQuestion(text) {
  const raw = text || "";
  const t = " " + raw.toLowerCase() + " ";
  if (/(question pour le (docteur|médecin|medecin|dentiste)|demander au (docteur|médecin|medecin|dentiste)|demande au (docteur|médecin|medecin|dentiste))/.test(t)) return true;
  if (/(nes2el|ns2el|nes2al)\s+(el\s+)?(tbib|doktor|docteur)/.test(t)) return true;
  if (/(sou2el|so2el)\s+(lel|el)\s+(tbib|doktor)/.test(t)) return true;
  // Fix U (QUE7): a callback request names the doctor + rappeler — it is
  // routed to the doctor like any doctor question.
  if (/(docteur|médecin|medecin|dentiste|tbib|doktor).{0,40}(rappel|rappeler)/.test(t)) return true;
  if (/(peut|pourra(it)?|peux-tu)\s+(me|nous)\s+rappeler/.test(t)) return true;
  // Fix V: the French analog of the Derja practice pattern below —
  // "est-ce que le docteur fait les implants ?" asks about the doctor's
  // own practice and takes the same escalation offer. Doctor noun +
  // practice verb only: availability wording ("le docteur est
  // disponible ?") names no practice verb and keeps its normal path.
  if (/(docteur|médecin|medecin|dentiste)\s+(fait|pratique|propose|offre|réalise|realise)\b/.test(t)) return true;
  // Fix U (QUE8/BIZ7): a question about the DOCTOR'S OWN practice in Derja
  // ("el tbib ye5dem bel CNAM?", "el tbib ynajem yji lel dar?") — tbib +
  // practice verb. Weekday hours questions ("ye5dem el sabt?") name no
  // doctor-verb pair and keep their FAQ path (this branch also requires
  // no resolved date at the call site).
  if (/(tbib|doktor)\s+(ynajem|ynajjem|yji|ye5dem|ya3mel)/.test(t)) return true;
  // Fix X (MD7): a French symptom / diagnosis question ("J'ai une boule
  // sur la gencive... est-ce que c'est un cancer ?") is a question FOR
  // the doctor — it takes the escalation offer, never the generic menu.
  if (/(boule|kyste|grosseur|tumeur|cancer|masse)\b/.test(t) && /(\?|est-ce|c'est grave|inqui)/.test(t)) return true;
  return /(سؤال للطبيب|سؤال للدكتور|نسأل الطبيب|نسأل الدكتور|اسأل الطبيب|أسأل الطبيب)/.test(raw);
}

// Shared by the WhatsApp webhook and the /test page.
// displayNumber: the bot number's display_phone_number from the webhook
// metadata (optional) — used to resolve the salon vertical without a
// phone_number_id.
// 2026-10-09: after an AI reply, detect the "ask the doctor?" offer so the
// patient's next "ey" can be routed to the supervisor via notif_question.
function rememberQuestionOffer(phone, reply, question, clinic) {
  if (!reply || !question) return;
  const fr = /je demande au docteur/i.test(reply);
  // Fix T (Q6): an Arabic-script offer ("تحب نسأل الطبيب؟") arms too — the
  // detector used to know only the Latin Derja and French wordings, so
  // the escalation could never trigger for Arabic-script patients. The
  // offer's own language is stored with it (Fix T, Q3b).
  const arLang = isAr(reply) && /نسأل (الطبيب|الدكتور)/.test(reply);
  if (fr || arLang || /nes2el el tbib/i.test(reply)) {
    pendingQuestion.set(phone, {
      question: String(question).slice(0, 500), clinicId: clinic && clinic.id, ts: Date.now(),
      lang: fr ? "fr" : arLang ? "ar" : "az",
    });
    console.log(`[question] offer armed for ${phone}`);
  }
}

async function processPatientText(phone, text, numberId, displayNumber) {
  const clinic = await getClinic(numberId, displayNumber);
  const vertical = (clinic && clinic.vertical) || "dentist";
  const history = await db.getHistory(phone); // last 15 messages
  await db.saveMessage(phone, "user", text, clinic && clinic.id);

  // 2026-10-09: pending hard-question escalation. The bot offered
  // "T7eb nes2el el tbib? Ekteb ey." — "ey" forwards via notif_question.
  if (vertical === "dentist" && pendingQuestion.has(phone)) {
    const pq = pendingQuestion.get(phone);
    const t = (text || "").trim();
    // Fix U (QUE10): the offer is no longer deleted up-front — only an
    // accept, a decline, an expired TTL or a non-question reply consumes
    // it. A clarifying question ("ça dépend, est-ce que c'est gratuit?")
    // leaves it armed for the real answer.
    if (Date.now() - pq.ts > QUESTION_TTL_MS) pendingQuestion.delete(phone);
    if (Date.now() - pq.ts <= QUESTION_TTL_MS) {
      // Fix S: the reply language comes from the central resolver (sticky —
      // a bare "oui" keeps the conversation's French; the Prignol incident
      // was this branch answering a French patient in Arabizi), and the
      // forward goes through the shared supervisor helper: free-form while
      // the 24h window is open, "notif_question" template otherwise (the
      // old free-form-only send failed live with Meta error 131047).
      let lang = await resolveLang(phone, text, { history });
      // Fix T (Q3b): on a COLD conversation (the offer was armed
      // programmatically — no patient message in history to stick to),
      // the reply language comes from the OFFER itself: a French offer
      // declined with "Non" is answered in French, never default Arabizi.
      if (pq.lang && !langOfText(text) && !(history || []).some((m) => m && m.role === "user" && langOfText(m.text))) {
        lang = pq.lang;
      }
      // Fix T (Q6b): Arabic-script "نعم / اي" accept and "لا / لأ" decline,
      // like their Latin forms — the offer is consumed by this reply
      // either way, so an unrecognized yes used to vanish silently.
      // Fix U (QUE6/QUE3): natural acceptances/declines count too —
      // "d'accord, vas-y", "vas-y", "ok demande", "نعم اسأل", "non merci",
      // "le choukran" — the bare-only regexes silently ate all of them.
      const isAccept = /^(ey|oui|na3m|yes|aye|نعم|اي|أي)$/i.test(t)
        || /^(ok|ey|oui|na3m|yes)\s+(demande|demandez|demander|es2el|nes2el)\b/i.test(t)
        || /^d['’]accord\b/i.test(t)
        || /^[^.!?]{0,30}\b(vas-y|allez-y)\b/i.test(t)
        || /^(نعم|اي|أي)\s+(اسأل|اسال)/.test(t);
      const isDecline = /^(le|la|non|no|لا|لأ)(\s+(merci|choukran|shukran|thanks|thank you))?$/i.test(t);
      if (isAccept) {
        pendingQuestion.delete(phone);
        const sup = supervisorNumber(clinic);
        const nm = await db.getPatientName(phone).catch(() => null);
        if (sup) {
          const qMsg = `❓ Sou2el jdid mel patient ${nm || phone}: ${String(pq.question || "").slice(0, 500)} bark. El patient yestanna el jewb mte3ek.`;
          await notifySupervisor(clinic, qMsg, "notif_question", {
            patient_name: nm || phone,
            question: String(pq.question || "").slice(0, 500),
          });
          pendingDoctorAnswer.set(clinic.id, { patientPhone: phone, question: pq.question, ts: Date.now() });
          console.log(`[question] forwarded to supervisor for ${phone}`);
        }
        return (await say(phone, msg("esc_asked_doctor", lang), clinic)).reply;
      }
      if (isDecline) {
        pendingQuestion.delete(phone);
        return (await say(phone, msg("esc_declined", lang), clinic)).reply;
      }
      // Fix U (QUE10): neither accept nor decline. A pure clarifying
      // question (no slot, no booking/cancel/reschedule intent) keeps the
      // offer armed and falls through to be answered normally; anything
      // else consumes the offer, exactly as before.
      const rsPQ = dates.resolveSlot(t);
      const keepArmed = looksLikeQuestion(t) && !(rsPQ.found && rsPQ.date)
        && !looksLikeBookingIntent(t) && !looksLikeCancellation(t) && !looksLikeReschedule(t);
      if (!keepArmed) pendingQuestion.delete(phone);
    }
    // Expired or anything else: fall through to normal handling.
  }

  // Explicit script request ("aktebli bel 3arbi" / "aktebli b 7rouf"):
  // remembered per patient, honored from this message on. An explicit
  // French request ("ektebli bel francais") is remembered the same way
  // (Fix S) — checked before the Latin branch, whose pattern also matches
  // "francais" wording.
  if (looksLikeScriptRequest(text)) await db.saveScriptPref(phone, "ar").catch(() => {});
  else if (looksLikeFrenchRequest(text)) await db.saveScriptPref(phone, "fr").catch(() => {});
  else if (looksLikeLatinRequest(text)) await db.saveScriptPref(phone, "latin").catch(() => {});

  // Vendor (sales) mode — DENTIST numbers only. Salon numbers run the salon
  // demo+lead flow instead; vixa numbers run the VIXA sales flow. Vendor lead
  // stages ("salon_*", "vixa_*") live in the same table and must never enter
  // the dentist pitch.
  const vlead = await db.getVendorLead(phone).catch(() => null);
  const vstage = (vlead && vlead.stage) || "";
  // Vendor stages belong to their vertical: vixa_* only on vixa numbers,
  // salon_* only on salon numbers. A foreign lead must never hijack the
  // dentist flow (true number isolation).
  const foreignLead = vstage.indexOf("vixa_") === 0 || vstage.indexOf("salon_") === 0;
  if (vertical === "dentist" && !foreignLead && (looksLikeVendorTrigger(text) || vlead)) {
    const v = await handleVendorTurn(phone, text, looksLikeVendorTrigger(text) ? null : vlead, clinic);
    if (v.handled) return v.reply;
  }

  // VIXA SALES vertical (+216 52 150 093): sales assistant for clinic owners.
  // Never the dentist booking flow, never the dentist vendor pitch, never
  // "Cabinet Dr Ines". Unmatched messages fall back to the deterministic
  // qualify — no AI on this number, ever (random messages cost 0 tokens).
  if (vertical === "vixa") {
    const v = await handleVixaTurn(phone, text, clinic);
    if (v.handled) return v.reply;
    const useAr = await scriptAr(phone, text);
    // Bare yes/no with no lead (e.g. "ey" answering the medical redirect's
    // invitation): treat as the doctor answering, not as "I don't understand".
    const yn0 = vixaYesNo(text);
    if (yn0 === "yes") {
      const fr0 = looksLikeFrenchAuto(text);
      await db.saveVendorLead(phone, "vixa_ask_name", JSON.stringify({ lang: fr0 ? "fr" : useAr ? "ar" : "latin" })).catch(() => {});
      return (await say(phone, fr0 ? vixaOwnerPitchFr() : vixaOwnerPitch(useAr), clinic)).reply;
    }
    if (yn0 === "no") {
      return (await say(phone, useAr ? VIXA_NOTOWNER_AR : VIXA_NOTOWNER_LATIN, clinic)).reply;
    }
    await db.saveVendorLead(phone, "vixa_qualify", JSON.stringify({ lang: useAr ? "ar" : "latin" })).catch(() => {});
    const r = await say(phone, useAr
      ? "ما فهمتكش 🙂 انتي طبيب ولا عندك عيادة؟ (أي / لا)"
      : "Ma fhemtkch 🙂 Enti tbib walla 3andek 3iyada? (ey / le)", clinic);
    return r.reply;
  }

  // Salon vertical: demo + lead capture. Never touches the dentist booking
  // flow, the dentist French prompt, or the dentist vendor pitch. Unmatched
  // messages fall back to the salon AI prompt (sysOverride), never the
  // dentist SYSTEM_PROMPT.
  if (vertical === "salon") {
    const s = await handleSalonTurn(phone, text, clinic);
    if (s.handled) return s.reply;
    // No AI on the salon number, ever: any unmatched (random) message funnels
    // back into the qualify ("3andek salon?"). Random messages cost 0 tokens.
    const useAr = await scriptAr(phone, text);
    await db.saveVendorLead(phone, "salon_qualify", JSON.stringify({ lang: useAr ? "ar" : "latin" })).catch(() => {});
    const r = await say(phone, useAr
      ? "ما فهمتكش 🙂 عندك صالون؟ (أي / لا)"
      : "Ma fhemtkch 🙂 3andek salon? (ey / le)", clinic);
    return r.reply;
  }

  // Shared clinic: the patient asks for the OTHER doctor by name -> never book
  // for them, hand to the secretary (per-number config: otherDoctor).
  if (clinic.otherDoctor && new RegExp(String(clinic.otherDoctor).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text || "")) {
    await notifySecretary(`👨‍⚕️ Patient ${phone} yes2el 3la Dr ${clinic.otherDoctor}: "${(text || "").slice(0, 120)}"`, clinic).catch(() => {});
    const lang = await resolveLang(phone, text, { history });
    const dh = await say(phone, msg("other_doctor", lang, { doctor: clinic.otherDoctor, clinicName: clinic.name }), clinic);
    return dh.reply;
  }

  // Fix U (CHA13): voice-note placeholders ("[Audio]", "[voice note]",
  // "(رسالة صوتية)") — the bot cannot hear audio; ask for text instead of
  // feeding the placeholder into the booking/AI flow.
  if (vertical === "dentist" && /^\s*[\[(]?\s*(audio|voice note|voice message|vocal|message vocal|note vocale|رسالة صوتية|مقطع صوتي)\s*[\])]?\s*$/i.test(text || "")) {
    const lang = await resolveLang(phone, text, { history });
    return (await say(phone, msg("voice_note", lang), clinic)).reply;
  }

  // Fix T (Q1a/Q2/Q4/Q5) — a question FOR THE DOCTOR in deterministic mode
  // (no AI key): the AI was the only path that could offer to forward it,
  // so without a key the offer never armed — the question vanished into a
  // generic fallback, or a pending booking swallowed the patient's "Oui".
  // Offer + arm directly, in the patient's language. A pending booking
  // proposal stays untouched in the db and resumes after the answer.
  if (!AI_API_KEY && vertical === "dentist" && looksLikeDoctorQuestion(text)
      && !looksLikeEmergency(text) && !dates.resolveSlot(text).date) {
    const lang = await resolveLang(phone, text, { history });
    pendingQuestion.set(phone, {
      question: String(text).slice(0, 500), clinicId: clinic && clinic.id, ts: Date.now(), lang,
    });
    console.log(`[question] offer armed (deterministic) for ${phone}`);
    return (await say(phone, msg("doc_q_offer", lang), clinic)).reply;
  }

  // French path (2026-09-29: text-only — the French voice note was removed;
  // 2026-10-01: auto-detect is GLOBAL — whoever writes in French gets French,
  // whoever writes Derja gets Derja, per message, no per-clinic flag).
  // The lenient detector keeps real Derja out: any Derja marker (n7eb,
  // chnowa, 9adech...) vetoes French. When the word-list is unsure,
  // aiLangIsFrench asks the AI itself — meaning, not keywords.
  // 2026-10-10 Bug 3+4: a message with a parseable date/slot ("lundi 10") is
  // booking info — never route it to the French AI. handleBookingTurn mirrors
  // the language itself and owns the whole booking flow.
  const _sp1 = dates.resolveSlot(text, false);
  const _sp2 = _sp1.found && _sp1.date ? _sp1 : dates.resolveSlot(text, true);
  const _hasSlot = _sp2.found && !!_sp2.date;
  // Deterministic intents and pending booking flows beat the French chat
  // path (2026-10-13, Fix C): a French "je veux annuler mon rendez-vous",
  // "vous fermez à quelle heure ?", "ça fait trois fois que je demande !"
  // or a bare "10h" answering a pending time question carries no date, so
  // the slot check above can't protect it — the French fallback used to
  // swallow it with a generic greeting and the intent was lost. Derja never
  // had this problem: handleBookingTurn runs BEFORE the AI there. It owns
  // these intents in French too (same detectors, French replies).
  const _prop = await db.getProposal(phone).catch(() => null);
  const _detIntent = looksLikeEmergency(text) || looksLikeFrustration(text) ||
    looksLikeCancellation(text) || looksLikeReschedule(text) ||
    looksLikeStatusQuestion(text) || looksLikeWalkin(text) ||
    looksLikeTwoAppointments(text) || !!faqKind(text) ||
    // Fix X (OT6): a beneficiary swap ("...pour ma femme X, pas pour
    // moi") acts on an existing BOOKING — with no proposal pending it
    // used to fall into the French fallback and get the greeting menu.
    !!parseBeneficiarySwap(text);
  if (!_hasSlot && !_prop && !_detIntent && (looksLikeFrenchRequest(text) || looksLikeFrenchAuto(text) || await aiLangIsFrench(text))) {
    const freply = AI_API_KEY
      ? await aiReply(text, history, await db.getPatientName(phone).catch(() => null), clinic.name, false, "", FRENCH_SYSTEM_PROMPT, clinic.address, clinic.hours)
      : frenchFallback(text, clinic.name, clinic.address); // deterministic French without AI key (local tests)
    await db.saveMessage(phone, "assistant", freply, clinic && clinic.id);
    rememberQuestionOffer(phone, freply, text, clinic);
    return freply;
  }

  // Neutral greeting: no vendeur pitch, no réceptionniste steering.
  // The next message decides the mode.
  if (looksLikePureGreeting(text)) {
    const lang = await resolveLang(phone, text, { history });
    const fallback = msg("greeting_default", lang);
    const g = await say(phone, lang === "ar"
      ? (clinic.greetingAr || clinic.greeting || fallback)
      : (clinic.greeting || fallback), clinic);
    return g.reply;
  }

  const booking = await handleBookingTurn(phone, text, history, clinic);
  if (booking.handled) return booking.reply;

  const pname = await db.getPatientName(phone).catch(() => null);
  const useAr = await scriptAr(phone, text);
  // Fix V: this generic fallthrough must mirror the conversation language.
  // It used to always hand the AI the Derja SYSTEM_PROMPT, whose canned
  // "unknown" line is Arabizi-only — a French patient whose message landed
  // here (e.g. a question at the name gate, live 2026-10-13) got that
  // Arabizi line back. A French conversation now gets the French prompt,
  // exactly like the dedicated French path above; Derja/Arabic unchanged.
  const langF = await resolveLang(phone, text, { history });
  const reply = await aiReply(text, history, pname, clinic.name, useAr, "", langF === "fr" ? FRENCH_SYSTEM_PROMPT : null, clinic.address, clinic.hours);
  await db.saveMessage(phone, "assistant", reply, clinic && clinic.id);
  rememberQuestionOffer(phone, reply, text, clinic);
  return reply;
}

// Secretary commands: "ok <id>" / "le <id>" / "list" / "rapport"
async function processSecretaryText(text, clinic, from) {
  const t = (text || "").trim();
  // Pending agenda-photo confirmation (2026-10-08): "ey" saves the batch.
  // Phone unknown from a photo -> recorded for rapport/conflicts (no reminder).
  if (pendingAgenda.has(from)) {
    const items = pendingAgenda.get(from);
    if (/^(ey|oui|na3m|ok)$/i.test(t)) {
      pendingAgenda.delete(from);
      let n = 0;
      for (const it of items) {
        const s = agendaItemSlot(it);
        await db.saveBooking("", s.display, s.iso, it.name || null, clinic && clinic.id).catch(() => {});
        n++;
      }
      console.log(`[agenda] saved ${n} bookings (from photo) for ${from}`);
      return `Tsajlou ${n} rendez-vous mel taswira. ✅\nValidihom b "ok <numero>" kima el 3ada.`;
    }
    if (/^(le|la|non)$/i.test(t)) {
      pendingAgenda.delete(from);
      return "Ok, ma sajelt chay. Ab3ath taswira o5ra walla 9olli el corrections. 👍";
    }
    // Anything else: keep the pending batch, fall through to normal commands.
  }
  // Forgiving command parsing (2026-10-08): "ok14", "le 14,13,12", "ok 5 6" all work.
  // Fix X (SP2): the doubled-k typo "okk <id>" settles too.
  let m = t.match(/^(ok|okk|okay|na3m|ey)\s*(\d[\d\s,]*)$/i);
  if (m) {
    const ids = m[2].match(/\d+/g).map(Number);
    const outs = [];
    for (const id of ids) outs.push(await settleBooking(id, true, clinic));
    return outs.join("\n");
  }
  m = t.match(/^(le|la|non|faskh|cancel)\s*(\d[\d\s,]*)$/i);
  if (m) {
    const ids = m[2].match(/\d+/g).map(Number);
    const outs = [];
    for (const id of ids) outs.push(await settleBooking(id, false, clinic));
    return outs.join("\n");
  }
  // Fix U (SEC11/SEC12): French secretary commands — "annule le <id>",
  // "validez le <id> svp" — same settle machinery, never the suggestion box.
  m = t.match(/^(annule|annulez|annuler)\s+(?:le\s+|la\s+)?(?:rendez-vous\s+|rdv\s+)?#?(\d[\d\s,]*)\s*(svp)?[.!]?$/i);
  if (m) {
    const ids = m[2].match(/\d+/g).map(Number);
    const outs = [];
    for (const id of ids) outs.push(await settleBooking(id, false, clinic));
    return outs.join("\n");
  }
  m = t.match(/^(valide|validez|valider|confirme|confirmez|confirmer)\s+(?:le\s+|la\s+)?(?:rendez-vous\s+|rdv\s+)?#?(\d[\d\s,]*)\s*(svp)?[.!]?$/i);
  if (m) {
    const ids = m[2].match(/\d+/g).map(Number);
    const outs = [];
    for (const id of ids) outs.push(await settleBooking(id, true, clinic));
    return outs.join("\n");
  }
  // Fix X (SP12): Arabic-script validation — "أكد <id>" settles like "ok <id>".
  m = t.match(/^(أكد|اكد|أكّد)\s*#?(\d[\d\s,]*)$/);
  if (m) {
    const ids = m[2].match(/\d+/g).map(Number);
    const outs = [];
    for (const id of ids) outs.push(await settleBooking(id, true, clinic));
    return outs.join("\n");
  }
  // Fix U (SEC2/SEC3): bare "ok"/"ey" — with EXACTLY ONE pending booking
  // it validates that booking (the secretary's intent is unambiguous);
  // with several, point at the numbered form; never a suggestion.
  if (/^(ok|okay|ey|na3m|oui)$/i.test(t)) {
    const pending = await db.getPendingBookings(clinic && clinic.id).catch(() => []);
    if (pending.length === 1) return settleBooking(pending[0].id, true, clinic);
    if (pending.length > 1) return `Fama ${pending.length} rendez-vous en cours — validi b 'ok <numero>' (walla 'list' bech tchoufhom).`;
    return "Ma fama 7atta rendez-vous en cours. 👍";
  }
  if (/^(list|liste|pending|chouf)/i.test(t)) {
    const pending = await db.getPendingBookings(clinic && clinic.id);
    if (!pending.length) return "Ma fama 7atta rendez-vous en cours. 👍";
    return "⏳ En cours:\n" + pending.map((b) => `#${b.id} — ${b.patient_name || b.phone || "?"} — ${b.slot}`).join("\n");
  }
  // Fix X (SP11): the kh spelling "fassakh <num>" deletes too — the
  // patient side always accepted kh spellings; the secretary side didn't.
  m = t.match(/^(fassa5|fassakh|fass5|faskh|effacer|delete)\s+(\d+)$/i);
  if (m) {
    let phone = m[2].replace(/\D/g, "");
    let n = await db.deleteConversation(phone).catch(() => 0);
    // Fix U (SEC16): secretaries dial the LOCAL 8-digit number while
    // conversations are stored in international form — retry with the
    // 216 prefix before declaring the conversation missing.
    if (!n && phone.length === 8) {
      const intl = "216" + phone;
      const n2 = await db.deleteConversation(intl).catch(() => 0);
      if (n2) { n = n2; phone = intl; }
    }
    if (!n) return `Ma l9it 7atta conversation lel numero ${phone}.`;
    console.log(`[secretary] deleted conversation ${phone} (${n} messages)`);
    return `Tfass5et el conversation mta3 ${phone} (${n} messages). El rendez-vous el ma7jouza ma tfass5etch. ✅`;
  }
  // Fix U (SEC14): polite filler must not break the command ("rapport svp").
  // Fix X (SP3): the one-p typo "raport" is the same command.
  m = t.match(/^(rapport|raport|report|تقرير)(\s+(svp|merci|el youm|lyoum|please))?[\s.!]*$/i);
  if (m) {
    const day = todayInTunis();
    const bookings = await db.getBookingsForDay(clinic && clinic.id, day).catch(() => []);
    const pdf = await buildRapportPdf({
      clinicName: (clinic && clinic.name) || "Clinique",
      dateLabel: day,
      bookings,
    }).catch(() => null);
    if (!pdf) return "Ma najjamtch ngeneri el PDF. ❌";
    // 2026-10-09: rapport as REGULAR document (not template) — the supervisor
    // just messaged, so the 24h window is open. Meta rejects B2B templates.
    const sent = await sendWhatsAppDocument(from, pdf, `rapport-${day}.pdf`,
      `Rapport du ${day} — ${bookings.length} rendez-vous.`, clinic && clinic.id).catch(() => false);
    console.log(`[rapport] ${bookings.length} bookings -> ${from} (sent=${sent})`);
    return sent
      ? `Tbe3ath el rapport mta3 el youm (${bookings.length} rendez-vous) ka PDF. ✅`
      : `El rapport tgenera ka PDF (${bookings.length} rendez-vous) ama ma tbe3athch — thabbet el configuration. ⚠️`;
  }
  // 2026-10-09: "pin 1234" — ADMIN RESET of the viewer PIN (e.g. the doctor
  // forgot his). Normally the doctor sets his own PIN on first visit to the
  // viewer link; Ahmed never needs to know it. "pin clear" removes it.
  m = t.match(/^(pin|code)\s+(\d{4,12})$/i);
  if (m) {
    const cfg = await db.getClinicConfig(clinic.id).catch(() => null) || {};
    await db.saveClinicConfig(clinic.id, {
      clinic_name: cfg.clinic_name || clinic.name || "",
      address: cfg.address || clinic.address || "",
      greeting: cfg.greeting || "",
      hours: cfg.hours || "",
      secretary_number: cfg.secretary_number || clinic.secretary || "",
      booking_hours: cfg.booking_hours || "",
      greeting_ar: cfg.greeting_ar || "",
      other_doctor: cfg.other_doctor || "",
      vertical: cfg.vertical || clinic.vertical || "",
      viewer_pin: m[2],
    }).catch(() => {});
    console.log(`[pin] admin reset for ${clinic.id}`);
    return `El PIN treset: ${m[2]} 🔒\nA3tih lel tbib.`;
  }
  m = t.match(/^(pin|code)\s+(clear|fass5|0)$/i);
  if (m) {
    const cfg = await db.getClinicConfig(clinic.id).catch(() => null) || {};
    await db.saveClinicConfig(clinic.id, {
      clinic_name: cfg.clinic_name || clinic.name || "",
      address: cfg.address || clinic.address || "",
      greeting: cfg.greeting || "",
      hours: cfg.hours || "",
      secretary_number: cfg.secretary_number || clinic.secretary || "",
      booking_hours: cfg.booking_hours || "",
      greeting_ar: cfg.greeting_ar || "",
      other_doctor: cfg.other_doctor || "",
      vertical: cfg.vertical || clinic.vertical || "",
      viewer_pin: "CLEAR",
    }).catch(() => {});
    console.log(`[pin] cleared for ${clinic.id}`);
    return "El PIN tfass5et — el viewer ma3adch yotlob PIN. 🔓";
  }
  // 2026-10-09: wasel supports scheduling: "wasel <numero> <HH:MM> <message>"
  // Time is Tunisia time. Without HH:MM, sends immediately (existing behavior).
  // Fix U (SEC5/SEC6/SEC7/SEC8): keyword-first parsing. A leading HH:MM in
  // the message is a SCHEDULE only when the rest reads as a reminder (or
  // names another time) — otherwise the time is message content and the
  // FULL text sends now ("10:00 rendez-vous confirmé ghodwa"). An invalid
  // time ("25:00") is rejected with an error — never silently eaten while
  // the message sends immediately.
  m = t.match(/^(wasel|b3ath|ib3ath)\b([\s\S]*)$/i);
  if (m) {
    const WASEL_FORMAT = "El format: wasel <numero> <el message>. Walla: wasel <numero> <HH:MM> <el message> (b wa9t tounes).";
    // Fix X (SP7): the number may be written with spaces ("+216 55 600
    // 109"). The old LAZY regex stopped at the first space after 8
    // digits, sent the template to the truncated "21655600" and glued
    // "109" onto the message — while telling the secretary "Woslet ✅".
    // Walk the leading digit TOKENS and stop at the FIRST complete
    // number (8-digit local, 216 + 8, "+" international ≥ 9 digits):
    // a following token like a "21:30" schedule time is never eaten.
    // Anything incomplete is an honest format error — nothing is ever
    // sent to a truncated number.
    const restW = (m[2] || "").trim();
    let patientPhone = "";
    let msgText = "";
    {
      const tokRe = /\S+/g;
      let tm = null, acc = "", takeEnd = -1, consumed = 0, startedPlus = false, firstTokLen = 0;
      while ((tm = tokRe.exec(restW))) {
        const tok = tm[0];
        if (!/^\+?\d+$/.test(tok)) break;
        if (consumed === 0) { startedPlus = tok.startsWith("+"); firstTokLen = tok.replace(/\D/g, "").length; }
        acc += tok.replace(/\D/g, "");
        consumed++;
        let complete = false;
        if (startedPlus) complete = acc.length >= 9;
        else if (consumed === 1 && firstTokLen === 8) complete = true;
        else if (acc.startsWith("216")) complete = acc.length >= 11;
        else complete = acc.length >= 8;
        if (complete) { takeEnd = tm.index + tok.length; break; }
        if (acc.length > 15) { takeEnd = -1; break; }
      }
      if (takeEnd > 0 && acc.length >= 8 && acc.length <= 15) {
        patientPhone = acc;
        msgText = restW.slice(takeEnd).trim();
      }
    }
    if (!patientPhone || !msgText) return WASEL_FORMAT;
    let schedHH = null;
    let schedMM = null;
    const timeM = msgText.match(/^(\d{1,2}):(\d{2})\s+([\s\S]+)$/);
    if (timeM) {
      const hh = parseInt(timeM[1], 10);
      const mm2 = parseInt(timeM[2], 10);
      const after = timeM[3].trim();
      if (hh > 23 || mm2 > 59) return "El wa9t ghalet. Mithal: wasel 216XXXXXXXX 19:00 el message.";
      const reminderish = /(tfakkir|tfakker|fakker|ntfakkrek|nfakkrek|rappel|remind)/i.test(after)
        || /\d{1,2}:\d{2}/.test(after)
        || /\d{1,2}\s*h(\d{2})?\b/.test(after)
        || /\bel\s+\d/.test(after);
      if (reminderish && after) { schedHH = hh; schedMM = mm2; msgText = after; }
      // else: the time belongs to the message — msgText stays the full text.
    }
    msgText = msgText.slice(0, 500);
    if (!patientPhone || !msgText) return WASEL_FORMAT;
    // Fix X (SP10): cross-clinic guard — settle has had one since
    // 2026-10-08, wasel didn't. When the number is KNOWN to belong to
    // another clinic (a booking or a conversation under a different
    // number_id) and has no tie to THIS clinic, refuse honestly instead
    // of messaging the other clinic's patient. Unknown numbers (a new
    // patient the secretary types by hand) stay allowed.
    if (clinic && clinic.id) {
      let knownHere = false, knownElsewhere = false;
      const bksW = await db.getBookingsByPhone(patientPhone).catch(() => []);
      for (const b of bksW || []) {
        if (!b || !b.number_id) continue;
        if (b.number_id === clinic.id) knownHere = true; else knownElsewhere = true;
      }
      if (!knownHere && !knownElsewhere) {
        const convsW = await db.getConversations().catch(() => []);
        const cvW = (convsW || []).find((c) => c && c.phone === patientPhone);
        if (cvW && cvW.number_id) {
          if (cvW.number_id === clinic.id) knownHere = true; else knownElsewhere = true;
        }
      }
      if (knownElsewhere && !knownHere) {
        return "El patient hetha teba3 3iyada o5ra — el wasel yemchi ken lel patients mta3 el 3iyada mte3ek. ❌";
      }
    }
    // Scheduled?
    if (schedHH !== null) {
      const sendAt = tunisTimeToUTC(schedHH, schedMM);
      if (!sendAt) return "El wa9t ghalet. Mithal: wasel 216XXXXXXXX 19:00 el message.";
      const sid = await db.saveScheduledMessage(clinic && clinic.id, patientPhone, msgText, sendAt).catch(() => null);
      if (!sid) return "Ma t7afdhach — thabbet el configuration. ⚠️";
      const tunisLabel = `${String(schedHH).padStart(2, "0")}:${String(schedMM).padStart(2, "0")}`;
      console.log(`[wasel:scheduled] #${sid} -> ${patientPhone} at ${tunisLabel} Tunis`);
      return `Tebrmej lel ${tunisLabel} (wa9t tounes). ✅`;
    }
    const nm = await db.getPatientName(patientPhone).catch(() => null);
    const sent = await sendTemplate(patientPhone, "message_docteur",
      [nm || "cher patient", msgText], {}, clinic && clinic.id).catch(() => false);
    console.log(`[wasel] doctor -> ${patientPhone} (sent=${sent})`);
    return sent ? "Woslet lel patient. ✅" : "Ma tbe3athch — thabbet el configuration. ⚠️";
  }
  // Fix U (SEC20): pure social filler ("merci", "👍", "choukran") is not a
  // command and not a suggestion — acknowledge politely, claim no action,
  // and never let it consume a pending doctor answer. EXACT matches only:
  // a real instruction ("badel el message…") still files as a suggestion.
  const smalltalk = t.toLowerCase().replace(/[\s.!]+$/g, "");
  if (/^(merci( beaucoup)?|choukran( barcha)?|chokran|شكرا|شكراً|thanks|thank you|bravo|parfait|super|excellent|très bien|tres bien|ya3tik el sa77a|yaatik el saha|barakallahou fik|بارك الله فيك|👍|👌|🙏|❤️|🌸)$/.test(smalltalk)) {
    return /^(👍|👌|🙏|❤️|🌸)$/.test(smalltalk) ? "👍" : "El 3afou, marhba bik fi kol wa9t. 🌸";
  }
  // GENERAL RULE (2026-10-08, live bug): a question is never a suggestion.
  // The supervisor asking "chnowa ta3mel tawa?" got "modification en cours" —
  // wrong. Answer the question (or say you can't), never file it as a suggestion.
  if (looksLikeQuestion(t)) {
    // "chnowa ta3mel tawa?" / "status?" -> live status of THIS clinic
    // Fix U (SEC22): the French form ("Combien de rendez-vous en attente ?")
    // gets the same live-status answer.
    if (/chnowa|chowa|chneya|chno\b|status|combien|en attente|attente|pending/i.test(t)) {
      const pending = await db.getPendingBookings(clinic && clinic.id).catch(() => []);
      const day = todayInTunis();
      const todays = await db.getBookingsForDay(clinic && clinic.id, day).catch(() => []);
      return `El tawa: ${pending.length} rendez-vous en cours, ${todays.length} lyoum (${day}).`;
    }
    // Fix X (SP8): a COUNT question about a specific day ("9adech men
    // rendez-vous ghodwa?") is answered from that day's bookings — it
    // used to fall into the generic refusal below.
    if (/(9adech|kadech|قداش)/i.test(t) && /(rendez|rdv|رونديفو|موعد)/i.test(t)) {
      const fmtD = (isoDay) => isoDay.split("-").reverse().join("-");
      // Day strings come from the DATES module's clock — the same frame
      // the bookings' slot_at values were resolved in.
      const todayStr = dates.tunisNow().toISOString().slice(0, 10);
      if (/(ghodwa|ghadwa|demain|غدوة|غدا)/i.test(t)) {
        const tmStr = new Date(dates.tunisNow().getTime() + 86400000).toISOString().slice(0, 10);
        const toms = await db.getBookingsForDay(clinic && clinic.id, tmStr).catch(() => []);
        return `Ghodwa (${fmtD(tmStr)}): ${toms.length} rendez-vous.`;
      }
      if (/(lyoum|elyoum|aujourd|اليوم)/i.test(t)) {
        const todays = await db.getBookingsForDay(clinic && clinic.id, todayStr).catch(() => []);
        return `Lyoum (${fmtD(todayStr)}): ${todays.length} rendez-vous.`;
      }
      const pending = await db.getPendingBookings(clinic && clinic.id).catch(() => []);
      return `Fama ${pending.length} rendez-vous en cours.`;
    }
    return "Ma najjamch njeweb 3la el sou2el hetha. El commandes: ok <numero>, le <numero>, list, rapport.";
  }
  // 2026-10-09: pending doctor answer. The supervisor's free-text reply is the
  // doctor's answer to the patient's escalated question — forward it, don't
  // file it as a suggestion. Expires after 2h.
  if (clinic && clinic.id && pendingDoctorAnswer.has(clinic.id)) {
    const pa = pendingDoctorAnswer.get(clinic.id);
    pendingDoctorAnswer.delete(clinic.id); // one shot
    if (Date.now() - pa.ts <= ANSWER_TTL_MS) {
      const sent = await sendWhatsApp(pa.patientPhone, t, clinic.id).catch(() => false);
      console.log(`[answer] doctor -> patient ${pa.patientPhone} (sent=${sent})`);
      return sent ? "Woslet lel patient. ✅" : "Ma tbe3athch lel patient — thabbet el configuration. ⚠️";
    }
    // Expired: fall through to normal handling.
  }
  // Fix X (SP4): a COMMAND-SHAPED message that failed every command
  // pattern ("ok abc", "annule xyz") is a malformed command, not a
  // suggestion — answer with an honest error instead of the fake
  // "modification en cours ✅" ack. Placed AFTER the doctor-answer
  // forwarding above, so a genuine free-text answer is never eaten.
  if (/^((ok|okk|okay)\s+\S+\s*$|(annule|annulez|annuler|valide|validez|valider|confirme|confirmez|confirmer|fassa5|fassakh|wasel|b3ath|ib3ath|أكد|اكد)\s+[\s\S]{1,60}$)/i.test(t)
      && t.split(/\s+/).length <= 5) {
    return "Ma fhemtch el commande hethi. El commandes: ok <numero>, le <numero>, list, rapport, wasel <numero> <message>.";
  }
  // Anything else from the supervisor = a suggestion ("badel hedhi / a3mel hedhi").
  // Saved for Ahmed's /suggestions page; the bot only acknowledges.
  if (clinic && clinic.id) {
    await db.saveSuggestion(clinic.id, from || null, t).catch(() => {});
    console.log(`[suggestion] saved from ${from || "?"} (${clinic.id})`);
  }
  return "Ok, modification en cours ✅\n(Ekteb: 'ok <numero>' bech tvalidi, 'le <numero>' bech tl4i, 'list' bech tchouf el pending.)";
}

async function settleBooking(id, approve, clinic) {
  const b = await db.getBooking(id).catch(() => null);
  if (!b) return `Ma l9it 7atta rendez-vous b numero ${id}.`;
  if (b.status !== "pending") return `Rendez-vous ${id} deja: ${b.status}.`;
  // Cross-clinic guard (2026-10-08): a supervisor can only settle her own
  // clinic's bookings. No clinic = Ahmed's admin page -> allowed on purpose.
  if (clinic && clinic.id && b.number_id && b.number_id !== clinic.id)
    return `Rendez-vous #${id} mech teba3 el 3iyada mte3ek. ❌`;
  await db.setBookingStatus(id, approve ? "confirmed" : "cancelled");
  // Fix S: the settle message uses the patient's conversation language —
  // saved preference, then their recent messages (sticky), Derja default;
  // an Arabic-script slot display still forces Arabic (the legacy signal).
  let lang = "az";
  const pref = await db.getScriptPref(b.phone).catch(() => null);
  if (pref === "ar" || pref === "fr") lang = pref;
  else {
    const hist = await db.getHistory(b.phone).catch(() => []);
    for (let i = hist.length - 1; i >= 0; i--) {
      if (!hist[i] || hist[i].role !== "user") continue;
      const l = langOfText(hist[i].text);
      if (l) { lang = l; break; }
    }
  }
  if (isAr(b.slot)) lang = "ar"; // the slot display carries the patient's script
  const patientMsg = msg(approve ? "settle_confirmed" : "settle_cancelled", lang, { slot: b.slot });
  await db.saveMessage(b.phone, "assistant", patientMsg, clinic && clinic.id);
  // The patient hears back from the same bot number they wrote to.
  await sendWhatsApp(b.phone, patientMsg, (b.number_id) || (clinic && clinic.id));
  console.log(`[booking] #${id} ${approve ? "CONFIRMED" : "CANCELLED"}`);
  return approve
    ? `T2akked rendez-vous #${id} (${b.slot}) w tbe3ath lel patient. ✅`
    : `Tl4a rendez-vous #${id} (${b.slot}) w tbe3ath lel patient. ❌`;
}

// Webhook signature verification (2026-10-08): Meta signs every webhook POST
// with X-Hub-Signature-256 = HMAC-SHA256 of the raw body, keyed by the App
// Secret (META_APP_SECRET env). No secret configured -> skip (local tests,
// and production until Ahmed adds the secret — zero friction rollout).
// Wrong signature -> the POST is not from Meta -> reject.
function verifyWebhookSignature(req) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return true;
  const sig = req.get("x-hub-signature-256") || "";
  if (!sig.startsWith("sha256=")) return false;
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
  if (!verifyWebhookSignature(req)) {
    console.log("[webhook] rejected: bad signature (not from Meta)");
    return res.sendStatus(403);
  }
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
    // display_phone_number feeds the vertical resolution (salon ad number)
    // so no phone_number_id lookup is ever needed for it.
    const numberId = value.metadata?.phone_number_id || DEFAULT_NUMBER_ID;
    const displayNumber = value.metadata?.display_phone_number || "";
    const clinic = await getClinic(numberId, displayNumber);
    const messages = value.messages || [];
    for (const msg of messages) {
      const from = msg.from;
      // 1b) Agenda photo from the supervisor -> read it (2026-10-08)
      if (msg.type === "image" && msg.image?.id && clinic.secretary && samePhone(from, clinic.secretary)) {
        console.log(`[agenda] photo from supervisor ${from}`);
        await db.saveMessage(from, "user", "[photo agenda]", clinic && clinic.id).catch(() => {});
        const reply = await processSupervisorImage(from, msg.image.id, clinic, numberId);
        lastWebhook = { at: new Date().toISOString(), from, text: "[photo]", reply };
        await sendWhatsApp(from, reply, numberId);
        await db.saveMessage(from, "assistant", reply, clinic && clinic.id).catch(() => {});
        continue;
      }
      if (msg.type !== "text" || !msg.text?.body) {
        console.log(`[msg] non-text from ${from} (${msg.type}) -> skipped`);
        continue;
      }
      const text = msg.text.body;

      // 2a) Secretary command (from her recognized number for this clinic)
      // samePhone: "+1717..." matches "717..." — country-code agnostic (2026-10-08).
      // 2026-10-09: the global admin (Ahmed) can also send supervisor commands
      // to any clinic — the clinic's own supervisor is NOT removed.
      const isSecretary = clinic.secretary && samePhone(from, clinic.secretary);
      const isAdmin = ADMIN_NUMBER && samePhone(from, ADMIN_NUMBER);
      if (isSecretary || isAdmin) {
        console.log(`[secretary] ${from}: ${text}${isAdmin && !isSecretary ? " (admin)" : ""}`);
        await db.saveMessage(from, "user", text, clinic && clinic.id);
        const reply = await processSecretaryText(text, clinic, from);
        lastWebhook = { at: new Date().toISOString(), from, text, reply };
        await sendWhatsApp(from, reply, numberId);
        await db.saveMessage(from, "assistant", reply, clinic && clinic.id);
        continue;
      }

      // 2b) Patient message
      const unpauseAt = pausedChats.get(from) || 0;
      if (Date.now() < unpauseAt) {
        console.log(`[msg] chat ${from} paused (staff active) -> bot stays silent`);
        continue;
      }
      console.log(`[msg] from ${from}: ${text}`);
      const reply = await processPatientText(from, text, numberId, displayNumber);
      lastWebhook = { at: new Date().toISOString(), from, text, reply };
      await sendWhatsApp(from, reply, numberId);
    }

    // 3) Status updates -> log with error details (2026-10-09: to debug "failed" deliveries)
    for (const st of value.statuses || []) {
      const errStr = st.errors ? ` errors=${JSON.stringify(st.errors)}` : "";
      console.log(`[status] ${st.id}: ${st.status}${errStr}`);
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
  // "number": simulate the message arriving on a bot number (e.g. the salon
  // ad number "21653180566") — drives the vertical resolution like the webhook.
  const dispNum = String(req.body.number || "");
  const reply = await processPatientText(ident, clean, undefined, dispNum);
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
<div id="filter" style="margin:8px 0"></div>
<div id="list"></div>
<div id="conv" style="display:none"></div>
<script>
let pw="";
function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmtTime(s){if(!s)return '';var d=new Date(s);if(isNaN(d.getTime()))return s;return d.toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true});}
let allConvs=[];
function clinicOf(c){return (c&&c.clinic)||'9dima';}
async function load(){pw=document.getElementById('pw').value;
const r=await fetch('/api/conversations?password='+encodeURIComponent(pw));const j=await r.json();
document.getElementById('conv').style.display='none';
if(!r.ok){document.getElementById('list').innerHTML='<p>⚠️ '+(j.error||'error')+'</p>';document.getElementById('filter').innerHTML='';return;}
allConvs=j.conversations||[];
if(!allConvs.length){document.getElementById('list').innerHTML='<p>Ma fama 7atta conversation. 👍</p>';document.getElementById('filter').innerHTML='';return;}
const names=[...new Set(allConvs.map(clinicOf))];
document.getElementById('filter').innerHTML='<select onchange="renderList(this.value)"><option value="">El koll ('+allConvs.length+')</option>'+names.map(n=>'<option value="'+n.split('"').join('&quot;')+'">🏥 '+esc(n)+'</option>').join('')+'</select>';
renderList('');}
function renderList(f){const rows=f?allConvs.filter(c=>clinicOf(c)===f):allConvs;
document.getElementById('list').innerHTML=rows.map(c=>'<div class="card"><b>'+esc(c.phone)+'</b> — '+c.count+' messages<br>🏥 '+esc(clinicOf(c))+'<br><small>🕐 '+esc(fmtTime(c.last_at))+'</small><div class="row"><button class="ok" onclick="viewConv(\\''+esc(c.phone)+'\\')">Chouf</button><button class="no" onclick="delConv(\\''+esc(c.phone)+'\\')">Fassa5</button></div></div>').join('')||'<p>Ma fama 7atta conversation. 👍</p>';}
async function viewConv(phone){const r=await fetch('/api/conversations/'+encodeURIComponent(phone)+'?password='+encodeURIComponent(pw));const j=await r.json();
const el=document.getElementById('conv');el.style.display='block';
if(!r.ok){el.innerHTML='<p>⚠️ '+(j.error||'error')+'</p>';return;}
const cc=allConvs.find(x=>x.phone===phone);
el.innerHTML='<div class="row"><button class="back" onclick="back()">← Erja3</button><button class="no" onclick="delConv(\\''+esc(phone)+'\\')">Fassa5 el conversation</button></div><h3>'+esc(phone)+'</h3><p>🏥 '+esc(clinicOf(cc))+'</p>'+
(j.messages.map(m=>'<div class="msg '+m.role+'"><span class="who">'+(m.role==='user'?'Patient':'Bot')+'</span> <small>🕐 '+esc(fmtTime(m.created_at))+'</small><br>'+esc(m.text)+'</div>').join('')||'<p>Faragh.</p>');}
function back(){document.getElementById('conv').style.display='none';}
async function delConv(phone){if(!confirm('Tfassa5 el conversation mta3 '+phone+'? El bot bech yenseha jemla.'))return;
const r=await fetch('/api/conversations/'+encodeURIComponent(phone)+'/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
const j=await r.json();alert(j.deleted!=null?('Tfass5et ('+j.deleted+' messages). El bot nseh jemla. 👍'):(j.error||'error'));load();}
</script></body></html>`;

app.get("/messages", (req, res) => res.send(MESSAGES_PAGE));

app.get("/api/conversations", async (req, res) => {
  if (req.query.password !== VERIFY_TOKEN) return res.status(403).json({ error: "wrong password" });
  const rows = await db.getConversations().catch(() => []);
  // one clinic name per bot number, so Ahmed can tell clinics apart
  const names = {};
  for (const r of rows) {
    const nid = r.number_id || "";
    if (!(nid in names)) {
      try {
        names[nid] = nid ? (await getClinic(nid)).name || nid : "9dima";
      } catch {
        names[nid] = nid || "9dima";
      }
    }
  }
  res.json({ conversations: rows.map((r) => ({ ...r, clinic: names[r.number_id || ""], number_id: r.number_id || null })) });
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

// ---------- Dentist viewer: private per-number link, read-only ----------
// The dentist gets a private link like /v/<phone_number_id>/<token> showing
// ONLY her own bot number's conversations — never other clinics'. The token
// is an HMAC of the number id keyed by VERIFY_TOKEN: unguessable, needs no
// database, and works for seed-only clinics too.
function viewerToken(numberId) {
  return crypto.createHmac("sha256", VERIFY_TOKEN).update("viewer:" + String(numberId)).digest("hex").slice(0, 32);
}
function viewerTokenOk(numberId, token) {
  const a = String(token || ""), b = viewerToken(numberId);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function viewerUrl(req, numberId) {
  return req.protocol + "://" + req.get("host") + "/v/" + encodeURIComponent(numberId) + "/" + viewerToken(numberId);
}

// ---------- Viewer PIN (2026-10-09) ----------
// The doctor gets a private PIN (set by Ahmed via /api/clinics). The viewer
// page asks for it before showing conversations — so the doctor feels the
// link is truly his, even though Ahmed also holds the URL.
function parseCookies(req) {
  const out = {};
  const h = req.headers && req.headers.cookie;
  if (!h) return out;
  for (const part of String(h).split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function pinCookieName(numberId) { return "vpin_" + String(numberId).replace(/\D/g, ""); }
function pinCookieValue(numberId) {
  return crypto.createHmac("sha256", VERIFY_TOKEN).update("pin-ok:" + String(numberId)).digest("hex").slice(0, 32);
}
function pinCookieOk(numberId, val) {
  const a = String(val || ""), b = pinCookieValue(numberId);
  if (a.length !== b.length || !a) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
// Returns the clinic's PIN requirement: "" = no PIN, otherwise the PIN.
// Checks the signed cookie — true means the viewer may proceed.
function viewerPinOk(req, numberId, clinic) {
  const pin = clinic && clinic.viewer_pin;
  if (!pin) return true;
  return pinCookieOk(numberId, parseCookies(req)[pinCookieName(numberId)]);
}
function pinPage(numberId, token, clinicName, mode, badPin) {
  // mode: "create" (first visit — the doctor sets his own PIN) or "enter".
  const create = mode === "create";
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PIN — ${escHtml(clinicName)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:60px auto;padding:0 20px;text-align:center}
input{font-size:24px;padding:10px;width:140px;text-align:center;letter-spacing:8px;margin:8px 0}
button{font-size:18px;padding:10px 28px;background:#25d366;color:#fff;border:0;border-radius:8px;margin-top:8px}
.err{color:#c00;margin-top:12px}.hint{color:#666;font-size:14px}</style></head><body>
<h2>🔒 ${escHtml(clinicName)}</h2>
${create
  ? `<p>Choisissez votre <b>code PIN personnel</b> (4 chiffres minimum).<br><span class="hint">Vous seul le connaîtrez.</span></p>
<form method="POST" action="/v/${encodeURIComponent(numberId)}/${encodeURIComponent(token)}/pin">
<input name="new_pin" type="password" inputmode="numeric" maxlength="12" autocomplete="off" autofocus placeholder="PIN">
<br><input name="new_pin2" type="password" inputmode="numeric" maxlength="12" autocomplete="off" placeholder="Confirmer">
<br><button type="submit">Créer mon PIN</button>
</form>`
  : `<p>Entrez votre code PIN pour voir les conversations.</p>
<form method="POST" action="/v/${encodeURIComponent(numberId)}/${encodeURIComponent(token)}/pin">
<input name="pin" type="password" inputmode="numeric" maxlength="12" autocomplete="off" autofocus>
<br><button type="submit">Ouvrir</button>
</form>`}
${badPin ? '<p class="err">PIN incorrect — réessayez.</p>' : ""}
</body></html>`;
}

// Server-side HTML escaping (the other esc() helpers live inside page
// template strings as client-side JS — not visible here).
function escHtml(s){return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}

function viewerPage(numberId, token, clinicName) {
  const api = "/api/view/" + encodeURIComponent(numberId) + "/" + encodeURIComponent(token);
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conversations — ${escHtml(clinicName)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;padding:0;background:#e5ddd5;color:#222}
header{background:#075e54;color:#fff;padding:14px 16px;position:sticky;top:0}
header h1{font-size:17px;margin:0}
#list{padding:8px}
.card{background:#fff;border-radius:8px;padding:12px;margin:8px;box-shadow:0 1px 1px rgba(0,0,0,.15);cursor:pointer}
.card small{color:#888}
#thread{display:none;padding:8px 8px 16px}
.msg{max-width:80%;padding:8px 12px;border-radius:8px;margin:6px 8px;box-shadow:0 1px 1px rgba(0,0,0,.15);font-size:15px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}
.msg.user{background:#fff;float:left;clear:both}
.msg.assistant{background:#dcf8c6;float:right;clear:both}
.who{font-size:11px;color:#888;font-weight:700}
#back{background:#075e54;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:15px;margin:8px;cursor:pointer}
.clear{clear:both}
.empty{padding:32px;text-align:center;color:#666}
</style></head><body>
<header><h1>💬 Conversations — ${escHtml(clinicName)}</h1></header>
<div id="list"></div>
<div id="thread"></div>
<script>
var API=${JSON.stringify(api)};
function esc(s){return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/'/g,"&#39;");}
function fmtDate(s){ if(!s) return ""; var d=new Date(s); return isNaN(d.getTime())? s : d.toLocaleString("fr-FR",{timeZone:"Africa/Tunis"}); }
function fmtPhone(p){ p=String(p||""); var m=p.match(/^216(\d{8})$/); return m? m[1] : p; }
async function load(){
  var r=await fetch(API+"/conversations"); var j=await r.json();
  var list=document.getElementById("list"), th=document.getElementById("thread");
  th.style.display="none"; list.style.display="block";
  if(!r.ok){ list.innerHTML="<p class=empty>⚠️ "+esc(j.error||"erreur")+"</p>"; return; }
  if(!j.conversations.length){ list.innerHTML="<p class=empty>Aucune conversation pour le moment.</p>"; return; }
  list.innerHTML=j.conversations.map(function(c){
    return '<div class=card data-phone="'+esc(c.phone)+'"><b>'+esc(fmtPhone(c.phone))+'</b> — '+c.count+' messages<br><small>'+esc(fmtDate(c.last_at))+'</small></div>';
  }).join("");
  Array.prototype.forEach.call(list.querySelectorAll(".card"), function(el){ el.onclick=function(){ viewConv(el.getAttribute("data-phone")); }; });
}
async function viewConv(phone){
  var r=await fetch(API+"/conversations/"+encodeURIComponent(phone)); var j=await r.json();
  var list=document.getElementById("list"), th=document.getElementById("thread");
  list.style.display="none"; th.style.display="block";
  if(!r.ok){ th.innerHTML="<p class=empty>⚠️ "+esc(j.error||"erreur")+"</p>"; return; }
  th.innerHTML='<button id=back>← Retour</button>'+
    (j.messages.map(function(m){
      return '<div class="msg '+m.role+'"><span class=who>'+(m.role==="user"?"Patient":"Bot")+'</span><br>'+esc(m.text)+'</div>';
    }).join("") || "<p class=empty>Vide.</p>")+"<div class=clear></div>";
  document.getElementById("back").onclick=function(){ load(); };
}
load();
</script></body></html>`;
}

app.get("/v/:numberId/:token", async (req, res) => {
  const { numberId, token } = req.params;
  if (!viewerTokenOk(numberId, token)) return res.status(403).send("<h1>🔒 Lien invalide</h1>");
  const clinic = await getClinic(numberId).catch(() => null);
  const cname = (clinic && clinic.name) || "Clinique";
  // No PIN yet: the doctor creates his own on first visit (Ahmed never knows it).
  if (!clinic || !clinic.viewer_pin) return res.send(pinPage(numberId, token, cname, "create", false));
  if (!viewerPinOk(req, numberId, clinic)) return res.send(pinPage(numberId, token, cname, "enter", false));
  res.send(viewerPage(numberId, token, cname));
});

// PIN submission: create (first visit) or enter. Correct -> signed cookie (30d).
app.post("/v/:numberId/:token/pin", express.urlencoded({ extended: false }), async (req, res) => {
  const { numberId, token } = req.params;
  if (!viewerTokenOk(numberId, token)) return res.status(403).send("<h1>🔒 Lien invalide</h1>");
  const clinic = await getClinic(numberId).catch(() => null);
  const cname = (clinic && clinic.name) || "Clinique";
  const pin = clinic && clinic.viewer_pin;
  const body = req.body || {};
  const grant = () => {
    // Session cookie only: the PIN is asked every time the browser is reopened.
    res.cookie(pinCookieName(numberId), pinCookieValue(numberId),
      { httpOnly: true, sameSite: "lax" });
    return res.redirect("/v/" + encodeURIComponent(numberId) + "/" + encodeURIComponent(token));
  };
  if (!pin) {
    // First visit: the doctor sets his own PIN (4-12 digits, confirmed twice).
    const p1 = String(body.new_pin || "").replace(/\D/g, "").slice(0, 12);
    const p2 = String(body.new_pin2 || "").replace(/\D/g, "").slice(0, 12);
    if (p1.length >= 4 && p1 === p2) {
      const cfg = await db.getClinicConfig(numberId).catch(() => null) || {};
      await db.saveClinicConfig(numberId, {
        clinic_name: cfg.clinic_name || (clinic && clinic.name) || "",
        address: cfg.address || (clinic && clinic.address) || "",
        greeting: cfg.greeting || "", hours: cfg.hours || "",
        secretary_number: cfg.secretary_number || (clinic && clinic.secretary) || "",
        booking_hours: cfg.booking_hours || "", greeting_ar: cfg.greeting_ar || "",
        other_doctor: cfg.other_doctor || "", vertical: cfg.vertical || (clinic && clinic.vertical) || "",
        viewer_pin: p1,
      }).catch(() => {});
      console.log(`[pin] doctor set own PIN for ${numberId}`);
      return grant();
    }
    return res.send(pinPage(numberId, token, cname, "create", true));
  }
  if (String(body.pin || "").trim() === String(pin)) return grant();
  res.send(pinPage(numberId, token, cname, "enter", true));
});

app.get("/api/view/:numberId/:token/conversations", async (req, res) => {
  const { numberId, token } = req.params;
  if (!viewerTokenOk(numberId, token)) return res.status(403).json({ error: "lien ghalet" });
  const clinic = await getClinic(numberId).catch(() => null);
  if (!viewerPinOk(req, numberId, clinic)) return res.status(403).json({ error: "PIN lezem" });
  const conversations = await db.getConversations(numberId).catch(() => []);
  res.json({ conversations });
});

app.get("/api/view/:numberId/:token/conversations/:phone", async (req, res) => {
  const { numberId, token } = req.params;
  if (!viewerTokenOk(numberId, token)) return res.status(403).json({ error: "lien ghalet" });
  const clinic = await getClinic(numberId).catch(() => null);
  if (!viewerPinOk(req, numberId, clinic)) return res.status(403).json({ error: "PIN lezem" });
  const phone = (req.params.phone || "").replace(/\D/g, "");
  if (!phone) return res.status(400).json({ error: "bad phone" });
  const messages = await db.getFullHistory(phone, numberId).catch(() => []);
  res.json({ messages });
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
.wa-btn{display:block;background:#25D366;color:#fff;text-decoration:none;padding:16px;border-radius:10px;font-size:19px;font-weight:700;text-align:center}
</style></head><body>
<div class="card">
<video src="/demo.mp4" controls playsinline preload="metadata"></video>
</div>
<div class="card">
<a class="wa-btn" href="https://wa.me/21653180566?text=%D8%B3%D9%84%D8%A7%D9%85">💬 جرّب البوت على واتساب</a>
<p style="font-size:14px;margin:10px 0 0;text-align:center">أو ابعث «سلام» مباشرة إلى <b dir="ltr">+216 53 180 566</b><br>رقمك يظهر عندنا — نتّصلو بيك بعد التجربة</p>
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
<p>1️⃣ تجرّب البوت على واتساب بكليكة وحدة<br>2️⃣ نتّصلو بيك ونتفاهمو<br>3️⃣ نركّبولك نومرو واتساب للحجز في 5 دقايق</p>
<p>💰 ما تخلّص <b>حتّى فرنك</b> كان المريض ما يوصلش</p>
</div>
<div class="card">
<p style="font-size:14px;margin:0 0 4px">ما تنجّمش تجرّب توّا؟ عمّر الفورمولير ونتّصلو بيك:</p>
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
  const clinics = rows.map((r) => ({ ...r, viewer_url: viewerUrl(req, r.phone_number_id) }));
  res.json({ ok: true, clinics });
});

app.options("/api/clinics", (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});
app.post("/api/clinics", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  const b = req.body || {};
  if (b.password !== VERIFY_TOKEN) return res.status(403).json({ error: "wrong password" });
  const numberId = String(b.phone_number_id || "").trim();
  if (!numberId) return res.status(400).json({ error: "phone_number_id lezem." });
  const vertical = ["salon", "dentist"].includes(String(b.vertical || "").toLowerCase())
    ? String(b.vertical).toLowerCase() : "";
  await db.saveClinicConfig(numberId, {
    clinic_name: String(b.clinic_name || "").slice(0, 150),
    address: String(b.address || "").slice(0, 300),
    greeting: String(b.greeting || "").slice(0, 500),
    hours: String(b.hours || "").slice(0, 200),
    secretary_number: String(b.secretary_number || "").replace(/\D/g, "").slice(0, 20),
    booking_hours: String(b.booking_hours || "").slice(0, 200),
    greeting_ar: String(b.greeting_ar || "").slice(0, 500),
    other_doctor: String(b.other_doctor || "").slice(0, 100),
    vertical,
    // 2026-10-09: viewer PIN — set once, kept on later updates unless replaced.
    // Empty string = don't touch the existing PIN; "CLEAR" removes it.
    viewer_pin: String(b.viewer_pin || "").replace(/\D/g, "").slice(0, 12) === "CLEAR" ? "CLEAR" : String(b.viewer_pin || "").replace(/\D/g, "").slice(0, 12),
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
el.innerHTML=j.signups.map(s=>'<div class="card"><b>'+esc(s.name)+'</b> — '+esc(s.phone)+'<br>'+(s.kind==='salon'?'🏪 ':'🏥 ')+esc(s.clinic_name)+' — '+esc(s.city)+'<br><small>'+esc(s.created_at||'')+'</small><div class="row"><button class="no" onclick="del('+s.id+')">Fassa5</button></div></div>').join('');}
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

// ---------- /feedback: public web form for doctors (problem / suggestion) ----------
// The form POSTs to /api/feedback; submissions land in the same suggestions
// inbox Ahmed already checks (/suggestions). Pure formatter, exported for tests.
function formatFeedback(name, clinic, kind, message) {
  const k = kind === "probleme" ? "mouchkla" : "i9tira7";
  const n = String(name || "").trim().slice(0, 80) || "?";
  const c = String(clinic || "").trim().slice(0, 80);
  const m = String(message || "").trim().slice(0, 1000);
  return `[${k}] ${n}${c ? " (" + c + ")" : ""}: ${m}`;
}

async function submitFeedback({ name, clinic, kind, message }) {
  const m = String(message || "").trim();
  if (!m) return { ok: false, error: "message vide" };
  if (!["probleme", "suggestion"].includes(kind)) return { ok: false, error: "kind invalide" };
  const text = formatFeedback(name, clinic, kind, m);
  const id = await db.saveSuggestion(null, "web", text).catch(() => null);
  console.log(`[feedback] web submission ${id || "FAILED"}: ${text.slice(0, 60)}`);
  return id ? { ok: true, id } : { ok: false, error: "save failed" };
}

const FEEDBACK_PAGE = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Feedback — Assistant</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:20px;background:#f6f6f6}h2{margin-top:0}.card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,.1)}label{display:block;margin:12px 0 4px;font-weight:600}input,select,textarea{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:8px;font-size:16px}textarea{min-height:120px}button{margin-top:16px;width:100%;padding:12px;background:#25D366;color:#fff;border:0;border-radius:8px;font-size:17px;font-weight:700}#ok{display:none;background:#e6f9ec;border:1px solid #25D366;border-radius:8px;padding:12px;margin-top:12px}#err{display:none;background:#fdecec;border:1px solid #e66;border-radius:8px;padding:12px;margin-top:12px}</style></head>
<body><div class="card"><h2>💬 Un problème ? Une idée ?</h2><p>Dites-le nous ici — on lit tout.</p>
<label>Votre nom</label><input id="name" placeholder="Dr ...">
<label>Clinique</label><input id="clinic" placeholder="Cabinet ...">
<label>Type</label><select id="kind"><option value="probleme">Problème technique</option><option value="suggestion">Suggestion / idée</option></select>
<label>Message</label><textarea id="msg" placeholder="Décrivez le problème ou votre idée..."></textarea>
<button onclick="send()">Envoyer</button>
<div id="ok">✅ Merci ! Votre message a bien été envoyé.</div><div id="err"></div></div>
<script>async function send(){const b={name:document.getElementById('name').value,clinic:document.getElementById('clinic').value,kind:document.getElementById('kind').value,message:document.getElementById('msg').value};
const e=document.getElementById('err');e.style.display='none';
if(!b.message.trim()){e.textContent='Écrivez votre message d\\u2019abord.';e.style.display='block';return;}
try{const r=await fetch('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const j=await r.json();
if(j.ok){document.getElementById('ok').style.display='block';document.getElementById('msg').value='';}else{e.textContent='Erreur : '+(j.error||'?');e.style.display='block';}
}catch(x){e.textContent='Erreur réseau, réessayez.';e.style.display='block';}}</script></body></html>`;

app.get("/feedback", (req, res) => res.send(FEEDBACK_PAGE));

app.post("/api/feedback", async (req, res) => {
  const r = await submitFeedback(req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});

// ---------- /suggestions: doctor suggestions inbox (Ahmed only) ----------
// The supervisor number's free-text ("badel hedhi / a3mel hedhi") lands here,
// grouped per bot number. Ahmed folds them into the prompt, then deploys.
const SUGGESTIONS_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Suggestions</title>
<style>body{font-family:sans-serif;max-width:640px;margin:0 auto;padding:12px;background:#f5f5f5}
.card{background:#fff;border:1px solid #ccc;border-radius:8px;padding:10px;margin:8px 0}
.clinic{font-size:12px;color:#666}
.txt{font-size:16px;margin:6px 0;white-space:pre-wrap}
.row{display:flex;gap:6px;margin-top:8px}
button{padding:8px 12px;border-radius:8px;border:0;font-size:14px;color:#fff;cursor:pointer}
.no{background:#c33}
#pwrow{display:flex;gap:6px;margin-bottom:8px}
input,select{padding:10px;border-radius:8px;border:1px solid #ccc;font-size:16px}
input{flex:1}
small{color:#888}</style></head><body>
<h2>💡 Suggestions</h2>
<div id="pwrow"><input id="pw" type="password" placeholder="password (verify token)"><button class="no" onclick="load()">Load</button></div>
<div id="filters" style="margin-bottom:8px"></div>
<div id="list"></div>
<script>
let pw="",all=[],clinics={};
function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
async function load(){pw=document.getElementById('pw').value;
const r=await fetch('/api/suggestions?password='+encodeURIComponent(pw));const j=await r.json();
const el=document.getElementById('list');
if(!r.ok){el.innerHTML='<p>⚠️ '+(j.error||'error')+'</p>';return;}
all=j.suggestions||[];clinics=j.clinics||{};
if(!all.length){el.innerHTML='<p>Ma fama 7atta suggestion. 👍</p>';document.getElementById('filters').innerHTML='';return;}
const ids=[...new Set(all.map(s=>s.number_id||'?'))];
document.getElementById('filters').innerHTML='<select id="f" onchange="render()"><option value="">El kol</option>'+
ids.map(id=>'<option value="'+esc(id)+'">'+esc(clinics[id]||id)+'</option>').join('')+'</select>';
render();}
function render(){const f=(document.getElementById('f')||{}).value||'';
const rows=all.filter(s=>!f||(s.number_id||'?')===f);
document.getElementById('list').innerHTML=rows.map(s=>'<div class="card"><div class="clinic">🏥 '+esc(clinics[s.number_id]||s.number_id||'?')+
' — mel: '+esc(s.from_phone||'?')+'</div><div class="txt">'+esc(s.text)+'</div><small>'+esc(s.created_at||'')+'</small>'+
'<div class="row"><button class="no" onclick="del('+s.id+')">Fassa5</button></div></div>').join('');}
async function del(id){if(!confirm('Tfassa5 el suggestion #'+id+'?'))return;
const r=await fetch('/api/suggestions/'+id+'/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
const j=await r.json();if(!r.ok)alert(j.error||'error');load();}
</script></body></html>`;

app.get("/suggestions", (req, res) => res.send(SUGGESTIONS_PAGE));

app.get("/api/suggestions", async (req, res) => {
  if (req.query.password !== VERIFY_TOKEN) return res.status(403).json({ error: "wrong password" });
  const suggestions = await db.getSuggestions().catch(() => []);
  const rows = await db.listClinicConfigs().catch(() => []);
  const clinics = {};
  for (const r of rows) clinics[r.phone_number_id] = r.clinic_name || r.phone_number_id;
  res.json({ suggestions, clinics });
});

app.post("/api/suggestions/:id/delete", async (req, res) => {
  if ((req.body || {}).password !== VERIFY_TOKEN) return res.status(403).json({ error: "wrong password" });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "bad id" });
  const deleted = await db.deleteSuggestion(id).catch(() => 0);
  res.json({ deleted });
});

// ---------- Automatic daily rapport (2026-10-08) ----------
// TEST phase: 53 only, target AUTO_RAPPORT_TIME (default 21:40 Tunis tonight).
// Production target: 08:00 Tunis. 52 (Mahjoub) is EXCLUDED until Ahmed approves.
// Pure helper (exported for tests): due once per day, within 30 min after target
// (the window lets a slow Render deploy still catch it).
function autoRapportDue(nowHM, targetHM, lastDay, todayDay) {
  if (!nowHM || !targetHM || lastDay === todayDay) return false;
  const toMin = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; };
  const diff = toMin(nowHM) - toMin(targetHM);
  return diff >= 0 && diff <= 30;
}
const AUTO_RAPPORT_TIME = process.env.AUTO_RAPPORT_TIME || "21:40";
const AUTO_RAPPORT_NUMBERS = (process.env.AUTO_RAPPORT_NUMBERS || "1322286220971446")
  .split(",").map((s) => s.trim()).filter(Boolean);
let lastAutoRapportDay = "";

function tunisHHMM(d = new Date()) {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "Africa/Tunis", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

// 2026-10-09: "wasel <numero> <HH:MM> <message>" — HH:MM is Tunisia time.
// Returns a Date (UTC) for the next occurrence of HH:MM Tunis. Tunisia is UTC+1 year-round.
function tunisTimeToUTC(hh, mm) {
  try {
    const tunisDate = todayInTunis(); // "YYYY-MM-DD" in Tunis
    const d = new Date(`${tunisDate}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+01:00`);
    if (isNaN(d.getTime())) return null;
    if (d <= new Date()) d.setDate(d.getDate() + 1); // already passed today -> tomorrow
    return d;
  } catch { return null; }
}

// 2026-10-09: sends due scheduled wasel messages via message_docteur template.
async function sendDueScheduledMessages() {
  const due = await db.getDueScheduledMessages().catch(() => []);
  for (const s of due) {
    try {
      const nm = await db.getPatientName(s.patient_phone).catch(() => null);
      const sent = await sendTemplate(s.patient_phone, "message_docteur",
        [nm || "cher patient", s.message], {}, s.number_id).catch(() => false);
      await db.markScheduledMessage(s.id, sent ? "sent" : "failed").catch(() => {});
      console.log(`[wasel:scheduled] #${s.id} -> ${s.patient_phone} (sent=${sent})`);
    } catch (e) {
      console.error(`[wasel:scheduled:ERROR] #${s.id}`, e.message);
      await db.markScheduledMessage(s.id, "failed").catch(() => {});
    }
  }
}

async function sendAutoRapports() {
  const day = todayInTunis();
  for (const numberId of AUTO_RAPPORT_NUMBERS) {
    try {
      const clinic = await getClinic(numberId, "");
      if (!clinic || !clinic.secretary) { console.log(`[auto-rapport] skip ${numberId}: no supervisor`); continue; }
      const bookings = await db.getBookingsForDay(clinic.id, day).catch(() => []);
      const pdf = await buildRapportPdf({ clinicName: clinic.name || "Clinique", dateLabel: day, bookings }).catch(() => null);
      if (!pdf) { console.log(`[auto-rapport] skip ${numberId}: pdf failed`); continue; }
      // 2026-10-09: template with document header — always delivers (no 24h limit).
      const ok = await sendTemplate(clinic.secretary, "rapport",
        { date: day, count: String(bookings.length) },
        { dateParams: ["date"], headerDocument: { buffer: pdf, filename: `rapport-${day}.pdf` } },
        numberId).catch(() => false);
      console.log(`[auto-rapport] ${numberId} -> ${clinic.secretary}: ${ok ? "sent" : "FAILED"}`);
    } catch (e) { console.error(`[auto-rapport:ERROR] ${numberId}`, e.message); }
  }
  lastAutoRapportDay = day;
}

setInterval(async () => {
  try {
    if (autoRapportDue(tunisHHMM(), AUTO_RAPPORT_TIME, lastAutoRapportDay, todayInTunis())) {
      console.log(`[auto-rapport] firing (target ${AUTO_RAPPORT_TIME} Tunis)`);
      await sendAutoRapports();
    }
    // 2026-10-09: fire due scheduled wasel messages.
    await sendDueScheduledMessages();
  } catch (e) { console.error("[auto-rapport:TICK_ERROR]", e.message); }
}, 30000);
console.log(`[auto-rapport] armed: ${AUTO_RAPPORT_TIME} Tunis -> ${AUTO_RAPPORT_NUMBERS.join(",") || "(none)"}`);

// 2026-10-09: persist seed clinic configs to DB on boot (insert-only).
// Seeds make the bot work; DB rows make /api/clinics list them with viewer URLs.
// Insert-only: never overwrites a partner-edited (or cleared) DB row.
async function syncSeedClinics() {
  for (const [numberId, seed] of Object.entries(SEED_CLINICS)) {
    try {
      const existing = await db.getClinicConfig(numberId).catch(() => null);
      if (existing) continue;
      await db.saveClinicConfig(numberId, {
        clinic_name: seed.clinic_name || "",
        address: seed.address || "",
        greeting: seed.greeting || "",
        hours: seed.hours || "",
        secretary_number: String(seed.secretary_number || "").replace(/\D/g, "").slice(0, 20),
        booking_hours: seed.booking_hours || "",
        greeting_ar: seed.greeting_ar || "",
        other_doctor: seed.other_doctor || "",
        vertical: seed.vertical || "",
      });
      console.log(`[seed-sync] saved ${numberId} (${seed.clinic_name || "?"}) to DB`);
    } catch (e) { console.error("[seed-sync:ERROR]", numberId, e.message); }
  }
}

app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  // Seed sync runs after tables exist (insert-only, never overwrites edits).
  Promise.resolve(db.initDb()).then(() => syncSeedClinics())
    .catch((e) => console.error("[seed-sync:FATAL]", e.message));
  console.log(`AI: ${AI_API_KEY ? AI_MODEL + " via " + AI_BASE_URL : "FALLBACK mode (no AI_API_KEY)"}`);
  console.log(`WhatsApp: ${WHATSAPP_TOKEN && PHONE_NUMBER_ID ? "configured" : "NOT configured (set WHATSAPP_TOKEN + PHONE_NUMBER_ID)"}`);
  console.log(`Secretary: ${SECRETARY_NUMBER ? SECRETARY_NUMBER + " recognized" : "NOT set (set SECRETARY_NUMBER)"}`);
});

// Exported for the local regression test (test-local.js). No effect on the running server.
module.exports = { processPatientText, processSecretaryText, dates, buildRapportPdf, samePhone, normPhoneForCompare, parseAgendaJson, agendaItemSlot, autoRapportDue, formatFeedback, submitFeedback, _pendingAgenda: pendingAgenda, looksLikeAcceptance, looksLikeStatusQuestion, looksLikeRefusal, SYSTEM_PROMPT, isAr, enforceScript, validateSignup,
  // templates 2026-10-09 (exported for the regression test)
  sendTemplate, supervisorNumber, rememberQuestionOffer,
  // Fix S (2026-10-13): central language resolver + MSG catalog + the ONE
  // supervisor-notification helper (exported for test-lang.js)
  MSG, msg, resolveLang, langOfText, notifySupervisor,
  _pendingQuestion: pendingQuestion, _pendingDoctorAnswer: pendingDoctorAnswer,
  // viewer PIN 2026-10-09 (exported for the regression test)
  pinCookieValue, pinCookieOk, viewerPinOk, parseCookies,
  // global admin 2026-10-09 (exported for the regression test)
  ADMIN_NUMBER,
  // batch fix 2026-09-24 detectors (exported for the regression test)
  looksLikeEmergency, looksLikeFrustration, looksLikeCancellation, faqKind, looksLikeQuestion, looksLikeWalkin,
  looksLikeTwoAppointments, looksLikeReschedule, looksLikeThirdPartyQuery, looksLikeBookingIntent,
  stripCorrectionPrefix, hasTimeSignal, stripTimeTokens, stripDateTokens, hoursCheck, CLINIC_HOURS,
  verifyWebhookSignature, // webhook signature check (2026-10-08)
  // batch fix 2026-09-25 (exported for the regression test)
  getClinic, scriptAr, looksLikeScriptRequest, looksLikeLatinRequest,
  aiClaimsBooking, guardAiOutput, fixKnownTypos, AI_SAFE_FALLBACK, detectExplicitBeneficiaries, faqAnswer,
  // French text path (exported for the regression test)
  looksLikeFrench, looksLikeFrenchRequest, looksLikeFrenchAuto, hasDerjaMarker, aiLangIsFrench, FRENCH_SYSTEM_PROMPT, frenchFallback,
  // Per-number booking hours (exported for the regression test)
  parseBookingHours, SEED_CLINICS,
  // Fix W (2026-10-13): localized rendering of the stored hours text
  parseHoursText, renderHoursText,
  // Dentist viewer token (exported for the regression test)
  viewerToken,
  // Salon vertical (exported for the regression test)
  SALON_SYSTEM_PROMPT, localNumber, isSalonDisplayNumber, SEED_SALON_BY_NUMBER,
  salonFaqKind, salonFaqAnswer, salonLeadTrigger, salonFallbackReply, salonFrenchFallback,
  parseSalonService, SALON_DEMO_PRICES, SALON_OFFER_LATIN, SALON_OFFER_AR,
  salonYesNo, salonOwnerPitch, salonOwnerPitchFr, handleSalonQualifyTurn,
  // VIXA sales vertical (exported for the regression test)
  VIXA_GREETING, VIXA_GREETING_AR, isVixaDisplayNumber, SEED_VIXA_BY_NUMBER, SEED_VIXA_BY_ID, SEED_MAHJOUB, SEED_JRAD, SEED_CLINICS,
  vixaFaqKind, vixaFaqAnswer, vixaLeadTrigger, vixaFrenchFallback,
  vixaYesNo, vixaOwnerPitch, vixaOwnerPitchFr, handleVixaQualifyTurn,
  VIXA_OFFER_LATIN, VIXA_OFFER_AR, VIXA_INTRO_LATIN, VIXA_INTRO_AR };
