// test-local.js — full regression test for the clinic bot. No network, no Postgres.
// Drives the REAL processPatientText / processSecretaryText with an in-memory db stub,
// plus a wide matrix of Derja date/time expressions through the REAL dates.js.
// Usage: node test-local.js   (exit 0 = all green)
process.env.PORT = "43119";
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
    getBookingsByPhone: async (phone) => bookings.filter((b) => b.phone === phone),
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
    updateBookingName: async (id, patient_name) => {
      const b = bookings.find((b) => b.id === id);
      if (b) b.patient_name = patient_name;
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
// test-lang.js — Fix S (2026-10-13): STRUCTURAL language coverage.
// 1) CATALOG COVERAGE: mechanically enumerates bot.MSG — every key must
//    carry ar/fr/az variants, all rendering non-empty; ar must contain
//    Arabic script, fr/az must contain none. A future reply added in one
//    language only FAILS here instead of reaching a patient.
// 2) RESOLVER units: resolveLang priority + stickiness rules.
// 3) E2E conversations per language (French incl. the Prignol incident
//    as an explicit regression, Arabic, Arabizi) — every bot reply in
//    the conversation's language, no cross-language leakage.
// 4) Supervisor-notification hybrid: question forward + booking notif
//    choose free-form <24h, template >24h (Meta 131047 regression).
// Same harness as test-local/test-french (stub db, frozen now, no AI key).
// Usage: node test-lang.js   (exit 0 = all green)
// =====================================================================
const MAH = "1364750653386950";
const JRA = "1445223932002571";
const SUP_MAH = "98800749";   // Mahjoub supervisor (seed)
const SUP_JRA = "28192232";   // Jrad supervisor (seed)
const SUP_MAH_TO = "21698800749"; // Fix AE: outbound sends are normalized to intl
const SUP_JRA_TO = "21628192232";
const HOURS_MAH = "Thenin lel Jom3a: 08:30 - 17:30, Sebt: 08:30 - 13:00, Ahad: msakker";
const HOURS_JRA = "Thenin lel 5mis: 09:00 - 16:00, Jom3a w Sebt: 09:00 - 14:00, Ahad: msakker";

const ARABIC_RE = /[\u0600-\u06FF]/;
const ARABIZI_RE = /(mta3|n7eb|na7jez|n7ajzlek|9olli|anhou|el wa9t|t7eb n|ne5dem|3iyada|anhou nhar|se3a b|mta3 sbe7|mta3 l3chiya|fhemtek|sama7ni|tfadhel|mriguel|ghodwa|lyoum|n7ajzou|bech n|ken t7eb)/i;
function cleanCfg(r) {
  return String(r || "").split(HOURS_MAH).join(" ").split(HOURS_JRA).join(" ");
}
function isFR(r) {
  const c = cleanCfg(r);
  return typeof r === "string" && r.length > 0 && !ARABIC_RE.test(c) && !ARABIZI_RE.test(c);
}
function isAR(r) { return typeof r === "string" && ARABIC_RE.test(r); }
function isAZ(r) { return typeof r === "string" && r.length > 0 && !ARABIC_RE.test(cleanCfg(r)); }

let phoneSeq = 0;
function newPhone() { return "3362000" + String(++phoneSeq).padStart(4, "0"); }
function bookingsOf(phone) { return stubDb._inspect().bookings.filter((b) => b.phone === phone); }
function clearFetch() { fetchCalls.length = 0; }
function sentBodies() {
  return fetchCalls.map((x) => { try { return JSON.parse(x.opts.body); } catch { return null; } }).filter(Boolean);
}
function textBodiesTo(to) { return sentBodies().filter((b) => b.type === "text" && b.to === to); }
function templateBodiesTo(name, to) {
  return sentBodies().filter((b) => b.type === "template" && b.template && b.template.name === name && b.to === to);
}

const CTX = {
  clinicName: "Cabinet Test", doctor: "Ben Salah", ben1: "pour moi", ben2: "pour ma femme",
  disp: "vendredi 10:00", display: "vendredi 10:00", dateDisplay: "vendredi",
  slot: "vendredi 10:00", when: "vendredi 10:00", first: "Ahmed", badHour: "25",
  hourStr: "10", am: "10:00", pm: "22:00", range: "du lundi au samedi", sugDay: "lundi",
  hrs: "09:00 - 16:00", sug: "lundi 10:00", period: "morning",
  hours: "du lundi au samedi 09:00 - 16:00", address: "Rue Test, Tunis",
};

async function runLang() {
  // ---------- 1) Catalog coverage (the point of the refactor) ----------
  {
    const keys = Object.keys(bot.MSG || {});
    ok("catalog: MSG exported and sizeable", keys.length >= 50, `keys=${keys.length}`);
    for (const key of keys) {
      for (const lang of ["ar", "fr", "az"]) {
        const v = bot.msg(key, lang, CTX);
        ok(`catalog: ${key}.${lang} renders non-empty`, typeof v === "string" && v.trim().length > 0,
          `got ${JSON.stringify(v)}`);
        if (lang === "ar") ok(`catalog: ${key}.ar is Arabic script`, ARABIC_RE.test(v), JSON.stringify(v));
        else ok(`catalog: ${key}.${lang} has no Arabic script`, !ARABIC_RE.test(v), JSON.stringify(v));
        const bare = bot.msg(key, lang, {});
        ok(`catalog: ${key}.${lang} renders with empty ctx`, typeof bare === "string", `got ${JSON.stringify(bare)}`);
      }
    }
  }

  // ---------- 2) Resolver units ----------
  {
    const p = newPhone();
    ok("resolver: Arabic script -> ar", (await bot.resolveLang(p, "نحب نحجز رونديفو غدوة")) === "ar");
    ok("resolver: French -> fr", (await bot.resolveLang(p, "Je veux prendre un rendez-vous")) === "fr");
    ok("resolver: Derja -> az", (await bot.resolveLang(p, "n7eb na7jez rendez-vous")) === "az");
    ok("resolver: Arabic wins over French in one message",
      (await bot.resolveLang(p, "je veux un rendez-vous نحب نحجز")) === "ar");
    ok("resolver: explicit French request -> fr", (await bot.resolveLang(p, "ektebli bel francais")) === "fr");
    ok("resolver: explicit Arabic request -> ar", (await bot.resolveLang(p, "aktebli bel 3arbi")) === "ar");
    ok("resolver: explicit Latin request -> az", (await bot.resolveLang(p, "aktebli b 7rouf")) === "az");
    const frHist = [
      { role: "user", text: "Je veux prendre un rendez-vous vendredi" },
      { role: "assistant", text: "D'accord — vendredi. Quelle heure ?" },
    ];
    ok("resolver: short 'oui' sticks to French history",
      (await bot.resolveLang(p, "oui", { history: frHist })) === "fr");
    ok("resolver: bare 'oui' alone defaults to az", (await bot.resolveLang(p, "oui")) === "az");
    ok("resolver: short reply sticks to French proposal",
      (await bot.resolveLang(p, "oui", { proposalText: "je vous propose vendredi a dix heures du matin" })) === "fr");
    ok("resolver: full Derja sentence after French history -> az (no false stickiness)",
      (await bot.resolveLang(p, "Ok nhar thleth mawjoud?", { history: frHist })) === "az");
    const pAr = newPhone();
    await stubDb.saveScriptPref(pAr, "ar");
    ok("resolver: saved pref ar honored for neutral reply", (await bot.resolveLang(pAr, "ok")) === "ar");
    const pFr = newPhone();
    await stubDb.saveScriptPref(pFr, "fr");
    ok("resolver: saved pref fr honored for neutral reply", (await bot.resolveLang(pFr, "ok")) === "fr");
  }

  // ---------- 3a) E2E French conversation + Prignol regression (Jrad) ----------
  {
    const phone = newPhone();
    const replies = [];
    const say = async (t) => { const r = await bot.processPatientText(phone, t, JRA); replies.push(r); return r; };

    const r1 = await say("Bonjour");
    ok("FR e2e: greeting in French", isFR(r1), JSON.stringify(r1));
    const r2 = await say("Je veux prendre un rendez-vous");
    ok("FR e2e: booking intent answered in French", isFR(r2), JSON.stringify(r2));
    const r3 = await say("Vendredi à 10h");
    ok("FR e2e: slot proposed in French", isFR(r3) && r3.includes("Voulez-vous"), JSON.stringify(r3));
    const r4 = await say("Oui");
    ok("FR e2e: 'Oui' -> name asked in French", isFR(r4) && /nom et votre prénom/i.test(r4), JSON.stringify(r4));
    const r5 = await say("Gilles Prignol");
    ok("FR e2e: booking done in French", isFR(r5) && /bienvenue/i.test(r5), JSON.stringify(r5));
    ok("FR e2e: booking saved pending", bookingsOf(phone).length === 1 && bookingsOf(phone)[0].status === "pending",
      JSON.stringify(bookingsOf(phone)));

    // PRIGNOL REGRESSION (production, 2026-10-13 12:38): French patient
    // answers "Oui" to the doctor-question offer -> the confirmation MUST
    // be French (it shipped in Arabizi before Fix S).
    bot.rememberQuestionOffer(phone,
      "Je n'ai pas cette information. Voulez-vous que je demande au docteur ? Ecrivez oui.",
      "Est-ce que le blanchiment dentaire fait mal ?", { id: JRA });
    ok("FR prignol: offer armed", bot._pendingQuestion.has(phone));
    clearFetch();
    const r6 = await say("Oui");
    ok("FR prignol: escalation confirmation is FRENCH", isFR(r6), JSON.stringify(r6));
    has("FR prignol: confirmation wording", r6, "j'ai demandé au docteur");
    ok("FR prignol: question forwarded to supervisor (free-form, window open)",
      textBodiesTo(SUP_JRA_TO).some((b) => /Sou2el jdid/.test(b.text.body) && /blanchiment/.test(b.text.body)),
      JSON.stringify(sentBodies().map((b) => b.to)));

    // French decline of the same offer.
    bot.rememberQuestionOffer(phone,
      "Voulez-vous que je demande au docteur ? Ecrivez oui.", "Autre question ?", { id: JRA });
    const r7 = await say("Non");
    ok("FR e2e: 'Non' decline in French", isFR(r7) && /pas de problème/.test(r7), JSON.stringify(r7));

    // French cancellation closes the conversation.
    const r8 = await say("Je veux annuler mon rendez-vous");
    ok("FR e2e: cancellation in French", isFR(r8) && /annulé/.test(r8), JSON.stringify(r8));
    ok("FR e2e: booking actually cancelled", bookingsOf(phone)[0].status === "cancelled",
      JSON.stringify(bookingsOf(phone)));
    ok("FR e2e: NO reply leaked Arabic/Arabizi", replies.every(isFR),
      JSON.stringify(replies.filter((r) => !isFR(r))));
  }

  // ---------- 3b) E2E Arabic conversation (Mahjoub) ----------
  {
    const phone = newPhone();
    const replies = [];
    const say = async (t) => { const r = await bot.processPatientText(phone, t, MAH); replies.push(r); return r; };

    const r1 = await say("سلام");
    ok("AR e2e: greeting in Arabic", isAR(r1), JSON.stringify(r1));
    const r2 = await say("نحب نحجز رونديفو غدوة العشرة متاع الصباح");
    ok("AR e2e: slot proposed in Arabic", isAR(r2) && r2.includes("تحب نحجزلك"), JSON.stringify(r2));
    const r3 = await say("اي");
    ok("AR e2e: name asked in Arabic", isAR(r3) && r3.includes("الاسم واللقب"), JSON.stringify(r3));
    const r4 = await say("أحمد بن صالح");
    ok("AR e2e: booking done in Arabic", isAR(r4) && r4.includes("مرحبا بيك"), JSON.stringify(r4));
    ok("AR e2e: booking saved", bookingsOf(phone).length === 1, JSON.stringify(bookingsOf(phone)));

    bot.rememberQuestionOffer(phone, "T7eb nes2el el tbib? Ekteb ey.", "سؤال طبي؟", { id: MAH });
    const r5 = await say("ey");
    ok("AR e2e: escalation confirmation in Arabic", isAR(r5) && r5.includes("سألت الطبيب"), JSON.stringify(r5));

    const r6 = await say("ممكن تفسخلي الرونديفو؟");
    ok("AR e2e: cancellation in Arabic", isAR(r6) && r6.includes("فسخت الرونديفو"), JSON.stringify(r6));
    ok("AR e2e: booking actually cancelled", bookingsOf(phone)[0].status === "cancelled",
      JSON.stringify(bookingsOf(phone)));
    ok("AR e2e: every reply carries Arabic script", replies.every(isAR),
      JSON.stringify(replies.filter((r) => !isAR(r))));
  }

  // ---------- 3c) E2E Arabizi conversation (Mahjoub) ----------
  {
    const phone = newPhone();
    const replies = [];
    const say = async (t) => { const r = await bot.processPatientText(phone, t, MAH); replies.push(r); return r; };

    const r1 = await say("slem");
    ok("AZ e2e: greeting in Arabizi", isAZ(r1) && /Ahla w sahla/i.test(r1), JSON.stringify(r1));
    const r2 = await say("n7eb na7jez ghodwa 10 mta3 sbe7");
    ok("AZ e2e: slot proposed in Arabizi", isAZ(r2) && r2.includes("T7eb n7ajzlek"), JSON.stringify(r2));
    const r3 = await say("ey");
    ok("AZ e2e: name asked in Arabizi", isAZ(r3) && /esm wel la9ab/i.test(r3), JSON.stringify(r3));
    const r4 = await say("Ahmed Ben Salah");
    ok("AZ e2e: booking done in Arabizi", isAZ(r4) && /merhba bik/i.test(r4), JSON.stringify(r4));

    bot.rememberQuestionOffer(phone, "T7eb nes2el el tbib? Ekteb ey.", "9adech el consultation?", { id: MAH });
    const r5 = await say("ey");
    ok("AZ e2e: escalation confirmation in Arabizi", isAZ(r5) && r5.includes("s2elt el tbib"), JSON.stringify(r5));

    const r6 = await say("n7eb nfassakh el rendez-vous");
    ok("AZ e2e: cancellation in Arabizi", isAZ(r6) && /fassakht el rendez-vous/i.test(r6), JSON.stringify(r6));
    ok("AZ e2e: booking actually cancelled", bookingsOf(phone)[0].status === "cancelled",
      JSON.stringify(bookingsOf(phone)));
    ok("AZ e2e: NO reply in Arabic script or pure French", replies.every(isAZ),
      JSON.stringify(replies.filter((r) => !isAZ(r))));
  }

  // ---------- 3d) French settle: secretary "ok" -> patient told in French ----------
  {
    const phone = newPhone();
    await bot.processPatientText(phone, "Je veux un rendez-vous vendredi à 10h", JRA);
    await bot.processPatientText(phone, "oui", JRA);
    await bot.processPatientText(phone, "Marie Curie", JRA);
    const bk = bookingsOf(phone)[0];
    ok("FR settle: booking exists", !!bk, JSON.stringify(bookingsOf(phone)));
    const clinic = await bot.getClinic(JRA, undefined);
    clearFetch();
    const secReply = await bot.processSecretaryText(`ok ${bk.id}`, clinic, SUP_JRA);
    ok("FR settle: secretary gets her usual confirmation", /T2akked/.test(secReply), JSON.stringify(secReply));
    const toPatient = textBodiesTo(phone);
    ok("FR settle: patient confirmation sent", toPatient.length === 1, JSON.stringify(sentBodies().map((b) => b.to)));
    ok("FR settle: patient confirmation is FRENCH",
      toPatient.length === 1 && /Votre rendez-vous est confirmé/.test(toPatient[0].text.body),
      JSON.stringify(toPatient));
  }

  // ---------- 4) Supervisor hybrid: >24h -> template, <24h -> free-form ----------
  {
    const origSupTime = stubDb.getLastSupervisorMessageTime;
    // Supervisor silent for 48h: window CLOSED.
    stubDb.getLastSupervisorMessageTime = async () => new Date(Date.now() - 48 * 3600 * 1000);
    try {
      // 4a) Question forward must use the notif_question TEMPLATE.
      const phone = newPhone();
      bot.rememberQuestionOffer(phone, "T7eb nes2el el tbib? Ekteb ey.", "9adech el consultation?", { id: MAH });
      clearFetch();
      const r = await bot.processPatientText(phone, "ey", MAH);
      has("hybrid>24h: patient still confirmed", r, "s2elt el tbib");
      ok("hybrid>24h: notif_question TEMPLATE sent to supervisor",
        templateBodiesTo("notif_question", SUP_MAH_TO).length === 1,
        JSON.stringify(sentBodies()));
      ok("hybrid>24h: NO free-form text to supervisor (would fail 131047)",
        textBodiesTo(SUP_MAH_TO).length === 0, JSON.stringify(sentBodies()));
      const tpl = templateBodiesTo("notif_question", SUP_MAH_TO)[0];
      const params = ((tpl.template.components || []).find((c) => c.type === "body") || {}).parameters || [];
      ok("hybrid>24h: template carries the question",
        params.some((x) => /consultation/.test(x.text || "")), JSON.stringify(params));

      // 4b) Booking notification must use the notif_booking TEMPLATE.
      const bp = newPhone();
      await stubDb.savePatientName(bp, "Hybrid Test");
      await bot.processPatientText(bp, "ghodwa 10 mta3 sbe7", MAH);
      clearFetch();
      await bot.processPatientText(bp, "ey", MAH);
      ok("hybrid>24h: notif_booking TEMPLATE sent",
        templateBodiesTo("notif_booking", SUP_MAH_TO).length === 1, JSON.stringify(sentBodies()));
      ok("hybrid>24h: NO free-form booking notif",
        !textBodiesTo(SUP_MAH_TO).some((b) => /Rendez-vous jdid/.test(b.text.body)),
        JSON.stringify(sentBodies()));
    } finally {
      stubDb.getLastSupervisorMessageTime = origSupTime;
    }
    // 4c) Window OPEN (<24h, stub default): free-form, no template.
    const phone2 = newPhone();
    bot.rememberQuestionOffer(phone2, "T7eb nes2el el tbib? Ekteb ey.", "sou2el test?", { id: MAH });
    clearFetch();
    await bot.processPatientText(phone2, "ey", MAH);
    ok("hybrid<24h: free-form question forward",
      textBodiesTo(SUP_MAH_TO).some((b) => /Sou2el jdid/.test(b.text.body)), JSON.stringify(sentBodies()));
    ok("hybrid<24h: no template used", templateBodiesTo("notif_question", SUP_MAH_TO).length === 0,
      JSON.stringify(sentBodies()));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail;
}

runLang()
  .then((f) => process.exit(f ? 1 : 0)) // index.js holds an HTTP server open — exit explicitly
  .catch((e) => { console.error("LANG BATTERY CRASH:", e); process.exit(2); });
