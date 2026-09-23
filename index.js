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
const PORT = process.env.PORT || 3000;

const db = require("./db"); // Postgres memory + bookings
const dates = require("./dates"); // deterministic Derja date/time resolver

// Script detection: patient wrote in Arabic script -> answer in Arabic script ("kif kif").
// \u0600-\u06FF covers Arabic letters. \b doesn't work on them, so Arabic matching
// elsewhere in this file uses space-padded includes(), never \b.
const isAr = (s) => /[\u0600-\u06FF]/.test(s || "");

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
- Enti t3awen fel 7ajz, el istefsar 3al wa9t wel blasa wel aswem, w tbadel/fassa5 rendez-vous.
- El as2la el idariya (wa9t, blasa, aswem/b9adech/prix, 7ajz, tabdil, faskh): jewb 3lihom 3adi.
- MAMNOU3 bark: dwe, a3radh, tash5is, nasi7a tibbiya. Ken sou2el tibbi 9oul "el sou2elet el tibbiya lel doktor bark — t7eb n7ajzlek rendez-vous?" walla 9oul eli el secretaire bech tkalmou.
- Ken el patient ye7ki 3la wji3a wala a3radh, ibda b "nchalah labes" (empathie) 9bal ma t9oul eli el sou2elet el tibbiya lel doktor bark.
- Ken ma fhemtch el message, 9oul b wdhuh w i9tira7 chnowa tnajem t3awen fih.
- 9A3DA MO9ADDSA: 3omrek ma t2akked rendez-vous b tari9a nehe2iya wa7dek. Ken el patient ye9bel wa9t, 9oul "d'accord, merhba bik! n2akkedlek w narja3lek" bark — el t2akid el nehe2i yji mel secretaire.
- Ken el patient yotlob 7ajz w ma 9alch nhar w wa9t wad7in: is2lou "anhou nhar w anhou wa9t yse3dek?" — MA t9tar7ch wa9t mel rassek (el system yet3amel m3a el wa9t ki y9olhoulek).
- 3andek el conversation el 9dima (history) — 9bal ma tjewb chouf chnowa t9al 9balek. MAMNOU3 t3awed nafs el sou2el 7arfiyan: ken s2elt el patient 3la 7aja w ma jewbch 3liha b wdhuh, ma t3awedch nafs el sou2el — fassrou b tari9a o5ra w a3tih mthel wadh7 (kima "jem3a 10 mta3 sbe7").
- Ma t5tar3ch ma3loumet (wa9t, blasa, soum): ken ma ta3rafch, 9oul "n2akkedlek m3a el 3iyada".`;

// ---------- Meta: send a WhatsApp text message ----------
async function sendWhatsApp(to, text) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.log(`[send:SKIP] no token/phone_number_id. Would send to ${to}: ${text}`);
    return;
  }
  try {
    const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
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

async function notifySecretary(text) {
  if (!SECRETARY_NUMBER) {
    console.log("[secretary:SKIP] no SECRETARY_NUMBER set");
    return;
  }
  await sendWhatsApp(SECRETARY_NUMBER, text);
}

// ---------- AI: Derja reply (with conversation history) ----------
async function aiReply(patientText, history = []) {
  // Fallback: keyword replies so the webhook loop works even without an AI key
  if (!AI_API_KEY) return fallbackReply(patientText);

  const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...history.map((m) => ({ role: m.role, content: m.text })),
        { role: "user", content: patientText },
      ],
      max_tokens: 200,
      temperature: 0.5,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("[ai:ERROR]", JSON.stringify(data).slice(0, 300));
    return "sme7na, saret mochkla s8ira — najem n3awnek b 7aja o5ra?";
  }
  return data.choices?.[0]?.message?.content?.trim() || "ma fhemtch, tnajem t3awed b tari9a o5ra?";
}

function fallbackReply(text) {
  if (isAr(text)) {
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
// "jem3a 10" alone -> the bot asks "sbe7 walla lil?" and shows "jem3a 25 septembre".

function looksLikeAcceptance(text) {
  const raw = (text || "").trim();
  if (/^(اي|أي|نعم|موافق|احجز|احجزلي|إحجزلي)\s*[.,!؟]*$/.test(raw)) return true;
  const t = " " + raw.toLowerCase() + " ";
  if (/(^|\s)(le|mouch|man7ebch|faskh|cancel|badal|nbadal)(\s|$)/.test(t)) return false;
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

async function say(phone, reply) {
  await db.saveMessage(phone, "assistant", reply);
  return { handled: true, reply };
}

async function finishBooking(phone, p) {
  // p: { display, slot_at (ISO), slot_text }
  const dup = await db.findPendingBooking(phone, p.slot_at).catch(() => null);
  const ar = isAr(p.display); // the slot display carries the patient's script
  let reply;
  if (dup) {
    reply = ar
      ? `الرونديفو متاعك (${p.display}) مازال يستنى — نأكدلك ونرجعلك.`
      : `El rendez-vous mte3ek (${p.display}) deja pending — n2akkedlek w narja3lek.`;
  } else {
    const id = await db.saveBooking(phone, p.display, p.slot_at || null);
    console.log(`[booking] #${id} pending: ${phone} -> ${p.display}`);
    reply = ar
      ? `داكور، مرحبا بيك! نأكدلك رونديفو (${p.display}) ونرجعلك.`
      : `D'accord, merhba bik! n2akkedlek rendez-vous (${p.display}) w narja3lek.`;
    await notifySecretary(
      `⏳ Rendez-vous jdid mel bot:\nMel: ${phone}\nWa9t: ${p.display}\nBech tvalidih, ekteb: ok ${id}\nBech tl4ih, ekteb: le ${id}`
    );
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

