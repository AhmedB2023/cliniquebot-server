// test-local.js — full regression test for the clinic bot. No network, no Postgres.
// Drives the REAL processPatientText / processSecretaryText with an in-memory db stub,
// plus a wide matrix of Derja date/time expressions through the REAL dates.js.
// Usage: node test-local.js   (exit 0 = all green)
process.env.PORT = "43117";
// Template tests (S23, 2026-10-09): sendTemplate needs a token; fetch is mocked
// globally so no real network happens. Existing tests assert on reply text,
// not on send outcomes, so the mock is transparent to them.
process.env.WHATSAPP_TOKEN = "test-token-templates";
const fetchCalls = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  // Only Meta Graph calls are mocked; the local HTTP server tests use real fetch.
  if (!String(url).includes("graph.facebook.com")) return realFetch(url, opts);
  fetchCalls.push({ url: String(url), opts: opts || {} });
  const isMedia = String(url).includes("/media");
  return {
    ok: true,
    json: async () => (isMedia ? { id: "test-media-id" } : { messages: [{ id: "wamid.test" }] }),
  };
};
// VIXA sales test number (fake): the real 52150093 moved to the Dr Mahjoub
// dentist pilot on 2026-10-07, so S21 drives the vixa vertical via env var.
process.env.VIXA_NUMBERS = "52999999";

const path = require("path");