// Deterministic booking turn. Returns { handled, reply } or { handled: false }
// to let the AI answer normally.
async function handleBookingTurn(phone, text, history) {
  // A0) Status question first — real DB status beats AI guessing.
  const st = await handleStatusQuestion(phone, text);
  if (st.handled) return st;

  const proposal = await db.getProposal(phone).catch(() => null); // null if stale/absent
  const ar = isAr(text) || isAr(proposal && proposal.slot_text); // script sticks to the patient's own words
  let r = dates.resolveSlot(text);
  let slotText = text; // the phrase the proposal remembers — grows as follow-ups merge
  if ((!r.found || !r.date) && proposal && proposal.slot_text) {
    // R) pure refusal ("le") -> drop the proposal, don't glue it to the old slot
    if (looksLikeRefusal(text)) {
      await db.clearProposal(phone).catch(() => {});
      return say(phone, ar
        ? "داكور، فسخت الاقتراح. تحب وقت آخر؟ قولي نهار ووقت يساعدك."
        : "D'accord, l4it el i9tira7. T7eb wa9t e5er? 9olli nhar w wa9t yse3dek.");
    }
    // follow-up like "sbe7" or "10" -> merge with the previous slot phrase.
    // New text first, so a changed hour wins over the old one.
    const merged = dates.resolveSlot(text + " " + proposal.slot_text);
    if (merged.found && merged.date) { r = merged; slotText = text + " " + proposal.slot_text; }
  }

  // A) The patient accepts.
  if (looksLikeAcceptance(text)) {
    if (proposal && proposal.slot_at && proposal.display && !r.date) {
      return finishBooking(phone, proposal); // pure "ey" / "ok"
    }
    if (r.found && r.date && !r.needs && !r.past) {
      return finishBooking(phone, { display: r.display, slot_at: r.iso, slot_text: text });
    }
    if (proposal && proposal.slot_at && proposal.display) {
      return finishBooking(phone, proposal);
    }
    // last resort: a concrete slot inside the bot's previous message
    const lastAsst = [...history].reverse().find((m) => m.role === "assistant");
    const r2 = lastAsst ? dates.resolveSlot(lastAsst.text) : null;
    if (r2 && r2.found && r2.date && !r2.needs && !r2.past) {
      return finishBooking(phone, { display: r2.display, slot_at: r2.iso, slot_text: lastAsst.text });
    }
    return { handled: false }; // let the AI answer
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
    return say(phone, ar
      ? "أنهو نهار بالضبط؟ (اكتب كيما: الجمعة، غدوة، 21 سبتمبر...)"
      : "Anhou nhar b dhabt? (ekteb kima: jem3a, ghodwa, 21 septembre...)");
  }
  if (r.past) {
    return say(phone, ar ? "الوقت هذا فات — أعطيني وقت آخر." : "El wa9t hedha fet — a3tini wa9t e5er.");
  }
  if (r.needs === "time") {
    await db.saveProposal(phone, slotText, null, r.dateDisplay);
    // If the patient already said sbe7/l3chiya/lil, ask for the hour only.
    const period = r.morning ? (ar ? "متاع الصباح" : "mta3 sbe7")
      : r.afternoon ? (ar ? "متاع العشية" : "mta3 l3chiya")
      : r.night ? (ar ? "متاع الليل" : "mta3 lil") : null;
    // If the patient gave a bare hour ("10") with no period, ask about THAT
    // hour specifically — never repeat the generic question verbatim.
    // (Hours >= 13 never reach this branch: the resolver treats them as PM.)
    let hourStr = null;
    const hourCands = text.match(/\b\d{1,2}(?::\d{2})?\b/g) || [];
    if (hourCands.length) {
      const last = hourCands[hourCands.length - 1];
      const h = parseInt(last.split(":")[0], 10);
      if (h >= 1 && h <= 12) hourStr = last;
    }
    const q = ar
      ? (period
        ? `${r.dateDisplay} ${period} — أنهو ساعة بالضبط؟ (اكتب كيما 10:30)`
        : hourStr
        ? `${r.dateDisplay} — الـ${hourStr} هاذي متاع الصباح ولا متاع العشية؟`
        : `${r.dateDisplay} — قولي الوقت: متاع الصباح ولا متاع العشية؟ (ولا اكتب الوقت كيما 10:30)`)
      : (period
        ? `${r.dateDisplay} ${period} — anhou se3a b dhabt? (ekteb kima 10:30)`
        : hourStr
        ? `${r.dateDisplay} — el ${hourStr} hethi mta3 sbe7 walla mta3 l3chiya?`
        : `${r.dateDisplay} — 9olli el wa9t: mta3 sbe7 walla mta3 l3chiya? (walla ekteb el wa9t kima 10:30)`);
    // Memory: never send the identical question twice in a row — if the
    // patient just repeated the hour, rephrase with concrete 24h options.
    const lastAsst = [...history].reverse().find((m) => m.role === "assistant");
    if (lastAsst && lastAsst.text === q && hourStr) {
      const parts = hourStr.split(":");
      const hh = parseInt(parts[0], 10);
      const mm = parts[1] || "00";
      const am = `${String(hh).padStart(2, "0")}:${mm}`;
      const pm = `${String(hh + 12).padStart(2, "0")}:${mm}`;
      return say(phone, ar
        ? `${r.dateDisplay} — باش نتأكد: الـ${hourStr} هاذي ${am} متاع الصباح ولا ${pm} متاع العشية؟`
        : `${r.dateDisplay} — bech net2akked: el ${hourStr} hethi ${am} mta3 sbe7 walla ${pm} mta3 l3chiya?`);
    }
    return say(phone, q);
  }
  // concrete date+time -> propose it back, wait for "ey"
  await db.saveProposal(phone, slotText, r.iso, r.display);
  return say(phone, ar
    ? `داكور — ${r.display}. تحب نحجزلك؟ اكتب "اي".`
    : `D'accord — ${r.display}. T7eb n7ajzlek? Ekteb "ey".`);
}