// ---------- in-memory db stub (same interface as db.js) ----------
function makeStubDb() {
  const messages = [];
  const bookings = [];
  const suggestions = [];
  const proposals = new Map();
  const patients = new Map();
  const vendorLeads = new Map();
  const signups = [];
  const clinicConfigs = new Map();
  const scriptPrefs = new Map();
  let seq = 1;
  return {
    initDb: async () => true,
    saveMessage: async (phone, role, text, numberId = null) => { messages.push({ phone, role, text, number_id: numberId || null }); },
    getHistory: async (phone, limit = 15) =>
      messages.filter((m) => m.phone === phone).slice(-limit).map((m) => ({ role: m.role, text: m.text })),
    getConversations: async (numberId = null) =>
      [...new Set(messages.filter((m) => !numberId || m.number_id === numberId).map((m) => m.phone))].map((phone) => {
        const ms = messages.filter((m) => m.phone === phone && (!numberId || m.number_id === numberId));
        return { phone, count: ms.length, last_at: "test", number_id: ms.length ? ms[ms.length - 1].number_id : null };
      }),
    getFullHistory: async (phone, numberId = null) =>
      messages.filter((m) => m.phone === phone && (!numberId || m.number_id === numberId)).map((m) => ({ role: m.role, text: m.text })),
    deleteConversation: async (phone) => {
      let n = 0;
      for (let i = messages.length - 1; i >= 0; i--)
        if (messages[i].phone === phone) { messages.splice(i, 1); n++; }
      proposals.delete(phone);
      patients.delete(phone);
      vendorLeads.delete(phone);
      return n;
    },
    saveBooking: async (phone, slot, slot_at = null, patient_name = null, number_id = null) => {
      const b = { id: seq++, phone, slot, slot_at, patient_name, number_id, status: "pending" };
      bookings.push(b);
      return b.id;
    },
    findPendingBooking: async (phone, slot_at) =>
      bookings.find((b) => b.phone === phone && b.slot_at === slot_at && b.status === "pending") || null,
    getBooking: async (id) => bookings.find((b) => b.id === id) || null,
    getLatestBooking: async (phone) => {
      const l = bookings.filter((b) => b.phone === phone);
      return l[l.length - 1] || null;
    },
    getPendingBookings: async (numberId) => bookings.filter((b) => b.status === "pending" && (!numberId || b.number_id === numberId)),
    getBookingsForDay: async (numberId, dateStr) =>
      bookings.filter((b) => (!numberId || b.number_id === numberId) &&
        b.slot_at && String(b.slot_at).slice(0, 10) === dateStr),
    setBookingStatus: async (id, status) => {
      const b = bookings.find((b) => b.id === id);
      if (b) b.status = status;
    },
    updateBookingSlot: async (id, slot, slot_at) => {
      const b = bookings.find((b) => b.id === id);
      if (b) { b.slot = slot; b.slot_at = slot_at; }
    },
    saveProposal: async (phone, slot_text, slot_at, display, awaiting_name = false, partial_name = null) => {
      proposals.set(phone, { slot_text, slot_at, display, awaiting_name, partial_name });
    },
    getProposal: async (phone) => proposals.get(phone) || null,
    clearProposal: async (phone) => { proposals.delete(phone); },
    getPatientName: async (phone) => patients.get(phone) || null,
    savePatientName: async (phone, name) => { patients.set(phone, name); },
    getVendorLead: async (phone) => vendorLeads.get(phone) || null,
    saveVendorLead: async (phone, stage, clinic_name = null) => { vendorLeads.set(phone, { phone, stage, clinic_name }); },
    clearVendorLead: async (phone) => { vendorLeads.delete(phone); },
    saveSignup: async (name, phone, clinic_name, city, kind = "clinic") => {
      const s = { id: seq++, name, phone, clinic_name, city, kind, created_at: "test" };
      signups.push(s);
      return s.id;
    },
    getSignups: async () => [...signups].reverse(),
    deleteSignup: async (id) => {
      const i = signups.findIndex((s) => s.id === id);
      if (i >= 0) { signups.splice(i, 1); return 1; }
      return 0;
    },
    hasDb: () => true,
    // Stub: return null (unknown) → production code falls back to template.
    getLastSupervisorMessageTime: async () => new Date(Date.now() - 60 * 60 * 1000),
    saveSuggestion: async (numberId, fromPhone, text) => {
      const s = { id: seq++, number_id: numberId || null, from_phone: fromPhone || null, text, status: "new", created_at: "test" };
      suggestions.push(s);
      return s.id;
    },
    getSuggestions: async (numberId = null) =>
      suggestions.filter((s) => !numberId || s.number_id === numberId).slice().reverse(),
    deleteSuggestion: async (id) => {
      const i = suggestions.findIndex((s) => s.id === id);
      if (i >= 0) { suggestions.splice(i, 1); return 1; }
      return 0;
    },
    getClinicConfig: async (numberId) => clinicConfigs.get(numberId) || null,
    // Mirrors db.js: viewer_pin is sticky ("" keeps), "CLEAR" removes; other
    // fields merge (UPSERT updates only supplied columns in practice).
    saveClinicConfig: async (numberId, cfg) => {
      const prev = clinicConfigs.get(numberId) || {};
      const pin = cfg.viewer_pin === "" ? (prev.viewer_pin || "") : cfg.viewer_pin === "CLEAR" ? "" : (cfg.viewer_pin !== undefined ? cfg.viewer_pin : (prev.viewer_pin || ""));
      clinicConfigs.set(numberId, { ...prev, phone_number_id: numberId, ...cfg, viewer_pin: pin });
    },
    listClinicConfigs: async () => [...clinicConfigs.values()],
    getScriptPref: async (phone) => scriptPrefs.get(phone) || null,
    saveScriptPref: async (phone, script) => { scriptPrefs.set(phone, script); },
    _inspect: () => ({ messages, bookings, proposals, signups }),
    clearClinicConfig: async (numberId) => { clinicConfigs.delete(numberId); },
  };
}
const stubDb = makeStubDb();
const dbPath = require.resolve(path.join(__dirname, "db.js"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: stubDb };

const bot = require("./index.js");
const dates = bot.dates;
// Freeze time: Tue 2026-09-22 18:30 UTC = 19:30 Tunis. Deterministic tests.
dates.setNow(new Date("2026-09-22T18:30:00Z").getTime());

// ---------- tiny assert framework ----------
let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; }
  else { fail++; console.log(`FAIL: ${name}${extra ? "\n  " + extra : ""}`); }
}
function has(name, actual, substr) {
  ok(name, typeof actual === "string" && actual.includes(substr), `reply was: ${JSON.stringify(actual)}`);
}


// =====================================================================
// test-french.js — FRENCH PATIENT BATTERY (2026-10-13, exploratory).
// Same harness as test-local.js (stub db, frozen now = Tue 2026-09-22
// 19:30 Tunis, NO AI key -> deterministic layer only, like production
// fallback). Drives BOTH real clinic seeds via numberId:
//   MAH = Dr Mahjoub (Sousse): booking Lun-Ven 08-17, Sam 08-13, Dim fermé
//        (displayed hours 08:30-17:30 / Sam 08:30-13:00)
//   JRA = Dr Jrad (Djerba):    booking Lun-Jeu 09-16, Ven-Sam 09-14, Dim fermé
// Verdicts: PASS / GAP (works but degraded: hour not understood, question
// not really answered, second RDV ignored...) / FAIL (wrong language,
// wrong slot, derailed flow). Nothing here edits production behavior.
// Usage: node test-french.js
// =====================================================================
const MAH = "1364750653386950";
const JRA = "1445223932002571";
const HOURS_MAH = "Thenin lel Jom3a: 08:30 - 17:30, Sebt: 08:30 - 13:00, Ahad: msakker";
const HOURS_JRA = "Thenin lel 5mis: 09:00 - 16:00, Jom3a w Sebt: 09:00 - 14:00, Ahad: msakker";

const ARABIC_RE = /[\u0600-\u06FF]/;
const ARABIZI_RE = /(mta3|n7eb|na7jez|n7ajzlek|9olli|anhou|el wa9t|t7eb n|ne5dem|3iyada|anhou nhar|se3a b|mta3 sbe7|mta3 l3chiya|fhemtek|sama7ni|tfadhel|mriguel|ghodwa|lyoum|n7ajzou|bech n|ken t7eb)/i;
// French check: strip the clinics' own (Derja) hours config strings first —
// they are config data embedded inside French sentences, not bot language.
function cleanCfg(r) {
  return String(r || "").split(HOURS_MAH).join(" ").split(HOURS_JRA).join(" ");
}
function isFR(r) {
  const c = cleanCfg(r);
  return typeof r === "string" && r.length > 0 && !ARABIC_RE.test(c) && !ARABIZI_RE.test(c);
}
function isArabizi(r) {
  const c = cleanCfg(r);
  return typeof r === "string" && (ARABIC_RE.test(c) || ARABIZI_RE.test(c));
}

const results = [];
let phoneSeq = 0;
function newPhone() { return "3361000" + String(++phoneSeq).padStart(4, "0"); }
function bookingsOf(phone) { return stubDb._inspect().bookings.filter((b) => b.phone === phone); }

async function scenario(id, title, fn) {
  const phone = newPhone();
  const log = [];
  const say = async (text, clinicId) => {
    const r = await bot.processPatientText(phone, text, clinicId);
    log.push({ inn: text, out: r });
    return r;
  };
  let verdict = "PASS";
  const problems = [];
  const chk = {
    hard(cond, msg) { if (!cond) { problems.push(msg); verdict = "FAIL"; } },
    soft(cond, msg) { if (!cond) { problems.push(msg); if (verdict === "PASS") verdict = "GAP"; } },
  };
  try { await fn({ phone, say, chk }); }
  catch (e) { verdict = "FAIL"; problems.push("EXCEPTION: " + (e && e.message)); }
  results.push({ id, title, verdict, problems, log });
  console.log(`${id} [${verdict}] ${title}`);
  if (verdict !== "PASS") {
    for (const p of problems) console.log(`    - ${p}`);
    for (const t of log) {
      console.log(`    IN : ${JSON.stringify(t.inn)}`);
      console.log(`    OUT: ${JSON.stringify(t.out)}`);
    }
  }
}