// Shared by the WhatsApp webhook and the /test page.
async function processPatientText(phone, text) {
  const history = await db.getHistory(phone); // last 15 messages
  await db.saveMessage(phone, "user", text);

  const booking = await handleBookingTurn(phone, text, history);
  if (booking.handled) return booking.reply;

  const reply = await aiReply(text, history);
  await db.saveMessage(phone, "assistant", reply);
  return reply;
}

// Secretary commands: "ok <id>" / "le <id>" / "list"
async function processSecretaryText(text) {
  const t = (text || "").trim();
  let m = t.match(/^(ok|okay|na3m|ey)\s+(\d+)$/i);
  if (m) return settleBooking(parseInt(m[2], 10), true);
  m = t.match(/^(le|la|non|faskh|cancel)\s+(\d+)$/i);
  if (m) return settleBooking(parseInt(m[2], 10), false);
  if (/^(list|liste|pending|chouf)/i.test(t)) {
    const pending = await db.getPendingBookings();
    if (!pending.length) return "Ma fama 7atta rendez-vous pending. 👍";
    return "⏳ Pending:\n" + pending.map((b) => `#${b.id} — ${b.phone} — ${b.slot}`).join("\n");
  }
  return "Ekteb: 'ok <numero>' bech tvalidi, 'le <numero>' bech tl4i, walla 'list' bech tchouf el pending.";
}

async function settleBooking(id, approve) {
  const b = await db.getBooking(id).catch(() => null);
  if (!b) return `Ma l9it 7atta rendez-vous b numero ${id}.`;
  if (b.status !== "pending") return `Rendez-vous ${id} deja: ${b.status}.`;
  await db.setBookingStatus(id, approve ? "confirmed" : "cancelled");
  const ar = isAr(b.slot); // the slot display carries the patient's script
  const patientMsg = approve
    ? (ar ? `تأكد الرونديفو متاعك: ${b.slot}. نستناوك! 🌸` : `T2akked rendez-vous mte3ek: ${b.slot}. Nestennewk! 🌸`)
    : (ar ? `سامحنا، الوقت ${b.slot} ما عادش متاح. تحب وقت آخر؟` : `Sme7na, el wa9t ${b.slot} ma 3adech disponible. T7eb wa9t e5er?`);
  await db.saveMessage(b.phone, "assistant", patientMsg);
  await sendWhatsApp(b.phone, patientMsg);
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
    const messages = value.messages || [];
    for (const msg of messages) {
      const from = msg.from;
      if (msg.type !== "text" || !msg.text?.body) {
        console.log(`[msg] non-text from ${from} (${msg.type}) -> skipped`);
        continue;
      }
      const text = msg.text.body;

      // 2a) Secretary command (from her recognized number)
      if (SECRETARY_NUMBER && from === SECRETARY_NUMBER) {
        console.log(`[secretary] ${from}: ${text}`);
        await db.saveMessage(from, "user", text);
        const reply = await processSecretaryText(text);
        lastWebhook = { at: new Date().toISOString(), from, text, reply };
        await sendWhatsApp(from, reply);
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
      const reply = await processPatientText(from, text);
      lastWebhook = { at: new Date().toISOString(), from, text, reply };
      await sendWhatsApp(from, reply);
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
<p class="hint">Patient: ekteb 3adi. Secretaire: ibda b <b>admin:</b> (ex: <b>admin: ok 1</b>). Bech tjareb akther men patient: badel el esm fi el 5ana el fou9aniya w kamel. El wa9t lezem date 7a9i9iya (jem3a = 25 septembre). <a href="/bookings">/bookings</a> tchouf el pending.</p>
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
el.innerHTML=j.bookings.map(b=>'<div class="card"><b>#'+b.id+'</b> — '+b.phone+'<br>📅 '+b.slot+'<br><small>'+b.created_at+'</small><div class="row"><button class="ok" onclick="settle('+b.id+',1)">Valider</button><button class="no" onclick="settle('+b.id+',0)">Refuser</button></div></div>').join('');}
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

app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  db.initDb(); // create tables if needed (memory + bookings)
  console.log(`AI: ${AI_API_KEY ? AI_MODEL + " via " + AI_BASE_URL : "FALLBACK mode (no AI_API_KEY)"}`);
  console.log(`WhatsApp: ${WHATSAPP_TOKEN && PHONE_NUMBER_ID ? "configured" : "NOT configured (set WHATSAPP_TOKEN + PHONE_NUMBER_ID)"}`);
  console.log(`Secretary: ${SECRETARY_NUMBER ? SECRETARY_NUMBER + " recognized" : "NOT set (set SECRETARY_NUMBER)"}`);
});

// Exported for the local regression test (test-local.js). No effect on the running server.
module.exports = { processPatientText, processSecretaryText, dates, looksLikeAcceptance, looksLikeStatusQuestion, looksLikeRefusal, SYSTEM_PROMPT, isAr };