async function runFrench() {
  // ---- F01 — full date+time in ONE French message, whole flow (Jrad) ----
  await scenario("F01", "RDV date+heure en un message, flux complet (Jrad)", async ({ phone, say, chk }) => {
    const r1 = await say("Je voudrais un rendez-vous le 5 novembre à 10h30", JRA);
    chk.hard(isFR(r1), "proposal not in French");
    chk.hard(r1.includes("05-11-2026") && r1.includes("10:30"), "proposal slot wrong (want 05-11-2026, 10:30)");
    const r2 = await say("oui", JRA);
    chk.hard(isFR(r2), "name ask not in French");
    const r3 = await say("karim ben ali", JRA);
    chk.hard(isFR(r3), "confirmation-pending not in French");
    chk.soft(/confirme/i.test(r3), "confirmation-pending wording missing");
    const b = bookingsOf(phone);
    chk.hard(b.length === 1 && b[0].status === "pending" && b[0].slot === "05-11-2026, 10:30", "booking wrong: " + JSON.stringify(b));
    chk.soft(b.length === 1 && b[0].patient_name === "karim ben ali", "name on booking: " + JSON.stringify(b[0] && b[0].patient_name));
  });

  // ---- F02 — date only -> "le matin" -> "plutôt vers 11h" (Jrad) ----
  await scenario("F02", "Date seule -> le matin -> plutôt vers 11h (Jrad)", async ({ phone, say, chk }) => {
    const r1 = await say("Je voudrais un rendez-vous le 5 novembre", JRA);
    chk.hard(isFR(r1), "time question not in French");
    chk.hard(r1.includes("05-11-2026"), "date lost in time question");
    const r2 = await say("le matin", JRA);
    chk.hard(isFR(r2), "exact-hour ask not in French");
    const r3 = await say("plutôt vers 11h", JRA);
    chk.hard(isFR(r3), "proposal not in French");
    chk.hard(r3.includes("05-11-2026") && r3.includes("11:00"), "proposal slot wrong (want 05-11-2026, 11:00)");
  });

  // ---- F03 — date only -> "l'après-midi" -> "15h" (Jrad, jeudi 5 nov) ----
  await scenario("F03", "Date seule -> l'après-midi -> 15h (Jrad)", async ({ phone, say, chk }) => {
    const r1 = await say("Je voudrais un rendez-vous le 5 novembre", JRA);
    chk.hard(isFR(r1), "time question not in French");
    const r2 = await say("l'après-midi", JRA);
    chk.hard(isFR(r2), "exact-hour ask not in French");
    const r3 = await say("15h", JRA);
    chk.hard(isFR(r3), "proposal not in French");
    chk.hard(r3.includes("05-11-2026") && r3.includes("15:00"), "proposal slot wrong (want 05-11-2026, 15:00)");
  });

  // ---- F04 — "demain" (Mahjoub) ----
  await scenario("F04", "demain à 9h (Mahjoub)", async ({ phone, say, chk }) => {
    const r1 = await say("Je voudrais un rendez-vous demain à 9h", MAH);
    chk.hard(isFR(r1), "proposal not in French");
    chk.hard(r1.includes("23-09-2026") && r1.includes("09:00"), "slot wrong (want 23-09-2026, 09:00)");
  });

  // ---- F05 — "après-demain" (Jrad) ----
  await scenario("F05", "après-demain à 10h (Jrad)", async ({ phone, say, chk }) => {
    const r1 = await say("Je voudrais un rendez-vous après-demain à 10h", JRA);
    chk.hard(isFR(r1), "proposal not in French");
    chk.hard(r1.includes("24-09-2026") && r1.includes("10:00"), "slot wrong (want 24-09-2026, 10:00)");
  });

  // ---- F06 — "lundi prochain" (Jrad) ----
  await scenario("F06", "lundi prochain à 10h (Jrad)", async ({ phone, say, chk }) => {
    const r1 = await say("Je voudrais un rendez-vous lundi prochain à 10h", JRA);
    chk.hard(isFR(r1), "proposal not in French");
    chk.hard(r1.includes("28-09-2026") && r1.includes("10:00"), "slot wrong (want 28-09-2026, 10:00)");
  });

  // ---- F07 — spelled-out hour "à dix heures" — suspected GAP (Jrad) ----
  await scenario("F07", "Heure en lettres « à dix heures » (Jrad)", async ({ phone, say, chk }) => {
    const r1 = await say("Je voudrais un rendez-vous le 5 novembre à dix heures", JRA);
    chk.hard(isFR(r1), "reply not in French");
    // Full pass = hour understood (proposal 10:00). Graceful degradation =
    // French time question that keeps the date (hour NOT understood -> GAP).
    if (r1.includes("10:00") && r1.includes("05-11-2026")) { /* understood */ }
    else if (r1.includes("05-11-2026")) chk.soft(false, "spelled-out hour NOT understood (fell back to time question)");
    else chk.hard(false, "date lost / no proposal and no dated time question");
    chk.hard(bookingsOf(phone).every((b) => b.slot.includes("10:00")), "a booking with a wrong/invented time was created");
  });

  // ---- F08 — annulation en français (Jrad) ----
  await scenario("F08", "Annulation en français (Jrad)", async ({ phone, say, chk }) => {
    await say("Je voudrais un rendez-vous le 5 novembre à 10h30", JRA);
    await say("oui", JRA);
    await say("karim ben ali", JRA);
    chk.hard(bookingsOf(phone).length === 1, "setup booking missing");
    const r = await say("je veux annuler mon rendez-vous", JRA);
    chk.hard(isFR(r), "cancellation reply not in French");
    let b = bookingsOf(phone)[0];
    if (b && b.status === "pending") { // bot may ask for confirmation first
      const r2 = await say("oui", JRA);
      chk.soft(isFR(r2), "cancel-confirm reply not in French");
      b = bookingsOf(phone)[0];
    }
    chk.hard(b && b.status === "cancelled", "booking not cancelled, status=" + (b && b.status));
  });

  // ---- F09 — déplacer/report en français — suspected GAP (Jrad) ----
  await scenario("F09", "Déplacer mon rendez-vous (Jrad)", async ({ phone, say, chk }) => {
    await say("Je voudrais un rendez-vous le 5 novembre à 10h30", JRA);
    await say("oui", JRA);
    await say("karim ben ali", JRA);
    const r = await say("je veux déplacer mon rendez-vous", JRA);
    chk.soft(isFR(r), "reschedule reply not in French");
    chk.soft(/déplac|report|autre jour|nouvelle date|quel jour/i.test(r), "reschedule intent not acknowledged");
    const r2 = await say("au 6 novembre à 10h", JRA);
    // Canonical confirm step — identical to the Derja flow (test-local fR:
    // new slot is PROPOSED, then "ey" moves the booking). French: "oui".
    const r3 = await say("oui", JRA);
    chk.soft(isFR(r3) && /déplac/i.test(r3), "reschedule confirmation not in French / move not confirmed");
    const bs = bookingsOf(phone);
    chk.soft(bs.length === 1, "duplicate booking created instead of moving (count=" + bs.length + ")");
    chk.soft(bs.length >= 1 && bs[bs.length - 1].slot.includes("06-11-2026"), "booking not moved to 06-11-2026: " + JSON.stringify(bs.map((b) => b.slot)));
  });

  // ---- F10 — deux rendez-vous / famille — known V2 gap (Jrad) ----
  await scenario("F10", "Deux RDV : moi + ma fille (Jrad)", async ({ phone, say, chk }) => {
    const r1 = await say("Je voudrais deux rendez-vous, un pour moi et un pour ma fille, le 5 novembre à 10h", JRA);
    chk.hard(isFR(r1), "reply not in French");
    chk.soft(/deux|fille|un par un|premier/i.test(r1), "the TWO-appointment request was not acknowledged (second RDV silently dropped)");
    chk.soft(bookingsOf(phone).length !== 1 || /deux|fille/i.test(r1), "exactly one booking flow with no mention of the second person");
  });

  // ---- F11 — FAQ prix (Jrad) ----
  await scenario("F11", "FAQ prix : combien coûte une consultation ? (Jrad)", async ({ phone, say, chk }) => {
    const r = await say("Bonjour, combien coûte une consultation ?", JRA);
    chk.soft(isFR(r), "price reply not in French");
    chk.soft(/prix|dépend|consultation.*dira|docteur vous dira/i.test(r) && !/comment puis-je vous aider/i.test(r),
      "price question not actually answered (generic fallback)");
  });

  // ---- F12 — FAQ horaires (Jrad) ----
  await scenario("F12", "FAQ horaires : vous fermez à quelle heure ? (Jrad)", async ({ phone, say, chk }) => {
    const r = await say("Vous fermez à quelle heure ?", JRA);
    chk.soft(isFR(r), "hours reply not in French");
    chk.soft(/16:00|14:00|09:00|Horaires/i.test(r) && !/comment puis-je vous aider/i.test(r),
      "hours question not actually answered (generic fallback)");
  });

  // ---- F13 — FAQ adresse (Jrad) ----
  await scenario("F13", "FAQ adresse : où se trouve le cabinet ? (Jrad)", async ({ phone, say, chk }) => {
    const r = await say("Où se trouve le cabinet ?", JRA);
    chk.soft(isFR(r), "address reply not in French");
    chk.soft(/Bourguiba/i.test(r), "address (Av. Habib Bourguiba, Djerba) not given");
  });

  // ---- F14 — FAQ nom du cabinet (Mahjoub) ----
  await scenario("F14", "FAQ nom : comment s'appelle le cabinet ? (Mahjoub)", async ({ phone, say, chk }) => {
    const r = await say("Comment s'appelle le cabinet ?", MAH);
    chk.soft(isFR(r), "clinic-name reply not in French");
    chk.soft(/Mahjoub/i.test(r), "clinic name (Cabinet Dr Issam Mahjoub) not given");
  });

  // ---- F15 — urgence dentaire, adjectif « c'est urgent » (Jrad) ----
  await scenario("F15", "Urgence : j'ai très mal aux dents, c'est urgent (Jrad)", async ({ phone, say, chk }) => {
    const r = await say("J'ai très mal aux dents, c'est urgent, je souffre beaucoup", JRA);
    chk.hard(isFR(r), "urgency reply not in French");
    chk.soft(/urgences|190|médecin rapidement/i.test(r), "no emergency redirection (urgences / 190)");
    chk.hard(bookingsOf(phone).length === 0, "a booking was created from an emergency message");
  });

  // ---- F16 — walk-in en français — suspected GAP (Jrad) ----
  await scenario("F16", "Walk-in : je peux venir sans rendez-vous ? (Jrad)", async ({ phone, say, chk }) => {
    const r = await say("Bonjour, je peux venir sans rendez-vous ?", JRA);
    chk.soft(isFR(r), "walk-in reply not in French");
    chk.soft(/attente|réserve|créneau|venir maintenant/i.test(r) && !/comment puis-je vous aider/i.test(r),
      "walk-in question not actually answered (generic fallback)");
  });

  // ---- F18 — refus d'un créneau proposé, puis nouvelle date (Jrad) ----
  await scenario("F18", "Refus du créneau proposé puis nouvelle date (Jrad)", async ({ phone, say, chk }) => {
    const r1 = await say("Je voudrais un rendez-vous le 5 novembre à 10h30", JRA);
    chk.hard(isFR(r1) && r1.includes("05-11-2026"), "initial proposal wrong/not French");
    const r2 = await say("Non, pas ce jour-là", JRA);
    chk.hard(isFR(r2), "refusal reply not in French");
    const r3 = await say("Le 6 novembre à 10h plutôt", JRA);
    chk.hard(isFR(r3), "new proposal not in French");
    chk.hard(r3.includes("06-11-2026") && r3.includes("10:00"), "new slot wrong (want 06-11-2026, 10:00)");
  });

  // ---- F19 — statut : mon rendez-vous est confirmé ? (Jrad) ----
  await scenario("F19", "Statut : mon rendez-vous est confirmé ? (Jrad)", async ({ phone, say, chk }) => {
    await say("Je voudrais un rendez-vous le 5 novembre à 10h30", JRA);
    await say("oui", JRA);
    await say("karim ben ali", JRA);
    const r = await say("Mon rendez-vous est confirmé ?", JRA);
    chk.hard(isFR(r), "status reply not in French");
    chk.soft(/attente|secrétaire|confirme|en cours/i.test(r), "status answer does not state the pending/confirmation state");
  });

  // ---- F20 — mélange FR/Derja dans un message : la derja gagne (design) ----
  await scenario("F20", "Mélange FR/Derja : « Bonjour, n7eb na7jez rendez-vous ghodwa » (Jrad)", async ({ phone, say, chk }) => {
    const r = await say("Bonjour, n7eb na7jez rendez-vous ghodwa", JRA);
    // By the owner's rule a Derja marker means Derja: expect the Arabizi
    // time question for tomorrow (23-09-2026), NOT a French reply.
    chk.hard(isArabizi(r), "expected Derja/Arabizi handling (Derja marker wins by design)");
    chk.hard(r.includes("23-09-2026"), "ghodwa not resolved to 23-09-2026");
  });

  // ---- F21 — commence en français, bascule en arabizi pour l'heure (Jrad) ----
  await scenario("F21", "Bascule FR -> arabizi en cours de flux (Jrad)", async ({ phone, say, chk }) => {
    const r1 = await say("Je voudrais un rendez-vous le 5 novembre", JRA);
    chk.hard(isFR(r1), "time question not in French");
    const r2 = await say("10 mta3 sbe7", JRA);
    chk.soft(isFR(r2), "proposal after arabizi answer not in French (sticky French lost)");
    chk.hard(r2.includes("05-11-2026") && r2.includes("10:00"), "merged slot wrong (want 05-11-2026, 10:00)");
    const r3 = await say("oui", JRA);
    chk.soft(isFR(r3), "name ask not in French after switch");
  });

  // ---- F22 — frustration en français en plein flux (Jrad) ----
  await scenario("F22", "Frustration FR : « ça fait trois fois que je demande » (Jrad)", async ({ phone, say, chk }) => {
    const r1 = await say("Je voudrais un rendez-vous le 5 novembre", JRA);
    chk.hard(isFR(r1), "time question not in French");
    const r2 = await say("ça fait trois fois que je demande !", JRA);
    chk.soft(/pardon|désolé|sama7|excuse/i.test(r2), "frustration not acknowledged (no apology)");
    chk.soft(!/comment puis-je vous aider/i.test(r2), "flow derailed: generic greeting reset mid-booking");
    const r3 = await say("le 5 novembre à 10h30", JRA);
    chk.soft(isFR(r3) && r3.includes("10:30"), "could not recover the booking after frustration");
  });

  // ---- F23 — nom composé français (Mahjoub) ----
  await scenario("F23", "Nom composé : Jean-Pierre Dubois (Mahjoub)", async ({ phone, say, chk }) => {
    const r1 = await say("Je voudrais un rendez-vous le 5 novembre à 10h30", MAH);
    chk.hard(isFR(r1) && r1.includes("05-11-2026"), "proposal wrong/not French");
    await say("oui", MAH);
    const r3 = await say("Jean-Pierre Dubois", MAH);
    chk.hard(isFR(r3), "confirmation-pending not in French");
    const b = bookingsOf(phone);
    chk.hard(b.length === 1 && b[0].status === "pending", "booking wrong: " + JSON.stringify(b));
    chk.soft(b.length === 1 && /Dubois/i.test(b[0].patient_name || ""), "family name lost, stored: " + JSON.stringify(b[0] && b[0].patient_name));
    chk.soft(b.length === 1 && /Jean-Pierre/i.test(b[0].patient_name || ""), "hyphenated first name lost, stored: " + JSON.stringify(b[0] && b[0].patient_name));
  });

  // ---- F24 — format 5/11/2026 + heure à un chiffre « 9h » (Jrad) ----
  await scenario("F24", "Date 5/11/2026 + « 9h » (Jrad)", async ({ phone, say, chk }) => {
    const r1 = await say("Je voudrais un rendez-vous le 5/11/2026 à 9h", JRA);
    chk.hard(isFR(r1), "proposal not in French");
    chk.hard(r1.includes("05-11-2026") && r1.includes("09:00"), "slot wrong (want 05-11-2026, 09:00)");
  });

  // ---- F25 — samedi 15h : fermé l'après-midi chez les DEUX cliniques ----
  for (const [cid, cname, close] of [[JRA, "Jrad", "14"], [MAH, "Mahjoub", "13"]]) {
    await scenario("F25-" + cname, `samedi à 15h -> rejet (ferme ${close}h le samedi) (${cname})`, async ({ phone, say, chk }) => {
      const r = await say("Je voudrais un rendez-vous samedi à 15h", cid);
      chk.hard(isFR(r), "reject not in French");
      chk.hard(!r.includes("26-09-2026, 15:00"), "15:00 Saturday slot was PROPOSED despite closing");
      chk.soft(/ferm|en dehors|heures de travail|propose/i.test(r), "no closing/out-of-hours explanation or alternative");
      chk.hard(bookingsOf(phone).every((b) => !b.slot.includes("15:00")), "a 15:00 Saturday booking exists");
    });
  }

  // ---- F26 — vendredi 15h30 : VALIDE chez Mahjoub, INVALIDE chez Jrad ----
  await scenario("F26-Mahjoub", "vendredi à 15h30 -> valide (Mahjoub, ferme 17h)", async ({ phone, say, chk }) => {
    const r = await say("Je voudrais un rendez-vous vendredi à 15h30", MAH);
    chk.hard(isFR(r), "reply not in French");
    chk.hard(r.includes("25-09-2026") && r.includes("15:30"), "valid Friday 15:30 slot not proposed");
  });
  await scenario("F26-Jrad", "vendredi à 15h30 -> rejet (Jrad, ferme 14h le vendredi)", async ({ phone, say, chk }) => {
    const r = await say("Je voudrais un rendez-vous vendredi à 15h30", JRA);
    chk.hard(isFR(r), "reject not in French");
    chk.hard(!r.includes("25-09-2026, 15:30"), "15:30 Friday slot was PROPOSED despite 14:00 closing");
    chk.soft(/ferm|en dehors|heures de travail|propose/i.test(r), "no out-of-hours explanation or alternative");
  });

  // ---- F27 — dimanche : jour fermé chez les deux ----
  for (const [cid, cname] of [[JRA, "Jrad"], [MAH, "Mahjoub"]]) {
    await scenario("F27-" + cname, `dimanche à 10h -> jour fermé (${cname})`, async ({ phone, say, chk }) => {
      const r = await say("Je voudrais un rendez-vous dimanche à 10h", cid);
      chk.hard(isFR(r), "closed-day reply not in French");
      chk.hard(!r.includes("27-09-2026, 10:00"), "Sunday slot was PROPOSED despite closure");
      chk.soft(/fermé/i.test(r), "reply does not say the clinic is closed that day");
      chk.soft(r.includes("28-09-2026"), "no alternative proposed on the next open day (lundi 28-09)");
    });
  }

  // ---- F28 — jeudi 17h : limite chez Mahjoub (17:00 pile = dedans), rejet chez Jrad (ferme 16h) ----
  await scenario("F28-Mahjoub", "jeudi à 17h -> limite acceptée (Mahjoub)", async ({ phone, say, chk }) => {
    const r = await say("Je voudrais un rendez-vous jeudi à 17h", MAH);
    chk.hard(isFR(r), "reply not in French");
    chk.hard(r.includes("24-09-2026") && r.includes("17:00"), "boundary 17:00 slot not proposed");
  });
  await scenario("F28-Jrad", "jeudi à 17h -> rejet (Jrad, ferme 16h)", async ({ phone, say, chk }) => {
    const r = await say("Je voudrais un rendez-vous jeudi à 17h", JRA);
    chk.hard(isFR(r), "reject not in French");
    chk.hard(!r.includes("24-09-2026, 17:00"), "17:00 slot was PROPOSED despite 16:00 closing");
  });

  // ---- F29 — heure hors horaires le soir (Jrad) ----
  await scenario("F29", "jeudi à 19h -> hors horaires (Jrad)", async ({ phone, say, chk }) => {
    const r = await say("Je voudrais un rendez-vous jeudi à 19h", JRA);
    chk.hard(isFR(r), "reject not in French");
    chk.hard(!r.includes("24-09-2026, 19:00"), "19:00 slot was PROPOSED despite closing");
    chk.soft(/en dehors|heures de travail|propose/i.test(r), "no out-of-hours explanation or alternative");
  });

  // ---- F30 — date passée en français (Jrad) ----
  await scenario("F30", "Date passée : le 10 septembre (Jrad)", async ({ phone, say, chk }) => {
    const r = await say("Je voudrais un rendez-vous le 10 septembre à 10h", JRA);
    chk.hard(isFR(r), "past-date reply not in French");
    chk.soft(/passé|passée|déjà|avenir|autre date|prochain/i.test(r), "past date not flagged as past");
    chk.hard(bookingsOf(phone).length === 0, "a booking was created for a past date");
  });

  // ---- F31 — samedi matin : valide chez Jrad (09-14), flux par période ----
  await scenario("F31", "samedi matin -> 10h (Jrad)", async ({ phone, say, chk }) => {
    const r1 = await say("Je voudrais un rendez-vous samedi matin", JRA);
    chk.hard(isFR(r1), "exact-hour ask not in French");
    chk.hard(r1.includes("26-09-2026"), "Saturday date wrong in ask (want 26-09-2026)");
    const r2 = await say("10h", JRA);
    chk.hard(isFR(r2), "proposal not in French");
    chk.hard(r2.includes("26-09-2026") && r2.includes("10:00"), "slot wrong (want 26-09-2026, 10:00)");
  });

  // ---- F32 — salutation française pure (Mahjoub) ----
  await scenario("F32", "Salutation : « Bonjour » (Mahjoub)", async ({ phone, say, chk }) => {
    const r = await say("Bonjour", MAH);
    chk.hard(isFR(r), "greeting reply not in French");
    chk.soft(/Mahjoub/i.test(r), "greeting does not name the clinic");
  });

  // ---- F17 — autre docteur nommé (config other_doctor) — LAST: mutates the
  // Mahjoub stub config for the rest of the process. Suspected GAP: the
  // handoff message exists only in Derja/Arabizi. ----
  await stubDb.saveClinicConfig(MAH, { other_doctor: "Ben Salah" });
  await scenario("F17", "Autre docteur nommé : Dr Ben Salah (Mahjoub, other_doctor configuré)", async ({ phone, say, chk }) => {
    const r = await say("Je voudrais un rendez-vous avec le Dr Ben Salah s'il vous plaît", MAH);
    chk.soft(/Ben Salah/i.test(r), "other-doctor handoff did not happen (doctor not acknowledged)");
    chk.soft(isFR(r), "handoff reply not in French (French patient answered in Derja)");
  });

  // ---------- summary ----------
  const nP = results.filter((x) => x.verdict === "PASS").length;
  const nG = results.filter((x) => x.verdict === "GAP").length;
  const nF = results.filter((x) => x.verdict === "FAIL").length;
  console.log(`\n=== FRENCH BATTERY: ${results.length} scenarios — ${nP} PASS, ${nG} GAP, ${nF} FAIL ===`);
  for (const x of results) console.log(`${x.id}\t${x.verdict}\t${x.title}`);
}

runFrench()
  .then(() => process.exit(0)) // index.js holds an HTTP server open — exit explicitly
  .catch((e) => { console.error("FRENCH BATTERY CRASH:", e); process.exit(2); });
