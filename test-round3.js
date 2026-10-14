// test-round3.js — ROUND-3 adversarial battery (2026-10-13). No network, no Postgres.
// Drives the REAL processPatientText / processSecretaryText with an in-memory db stub.
// NEW scenarios only (round 1 = test-deep.js 87, round 2 = test-round2.js 117).
// Frozen clock: Wed 2026-10-14 09:00 Tunis (= 2026-10-14T08:00:00Z).
// Oct 2026 calendar: 14 Wed, 15 Thu, 16 Fri, 17 Sat, 18 Sun, 19 Mon, 20 Tue,
// 21 Wed, 22 Thu, 23 Fri, 24 Sat, 25 Sun, 26 Mon, 27 Tue, 28 Wed, 29 Thu,
// 30 Fri, 31 Sat. Nov: 1 Sun, 2 Mon, 11 Wed, 12 Thu. Dec: 11 Fri, 12 Sat.
// NO AI key -> deterministic layer only (production fallback path).
// Usage: node test-round3.js
process.env.PORT = "43121";
process.env.WHATSAPP_TOKEN = "test-token-templates";
delete process.env.AI_API_KEY;
delete process.env.OPENAI_API_KEY;
const fetchCalls = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (!String(url).includes("graph.facebook.com")) return realFetch(url, opts);
  fetchCalls.push({ url: String(url), opts: opts || {} });
  const isMedia = String(url).includes("/media");
  return {
    ok: true,
    json: async () => (isMedia ? { id: "test-media-id" } : { messages: [{ id: "wamid.test" }] }),
  };
};
process.env.VIXA_NUMBERS = "52999999";

const path = require("path");

// ---------- in-memory db stub (same interface as db.js, + scheduled messages) ----------
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
  const scheduled = [];
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
    saveClinicConfig: async (numberId, cfg) => {
      const prev = clinicConfigs.get(numberId) || {};
      const pin = cfg.viewer_pin === "" ? (prev.viewer_pin || "") : cfg.viewer_pin === "CLEAR" ? "" : (cfg.viewer_pin !== undefined ? cfg.viewer_pin : (prev.viewer_pin || ""));
      clinicConfigs.set(numberId, { ...prev, phone_number_id: numberId, ...cfg, viewer_pin: pin });
    },
    listClinicConfigs: async () => [...clinicConfigs.values()],
    getScriptPref: async (phone) => scriptPrefs.get(phone) || null,
    saveScriptPref: async (phone, script) => { scriptPrefs.set(phone, script); },
    // Scheduled wasel (db.js has these; test-deep's stub did not)
    saveScheduledMessage: async (numberId, patientPhone, message, sendAt) => {
      const s = { id: seq++, number_id: numberId || null, phone: patientPhone, message, sendAt, status: "pending" };
      scheduled.push(s);
      return s.id;
    },
    getDueScheduledMessages: async () => [],
    markScheduledMessage: async (id, status) => {
      const s = scheduled.find((x) => x.id === id);
      if (s) s.status = status;
    },
    listPendingScheduledMessages: async (numberId = null) =>
      scheduled.filter((s) => s.status === "pending" && (!numberId || s.number_id === numberId)),
    _inspect: () => ({ messages, bookings, proposals, signups, suggestions, scheduled }),
    clearClinicConfig: async (numberId) => { clinicConfigs.delete(numberId); },
  };
}
const stubDb = makeStubDb();
const dbPath = require.resolve(path.join(__dirname, "db.js"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: stubDb };

const bot = require("./index.js");
const dates = bot.dates;
// Freeze time: Wed 2026-10-14 09:00 Tunis.
const DEFAULT_NOW_MS = new Date("2026-10-14T08:00:00Z").getTime();
dates.setNow(DEFAULT_NOW_MS);

// =====================================================================
const MAH = "1364750653386950"; // Dr Mahjoub, Sousse — Lun-Ven 08:30-17:30 (booking 8-17), Sam 08:30-13:00, Dim fermé
const JRA = "1445223932002571";  // Dr Jrad, Djerba — Lun-Jeu 09:00-16:00, Ven-Sam 09:00-14:00, Dim fermé
const SUP_MAH = "98800749";
const SUP_JRA = "28192232";
const SEC_FROM = { [MAH]: "21698800749", [JRA]: "21628192232" };
const HOURS_MAH = "Thenin lel Jom3a: 08:30 - 17:30, Sebt: 08:30 - 13:00, Ahad: msakker";
const HOURS_JRA = "Thenin lel 5mis: 09:00 - 16:00, Jom3a w Sebt: 09:00 - 14:00, Ahad: msakker";

const ARABIC_RE = /[\u0600-\u06FF]/;
const ARABIZI_RE = /(mta3|n7eb|na7jez|n7ajzlek|9olli|anhou|el wa9t|t7eb|ne5dem|3iyada|anhou nhar|mta3 sbe7|mta3 l3chiya|fhemt|tfadhel|mriguel|ghodwa|lyoum|n7ajzou|bech n|ken t7eb|esbou3|barcha|na7i|nbaddel)/i;
function cleanCfg(r) {
  return String(r || "").split(HOURS_MAH).join(" ").split(HOURS_JRA).join(" ");
}
function isFR(r) {
  const c = cleanCfg(r);
  return typeof r === "string" && r.length > 0 && !ARABIC_RE.test(c) && !ARABIZI_RE.test(c);
}
function isAR(r) { return typeof r === "string" && ARABIC_RE.test(r); }
function hasDate(r, ddmmyyyy) { return String(r || "").includes(ddmmyyyy); }

const results = [];
let phoneSeq = 0;
function newPhone() { return "3363100" + String(++phoneSeq).padStart(4, "0"); }
function parseBodies(list) {
  return list.map((x) => { try { return JSON.parse(x.opts.body); } catch { return null; } }).filter(Boolean);
}

async function scenario(id, family, title, clinicId, fn, opts = {}) {
  dates.setNow(DEFAULT_NOW_MS); // every scenario starts from the same frozen clock
  const phone = opts.phone || newPhone();
  const fetchStart = fetchCalls.length;
  const suggStart = stubDb._inspect().suggestions.length;
  const schedStart = stubDb._inspect().scheduled.length;
  const log = [];
  const say = async (text, cid) => {
    const r = await bot.processPatientText(phone, text, cid || clinicId);
    log.push({ inn: text, out: r });
    return r;
  };
  const sec = async (text, cid, from) => {
    const c = await bot.getClinic(cid || clinicId, undefined);
    const r = await bot.processSecretaryText(text, c, from || SEC_FROM[cid || clinicId]);
    log.push({ inn: "[SEC] " + text, out: r });
    return r;
  };
  const chk = {
    problems: [], verdict: "PASS",
    hard(cond, msg, sev) { if (!cond) { this.problems.push({ kind: "FAIL", msg, sev: sev || "medium" }); this.verdict = "FAIL"; } },
    soft(cond, msg, sev) { if (!cond) { this.problems.push({ kind: "GAP", msg, sev: sev || "low" }); if (this.verdict === "PASS") this.verdict = "GAP"; } },
  };
  const ctx = {
    phone, say, sec, chk,
    bookings: () => stubDb._inspect().bookings.filter((b) => b.phone === phone),
    allBookings: () => stubDb._inspect().bookings,
    sent: () => parseBodies(fetchCalls.slice(fetchStart)),
    forwardsTo: (sup) => parseBodies(fetchCalls.slice(fetchStart)).filter((b) => b.to === sup && (b.type === "text" || b.type === "template")),
    sentTo: (num) => parseBodies(fetchCalls.slice(fetchStart)).filter((b) => b.to === num),
    templatesTo: (num, name) => parseBodies(fetchCalls.slice(fetchStart)).filter((b) => b.to === num && b.template && (!name || b.template.name === name)),
    textsTo: (num) => parseBodies(fetchCalls.slice(fetchStart)).filter((b) => b.to === num && b.type === "text"),
    suggestions: () => stubDb._inspect().suggestions.slice(suggStart),
    scheduled: () => stubDb._inspect().scheduled.slice(schedStart),
    messagesOf: (ph) => stubDb._inspect().messages.filter((m) => m.phone === ph),
    armed: () => bot._pendingQuestion.has(phone),
    proposal: () => stubDb._inspect().proposals.get(phone) || null,
    replies: () => log.map((l) => l.out),
    last: () => (log.length ? log[log.length - 1].out : null),
    // Complete a Derja booking: propose-msg already sent by caller pattern below.
    bookDerja: async (slotMsg, name) => {
      await say(slotMsg);
      await say("ey");
      return say(name);
    },
    bookFr: async (slotMsg, name) => {
      await say(slotMsg);
      await say("oui");
      return say(name);
    },
    // Round-3 extras: move the frozen clock, talk as another phone, inspect others.
    setClock: (iso) => { dates.setNow(new Date(iso).getTime()); },
    sayAs: async (ph, text, cid) => {
      const r = await bot.processPatientText(ph, text, cid || clinicId);
      log.push({ inn: `[${ph}] ` + text, out: r });
      return r;
    },
    bookingsOf: (ph) => stubDb._inspect().bookings.filter((b) => b.phone === ph),
  };
  try { await fn(ctx); }
  catch (e) { chk.problems.push({ kind: "FAIL", msg: "EXCEPTION: " + (e && e.message), sev: "high" }); chk.verdict = "FAIL"; }
  const res = { id, family, title, clinicId, verdict: chk.verdict, problems: chk.problems, log, bookings: ctx.bookings() };
  results.push(res);
  console.log(`\n===== ${id} [${chk.verdict}] (${family}) ${title}`);
  for (const t of log) {
    console.log("  In: " + String(t.inn).replace(/\n/g, " / ").slice(0, 300));
    console.log("  Bot: " + String(t.out == null ? "(null)" : t.out).replace(/\n/g, " / ").slice(0, 400));
  }
  for (const b of res.bookings) console.log(`  >> booking: ${b.slot} | at=${b.slot_at} | status=${b.status} | name=${b.patient_name || "-"}`);
  for (const p of chk.problems) console.log(`  !! ${p.kind} (${p.sev}): ${p.msg}`);
  return res;
}


// ================= Round-3 helpers =================
const PRICE_FIG = /\d+\s*(dt|dinar|dinars|tnd|€|euros?)/i;
function probe3(id, family, title, clinicId, text, expect = {}) {
  return scenario(id, family, title, clinicId, async (ctx) => {
    const r = await ctx.say(text);
    const rr = String(r || "");
    ctx.chk.hard(typeof r === "string" && rr.length > 0, "the patient must get SOME reply", "medium");
    if (expect.date) ctx.chk.soft(hasDate(rr, expect.date), `reply should resolve to ${expect.date}; got: ${rr}`, expect.sev || "medium");
    if (expect.notDate) ctx.chk.hard(!hasDate(rr, expect.notDate), `reply must NOT propose ${expect.notDate}; got: ${rr}`, expect.sev || "medium");
    if (expect.noSlot) ctx.chk.hard(!/\d{2}-\d{2}-\d{4}, \d{2}:\d{2}/.test(rr), `reply must NOT propose a concrete slot; got: ${rr}`, expect.sev || "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking should exist after a single probe turn");
    if (expect.extra) expect.extra(ctx, rr);
  });
}

// ================= Family 1: long multi-turn conversations =================
async function runLong() {
  await scenario("LT1", "long", "11-turn journey: FAQs, book, date change, FAQ at name gate, status, reschedule, status (Mahjoub)", MAH, async (ctx) => {
    await ctx.say("slm");
    const rp = await ctx.say("9adech el consultation?");
    ctx.chk.hard(!PRICE_FIG.test(String(rp || "")), `no price figure may be invented; got: ${rp}`, "high");
    await ctx.say("chnowa wa9t el 5edma?");
    await ctx.say("nheb na7jez el jom3a el 10 mta3 el sbe7");
    await ctx.say("le, badel el sabt el 11");
    await ctx.say("ey");
    const ra = await ctx.say("win el 3iyada bedhabt?");
    ctx.chk.hard(String(ra || "").includes("Sousse"), `the address FAQ at the name gate must be answered; got: ${ra}`, "medium");
    await ctx.say("Amine Trabelsi");
    let bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "17-10-2026") && bs[0].slot.includes("11:00"),
      `booking should be Sat 17-10 11:00 after the mid-flow change; got: ${JSON.stringify(bs)}`, "high");
    const rs = await ctx.say("wa9tech el rendez-vous mte3i?");
    ctx.chk.hard(hasDate(String(rs || ""), "17-10-2026"), `status must show the booked Saturday; got: ${rs}`, "medium");
    await ctx.say("nheb nbadel lel thenin el 10 mta3 el sbe7");
    await ctx.say("ey"); // confirm the proposed move
    const rs2 = await ctx.say("wa9tech el rendez-vous mte3i?");
    ctx.chk.hard(hasDate(String(rs2 || ""), "19-10-2026"), `status after reschedule must show Mon 19-10; got: ${rs2}`, "medium");
    bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "19-10-2026") && bs[0].status === "pending",
      `exactly ONE booking, moved to Monday, still pending; got: ${JSON.stringify(bs)}`, "high");
  });

  await scenario("LT2", "long", "Topic switch mid-booking: propose -> 'fassa5 el koul' -> rebook another day (Jrad)", JRA, async (ctx) => {
    await ctx.say("nheb na7jez el jom3a el 10 mta3 el sbe7");
    await ctx.say("le fassa5 el koul, nheb n3awed mel jdid");
    await ctx.say("nheb na7jez el sabt el 11 mta3 el sbe7");
    await ctx.say("ey");
    await ctx.say("Hela Mansour");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "17-10-2026"),
      `only the Saturday rebook may exist (the abandoned Friday proposal must never book); got: ${JSON.stringify(bs)}`, "high");
  });

  await scenario("LT3", "long", "Greeting spam between proposal and acceptance (Mahjoub)", MAH, async (ctx) => {
    await ctx.say("nheb na7jez ghodwa el 10 mta3 el sbe7");
    await ctx.say("slm");
    await ctx.say("cv?");
    await ctx.say("ey");
    await ctx.say("slm");
    await ctx.say("Sami Ayadi");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "15-10-2026"),
      `greetings between steps must not reset the flow — booking Thu 15-10 expected; got: ${JSON.stringify(bs)}`, "high");
  });

  await scenario("LT4", "long", "Change of mind twice with full slots before confirming (Jrad)", JRA, async (ctx) => {
    await ctx.say("nheb na7jez el jom3a el 10 mta3 el sbe7");
    await ctx.say("le, el sabt el 11");
    await ctx.say("le, el thenin el 14");
    await ctx.say("ey");
    await ctx.say("Yosri Ben Ammar");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "19-10-2026") && bs[0].slot.includes("14:00"),
      `only the LAST slot (Mon 19-10 14:00) may be booked; got: ${JSON.stringify(bs)}`, "high");
  });

  await scenario("LT5", "long", "Two phases: book, goodbye, return, status, cancel, status (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez el jom3a el 10 mta3 el sbe7", "Rim Khelifi");
    await ctx.say("choukran, bye");
    await ctx.say("slm, rja3t");
    const rs = await ctx.say("el rendez-vous mte3i t2akked walla mazel?");
    ctx.chk.hard(hasDate(String(rs || ""), "16-10-2026"), `returning patient status must show the Friday booking; got: ${rs}`, "medium");
    await ctx.say("nheb nfassakh el rendez-vous mte3i");
    ctx.chk.hard(ctx.bookings()[0].status === "cancelled", `the booking should be cancelled; got ${ctx.bookings()[0].status}`, "high");
    const rs2 = await ctx.say("mazel 3andi rendez-vous?");
    ctx.chk.hard(!hasDate(String(rs2 || ""), "16-10-2026") || /tfasa5|annul|cancel|ma3adech|ma fama/i.test(String(rs2 || "")),
      `status after cancel must not present the Friday slot as still active; got: ${rs2}`, "medium");
  });

  await scenario("LT6", "long", "FAQ sandwich: place + price questions between proposal and acceptance (Jrad, French)", JRA, async (ctx) => {
    await ctx.say("bonjour");
    await ctx.say("Je veux un rendez-vous jeudi a 10h");
    const rp = await ctx.say("Vous etes ou exactement ?");
    ctx.chk.hard(String(rp || "").includes("Djerba"), `the place FAQ must be answered mid-proposal; got: ${rp}`, "medium");
    const rc = await ctx.say("C'est combien la consultation ?");
    ctx.chk.hard(!PRICE_FIG.test(String(rc || "")), `no price figure may be invented mid-flow; got: ${rc}`, "high");
    await ctx.say("Oui");
    await ctx.say("Nour El Houda");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "15-10-2026"),
      `the proposal must survive two FAQ detours and book Thu 15-10; got: ${JSON.stringify(bs)}`, "high");
  });

  await scenario("LT7", "long", "New concrete slot given AT the name gate replaces the old one (Mahjoub)", MAH, async (ctx) => {
    await ctx.say("nheb na7jez el jom3a el 10 mta3 el sbe7");
    await ctx.say("ey");
    await ctx.say("le, el jom3a el 11");
    await ctx.say("Amine Trabelsi");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "16-10-2026") && bs[0].slot.includes("11:00"),
      `the gate-time slot change must win: Fri 16-10 11:00 expected; got: ${JSON.stringify(bs)}`, "high");
    ctx.chk.hard(bs.length === 1 && /Amine/.test(bs[0].patient_name || ""), `the name must be the person's name, not the slot text; got name=${bs[0] && bs[0].patient_name}`, "high");
  });

  await scenario("LT8", "long", "Second booking FOR the wife + cancel by beneficiary reference (Jrad)", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez el jom3a el 10 mta3 el sbe7", "Mohamed Ali");
    await ctx.say("nheb na7jez le marti el sabt el 11 mta3 el sbe7");
    await ctx.say("ey");
    await ctx.say("Amina Ali");
    const bs0 = ctx.bookings();
    ctx.chk.hard(bs0.length === 2 && hasDate(bs0[1].slot, "17-10-2026") && bs0[1].slot.includes("11:00"),
      `setup: the wife's Saturday 11:00 booking should exist; got: ${JSON.stringify(bs0)}`, "medium");
    ctx.chk.soft(/Amina/.test(bs0[1].patient_name || ""),
      `the wife's booking is stored under the CALLER's name ('${bs0[1].patient_name}') — once a patient name is saved, the name gate is skipped even for an explicit 'le marti' beneficiary`, "medium");
    const r = await ctx.say("fassa5 el rendez-vous mta3 marti");
    const bs = ctx.bookings();
    const wife = bs[1];
    const self = bs[0];
    ctx.chk.soft(!!wife && wife.status === "cancelled",
      `'fassa5 el rendez-vous mta3 marti' does not cancel the wife's booking (status=${wife && wife.status}) — 'fassa5' (ss+5) matches neither cancellation pattern; reply: ${r}`, "medium");
    ctx.chk.hard(!!self && self.status === "pending", "the caller's own booking must never be cancelled by a beneficiary reference", "high");
  });

  await scenario("LT9", "long", "French journey, then a Derja hours question at the end (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookFr("Je voudrais un rendez-vous lundi a 9h", "Karim Bouslama");
    ctx.chk.hard(ctx.bookings().length === 1 && hasDate(ctx.bookings()[0].slot, "19-10-2026"), "setup: Monday booking exists");
    const rf = await ctx.say("Vous fermez a quelle heure le vendredi ?");
    ctx.chk.hard(String(rf || "").includes("17:30"), `the French Friday-hours answer must carry the 17:30 close; got: ${rf}`, "medium");
    const rd = await ctx.say("w el sabt te5dmou?");
    ctx.chk.hard(String(rd || "").includes("13:00"), `the Derja Saturday question must be answered with the Saturday hours (close 13:00); got: ${rd}`, "medium");
    ctx.chk.soft(!isFR(rd) || ARABIZI_RE.test(String(rd || "")), `after the Derja switch the answer should follow Derja; got: ${rd}`, "low");
  });

  await scenario("LT10", "long", "Full lifecycle x3: book-cancel, book-reschedule-status-cancel, book-status (Jrad)", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez el jom3a el 10 mta3 el sbe7", "Nader Slim");
    await ctx.say("nheb nfassakh el rendez-vous mte3i");
    await ctx.bookDerja("nheb na7jez el sabt el 11 mta3 el sbe7", "Nader Slim");
    await ctx.say("nheb nbadel lel thenin el 9 mta3 el sbe7");
    await ctx.say("ey"); // confirm the proposed move
    const rs = await ctx.say("wa9tech el rendez-vous mte3i?");
    ctx.chk.hard(hasDate(String(rs || ""), "19-10-2026"), `status mid-lifecycle must show Mon 19-10; got: ${rs}`, "medium");
    await ctx.say("nheb nfassakh el rendez-vous mte3i");
    await ctx.bookDerja("nheb na7jez el 5mis el 10 mta3 el sbe7", "Nader Slim");
    const bs = ctx.bookings();
    const active = bs.filter((b) => b.status === "pending");
    ctx.chk.hard(bs.length === 3 && active.length === 1 && hasDate(active[0].slot, "15-10-2026"),
      `3 booking records, exactly ONE active (Thu 15-10); got: ${JSON.stringify(bs.map((b) => [b.slot, b.status]))}`, "high");
  });
}

// ================= Family 2: hostile / edge inputs =================
async function runEdge() {
  await scenario("ED1", "edge", "Numbers-only message cold: '123456' (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("123456");
    ctx.chk.hard(typeof r === "string" && r.length > 0, "a numbers-only message must still get a reply", "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking may be created");
  });

  await scenario("ED2", "edge", "Same slot request repeated x3, then accept (Jrad)", JRA, async (ctx) => {
    await ctx.say("nheb na7jez el jom3a el 10 mta3 el sbe7");
    await ctx.say("nheb na7jez el jom3a el 10 mta3 el sbe7");
    await ctx.say("nheb na7jez el jom3a el 10 mta3 el sbe7");
    ctx.chk.hard(ctx.bookings().length === 0, "repeats alone must not book anything");
    await ctx.say("ey");
    await ctx.say("Sana Guesmi");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "16-10-2026"),
      `exactly ONE booking after the repeat storm; got: ${JSON.stringify(bs)}`, "high");
  });

  await scenario("ED3", "edge", "ALL-CAPS French booking (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("BONJOUR JE VEUX UN RENDEZ-VOUS VENDREDI A 10H");
    ctx.chk.hard(hasDate(String(r || ""), "16-10-2026"), `the caps French request must resolve to Fri 16-10; got: ${r}`, "medium");
    await ctx.say("OUI");
    await ctx.say("AHMED BEN SALAH");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "16-10-2026"),
      `the caps flow must complete a booking; got: ${JSON.stringify(bs)}`, "high");
  });

  await scenario("ED4", "edge", "Voice-note placeholders AT the name gate (Jrad)", JRA, async (ctx) => {
    await ctx.say("nheb na7jez el jom3a el 10 mta3 el sbe7");
    await ctx.say("ey");
    await ctx.say("🎤 0:07");
    ctx.chk.hard(ctx.bookings().length === 0, "a voice placeholder must NEVER be stored as the patient name / complete the booking", "high");
    await ctx.say("[voice message]");
    ctx.chk.hard(ctx.bookings().length === 0, "a '[voice message]' placeholder must not complete the booking either", "high");
    await ctx.say("Ines Khelifi");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && /Ines/.test(bs[0].patient_name || ""),
      `the real name afterwards must complete the booking; got: ${JSON.stringify(bs)}`, "high");
  });

  await scenario("ED5", "edge", "Thumbs-up emoji as the answer to a proposal (Mahjoub)", MAH, async (ctx) => {
    await ctx.say("nheb na7jez el jom3a el 10 mta3 el sbe7");
    const r = await ctx.say("👍");
    ctx.chk.hard(ctx.bookings().length === 0, "an emoji alone must not complete a booking (no name yet)", "high");
    ctx.chk.soft(/esm|nom|name|chneya|chkoun/i.test(String(r || "")),
      `ideally 👍 counts as acceptance and the bot asks the name; got: ${r}`, "low");
    await ctx.say("ey");
    await ctx.say("Omar Farhat");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "16-10-2026"),
      `the flow must not be corrupted by the emoji — booking completes after 'ey' + name; got: ${JSON.stringify(bs)}`, "high");
  });

  await scenario("ED6", "edge", "Single dot, then single letter, cold (Jrad)", JRA, async (ctx) => {
    const r1 = await ctx.say(".");
    const r2 = await ctx.say("a");
    ctx.chk.hard([r1, r2].every((x) => typeof x === "string" && x.length > 0), "each junk message gets a reply", "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking may be created");
  });

  await scenario("ED7", "edge", "~500-char Derja rambling ending in a DOSAGE question (Mahjoub)", MAH, async (ctx) => {
    const story = ("el youm el ta9s behi barcha w el chames tayba, ommi mchette lel sou9 w chraat el 5odhra wel le7ma, " +
      "w weldi yel3ab fel 7ouma m3a el sghar, w el 9ahwa mta3 el sbe7 kanet bnina, w ba3d mchina lel b7ar chwaya, " +
      "w el lil etfarrejna fi match w el ness el kol ferrhana, w ghodwa 3anna barcha 5edma w visites lel 3ayla, ").repeat(2);
    const r = await ctx.say(story + "w fi el a5er 9olli bark: el doliprane 9adech marra ne5dou fel nhar?");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking may come out of the rambling", "medium");
    ctx.chk.hard(!/(marrat|fois par jour|مرات|خذ|خوذ)/.test(String(r || "")) || /tbib|docteur|médecin/i.test(String(r || "")),
      `the bot must not answer the dosage question itself; got: ${r}`, "high");
    ctx.chk.hard(/tbib|docteur|médecin|طبيب|دكتور|نسأل|nes2el|demande/i.test(String(r || "")),
      `the dosage question buried in the rambling must be handed to a human; got: ${r}`, "high");
  });

  await scenario("ED8", "edge", "Bare day word alone: 'ghodwa' (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("ghodwa");
    ctx.chk.hard(ctx.bookings().length === 0, "a bare day word must not book");
    ctx.chk.soft(/wa9t|heure|nhar|\?/.test(String(r || "")), `the bot should ask for the missing piece (time/day detail); got: ${r}`, "low");
  });

  await scenario("ED9", "edge", "A phone number given AS the name at the name gate (Jrad)", JRA, async (ctx) => {
    await ctx.say("nheb na7jez el jom3a el 10 mta3 el sbe7");
    await ctx.say("ey");
    await ctx.say("21655998877");
    ctx.chk.hard(!ctx.bookings().some((b) => (b.patient_name || "").includes("21655998877")),
      "a phone number must never be stored as the patient name", "high");
    await ctx.say("Wissem Ayadi");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && /Wissem/.test(bs[0].patient_name || ""),
      `the real name afterwards must complete the booking; got: ${JSON.stringify(bs)}`, "medium");
  });

  await scenario("ED10", "edge", "Location pin + sticker placeholders cold (Mahjoub)", MAH, async (ctx) => {
    const r1 = await ctx.say("📍");
    const r2 = await ctx.say("[sticker]");
    ctx.chk.hard([r1, r2].every((x) => typeof x === "string" && x.length > 0), "each placeholder gets a reply", "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking may be created");
  });

  await scenario("ED11", "edge", "Forwarded promo from ANOTHER clinic + own booking request at the end (Jrad)", JRA, async (ctx) => {
    const r = await ctx.say("Message transféré : Cabinet Dentaire Plus, blanchiment a 199 DT seulement cette semaine ! Sinon moi je veux un rendez-vous chez vous samedi a 10h");
    ctx.chk.hard(hasDate(String(r || ""), "17-10-2026"), `the patient's own request (Sat 17-10) must be picked up; got: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "a proposal only — no booking yet");
    ctx.chk.soft(!String(r || "").includes("199"), `the other clinic's promo price must not be quoted as this clinic's; got: ${r}`, "medium");
  });

  await scenario("ED12", "edge", "Time-only message cold: 'el 10' (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("el 10");
    ctx.chk.hard(ctx.bookings().length === 0, "a bare time must not book");
    ctx.chk.soft(/nhar|jour|wa9tech|\?/.test(String(r || "")), `the bot should ask WHICH day; got: ${r}`, "low");
  });
}

// ================= Family 3: medical red-line probes =================
const MED_NAMES = /(paracétamol|paracetamol|doliprane|ibuprofène|ibuprofene|antibiotique|amoxicilline|aspirine)/i;
async function runMed() {
  await scenario("MD1", "med", "Arabic DOSAGE question (child paracetamol) (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("ما هي جرعة الباراسيتامول المناسبة لطفل عمره 6 سنوات؟");
    ctx.chk.hard(isAR(r), `an Arabic medical question must be answered in Arabic; got: ${r}`, "medium");
    ctx.chk.hard(!/\d+\s*(ملغ|mg|مل|مغ)/.test(String(r || "")), `no dosage amount may be given; got: ${r}`, "high");
    ctx.chk.hard(/دكتور|طبيب|العيادة/.test(String(r || "")), `the question must be handed to the doctor; got: ${r}`, "high");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking from a dosage question");
  });

  await scenario("MD2", "med", "Arabic treatment-advice question: wisdom tooth, extract or treat? (Jrad)", JRA, async (ctx) => {
    const r = await ctx.say("عندي ألم في ضرس العقل، هل لازم نخلعوه ولا فما علاج آخر أحسن؟");
    ctx.chk.hard(!/(اخلع|نخلع|خوذ|خذ)/.test(String(r || "")), `the bot must not recommend a treatment; got: ${r}`, "high");
    ctx.chk.hard(/دكتور|طبيب/.test(String(r || "")), `the question must be handed to the doctor; got: ${r}`, "high");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking from a treatment question");
  });

  await scenario("MD3", "med", "French: child swallowed bleach — poisoning emergency (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("Mon fils de 4 ans a avalé de l'eau de Javel, qu'est-ce que je dois faire ?");
    ctx.chk.hard(/urgence|190|samu|antipoison|appeler|appelez/i.test(String(r || "")),
      `a poisoning must be directed to emergency care NOW; got: ${r}`, "high");
    ctx.chk.hard(!/(faites-le boire|donnez-lui du lait|faites-le vomir|boire du lait)/i.test(String(r || "")),
      `no home-remedy / first-aid instructions may be given; got: ${r}`, "high");
    ctx.chk.hard(!MED_NAMES.test(String(r || "")), `no medication may be named; got: ${r}`, "high");
    ctx.chk.soft(ctx.forwardsTo(SEC_FROM[MAH]) /* Fix AE: forwards are normalized to intl */.length >= 1, "the supervisor should be notified of the emergency", "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "an emergency is never turned into a booking");
  });

  await scenario("MD4", "med", "Derja: small child drank my medicine (Jrad)", JRA, async (ctx) => {
    const r = await ctx.say("waldi el sghir chrab mel dwe mte3i, chna3mel tawa?");
    ctx.chk.hard(!/(a3tih|charbou|a3melou)/.test(String(r || "")), `no first-aid instructions may be given; got: ${r}`, "high");
    ctx.chk.hard(/190|urgence|es3af|antipoison|طوارئ|is3af/i.test(String(r || "")),
      `a child poisoning must get EMERGENCY direction (190 / urgences), not the routine 'book an RDV to ask the doctor' answer; got: ${r}`, "high");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking from a poisoning report");
  });

  await scenario("MD5", "med", "Derja toothache + booking intent — pain is NOT an emergency (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("seni youja3 barcha mel bare7, nheb na7jez a9reb wa9t mumkin");
    ctx.chk.hard(!String(r || "").includes("190"), `ordinary toothache must NOT be turned away to the 190 emergency line; got: ${r}`, "high");
    ctx.chk.soft(/nhar|wa9t|jour|heure|9olli|propose/i.test(String(r || "")),
      `the booking intent should be picked up (ask day/time or propose); got: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no concrete slot was given, so no booking yet");
  });

  await scenario("MD6", "med", "Arabic chest pain + breathing difficulty — emergency (Jrad)", JRA, async (ctx) => {
    const r = await ctx.say("عندي ألم كبير في صدري وصعوبة في التنفس");
    ctx.chk.hard(isAR(r), `an Arabic emergency must be answered in Arabic; got: ${r}`, "medium");
    ctx.chk.hard(/طوارئ|190|إسعاف|اسعاف/.test(String(r || "")), `the reply must direct to emergency care (طوارئ/190); got: ${r}`, "high");
    ctx.chk.hard(ctx.bookings().length === 0, "an emergency is never turned into a booking");
  });

  await scenario("MD7", "med", "French diagnosis request: 'est-ce que c'est un cancer ?' (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("J'ai une boule sur la gencive depuis une semaine, est-ce que c'est un cancer ?");
    ctx.chk.hard(!/(c'est bénin|rien de grave|pas un cancer|ne vous inquiétez pas, c'est)/i.test(String(r || "")),
      `the bot must not diagnose or reassure medically; got: ${r}`, "high");
    ctx.chk.soft(/docteur|médecin|demande/i.test(String(r || "")), `the diagnosis question should be handed to the doctor; got: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking from a diagnosis request");
  });

  await scenario("MD8", "med", "Derja prescription renewal by phone (Jrad)", JRA, async (ctx) => {
    const r = await ctx.say("el ordonnance mte3i wfett, tnajem tjaddedheli mel telephone?");
    ctx.chk.hard(!/(njaddedlek|ey njaded|tettjadded)/.test(String(r || "")), `the bot must not promise to renew a prescription; got: ${r}`, "high");
    ctx.chk.soft(/tbib|doktor|docteur|secrétaire|nes2el|demande/i.test(String(r || "")), `the renewal request should be handed to a human; got: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking from a renewal request");
  });

  await scenario("MD9", "med", "Derja: 'can I just take an antibiotic from the pharmacy?' (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("najem ne5ou antibiotique mel pharmacie blech ma nji lel 3iyada?");
    ctx.chk.hard(!/(ey tnajem|tnajem te5ou|خوذ|خوذو)/.test(String(r || "")), `the bot must not green-light self-medication; got: ${r}`, "high");
    ctx.chk.soft(/tbib|doktor|docteur|secrétaire|nes2el|demande/i.test(String(r || "")), `the question should be handed to a human; got: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking");
  });

  await scenario("MD10", "med", "Arabic symptom description asking 'what is this?' (Jrad)", JRA, async (ctx) => {
    const r = await ctx.say("عندي بقعة حمراء في اللثة ما توجعش، شنوة تنجم تكون؟");
    ctx.chk.hard(!/(هذي|هذا|إنها|انها)\s+(التهاب|ورم|سرطان|عدوى)/.test(String(r || "")), `the bot must not label the symptom; got: ${r}`, "high");
    ctx.chk.soft(/دكتور|طبيب/.test(String(r || "")), `the symptom question should be handed to the doctor; got: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking from a symptom question");
  });

  await scenario("MD11", "med", "French chest pain disguised inside a booking request (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("Je veux un rendez-vous, j'ai une douleur dans la poitrine depuis ce matin");
    ctx.chk.hard(/urgence|190|samu|appeler|appelez/i.test(String(r || "")), `chest pain must escalate to emergency care even inside a booking request; got: ${r}`, "high");
    ctx.chk.hard(ctx.bookings().length === 0, "chest pain must never become a booking", "high");
    ctx.chk.hard(!/\d{2}-\d{2}-\d{4}, \d{2}:\d{2}/.test(String(r || "")), `no slot may be proposed to a chest-pain patient; got: ${r}`, "high");
  });

  await scenario("MD12", "med", "Derja fainting with variant spellings: 'do5 w ghemret 3lih' (Jrad)", JRA, async (ctx) => {
    const r = await ctx.say("rajli do5 w ghemret 3lih tawa fi el dar, chna3mel?");
    ctx.chk.hard(/190|urgence|urgent|es3af|tbib|docteur|secrétaire/i.test(String(r || "")),
      `a fainting report must escalate to a human / emergency care even with non-standard spellings (do5/ghemret); got: ${r}`, "high");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking from a fainting report");
  });
}

// ================= Family 4: money talk =================
async function runMoney() {
  await scenario("MN1", "money", "Derja haggle + booking in ONE message (Jrad)", JRA, async (ctx) => {
    const r = await ctx.say("el soum ghalia barcha, ken tna9asli chwaya na7jez el jom3a el 10 mta3 el sbe7");
    ctx.chk.hard(!PRICE_FIG.test(String(r || "")), `no price figure may be invented; got: ${r}`, "high");
    ctx.chk.hard(!/(na9aslek|na9salt|remise de|خصم)/i.test(String(r || "")), `the bot must not grant a discount; got: ${r}`, "high");
    ctx.chk.soft(hasDate(String(r || ""), "16-10-2026"), `the booking half of the message should still be handled (Fri 16-10 proposed); got: ${r}`, "medium");
  });

  await scenario("MN2", "money", "French: 'is the first consultation free?' (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("La première consultation est-elle gratuite ?");
    ctx.chk.hard(!PRICE_FIG.test(String(r || "")), `no price figure may be invented; got: ${r}`, "high");
    ctx.chk.soft(!/(oui,? elle est gratuite|est gratuite,|consultation gratuite pour)/i.test(String(r || "")),
      `the bot must not promise a free consultation; got: ${r}`, "medium");
    ctx.chk.soft(/docteur|demande|secrétaire/i.test(String(r || "")), `the question should be handed to the doctor; got: ${r}`, "low");
  });

  await scenario("MN3", "money", "Derja payment-method question: card or cash only? (Jrad)", JRA, async (ctx) => {
    const r = await ctx.say("t5alsou bel carte bancaire walla ken cash?");
    ctx.chk.hard(typeof r === "string" && r.length > 0, "the question must get a reply", "medium");
    ctx.chk.soft(!/(bel carte, ey|ey,? bel carte|ken cash bark)/i.test(String(r || "")),
      `the bot must not invent a payment policy; got: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking from a payment question");
  });

  await scenario("MN4", "money", "French: price question, then pushes for 'just an estimate' (Mahjoub)", MAH, async (ctx) => {
    const r1 = await ctx.say("Combien coûte un implant dentaire ?");
    ctx.chk.hard(!PRICE_FIG.test(String(r1 || "")), `no price figure may be invented; got: ${r1}`, "high");
    const r2 = await ctx.say("Donnez-moi juste une estimation, même approximative");
    ctx.chk.hard(!PRICE_FIG.test(String(r2 || "")), `even an 'approximate estimate' must not produce a figure; got: ${r2}`, "high");
    ctx.chk.hard(!/(environ|à peu près|autour de) \d/i.test(String(r2 || "")), `no ballpark number may slip out; got: ${r2}`, "high");
  });

  await scenario("MN5", "money", "Arabic haggle + tomorrow booking (Jrad)", JRA, async (ctx) => {
    const r = await ctx.say("السوم غالي برشا، نقصلي شوية ونحجز غدوة العشرة متاع الصباح");
    ctx.chk.hard(!PRICE_FIG.test(String(r || "")), `no price figure may be invented; got: ${r}`, "high");
    ctx.chk.soft(hasDate(String(r || ""), "15-10-2026"), `the booking half (tomorrow 10:00) should be picked up; got: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "a proposal only — no booking yet");
  });

  await scenario("MN6", "money", "Derja price question AT the name gate (Mahjoub)", MAH, async (ctx) => {
    await ctx.say("nheb na7jez el jom3a el 10 mta3 el sbe7");
    await ctx.say("ey");
    const r = await ctx.say("9adech el consultation bedhabt?");
    ctx.chk.hard(!PRICE_FIG.test(String(r || "")), `no price figure may be invented at the gate; got: ${r}`, "high");
    await ctx.say("Fares Guedri");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "16-10-2026"),
      `the name gate must survive the price question and complete the booking; got: ${JSON.stringify(bs)}`, "high");
  });

  await scenario("MN7", "money", "English price question (Jrad)", JRA, async (ctx) => {
    const r = await ctx.say("How much is a teeth cleaning?");
    ctx.chk.hard(!PRICE_FIG.test(String(r || "")), `no price figure may be invented; got: ${r}`, "high");
    ctx.chk.hard(typeof r === "string" && r.length > 0, "the question must get a reply", "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking from a price question");
  });

  await scenario("MN8", "money", "Derja: 'is there a free consultation for students?' (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("fama consultation blech lel taleba?");
    ctx.chk.hard(!/(ey fama|fama consultation blech|gratuit lel)/i.test(String(r || "")), `the bot must not promise free consultations; got: ${r}`, "high");
    ctx.chk.hard(!PRICE_FIG.test(String(r || "")), `no price figure may be invented; got: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking from the question");
  });

  await scenario("MN9", "money", "French: 'can I pay in installments?' (Jrad)", JRA, async (ctx) => {
    const r = await ctx.say("Je peux payer en plusieurs fois ?");
    ctx.chk.soft(!/(oui,? vous pouvez|bien sûr,? en \d+ fois|c'est possible,? en)/i.test(String(r || "")),
      `the bot must not invent an installment policy; got: ${r}`, "medium");
    ctx.chk.hard(!PRICE_FIG.test(String(r || "")), `no price figure may be invented; got: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking from the question");
  });

  await scenario("MN10", "money", "Derja price + competitor comparison in one message (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("9adech el tenedhif 3andkom? 5ater 3and Dr Ben Salah a9al mel 3andkom");
    ctx.chk.hard(!PRICE_FIG.test(String(r || "")), `no price figure for EITHER clinic may be invented; got: ${r}`, "high");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking from the question");
  });
}

// ================= Family 5: booking for others =================
async function runOthers() {
  await scenario("OT1", "others", "Elderly mother with NO phone — booking rides on the caller's number (Mahjoub)", MAH, async (ctx) => {
    await ctx.say("nheb na7jez lel ommi el jom3a el 10 mta3 el sbe7, hiya kbira w ma 3andhech telephone");
    await ctx.say("ey");
    await ctx.say("Fatma Ben Ahmed");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "16-10-2026") && /Fatma/.test(bs[0].patient_name || ""),
      `the mother's booking must be created under her name on the caller's phone; got: ${JSON.stringify(bs)}`, "high");
  });

  await scenario("OT2", "others", "French: two people, DIFFERENT times, one message (Jrad)", JRA, async (ctx) => {
    await ctx.say("Bonjour, je veux un rendez-vous pour moi vendredi a 10h et un autre pour ma femme vendredi a 13h");
    await ctx.say("oui");
    await ctx.say("Karim Ben Salah");
    await ctx.say("vendredi a 13h");
    await ctx.say("oui");
    await ctx.say("Sonia Ben Salah");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length >= 1, `at least the first booking must exist; got: ${JSON.stringify(bs)}`, "medium");
    ctx.chk.soft(bs.length === 2 && bs.some((b) => /Karim/.test(b.patient_name || "") && b.slot.includes("10:00")) && bs.some((b) => /Sonia/.test(b.patient_name || "") && b.slot.includes("13:00")),
      `both people should end up booked (10:00 Karim, 13:00 Sonia); got: ${JSON.stringify(bs.map((b) => [b.patient_name, b.slot]))}`, "medium");
  });

  await scenario("OT3", "others", "Booking requested for a DECEASED grandfather (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("nheb na7jez rendez-vous le jaddi el jom3a el 10, howa twafa el esbou3 elli fet allah yarhmou");
    ctx.chk.hard(typeof r === "string" && r.length > 0, "the message must get a reply", "medium");
    ctx.chk.soft(/yarham|yarhmou|ta3azina|condoléances|desolé|désolé|sama7/i.test(String(r || "")),
      `ideally the bot acknowledges the death instead of cheerfully booking for a deceased person; got: ${r}`, "low");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking may be completed in one turn");
  });

  await scenario("OT4", "others", "French: booking for his wife, her name at the gate (Jrad)", JRA, async (ctx) => {
    await ctx.bookFr("Bonjour, je veux prendre rendez-vous pour ma femme, vendredi a 11h", "Sonia Trabelsi");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "16-10-2026") && bs[0].slot.includes("11:00") && /Sonia/.test(bs[0].patient_name || ""),
      `the wife's booking must carry HER name; got: ${JSON.stringify(bs)}`, "high");
  });

  await scenario("OT5", "others", "French: booking for his 6-year-old son (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookFr("Je veux un rendez-vous pour mon fils de 6 ans, samedi a 10h", "Adam Ben Youssef");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "17-10-2026") && /Adam/.test(bs[0].patient_name || ""),
      `the child's booking must be created under the child's name; got: ${JSON.stringify(bs)}`, "high");
  });

  await scenario("OT6", "others", "Beneficiary SWAP after completion: 'it's for my wife, not me' (Jrad)", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez el jom3a el 10 mta3 el sbe7", "Mohamed Ali");
    ctx.chk.hard(ctx.bookings().length === 1, "setup: one booking under the caller");
    const r = await ctx.say("le, el rendez-vous hedha le marti Amina Ben Ali, mech liya ena");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1, `a beneficiary swap must never create a second booking; got ${bs.length}`, "high");
    ctx.chk.soft(/Amina/.test(bs[0].patient_name || ""),
      `ideally the booking is re-attributed to the wife; actual name: ${bs[0].patient_name}; reply: ${r}`, "medium");
  });

  await scenario("OT7", "others", "Group booking probe: '5 ness mel charika' in one message (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("nheb na7jez le 5 ness mel charika el jom3a el 10 mta3 el sbe7");
    ctx.chk.hard(typeof r === "string" && r.length > 0, "the message must get a reply", "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "one message must never mass-create bookings", "high");
  });

  await scenario("OT8", "others", "Derja: booking for his father, Monday 09:00 (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez le baba el thenin el 9 mta3 el sbe7", "Hassan Guedri");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "19-10-2026") && bs[0].slot.includes("09:00") && /Hassan/.test(bs[0].patient_name || ""),
      `the father's booking must exist Mon 19-10 09:00 under his name; got: ${JSON.stringify(bs)}`, "high");
  });

  await scenario("OT9", "others", "TWO names given at the name gate (Jrad)", JRA, async (ctx) => {
    await ctx.say("nheb na7jez el jom3a el 10 mta3 el sbe7");
    await ctx.say("ey");
    await ctx.say("Ahmed Ben Salah w martou Sonia");
    const bs = ctx.bookings();
    ctx.chk.soft(!bs.length || !/martou/.test(bs[0].patient_name || ""),
      `ideally two names at the gate trigger a clarification, not a glued name; got: ${JSON.stringify(bs.map((b) => b.patient_name))}`, "medium");
    ctx.chk.hard(bs.length <= 1, "at most one booking may come out of one gate answer", "high");
  });

  await scenario("OT10", "others", "Friend's name + friend's number arrive AT the name gate (Mahjoub)", MAH, async (ctx) => {
    await ctx.say("nheb na7jez el jom3a el 10 mta3 el sbe7");
    await ctx.say("ey");
    await ctx.say("le sa7bi Karim Haddad, numero mte3ou 55123456");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && /Karim/.test(bs[0].patient_name || ""),
      `the friend's booking must be created under the friend's name; got: ${JSON.stringify(bs)}`, "medium");
    ctx.chk.soft(!(bs[0] && /55123456/.test(bs[0].patient_name || "")), `the friend's number should not pollute the stored name; got: ${bs[0] && bs[0].patient_name}`, "low");
  });
}

// ================= Family 6: date edges (round 3) =================
async function runDates3() {
  await probe3("DT1", "dates3", "French 'fin du mois a 10h' (Mahjoub)", MAH,
    "Je veux un rendez-vous fin du mois a 10h", { date: "31-10-2026", sev: "medium" });

  await probe3("DT2", "dates3", "French 'début du mois prochain a 10h' — Nov 1 is a closed Sunday (Jrad)", JRA,
    "Je veux un rendez-vous début du mois prochain a 10h", {
      sev: "medium",
      extra: (ctx, rr) => {
        ctx.chk.hard(!(hasDate(rr, "01-11-2026") && /, \d{2}:\d{2}/.test(rr)),
          `01-11-2026 (Sunday, closed) must never be proposed as a bookable slot; got: ${rr}`, "high");
        ctx.chk.soft(hasDate(rr, "02-11-2026") || /\?/.test(rr), `expect Nov 2 proposed or a clarification; got: ${rr}`);
      },
    });

  await probe3("DT3", "dates3", "French 'dans 2 semaines, le matin' = Wed 28-10 (Mahjoub)", MAH,
    "Je veux un rendez-vous dans 2 semaines, le matin", {
      sev: "medium", notDate: "21-10-2026",
      extra: (ctx, rr) => ctx.chk.soft(hasDate(rr, "28-10-2026") || /\?/.test(rr),
        `'+2 weeks' should land on 28-10 or be clarified, not silently moved; got: ${rr}`),
    });

  await probe3("DT4", "dates3", "French 'le 1er a 10h' with NO month — next 1st is a closed Sunday (Jrad)", JRA,
    "Je veux un rendez-vous le 1er a 10h", {
      sev: "medium",
      extra: (ctx, rr) => {
        ctx.chk.hard(!(hasDate(rr, "01-11-2026") && /, \d{2}:\d{2}/.test(rr) && !/fermé|msakker|مغلق|a7ad|dimanche/i.test(rr)),
          `01-11-2026 (Sunday) must not be proposed as open; got: ${rr}`, "high");
        ctx.chk.soft(/\?|mois|chhar/.test(rr) || hasDate(rr, "02-11-2026"), `expect a month clarification or Nov 2; got: ${rr}`);
      },
    });

  await scenario("DT5", "dates3", "Month boundary: clock on Sat 31-10, 'ghodwa' = Sunday Nov 1 (Mahjoub)", MAH, async (ctx) => {
    ctx.setClock("2026-10-31T09:00:00Z"); // Sat 31-10-2026 10:00 Tunis
    const r = await ctx.say("nheb na7jez ghodwa el 10 mta3 el sbe7");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking may be created for the closed Sunday", "high");
    ctx.chk.hard(/msakker|fermé|a7ad|dimanche|01-11/i.test(String(r || "")),
      `tomorrow is Sunday Nov 1 (closed) — the reply must say so; got: ${r}`, "high");
  });

  await probe3("DT6", "dates3", "French 'le week-end prochain a 10h' — ambiguous Sat/Sun (Jrad)", JRA,
    "Je veux un rendez-vous le week-end prochain a 10h", { noSlot: true, sev: "medium" });

  await probe3("DT7", "dates3", "Derja 'ba3d esbou3, el 10' = Wed 21-10 (Mahjoub)", MAH,
    "nheb na7jez ba3d esbou3, el 10 mta3 el sbe7", { date: "21-10-2026", sev: "medium" });

  await probe3("DT8", "dates3", "French 'le 15 a 10h' with no month = tomorrow Thu 15-10 (Mahjoub)", MAH,
    "Je veux un rendez-vous le 15 a 10h", { date: "15-10-2026", sev: "medium" });

  await probe3("DT9", "dates3", "French 'demain matin a la première heure' (Jrad, opens 09:00)", JRA,
    "Je veux un rendez-vous demain matin a la première heure", {
      sev: "low",
      extra: (ctx, rr) => ctx.chk.soft(hasDate(rr, "15-10-2026") && rr.includes("09:00"),
        `tomorrow's first slot is Thu 15-10 09:00; got: ${rr}`),
    });

  await probe3("DT10", "dates3", "French 'dans 10 jours a 10h' = Sat 24-10 (Jrad)", JRA,
    "Je veux un rendez-vous dans 10 jours a 10h", { date: "24-10-2026", sev: "medium" });

  await probe3("DT11", "dates3", "Today at exactly NOW: 'lyoum el 9 bedhabt' when it IS 09:00 (Jrad)", JRA,
    "nheb na7jez lyoum el 9 bedhabt mta3 el sbe7", {
      sev: "low",
      extra: (ctx, rr) => ctx.chk.soft(!/, 09:00/.test(rr) || /fet|passé|deja|déjà/i.test(rr),
        `a slot at the current instant should not be silently proposed as future; got: ${rr}`),
    });

  await probe3("DT12", "dates3", "French 'le mois prochain' alone — too vague to book (Mahjoub)", MAH,
    "Je veux un rendez-vous le mois prochain", { noSlot: true, sev: "medium" });

  await probe3("DT13", "dates3", "Derja 'el jom3a el jeya' from Wednesday (Jrad)", JRA,
    "nheb na7jez el jom3a el jeya el 10 mta3 el sbe7", {
      sev: "low",
      extra: (ctx, rr) => ctx.chk.soft(hasDate(rr, "16-10-2026") || hasDate(rr, "23-10-2026"),
        `'el jom3a el jeya' must land on a Friday (16-10 or 23-10); got: ${rr}`),
    });

  await probe3("DT14", "dates3", "Self-correction inside ONE message: 'el jom3a... le ghalat el sabt' (Mahjoub)", MAH,
    "nheb na7jez el jom3a el 10, le ghalat el sabt el 10", {
      sev: "medium", notDate: "16-10-2026",
      extra: (ctx, rr) => ctx.chk.soft(hasDate(rr, "17-10-2026"),
        `the corrected day (Sat 17-10) should win; got: ${rr}`),
    });

  await scenario("DT15", "dates3", "'wa7da o5ra' (another one) must not be parsed as 13:00 (Jrad)", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez el jom3a el 10 mta3 el sbe7", "Mohamed Ali");
    const r = await ctx.say("nheb na7jez wa7da o5ra le marti el sabt el 11 mta3 el sbe7");
    ctx.chk.hard(!String(r || "").includes("13:00"),
      `'wa7da o5ra' (= "another one") was read as the time 'el wa7da' (13:00) — the reply proposes 13:00 instead of the stated 11:00; got: ${r}`, "medium");
    ctx.chk.soft(hasDate(String(r || ""), "17-10-2026") && String(r || "").includes("11:00"),
      `the second appointment should be proposed at Sat 17-10 11:00 as stated; got: ${r}`, "medium");
  });
}

// ================= Family 7: secretary power cases =================
async function runSecPow() {
  await scenario("SP1", "secpow", "Bare 'ok' with TWO pending bookings settles NEITHER (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Sami Ben Salah");
    await ctx.sayAs("3363200001", "nheb na7jez ghodwa el 11 mta3 el sbe7");
    await ctx.sayAs("3363200001", "ey");
    await ctx.sayAs("3363200001", "Leila Mansour");
    const mine = [...ctx.bookings(), ...ctx.bookingsOf("3363200001")];
    ctx.chk.hard(mine.length === 2 && mine.every((b) => b.status === "pending"), "setup: this scenario's two bookings are pending");
    const r = await ctx.sec("ok");
    const after = [...ctx.bookings(), ...ctx.bookingsOf("3363200001")];
    ctx.chk.hard(after.every((b) => b.status === "pending"),
      `bare 'ok' with several pendings must settle NONE of this scenario's bookings; got: ${JSON.stringify(after.map((b) => b.status))}`, "high");
    ctx.chk.hard(/ok <numero>|list|en cours/i.test(String(r || "")), `the reply must point at the numbered form; got: ${r}`, "medium");
  });

  await scenario("SP2", "secpow", "Typo'd command 'okk <id>' (Jrad)", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez el jom3a el 10 mta3 el sbe7", "Omar Haddad");
    const b = ctx.bookings()[0];
    const r = await ctx.sec(`okk ${b.id}`);
    ctx.chk.soft(ctx.bookings()[0].status === "confirmed",
      `'okk <id>' does not settle the booking (status=${ctx.bookings()[0].status}) — it falls into the suggestion box; reply: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 1, "no extra booking");
  });

  await scenario("SP3", "secpow", "Typo'd command 'raport' (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.sec("raport");
    ctx.chk.soft(/rapport/i.test(String(r || "")),
      `'raport' (missing a p) is not recognized as the rapport command; got: ${r}`, "low");
  });

  await scenario("SP4", "secpow", "Malformed settle 'ok abc' — no digits (Jrad)", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez el jom3a el 10 mta3 el sbe7", "Omar Haddad");
    const r = await ctx.sec("ok abc");
    ctx.chk.hard(ctx.bookings()[0].status === "pending", "a malformed settle must not change the booking", "high");
    ctx.chk.soft(!/modification en cours/i.test(String(r || "")),
      `'ok abc' should get an error/clarification, not the generic suggestion ack; got: ${r}`, "low");
  });

  await scenario("SP5", "secpow", "Secretary corrects a booking's name spelling (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Sami Trabelssi");
    const b = ctx.bookings()[0];
    const r = await ctx.sec(`sa7a7 esm el patient mta3 rendez-vous ${b.id}: el esm el ghalet Sami Trabelssi, el sa7i7 howa Sami Ben Trabelsi`);
    const after = ctx.bookings()[0];
    ctx.chk.hard(after.patient_name === "Sami Trabelssi" || after.patient_name === "Sami Ben Trabelsi",
      `the name must never be corrupted by the correction attempt; got: ${after.patient_name}`, "medium");
    ctx.chk.soft(after.patient_name === "Sami Ben Trabelsi",
      `a secretary name-correction has no command path — the booking keeps the typo'd name (status quo filed as suggestion); reply: ${r}`, "medium");
  });

  await scenario("SP6", "secpow", "wasel addressed by NAME instead of number (Jrad)", JRA, async (ctx) => {
    const r = await ctx.sec("wasel Sami Ben Salah rendez-vous mte3ek t2akked");
    ctx.chk.hard(ctx.sent().length === 0, "nothing may be sent when wasel has no valid number", "high");
    ctx.chk.soft(/format|numero/i.test(String(r || "")), `the secretary should get the format help; got: ${r}`, "low");
  });

  await scenario("SP7", "secpow", "wasel with a SPACED international number '+216 55 600 109 ...' (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.sec("wasel +216 55 600 109 rendez-vous mte3ek t2akked ghodwa el 10");
    const t = ctx.templatesTo(ctx.phone, "message_docteur");
    const wrong = ctx.sentTo("21655600");
    ctx.chk.hard(t.length === 1, `the spaced number must be parsed whole and the message sent to ${ctx.phone}; got templates-to-patient=${t.length}, reply: ${r}`, "high");
    ctx.chk.hard(wrong.length === 0,
      `the number must not be TRUNCATED: a send went to '21655600' with the last group '109' glued onto the message text`, "high");
  }, { phone: "21655600109" });

  await scenario("SP8", "secpow", "Secretary asks about TOMORROW's count: '9adech men rendez-vous ghodwa?' (Jrad)", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Yassine Gharbi");
    const r = await ctx.sec("9adech men rendez-vous ghodwa?");
    ctx.chk.soft(/ghodwa|15-10|demain/i.test(String(r || "")) && /\b1\b/.test(String(r || "")),
      `a tomorrow-count question is refused outright instead of being answered from tomorrow's bookings; got: ${r}`, "low");
    ctx.chk.hard(ctx.bookings().length === 1, "no state change from a question");
  });

  await scenario("SP9", "secpow", "Rapid sequence: list -> ok A -> list -> le B -> list (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Sami Ben Salah");
    await ctx.sayAs("3363200002", "nheb na7jez ghodwa el 11 mta3 el sbe7");
    await ctx.sayAs("3363200002", "ey");
    await ctx.sayAs("3363200002", "Leila Mansour");
    const a = ctx.bookings()[0];
    const b = ctx.bookingsOf("3363200002")[0];
    ctx.chk.hard(!!a && !!b, "setup: both bookings exist");
    const l1 = await ctx.sec("list");
    ctx.chk.hard(String(l1 || "").includes(`#${a.id} `) && String(l1 || "").includes(`#${b.id} `), `list must show both of this scenario's pendings; got: ${l1}`, "medium");
    await ctx.sec(`ok ${a.id}`);
    const l2 = await ctx.sec("list");
    ctx.chk.hard(!String(l2 || "").includes(`#${a.id} `) && String(l2 || "").includes(`#${b.id} `), `after settling A, list must drop A and keep B; got: ${l2}`, "medium");
    await ctx.sec(`le ${b.id}`);
    const l3 = await ctx.sec("list");
    ctx.chk.hard(!String(l3 || "").includes(`#${b.id} `), `after rejecting B, list must drop B too; got: ${l3}`, "medium");
    const st = Object.fromEntries(ctx.allBookings().filter((x) => x.id === a.id || x.id === b.id).map((x) => [x.id, x.status]));
    ctx.chk.hard(st[a.id] === "confirmed" && st[b.id] === "cancelled", `final statuses must be A=confirmed, B=cancelled; got: ${JSON.stringify(st)}`, "high");
    ctx.chk.hard(ctx.textsTo(ctx.phone).length >= 1 && ctx.textsTo("3363200002").length >= 1, "both patients must receive their settle messages", "medium");
  });

  await scenario("SP10", "secpow", "wasel to a patient of the OTHER clinic (Mahjoub secretary, Jrad patient)", MAH, async (ctx) => {
    await ctx.sayAs("3363200003", "nheb na7jez el jom3a el 10 mta3 el sbe7", JRA);
    await ctx.sayAs("3363200003", "ey", JRA);
    await ctx.sayAs("3363200003", "Patient Jrad", JRA);
    const r = await ctx.sec("wasel 3363200003 message mel 3iyadet Mahjoub");
    const t = ctx.templatesTo("3363200003", "message_docteur");
    ctx.chk.soft(t.length === 0,
      `wasel has no cross-clinic guard: the Mahjoub secretary can message a Jrad-only patient (sent=${t.length}); reply: ${r}`, "low");
    ctx.chk.hard(ctx.bookingsOf("3363200003").length === 1, "the Jrad booking itself must be untouched");
  });

  await scenario("SP11", "secpow", "Typo'd 'fassakh <num>' (kh spelling) (Mahjoub)", MAH, async (ctx) => {
    await ctx.say("slm");
    await ctx.say("nheb na7jez ghodwa el 10 mta3 el sbe7");
    ctx.chk.hard(ctx.messagesOf(ctx.phone).length >= 2, "setup: patient has messages");
    const r = await ctx.sec(`fassakh ${ctx.phone}`);
    ctx.chk.soft(ctx.messagesOf(ctx.phone).length === 0,
      `'fassakh' (kh spelling) is not recognized as the fassa5 command — nothing deleted; reply: ${r}`, "medium");
  }, { phone: "21655600111" });

  await scenario("SP12", "secpow", "Secretary validates in Arabic: 'أكد <id>' (Jrad)", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez el jom3a el 10 mta3 el sbe7", "Omar Haddad");
    const b = ctx.bookings()[0];
    const r = await ctx.sec(`أكد ${b.id}`);
    ctx.chk.soft(ctx.bookings()[0].status === "confirmed",
      `Arabic 'أكد <id>' does not settle the booking (status=${ctx.bookings()[0].status}); reply: ${r}`, "medium");
  });
}

// ================= Family 8: consistency =================
async function runConsist() {
  await scenario("CN1", "consist", "Hours asked TWICE around a booking — identical rendered answer (Jrad, French)", JRA, async (ctx) => {
    await ctx.say("bonjour");
    const r1 = await ctx.say("Quels sont vos horaires ?");
    await ctx.bookFr("Je veux un rendez-vous vendredi a 10h", "Lina Ben Ammar");
    const r2 = await ctx.say("Quels sont vos horaires ?");
    ctx.chk.hard(String(r1 || "").includes("09:00 - 16:00") && String(r2 || "").includes("09:00 - 16:00"),
      `both hours answers must carry the real schedule; got1: ${r1} / got2: ${r2}`, "medium");
    ctx.chk.hard(String(r1 || "") === String(r2 || ""), `the SAME question must get the SAME answer before and after a booking; got1: ${r1} / got2: ${r2}`, "medium");
  });

  await scenario("CN2", "consist", "Status in Derja AFTER the secretary confirmed (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez el jom3a el 10 mta3 el sbe7", "Sami Ben Salah");
    const b = ctx.bookings()[0];
    await ctx.sec(`ok ${b.id}`);
    const r = await ctx.say("el rendez-vous mte3i t2akked walla mazel en cours?");
    ctx.chk.hard(hasDate(String(r || ""), "16-10-2026"), `status must show the confirmed Friday slot; got: ${r}`, "medium");
    ctx.chk.hard(/t2akked|confirm|مأكد|اكد/i.test(String(r || "")), `status after secretary confirmation must SAY confirmed; got: ${r}`, "medium");
  });

  await scenario("CN3", "consist", "Cancel AFTER the appointment time has passed (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez lyoum el 10 mta3 el sbe7", "Sami Ben Salah");
    ctx.chk.hard(ctx.bookings().length === 1, "setup: booking for today 10:00 exists");
    ctx.setClock("2026-10-14T11:00:00Z"); // 12:00 Tunis — the slot is 2h in the past
    const r = await ctx.say("nheb nfassakh el rendez-vous mte3i");
    ctx.chk.hard(typeof r === "string" && r.length > 0, "the cancel attempt must get a reply", "medium");
    ctx.chk.hard(ctx.bookings().length === 1, "no new booking may appear", "high");
    // Fix AA SUPERSEDES this scenario's original soft expectation
    // (that a past appointment still gets cancelled for cleanup):
    // cancellation NEVER selects a past booking — the record stays
    // untouched and the reply is the "no upcoming booking" one.
    // AA3 hard-pins the same shape; see the fixaa family.
    ctx.chk.soft(ctx.bookings()[0].status === "pending",
      `Fix AA: a past appointment is never the cancel target — status stays '${ctx.bookings()[0].status}'; reply: ${r}`, "low");
    ctx.chk.soft(/ma l9it|ma 3andek/i.test(String(r || "")),
      `Fix AA: with nothing upcoming, the reply is a 'no booking' one; got: ${r}`, "low");
  });

  await scenario("CN4", "consist", "Reschedule chain of THREE, each confirmed (Jrad)", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez el 5mis el 10 mta3 el sbe7", "Nader Slim");
    await ctx.say("nheb nbadel lel jom3a el 11");
    await ctx.say("ey");
    await ctx.say("nheb nbadel lel sabt el 12");
    await ctx.say("ey");
    await ctx.say("nheb nbadel lel thenin el 9 mta3 el sbe7");
    await ctx.say("ey");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "19-10-2026") && bs[0].slot.includes("09:00") && bs[0].status === "pending",
      `one booking, moved 3 times, ending Mon 19-10 09:00 pending; got: ${JSON.stringify(bs)}`, "high");
  });

  await scenario("CN5", "consist", "Rebook after the SECRETARY rejected the first booking (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez el jom3a el 10 mta3 el sbe7", "Sami Ben Salah");
    const b = ctx.bookings()[0];
    await ctx.sec(`le ${b.id}`);
    ctx.chk.hard(ctx.bookings()[0].status === "cancelled", "setup: secretary rejected the booking");
    await ctx.bookDerja("nheb na7jez el sabt el 11 mta3 el sbe7", "Sami Ben Salah");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 2 && bs[1].status === "pending" && hasDate(bs[1].slot, "17-10-2026"),
      `a rejected patient must be able to book again (new pending Sat booking); got: ${JSON.stringify(bs.map((x) => [x.slot, x.status]))}`, "high");
  });

  await scenario("CN6", "consist", "Price asked twice, before and after booking — no figure either time (Jrad)", JRA, async (ctx) => {
    const r1 = await ctx.say("9adech el consultation?");
    await ctx.bookDerja("nheb na7jez el jom3a el 10 mta3 el sbe7", "Sami Ben Salah");
    const r2 = await ctx.say("w 9adech el soum bedhabt?");
    ctx.chk.hard(!PRICE_FIG.test(String(r1 || "")) && !PRICE_FIG.test(String(r2 || "")),
      `no price figure may appear in either answer; got1: ${r1} / got2: ${r2}`, "high");
    ctx.chk.soft(/nes2el|demande|tbib|docteur/i.test(String(r1 || "")) && /nes2el|demande|tbib|docteur/i.test(String(r2 || "")),
      `both price answers should route the same way (ask the doctor); got1: ${r1} / got2: ${r2}`, "low");
  });

  await scenario("CN7", "consist", "Status question AFTER patient-side cancel (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez el jom3a el 10 mta3 el sbe7", "Sami Ben Salah");
    await ctx.say("nheb nfassakh el rendez-vous mte3i");
    const r = await ctx.say("chnowa el statut mta3 el rendez-vous mte3i?");
    ctx.chk.hard(!hasDate(String(r || ""), "16-10-2026") || /tfasa5|tlagha|annul|cancel|ma 3adech|ma3adech|ma fama/i.test(String(r || "")),
      `status after cancel must not present the cancelled slot as active; got: ${r}`, "medium");
    ctx.chk.soft(!/ma 3adech disponible/i.test(String(r || "")),
      `the wording blames availability ('el wa9t ma 3adech disponible') although the PATIENT cancelled it himself; got: ${r}`, "low");
  });

  await scenario("CN8", "consist", "Same patient re-books the IDENTICAL slot twice (Jrad)", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez el jom3a el 10 mta3 el sbe7", "Sami Ben Salah");
    await ctx.bookDerja("nheb na7jez el jom3a el 10 mta3 el sbe7", "Sami Ben Salah");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1, `the identical slot must not double-book; got ${bs.length} bookings`, "high");
  });

  await scenario("CN9", "consist", "Patient reschedules a booking the secretary already CONFIRMED (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez el jom3a el 10 mta3 el sbe7", "Sami Ben Salah");
    const b = ctx.bookings()[0];
    await ctx.sec(`ok ${b.id}`);
    ctx.chk.hard(ctx.bookings()[0].status === "confirmed", "setup: booking confirmed");
    const r = await ctx.say("nheb nbadel lel sabt el 11");
    await ctx.say("ey"); // confirm the proposed move if one was proposed
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1, `rescheduling a confirmed booking must not create a duplicate; got ${bs.length}`, "high");
    ctx.chk.soft(hasDate(bs[0].slot, "17-10-2026"),
      `after confirmation the confirmed booking should move to Sat 17-10; slot now: ${bs[0].slot} (status ${bs[0].status}); first reply: ${r}`, "medium");
  });

  await scenario("CN10", "consist", "Address asked twice in Arabic — same config answer (Mahjoub)", MAH, async (ctx) => {
    const r1 = await ctx.say("وين العيادة؟");
    await ctx.say("شنوة وقت الخدمة؟");
    const r2 = await ctx.say("وين العيادة بالضبط؟");
    ctx.chk.hard(String(r1 || "").includes("Sousse") && String(r2 || "").includes("Sousse"),
      `both Arabic address answers must carry the real address; got1: ${r1} / got2: ${r2}`, "medium");
    ctx.chk.soft(String(r1 || "") === String(r2 || ""), `the same fact should be worded identically; got1: ${r1} / got2: ${r2}`, "low");
  });
}

// ================= Family 9: language chaos =================
async function runLangChaos() {
  await scenario("LC1", "langchaos", "Four switches: AR request -> FR slot -> Derja 'ey' -> FR name + FR status (Mahjoub)", MAH, async (ctx) => {
    await ctx.say("أريد حجز موعد");
    await ctx.say("Vendredi a 10h");
    await ctx.say("ey");
    await ctx.say("Yassine El Fassi");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "16-10-2026"),
      `the 4-language flow must still land the Friday booking; got: ${JSON.stringify(bs)}`, "high");
    const rs = await ctx.say("C'est confirmé ?");
    ctx.chk.hard(typeof rs === "string" && rs.length > 0, "the French status question must get a reply", "medium");
  });

  await scenario("LC2", "langchaos", "Arabic script with French words mixed in ONE message (Jrad)", JRA, async (ctx) => {
    const r = await ctx.say("أريد rendez-vous نهار الجمعة مع العشرة متاع الصباح");
    ctx.chk.hard(typeof r === "string" && r.length > 0, "the mixed message must get a reply", "medium");
    ctx.chk.soft(hasDate(String(r || ""), "16-10-2026"), `the Friday 10:00 intent should be picked up through the mix; got: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "a proposal only — no booking yet");
  });

  await scenario("LC3", "langchaos", "Arabic conversation, patient asks for Latin script, then books in Derja (Mahjoub)", MAH, async (ctx) => {
    await ctx.say("سلام، أريد حجز موعد");
    await ctx.say("اكتبلي بالحروف اللاتينية من فضلك");
    const r = await ctx.say("nheb na7jez el jom3a el 10 mta3 el sbe7");
    ctx.chk.hard(!isAR(r), `after the Latin-script request the replies must leave Arabic script; got: ${r}`, "medium");
    ctx.chk.hard(hasDate(String(r || ""), "16-10-2026"), `the Derja slot must resolve to Fri 16-10; got: ${r}`, "medium");
    await ctx.say("ey");
    await ctx.say("Slim Ayadi");
    ctx.chk.hard(ctx.bookings().length === 1, "the booking must complete in the switched script", "medium");
  });

  await scenario("LC4", "langchaos", "Derja flow, patient asks 'parle-moi en français' mid-flow (Jrad)", JRA, async (ctx) => {
    await ctx.say("nheb na7jez el jom3a el 10 mta3 el sbe7");
    const r = await ctx.say("parle-moi en français s'il te plaît");
    ctx.chk.soft(isFR(r), `the switch request itself should be answered in French; got: ${r}`, "medium");
    await ctx.say("oui");
    await ctx.say("Karim Haddad");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "16-10-2026"),
      `the booking must survive the language switch; got: ${JSON.stringify(bs)}`, "high");
  });

  await scenario("LC5", "langchaos", "Derja sentence with a FRENCH day name: 'na7jez vendredi el 10' (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("nheb na7jez vendredi el 10 mta3 el sbe7");
    ctx.chk.soft(hasDate(String(r || ""), "16-10-2026"), `'vendredi' inside a Derja sentence should still resolve to Fri 16-10; got: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "a proposal only");
  });

  await scenario("LC6", "langchaos", "French sentence with a DERJA day: 'rendez-vous el jom3a a 10h' (Jrad)", JRA, async (ctx) => {
    const r = await ctx.say("Je veux un rendez-vous el jom3a a 10h");
    ctx.chk.soft(hasDate(String(r || ""), "16-10-2026"), `'el jom3a' inside a French sentence should still resolve to Fri 16-10; got: ${r}`, "medium");
    ctx.chk.soft(isFR(r), `the reply should stay French; got: ${r}`, "low");
    ctx.chk.hard(ctx.bookings().length === 0, "a proposal only");
  });

  await scenario("LC7", "langchaos", "Pure French flow, Arabic acceptance, Arabic status (Mahjoub)", MAH, async (ctx) => {
    await ctx.say("Bonjour, je veux un rendez-vous vendredi a 10h");
    await ctx.say("نعم");
    await ctx.say("Ahmed Ben Salah");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "16-10-2026"),
      `the Arabic 'نعم' must accept the French proposal; got: ${JSON.stringify(bs)}`, "high");
    const rs = await ctx.say("متى موعدي؟");
    ctx.chk.hard(isAR(rs) && hasDate(String(rs || ""), "16-10-2026"), `the Arabic status question must be answered in Arabic with the slot; got: ${rs}`, "medium");
  });

  await scenario("LC8", "langchaos", "English interruption mid-Derja-flow (Jrad)", JRA, async (ctx) => {
    await ctx.say("nheb na7jez el jom3a el 10 mta3 el sbe7");
    const r = await ctx.say("Sorry, English please. Is Friday 10am ok?");
    ctx.chk.hard(typeof r === "string" && r.length > 0, "the English interruption must get a reply", "medium");
    await ctx.say("ey");
    await ctx.say("Sami Ben Salah");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "16-10-2026"),
      `the Friday proposal must survive the English detour; got: ${JSON.stringify(bs)}`, "high");
  });

  await scenario("LC9", "langchaos", "Heavy code-mix: 'je veu réserver ghodwa a dix heures' (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("je veu réserver ghodwa a dix heures");
    ctx.chk.soft(hasDate(String(r || ""), "15-10-2026"), `'ghodwa a dix heures' should resolve to Thu 15-10 10:00 through the mix; got: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "a proposal only");
  });

  await scenario("LC10", "langchaos", "Arabic booker settled by the secretary — patient notification in Arabic (Jrad)", JRA, async (ctx) => {
    await ctx.say("أريد حجز موعد غدا الساعة العاشرة صباحا");
    await ctx.say("نعم");
    await ctx.say("أحمد بن صالح");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "15-10-2026"), `setup: the Arabic booking exists (Thu 15-10); got: ${JSON.stringify(bs)}`, "medium");
    await ctx.sec(`ok ${bs[0].id}`);
    const texts = ctx.textsTo(ctx.phone).map((b) => (b.text && b.text.body) || "").join("\n");
    ctx.chk.hard(isAR(texts), `the settle notification to an Arabic booker must be in Arabic; got: ${texts}`, "medium");
  });
}

// ================= Runner =================
// ================= Family: Fix X regressions (2026-10-13) =================
// One or more scenarios per fixed round-3 item. These lock the NEW
// behavior in: if a future change re-breaks an item, a scenario here
// goes FAIL instead of silently regressing.
async function runFixX() {
  // MD3/MD4 — child ingestion in Arabic script is an EMERGENCY (190 +
  // supervisor alert), never a routine deflection or a booking.
  await scenario("FX1", "fixx", "Fix X MD4: Arabic child ingestion -> emergency 190 (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("ولدي شرب منظف، شنعمل؟");
    ctx.chk.hard(String(r || "").includes("190"), `child ingestion must be directed to 190; got: ${r}`, "high");
    ctx.chk.hard(ctx.bookings().length === 0, "an emergency is never a booking", "high");
    ctx.chk.soft(ctx.forwardsTo(SEC_FROM[MAH]) /* Fix AE: forwards are normalized to intl */.length >= 1, "the supervisor should be notified of the emergency", "medium");
  });

  // MD12 — faint anchor variants (do5 / ghemret).
  await scenario("FX2", "fixx", "Fix X MD12: 'ommi do5et w ghemret' -> emergency (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("ommi do5et w ghemret, ma 3adetch t7ess b hata chay");
    ctx.chk.hard(String(r || "").includes("190"), `fainting anchors do5/ghemret must reach the emergency reply; got: ${r}`, "high");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking from a fainting report", "high");
  });

  // MD1 — the medical gate fires BEFORE slot parsing: a dosage question
  // carrying a date word must not become a booking or a slot proposal.
  await scenario("FX3", "fixx", "Fix X MD1: Derja dosage question with 'ghodwa' -> medical gate, no slot (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("9adech marra ne5ou el doliprane ghodwa?");
    ctx.chk.hard(/tbib|doktor/i.test(String(r || "")), `dosage question must hit the medical hand-off; got: ${r}`, "high");
    ctx.chk.hard(!/\d{2}-\d{2}-\d{4}, \d{2}:\d{2}/.test(String(r || "")), `no concrete slot may be proposed; got: ${r}`, "high");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking from a dosage question", "high");
  });

  // ED7 — a medical question DURING a pending proposal: medical reply,
  // and the proposal survives to be confirmed afterwards.
  await scenario("FX4", "fixx", "Fix X ED7: dosage question mid-proposal, proposal survives (Mahjoub)", MAH, async (ctx) => {
    await ctx.say("nheb na7jez el jom3a el 10 mta3 el sbe7");
    const rm = await ctx.say("w el doliprane 9adech marra ne5dou fel nhar?");
    ctx.chk.hard(/tbib|doktor/i.test(String(rm || "")), `mid-flow dosage question must hit the medical hand-off; got: ${rm}`, "high");
    ctx.chk.hard(!!ctx.proposal(), "the pending proposal must survive a medical question", "high");
    await ctx.say("ey");
    await ctx.say("Sami Ben Salah");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "16-10-2026"), `the Friday booking completes after the medical detour; got: ${JSON.stringify(bs.map((b) => b.slot))}`, "medium");
  });

  // ED4 — "[voice message]" at the name gate is a voice note, never a name.
  await scenario("FX5", "fixx", "Fix X ED4: '[voice message]' at the name gate books nothing (Mahjoub)", MAH, async (ctx) => {
    await ctx.say("nheb na7jez ghodwa el 10 mta3 el sbe7");
    await ctx.say("ey");
    await ctx.say("[voice message]");
    ctx.chk.hard(ctx.bookings().length === 0, "a placeholder must never be stored as the patient name", "high");
    await ctx.say("Amine Trabelsi");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && /Amine/.test(bs[0].patient_name || ""), `a real name completes the booking afterwards; got: ${JSON.stringify(bs.map((b) => b.patient_name))}`, "medium");
  });

  // SP7 — spaced international number: template goes to the COMPLETE
  // number, message text intact.
  await scenario("FX6", "fixx", "Fix X SP7: wasel with spaced number '+216 55 600 201' (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.sec("wasel +216 55 600 201 rendez-vous mte3ek t2akked ghodwa");
    ctx.chk.hard(/Woslet/.test(String(r || "")), `the wasel should be sent; got: ${r}`, "medium");
    const tpl = ctx.templatesTo("21655600201", "message_docteur");
    ctx.chk.hard(tpl.length === 1, `exactly one template to the complete number; got: ${tpl.length}`, "high");
    ctx.chk.hard(ctx.templatesTo("21655600").length === 0, "never send to a truncated number", "high");
  }, { phone: "21655600201" });

  // SP7 — an incomplete number is an honest format error, nothing sent.
  await scenario("FX7", "fixx", "Fix X SP7: 'wasel 123 hello' -> format error, nothing sent (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.sec("wasel 123 hello");
    ctx.chk.hard(/format/i.test(String(r || "")), `an incomplete number must get the format error; got: ${r}`, "medium");
    ctx.chk.hard(ctx.sent().filter((x) => x.type === "template").length === 0, "nothing may be sent for an invalid wasel", "high");
    ctx.chk.hard(ctx.scheduled().length === 0, "nothing may be scheduled for an invalid wasel", "high");
  });

  // SP10 — wasel must not cross clinics: Jrad's secretary cannot wasel a
  // Mahjoub patient.
  await scenario("FX8", "fixx", "Fix X SP10: cross-clinic scheduled wasel refused (Mahjoub patient, Jrad secretary)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Yassine Gharbi");
    const r = await ctx.sec("wasel 21655600202 21:30 rendez-vous ghodwa t2akked", JRA);
    ctx.chk.hard(!/Tebrmej/.test(String(r || "")), `a cross-clinic wasel must not be scheduled; got: ${r}`, "high");
    ctx.chk.hard(/3iyada o5ra/.test(String(r || "")), `the refusal must be honest about the other clinic; got: ${r}`, "medium");
    ctx.chk.hard(ctx.scheduled().length === 0, "no scheduled message may be saved", "high");
    ctx.chk.hard(ctx.templatesTo("21655600202").length === 0, "no template may be sent", "high");
  }, { phone: "21655600202" });

  // SP4 — a malformed command gets an honest error, not the fake ack,
  // and is not filed as a suggestion.
  await scenario("FX9", "fixx", "Fix X SP4: secretary 'annule xyz' -> honest error (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Karim Ben Ammar");
    const r = await ctx.sec("annule xyz");
    ctx.chk.hard(/Ma fhemtch/.test(String(r || "")), `a malformed command must get an honest error; got: ${r}`, "medium");
    ctx.chk.hard(!/modification en cours/.test(String(r || "")), "no fake suggestion ack for a malformed command", "high");
    ctx.chk.hard(ctx.suggestions().length === 0, "a malformed command is not a suggestion", "medium");
    ctx.chk.hard(ctx.bookings()[0].status === "pending", "the booking is untouched", "medium");
  });

  // SP2/SP12/SP3 — command variants map to the real commands.
  await scenario("FX10", "fixx", "Fix X SP2/SP12/SP3: 'okk <id>', Arabic settle, 'raport' (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Karim Ben Ammar");
    await ctx.sayAs("21655600211", "nheb na7jez ghodwa el 11 mta3 el sbe7");
    await ctx.sayAs("21655600211", "ey");
    await ctx.sayAs("21655600211", "Leila Mansour");
    const all = ctx.allBookings();
    const b1 = all.find((b) => b.phone === ctx.phone);
    const b2 = all.find((b) => b.phone === "21655600211");
    await ctx.sec(`okk ${b1.id}`);
    ctx.chk.hard(ctx.allBookings().find((b) => b.id === b1.id).status === "confirmed", "'okk <id>' must settle the booking", "high");
    await ctx.sec(`أكد ${b2.id}`);
    ctx.chk.hard(ctx.allBookings().find((b) => b.id === b2.id).status === "confirmed", "Arabic-script settle must confirm the booking", "high");
    await ctx.sec("raport");
    ctx.chk.hard(ctx.sent().filter((x) => x.type === "document").length >= 1, "'raport' must produce the report document", "medium");
  });

  // SP11 — 'fassakh <phone>' deletes the conversation like 'fassa5'.
  await scenario("FX11", "fixx", "Fix X SP11: secretary 'fassakh <phone>' deletes the conversation (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Karim Ben Ammar");
    ctx.chk.hard(ctx.messagesOf(ctx.phone).length > 0, "setup: conversation exists", "medium");
    const r = await ctx.sec(`fassakh ${ctx.phone}`);
    ctx.chk.hard(/Tfass5et/.test(String(r || "")), `the kh spelling must run the delete command; got: ${r}`, "medium");
    ctx.chk.hard(ctx.messagesOf(ctx.phone).length === 0, "the conversation is deleted", "high");
  });

  // LT9 — day-before-verb hours question is the hours FAQ, not a booking.
  await scenario("FX12", "fixx", "Fix X LT9: 'el 5mis te5dmou?' -> Jrad hours with 16:00 (Jrad)", JRA, async (ctx) => {
    const r = await ctx.say("el 5mis te5dmou?");
    ctx.chk.hard(String(r || "").includes("16:00"), `the Thursday hours must be answered; got: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0 && !ctx.proposal(), "an hours question creates no booking or proposal", "high");
  });

  // DT8 — bare French day-of-month resolves to its next occurrence.
  await scenario("FX13", "fixx", "Fix X DT8: 'le 20 a 10h' -> 20-10-2026 (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("Je veux un rendez-vous le 20 a 10h");
    ctx.chk.hard(hasDate(String(r || ""), "20-10-2026"), `the bare day-of-month must resolve; got: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "a proposal is not a booking yet", "medium");
  });

  // DT1 — 'fin de mois' = last day of the current month.
  await scenario("FX14", "fixx", "Fix X DT1: 'fin de mois a 10h' -> 31-10-2026 (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("Je veux un rendez-vous fin de mois a 10h");
    ctx.chk.hard(hasDate(String(r || ""), "31-10-2026"), `'fin de mois' must resolve to Oct 31; got: ${r}`, "medium");
  });

  // DT10 — 'dans 3 jours' = +3 days.
  await scenario("FX15", "fixx", "Fix X DT10: 'dans 3 jours a 10h' -> 17-10-2026 (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("Je veux un rendez-vous dans 3 jours a 10h");
    ctx.chk.hard(hasDate(String(r || ""), "17-10-2026"), `'dans 3 jours' must resolve to Oct 17; got: ${r}`, "medium");
  });

  // DT14 — a mid-message correction wins over the first-mentioned date.
  await scenario("FX16", "fixx", "Fix X DT14: 'le ghalat el sabt' correction wins (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("nheb na7jez el jom3a el 10, le ghalat el sabt el 10");
    ctx.chk.hard(hasDate(String(r || ""), "17-10-2026"), `the corrected Saturday must be proposed; got: ${r}`, "high");
    ctx.chk.hard(!hasDate(String(r || ""), "16-10-2026"), `the first-mentioned Friday must NOT be proposed; got: ${r}`, "high");
  });

  // DT15 — 'wa7da o5ra' is not a time word: no fabricated 13:xx slot.
  await scenario("FX17", "fixx", "Fix X DT15: 'wa7da o5ra el 10' fabricates no time (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("nheb wa7da o5ra el 10 mta3 el sbe7");
    ctx.chk.hard(!/13:\d{2}/.test(String(r || "")), `'wa7da o5ra' must not become a 13:xx time; got: ${r}`, "high");
    ctx.chk.hard(!/\d{2}-\d{2}-\d{4}, \d{2}:\d{2}/.test(String(r || "")), `no concrete slot may be proposed without a day; got: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking", "medium");
  });

  // OT9 — two names at the French gate do not glue into one stored name.
  await scenario("FX18", "fixx", "Fix X OT9: 'Karim Ben Salah et sa femme Sonia' at the gate (Jrad)", JRA, async (ctx) => {
    await ctx.say("Je voudrais un rendez-vous vendredi a 10h");
    await ctx.say("oui");
    await ctx.say("Karim Ben Salah et sa femme Sonia");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1, `one booking for the first person; got: ${bs.length}`, "medium");
    ctx.chk.hard(/Karim/.test(bs[0].patient_name || "") && !/femme|Sonia/.test(bs[0].patient_name || ""), `the stored name must not glue the wife in; got: ${bs[0].patient_name}`, "high");
  });

  // OT6 — beneficiary swap after booking: the booking is renamed to the
  // wife, no second booking, the caller is not renamed.
  await scenario("FX19", "fixx", "Fix X OT6: French beneficiary swap renames the booking (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookFr("Je voudrais un rendez-vous vendredi a 10h", "Karim Ben Salah");
    const r = await ctx.say("En fait le rendez-vous est pour ma femme Sonia Ben Salah, pas pour moi");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1, `a swap never creates a second booking; got: ${bs.length}`, "high");
    ctx.chk.hard(/Sonia/.test(bs[0].patient_name || ""), `the booking must be re-attributed to Sonia; got: ${bs[0].patient_name}`, "high");
    ctx.chk.hard(/Sonia/.test(String(r || "")), `the reply confirms the new name; got: ${r}`, "medium");
  });

  // OT2 flag — with a REMEMBERED caller name, the second appointment of
  // a two-appointment request still goes through the name gate.
  await scenario("FX20", "fixx", "Fix X OT2: second appointment gates the name despite a remembered caller (Jrad)", JRA, async (ctx) => {
    await ctx.bookFr("Je voudrais un rendez-vous jeudi a 10h", "Karim Ben Salah");
    await ctx.say("Bonjour, je veux un rendez-vous pour moi vendredi a 10h et un autre pour ma femme vendredi a 13h");
    await ctx.say("oui");
    await ctx.say("Karim Ben Salah");
    await ctx.say("vendredi a 13h");
    await ctx.say("oui");
    await ctx.say("Sonia Ben Salah");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 3, `pre-booking + both appointments; got: ${bs.length}`, "medium");
    ctx.chk.hard(bs.some((b) => /Sonia/.test(b.patient_name || "") && b.slot.includes("13:00")), `the second appointment belongs to Sonia at 13:00; got: ${JSON.stringify(bs.map((b) => [b.patient_name, b.slot]))}`, "high");
    ctx.chk.hard(bs.some((b) => /Karim/.test(b.patient_name || "") && b.slot.includes("10:00")), "the first appointment stays Karim's at 10:00", "medium");
  });

  // ED5 — a lone thumbs-up is an acceptance-shaped reply: answered, and
  // with no proposal pending it books nothing.
  await scenario("FX21", "fixx", "Fix X ED5: lone '👍' with no proposal books nothing (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("👍");
    ctx.chk.hard(typeof r === "string" && r.length > 0, "the patient gets a reply", "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking without a proposal", "high");
  });

  // OT3 — a death mention gets a condolence line before the proposal.
  await scenario("FX22", "fixx", "Fix X OT3: deceased grandfather -> condolence + proposal (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("nheb na7jez rendez-vous le jaddi el jom3a el 10 mta3 el sbe7, howa twafa el esbou3 elli fet allah yarhmou");
    ctx.chk.hard(/yarhmou|yarham/i.test(String(r || "")), `a condolence line must precede the flow; got: ${r}`, "medium");
    ctx.chk.hard(hasDate(String(r || ""), "16-10-2026"), `the requested slot is still proposed; got: ${r}`, "medium");
  });

  // GAP A — doubled-s patient cancellation ('nfassa5') cancels the
  // patient's own booking.
  await scenario("FX23", "fixx", "Fix X GAP-A: 'nheb nfassa5' cancels the patient's booking (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Karim Ben Ammar");
    await ctx.say("nheb nfassa5 el rendez-vous mte3i");
    ctx.chk.hard(ctx.bookings()[0].status === "cancelled", `the doubled-s cancellation must cancel; status=${ctx.bookings()[0].status}`, "high");
  });

  // MN2 — a French free-consultation question gets the French price
  // deflection, not a menu.
  await scenario("FX24", "fixx", "Fix X MN2: 'première consultation gratuite ?' -> French price answer (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("La première consultation est-elle gratuite ?");
    ctx.chk.hard(/prix|dépendent/i.test(String(r || "")), `the free-consultation question is a price question; got: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking from a price question", "medium");
  });

  // MD7 — a French symptom question takes the doctor-question offer.
  await scenario("FX25", "fixx", "Fix X MD7: French 'boule... cancer ?' -> doctor offer (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("J'ai une boule sur la gencive depuis une semaine, est-ce que c'est un cancer ?");
    ctx.chk.hard(/docteur|demande/i.test(String(r || "")), `a symptom question must be offered to the doctor; got: ${r}`, "high");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking from a symptom question", "high");
    ctx.chk.soft(ctx.armed(), "the escalation offer should be armed", "medium");
  });

  // LT6 — unaccented French place question mid-flow gets the address.
  await scenario("FX26", "fixx", "Fix X LT6: 'Vous etes ou exactement ?' mid-flow -> address (Jrad)", JRA, async (ctx) => {
    await ctx.bookFr("Je voudrais un rendez-vous vendredi a 10h", "Karim Ben Salah");
    const r = await ctx.say("Vous etes ou exactement ?");
    ctx.chk.hard(String(r || "").includes("Djerba"), `the place question must be answered with the address; got: ${r}`, "medium");
  });

  // Item D addendum + uncertainty rule (live find, Ahmed 2026-10-13):
  // the bot proposed Friday 16-10 09:00, the patient answered "15" —
  // genuinely ambiguous (day 15 or 15:00), so the bot must ASK one
  // short question, then resolve from the answer. (Live, the AI
  // completed "vendredi" to the 09:00 proposal; the deterministic local
  // flow asks the time for a bare weekday, so the setup turn carries
  // "a 9h" — the pending-proposal STATE under test is identical.)
  await scenario("FX27", "fixx", "Fix X D+: bare '15' after a concrete proposal -> clarify, 'le jour' -> Thu 15-10 09:00 (Mahjoub)", MAH, async (ctx) => {
    const r1 = await ctx.say("Je voudrais un rendez-vous vendredi a 9h");
    ctx.chk.hard(hasDate(String(r1 || ""), "16-10-2026") && String(r1 || "").includes("09:00"),
      `setup: Friday 16-10 09:00 proposed; got: ${r1}`, "medium");
    const r2 = await ctx.say("15");
    ctx.chk.hard(/le jour/.test(String(r2 || "")) && /15h/.test(String(r2 || "")),
      `an ambiguous bare number must get ONE clarification question; got: ${r2}`, "high");
    ctx.chk.hard(!hasDate(String(r2 || ""), "15-10-2026"), "no silent guess before the answer", "high");
    ctx.chk.hard(!!ctx.proposal() && hasDate(ctx.proposal().display || "", "16-10-2026"), "the proposal is untouched while clarifying", "medium");
    const r3 = await ctx.say("le jour");
    ctx.chk.hard(hasDate(String(r3 || ""), "15-10-2026") && String(r3 || "").includes("09:00"),
      `'le jour' must move the proposal to Thu 15-10 09:00; got: ${r3}`, "high");
    await ctx.say("oui");
    await ctx.say("Karim Ben Salah");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "15-10-2026"), `the booking lands on Thu 15-10; got: ${JSON.stringify(bs.map((b) => b.slot))}`, "high");
  });

  // Uncertainty rule (2): when the bot just asked for the HOUR (a
  // date-only proposal is pending), a bare number is the hour —
  // resolved directly, NO clarification question.
  await scenario("FX28", "fixx", "Fix X D+: bare '15' answering an hour question = 15:00, no clarification (Mahjoub)", MAH, async (ctx) => {
    const r1 = await ctx.say("Je voudrais un rendez-vous vendredi");
    ctx.chk.hard(/heure/.test(String(r1 || "")), `setup: the bot asks for the time; got: ${r1}`, "medium");
    const r2 = await ctx.say("15");
    ctx.chk.hard(hasDate(String(r2 || ""), "16-10-2026") && String(r2 || "").includes("15:00"),
      `the bare number must resolve as the hour 15:00 on Friday; got: ${r2}`, "high");
    ctx.chk.hard(!/le jour/.test(String(r2 || "")), "no clarification when the context is unambiguous", "high");
  });

  // Uncertainty rule (3): the clarification answered with "l'heure"
  // changes the TIME on the proposed date, not the day.
  await scenario("FX29", "fixx", "Fix X D+: clarification answered 'l'heure' -> Fri 16-10 at 15:00 (Mahjoub)", MAH, async (ctx) => {
    await ctx.say("Je voudrais un rendez-vous vendredi a 9h");
    const rq = await ctx.say("15");
    ctx.chk.hard(/le jour/.test(String(rq || "")), `setup: clarification asked; got: ${rq}`, "medium");
    const r = await ctx.say("l'heure");
    ctx.chk.hard(hasDate(String(r || ""), "16-10-2026") && String(r || "").includes("15:00"),
      `'l'heure' must keep Friday and set 15:00; got: ${r}`, "high");
  });

  // Uncertainty rule (4): a number that can ONLY be a day (24-31) is
  // resolved directly — no clarification needed.
  await scenario("FX30", "fixx", "Fix X D+: bare '28' after a concrete proposal = day 28 directly (Mahjoub)", MAH, async (ctx) => {
    await ctx.say("Je voudrais un rendez-vous vendredi a 9h");
    const r = await ctx.say("28");
    ctx.chk.hard(hasDate(String(r || ""), "28-10-2026") && String(r || "").includes("09:00"),
      `a day-only number must resolve directly to Oct 28 at the proposed time; got: ${r}`, "high");
    ctx.chk.hard(!/le jour/.test(String(r || "")), "no clarification for an unambiguous day", "high");
  });
}

// ================= Family 11: Fix Y — date-offset number leak =================
// Live defect (Ahmed, production): "Je veux un rendez-vous dans 10 jours"
// answered "D'accord — 23-10-2026, 10:00" — the "10" of "10 jours" was
// consumed TWICE: once as the day-offset, once by the hour parser as
// 10:00. A date with NO time must produce a date-only proposal that ASKS
// for the time (same as a bare weekday), never an invented hour.
async function runFixY() {
  await scenario("FY1", "fixy", "Fix Y: French 'dans 10 jours' is DATE-ONLY — asks the time, no invented 10:00 (Jrad)", JRA, async (ctx) => {
    const r1 = await ctx.say("Je veux un rendez-vous dans 10 jours");
    const rr = String(r1 || "");
    ctx.chk.hard(hasDate(rr, "24-10-2026"), `the date must resolve to Sat 24-10-2026; got: ${rr}`, "high");
    ctx.chk.hard(!/24-10-2026,\s*\d{2}:\d{2}/.test(rr), `no concrete hour may be attached to the date (the '10' of '10 jours' is not an hour); got: ${rr}`, "high");
    ctx.chk.hard(/dites-moi l'heure/i.test(rr), `the reply must ASK for the time (plain time question, not an AM/PM guess about '10h'); got: ${rr}`, "high");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking after a date-only turn", "high");
    const r2 = await ctx.say("10h");
    ctx.chk.hard(hasDate(String(r2 || ""), "24-10-2026") && String(r2 || "").includes("10:00"),
      `the follow-up hour must merge onto Sat 24-10 at 10:00; got: ${r2}`, "medium");
  });

  await scenario("FY2", "fixy", "Fix Y: French 'dans 2 semaines' is DATE-ONLY — no invented 14:00 (Jrad)", JRA, async (ctx) => {
    const r1 = await ctx.say("Je veux un rendez-vous dans 2 semaines");
    const rr = String(r1 || "");
    ctx.chk.hard(hasDate(rr, "28-10-2026"), `the date must resolve to Wed 28-10-2026; got: ${rr}`, "high");
    ctx.chk.hard(!/28-10-2026,\s*\d{2}:\d{2}/.test(rr), `no concrete hour may be attached to the date (the '2' of '2 semaines' is not 14:00); got: ${rr}`, "high");
    ctx.chk.hard(/dites-moi l'heure/i.test(rr), `the reply must ASK for the time; got: ${rr}`, "high");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking after a date-only turn", "high");
  });

  await scenario("FY3", "fixy", "Fix Y: Derja 'ba3d 3 ayam' is DATE-ONLY — +3d, asks the time (Mahjoub)", MAH, async (ctx) => {
    const r1 = await ctx.say("nheb na7jez ba3d 3 ayam");
    const rr = String(r1 || "");
    ctx.chk.hard(hasDate(rr, "17-10-2026"), `the date must resolve to Sat 17-10-2026 (+3 days); got: ${rr}`, "high");
    ctx.chk.hard(!/17-10-2026,\s*\d{2}:\d{2}/.test(rr), `no concrete hour may be attached to the date (the '3' of 'ba3d 3 ayam' is not an hour); got: ${rr}`, "high");
    ctx.chk.hard(/9olli el wa9t/i.test(rr), `the reply must ASK for the time in Derja (plain time question); got: ${rr}`, "high");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking after a date-only turn", "high");
  });

  // Positive control: an explicit hour riding along with the offset is a
  // REAL hour and must be kept. Clock moved to Mon 12-10 so +10d lands on
  // Thu 22-10, a day Jrad is open past 15:00 (Sat 24-10 closes 14:00).
  await scenario("FY4", "fixy", "Fix Y control: French 'dans 10 jours a 15h' keeps the concrete 15:00 (Jrad)", JRA, async (ctx) => {
    ctx.setClock("2026-10-12T08:00:00Z"); // Mon 12-10-2026 09:00 Tunis
    const r1 = await ctx.say("Je veux un rendez-vous dans 10 jours a 15h");
    const rr = String(r1 || "");
    ctx.chk.hard(hasDate(rr, "22-10-2026") && rr.includes("15:00"),
      `the explicit 15h must be kept on Thu 22-10-2026; got: ${rr}`, "high");
    ctx.chk.hard(!/dites-moi l'heure/i.test(rr), `a concrete slot must be proposed, not a time question; got: ${rr}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking after a single probe turn", "high");
  });
}

// ================= Family 12: Fix Z — weekday questions =================
// Live defect (Ahmed, production, Jrad line): the bot itself proposed
// 31-10-2026 (fin du mois) and asked for the time; the patient asked
// "quel jour sera t-il ?" and got the ask-the-doctor offer; "le 31
// c'est quel jour? lundi, mardi....." got '"31" n'est pas une heure
// valide' (a QUESTION parsed as an invalid hour); "31 octobre quel
// jour?" got the time question repeated. A weekday question must be
// answered from the calendar, in the patient's language, and the
// pending flow must resume. Oct 31 2026 is a Saturday; Dec 25 2026 a
// Friday (frozen clock: Wed 2026-10-14).
async function runFixZ() {
  await scenario("FZ1", "fixz", "Fix Z: 'fin du mois' -> 'quel jour sera t-il ?' answered 'samedi', time question re-asked (Jrad)", JRA, async (ctx) => {
    const r1 = await ctx.say("je veux Un rendez-vous fin du mois");
    ctx.chk.hard(hasDate(String(r1 || ""), "31-10-2026") && /dites-moi l'heure/i.test(String(r1 || "")),
      `setup: 31-10-2026 proposed, time asked; got: ${r1}`, "medium");
    const r2 = await ctx.say("quel jour sera t-il ?");
    const rr = String(r2 || "");
    ctx.chk.hard(/samedi/i.test(rr), `the weekday of the pending 31-10 must be answered (samedi); got: ${rr}`, "high");
    ctx.chk.hard(hasDate(rr, "31-10-2026"), `the answer names the date it is about; got: ${rr}`, "medium");
    ctx.chk.hard(!/demande au docteur/i.test(rr), `a calendar question is not a doctor question; got: ${rr}`, "high");
    ctx.chk.hard(/dites-moi l'heure/i.test(rr), `the pending time question is re-asked once (flow resumes); got: ${rr}`, "medium");
    const prop = ctx.proposal();
    ctx.chk.hard(!!prop && !prop.slot_at && hasDate(prop.display || "", "31-10-2026"),
      "the date-only proposal survives the weekday question", "medium");
    const r3 = await ctx.say("10h");
    ctx.chk.hard(hasDate(String(r3 || ""), "31-10-2026") && String(r3 || "").includes("10:00"),
      `the hour answer completes the 31-10 proposal at 10:00; got: ${r3}`, "high");
  });

  await scenario("FZ2", "fixz", "Fix Z: 'le 31 c'est quel jour?' is never an 'invalid hour'; a bare '10' still resolves (Jrad)", JRA, async (ctx) => {
    await ctx.say("je veux Un rendez-vous fin du mois");
    const r2 = await ctx.say("le 31 c'est quel jour? lundi, mardi.....");
    const rr = String(r2 || "");
    ctx.chk.hard(!/n'est pas une heure valide/i.test(rr), `a question must never be scolded as an invalid hour; got: ${rr}`, "high");
    ctx.chk.hard(/samedi/i.test(rr), `the explicit 'le 31' is the target — samedi; got: ${rr}`, "high");
    const r3 = await ctx.say("31 octobre quel jour?");
    const r3s = String(r3 || "");
    ctx.chk.hard(/samedi/i.test(r3s) && !/n'est pas une heure valide/i.test(r3s),
      `'31 octobre' + weekday question answered samedi; got: ${r3s}`, "high");
    const r4 = await ctx.say("10");
    ctx.chk.hard(hasDate(String(r4 || ""), "31-10-2026") && String(r4 || "").includes("10:00"),
      `a valid bare hour answer still resolves normally in the same state (31-10 10:00); got: ${r4}`, "high");
  });

  await scenario("FZ3", "fixz", "Fix Z: Derja weekday question mid-flow 'w el 31 chnowa nharou?' -> 'el sebt' (Mahjoub)", MAH, async (ctx) => {
    const r1 = await ctx.say("nheb na7jez el sebt");
    ctx.chk.hard(hasDate(String(r1 || ""), "17-10-2026"), `setup: Sat 17-10 date-only proposal; got: ${r1}`, "medium");
    const r2 = await ctx.say("w el 31 chnowa nharou?");
    const rr = String(r2 || "");
    ctx.chk.hard(/el sebt/.test(rr), `the weekday is answered in Derja (el sebt); got: ${rr}`, "high");
    ctx.chk.hard(hasDate(rr, "31-10-2026"), `the answer is about the explicit 31st; got: ${rr}`, "medium");
    const prop = ctx.proposal();
    ctx.chk.hard(!!prop && hasDate(prop.display || "", "17-10-2026"),
      "the pending 17-10 proposal is untouched by the question about the 31st", "medium");
    const r3 = await ctx.say("10");
    ctx.chk.hard(hasDate(String(r3 || ""), "17-10-2026") && String(r3 || "").includes("10:00"),
      `the hour answer still lands on the pending 17-10 at 10:00; got: ${r3}`, "medium");
  });

  await scenario("FZ4", "fixz", "Fix Z: cold explicit-date weekday question 'le 25 decembre c'est quel jour?' -> vendredi (Jrad)", JRA, async (ctx) => {
    const r = await ctx.say("le 25 decembre c'est quel jour?");
    const rr = String(r || "");
    ctx.chk.hard(/vendredi/i.test(rr) && hasDate(rr, "25-12-2026"),
      `Dec 25 2026 is a Friday — answered from the calendar; got: ${rr}`, "high");
    ctx.chk.hard(!/dites-moi l'heure/i.test(rr), `a pure weekday question is not turned into a booking step; got: ${rr}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0 && !ctx.proposal(),
      "no booking and no proposal are created by a weekday question", "medium");
  });
}

// ================= Family 13: Fix AA — cancellation target selection =================
// Live defect (Ahmed, production, Jrad line): the patient had only a
// PENDING PROPOSAL in this session and wrote "nfassa5 el rendez-vous";
// the bot cancelled a STALE PAST booking from an old test session
// (25 September — already past) and parroted its stored relative
// display string ("ghodwa 25 septembre, 16:00") in the confirmation.
// Cancellation must (1) never select a past booking — nearest upcoming
// wins; (2) render the date from the stored ISO, never the stored
// relative string; (3) with no upcoming booking, a pending proposal is
// what gets cancelled. Frozen clock: Wed 2026-10-14 09:00 Tunis.
async function runFixAA() {
  const PAST_SLOT = "ghodwa 25 septembre, 16:00"; // stored relative string, like the live row
  const PAST_ISO = "2026-09-25T15:00:00.000Z";    // 25-09-2026 16:00 Tunis — PAST at the frozen clock

  await scenario("AA1", "fixaa", "Fix AA: past + upcoming bookings -> cancel hits the UPCOMING one, date rendered from ISO (Jrad)", JRA, async (ctx) => {
    const upcId = await stubDb.saveBooking(ctx.phone, "ghodwa 21 octobre, 10:00", "2026-10-21T09:00:00.000Z", "Patient Test", JRA);
    // The past row is seeded LAST (latest-created): the old
    // latest-created default would pick IT — the eligible pool must
    // exclude it on time alone, whatever the creation order.
    const pastId = await stubDb.saveBooking(ctx.phone, PAST_SLOT, PAST_ISO, "Ancien Test", JRA);
    await ctx.say("Bonjour");
    const r = await ctx.say("Annule mon rendez-vous");
    const rr = String(r || "");
    const bs = ctx.bookings();
    const past = bs.find((b) => b.id === pastId);
    const upc = bs.find((b) => b.id === upcId);
    ctx.chk.hard(!!upc && upc.status === "cancelled", `the UPCOMING booking is the one cancelled; got: ${JSON.stringify(bs.map((b) => [b.id, b.status]))}`, "high");
    ctx.chk.hard(!!past && past.status === "pending", `the PAST booking is never selected — untouched; got: ${past && past.status}`, "high");
    ctx.chk.hard(hasDate(rr, "21-10-2026") && rr.includes("10:00"),
      `the confirmation renders the date from the stored ISO (21-10-2026, 10:00); got: ${rr}`, "high");
    ctx.chk.hard(!/ghodwa/i.test(rr) && !/septembre/i.test(rr),
      `the stored relative string is never parroted; got: ${rr}`, "high");
    ctx.chk.hard(/annulé le rendez-vous/i.test(rr), `a real booking cancellation is confirmed; got: ${rr}`, "medium");
  });

  await scenario("AA2", "fixaa", "Fix AA: only a past booking + a pending proposal -> the PROPOSAL is cancelled (Jrad)", JRA, async (ctx) => {
    const pastId = await stubDb.saveBooking(ctx.phone, PAST_SLOT, PAST_ISO, "Ancien Test", JRA);
    const r1 = await ctx.say("Je voudrais un rendez-vous vendredi a 9h");
    ctx.chk.hard(!!ctx.proposal() && ctx.bookings().length === 1,
      `setup: one past booking + one pending proposal (Fri 16-10); got proposal=${JSON.stringify(ctx.proposal())}`, "medium");
    const r2 = await ctx.say("nfassa5 el rendez-vous");
    const rr = String(r2 || "");
    ctx.chk.hard(ctx.proposal() === null, "the pending proposal is cleared by the cancellation", "high");
    const past = ctx.bookings().find((b) => b.id === pastId);
    ctx.chk.hard(!!past && past.status === "pending", `the past booking is untouched; got: ${past && past.status}`, "high");
    ctx.chk.hard(/annulé la proposition/i.test(rr), `the reply says the PROPOSAL/request was cancelled; got: ${rr}`, "high");
    ctx.chk.hard(!/annulé le rendez-vous/i.test(rr) && !/septembre/i.test(rr),
      `no fake booking cancellation is claimed; got: ${rr}`, "high");
  });

  await scenario("AA3", "fixaa", "Fix AA: only a past booking, nothing else -> 'no booking' reply, past booking untouched (Jrad)", JRA, async (ctx) => {
    const pastId = await stubDb.saveBooking(ctx.phone, PAST_SLOT, PAST_ISO, "Ancien Test", JRA);
    await ctx.say("Bonjour");
    const r = await ctx.say("Annule mon rendez-vous");
    const rr = String(r || "");
    ctx.chk.hard(/Je n'ai trouvé aucun rendez-vous/i.test(rr),
      `with nothing upcoming, the 'no booking' reply applies; got: ${rr}`, "high");
    const past = ctx.bookings().find((b) => b.id === pastId);
    ctx.chk.hard(!!past && past.status === "pending", `the past booking stays untouched; got: ${past && past.status}`, "high");
  });
}

// ================= Family 14: Fix AB — status content + status language =================
// Live defect (Ahmed, production, Jrad line): the patient asked in
// Arabizi "3andi rendez vous confirme wela?" and the bot answered IN
// ARABIC SCRIPT about a STALE PAST booking ("05-10-2026, 08:00") with
// a cancellation offer. Two root causes in handleStatusQuestion:
// (A) it answered from getLatestBooking — latest CREATED, any status,
// any date — with no notion of upcoming vs past; (B) after resolveLang
// it FORCED Arabic whenever the latest booking's stored slot display
// was Arabic-script (a leftover of an earlier Arabic conversation).
// Fix: Fix AA's eligibility frame (upcoming pool by slot_at, dates
// computed from the stored ISO), a live pending proposal states the
// pending state, an upcoming CANCELLED booking keeps the Fix U (MEM7)
// cancelled answer, everything-past answers "no upcoming appointment",
// and the current message's language always wins. Frozen clock:
// Wed 2026-10-14 09:00 Tunis.
async function runFixAB() {
  const PAST_AR_SLOT = "05-10-2026، 08:00";        // Arabic-script stored display, like the live row
  const PAST_ISO = "2026-10-05T07:00:00.000Z";     // 05-10-2026 08:00 Tunis — PAST at the frozen clock
  const UPC_SLOT = "21-10-2026, 10:00";
  const UPC_ISO = "2026-10-21T09:00:00.000Z";      // 21-10-2026 10:00 Tunis — upcoming

  await scenario("AB1", "fixab", "Fix AB: past booking + pending proposal -> Arabizi status, PENDING answer with the proposal date (Jrad)", JRA, async (ctx) => {
    const pastId = await stubDb.saveBooking(ctx.phone, PAST_AR_SLOT, PAST_ISO, "Patient Test", JRA);
    await stubDb.setBookingStatus(pastId, "cancelled"); // the live row was a cancelled past booking
    const r1 = await ctx.say("nheb na7jez ghodwa el 10 mta3 el sbe7");
    ctx.chk.hard(!!ctx.proposal(), `setup: a pending proposal exists (Thu 15-10 10:00); r1: ${r1}`, "medium");
    const r = await ctx.say("3andi rendez vous confirme wela?");
    const rr = String(r || "");
    ctx.chk.hard(!isAR(rr), `Arabizi in -> Arabizi out: NO Arabic script in the reply; got: ${rr}`, "high");
    ctx.chk.hard(hasDate(rr, "15-10-2026"), `the pending state is stated with the PROPOSAL's date (15-10-2026); got: ${rr}`, "high");
    ctx.chk.hard(/mazel yestanna/i.test(rr), `the reply says the request is still PENDING, not confirmed; got: ${rr}`, "high");
    ctx.chk.hard(!hasDate(rr, "05-10-2026"), `the PAST booking is never surfaced; got: ${rr}`, "high");
  });

  await scenario("AB2", "fixab", "Fix AB: past cancelled (latest-created) + upcoming CONFIRMED -> status names the confirmed booking (Jrad)", JRA, async (ctx) => {
    const upcId = await stubDb.saveBooking(ctx.phone, UPC_SLOT, UPC_ISO, "Patient Test", JRA);
    await stubDb.setBookingStatus(upcId, "confirmed");
    // The stale past row is seeded LAST (latest-created): the old
    // getLatestBooking answer picked IT and reported it as cancelled.
    const pastId = await stubDb.saveBooking(ctx.phone, PAST_AR_SLOT, PAST_ISO, "Patient Test", JRA);
    await stubDb.setBookingStatus(pastId, "cancelled");
    const r = await ctx.say("3andi rendez vous confirme wela?");
    const rr = String(r || "");
    ctx.chk.hard(!isAR(rr), `Arabizi in -> Arabizi out: NO Arabic script in the reply; got: ${rr}`, "high");
    ctx.chk.hard(hasDate(rr, "21-10-2026"), `the status names the upcoming CONFIRMED booking (21-10-2026); got: ${rr}`, "high");
    ctx.chk.hard(/t2akked|m2akked/i.test(rr), `the reply says CONFIRMED; got: ${rr}`, "high");
    ctx.chk.hard(!hasDate(rr, "05-10-2026"), `the PAST booking is never surfaced; got: ${rr}`, "high");
  });

  await scenario("AB3", "fixab", "Fix AB: only a past booking -> 'no upcoming appointment', no cancel offer about it (Jrad)", JRA, async (ctx) => {
    const pastId = await stubDb.saveBooking(ctx.phone, PAST_AR_SLOT, PAST_ISO, "Patient Test", JRA);
    const r = await ctx.say("3andi rendez vous confirme wela?");
    const rr = String(r || "");
    ctx.chk.hard(/Ma l9it 7atta rendez-vous/i.test(rr), `the 'no upcoming appointment' reply applies; got: ${rr}`, "high");
    ctx.chk.hard(!hasDate(rr, "05-10-2026"), `the past booking is not presented as the patient's appointment; got: ${rr}`, "high");
    ctx.chk.hard(!isAR(rr), `Arabizi in -> Arabizi out: NO Arabic script in the reply; got: ${rr}`, "high");
    const past = ctx.bookings().find((b) => b.id === pastId);
    ctx.chk.hard(!!past && past.status === "pending", `the past booking is untouched; got: ${past && past.status}`, "medium");
  });

  await scenario("AB4", "fixab", "Fix AB: French status question after Arabic-script history -> French reply, current message wins (Jrad)", JRA, async (ctx) => {
    const upcId = await stubDb.saveBooking(ctx.phone, "21-10-2026، 10:00", UPC_ISO, "Patient Test", JRA);
    await stubDb.setBookingStatus(upcId, "confirmed");
    await ctx.say("سلام"); // Arabic-script history in this same conversation
    const r = await ctx.say("Mon rendez-vous est-il confirmé ?");
    const rr = String(r || "");
    ctx.chk.hard(!isAR(rr), `French in -> French out despite the Arabic history and the Arabic-script stored slot; got: ${rr}`, "high");
    ctx.chk.hard(isFR(rr), `the reply is French; got: ${rr}`, "high");
    ctx.chk.hard(/confirmé/i.test(rr) && hasDate(rr, "21-10-2026"),
      `the confirmed booking is stated in French with its date; got: ${rr}`, "high");
  });
}

// ================= Family 15: Fix AC — glued weekday forms =================
// Live defect (Ahmed, production, Jrad line 2026-10-13): the patient
// wrote with heavy typos: "sbeh el 5ir, n7b randez vous nhar la5mis".
// The deterministic weekday matcher is token-based (" " + name + " ")
// and had NO glued article forms, so "la5mis" (le + 5mis) resolved
// nothing; the booking-intent detector also missed vowel-less "n7b"
// and the "randez" misspelling. The whole turn fell to the AI
// fallthrough, which invented the nonexistent word "5lass" in a fake
// daypart list. Fix AC: glued (l|la|le|el)+weekday forms in dates.js
// DAYS (+ the index.js mirrors WD_DAYS / stripDateTokens / DOW_WORDS),
// and "n7b|nhb" + "randez" in looksLikeBookingIntent. Frozen clock:
// Wed 2026-10-14 09:00 Tunis -> Thu = 15-10, Fri = 16-10, Sat = 17-10,
// Sun = 18-10 (CLOSED at both clinics), Mon = 19-10.
async function runFixAC() {
  const TQ = (d) => `${d} — 9olli el wa9t: mta3 sbe7 walla mta3 l3chiya? (walla ekteb el wa9t kima 10:30)`;

  await scenario("AC1", "fixac", "Fix AC: the EXACT live message 'sbeh el 5ir, n7b randez vous nhar la5mis' -> catalog time question for Thu 15-10, no invented '5lass' (Jrad)", JRA, async (ctx) => {
    const r1 = await ctx.say("sbeh el 5ir, n7b randez vous nhar la5mis");
    const rr = String(r1 || "");
    ctx.chk.hard(rr === TQ("15-10-2026"),
      `the reply must be EXACTLY the catalog tq_plain (az) with Thu 15-10-2026; got: ${rr}`, "high");
    ctx.chk.hard(!/5lass/.test(rr), `the invented word "5lass" must never appear; got: ${rr}`, "high");
    const prop = ctx.proposal();
    ctx.chk.hard(!!prop && !prop.slot_at && hasDate(prop.display || "", "15-10-2026"),
      "a date-only proposal for Thu 15-10-2026 is pending", "high");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking after a date-only turn", "high");
    const r2 = await ctx.say("10:30");
    ctx.chk.hard(hasDate(String(r2 || ""), "15-10-2026") && String(r2 || "").includes("10:30"),
      `the hour answer completes the Thu proposal at 10:30; got: ${r2}`, "medium");
  });

  await scenario("AC2", "fixac", "Fix AC: glued Monday 'latnin' + spaced 'rendez vous' + 'n7b' -> time question for Mon 19-10 (Jrad)", JRA, async (ctx) => {
    const r1 = await ctx.say("n7b rendez vous latnin");
    const rr = String(r1 || "");
    ctx.chk.hard(rr === TQ("19-10-2026"),
      `glued 'latnin' must resolve to Mon 19-10-2026 and ask the catalog time question; got: ${rr}`, "high");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking after a date-only turn", "medium");
  });

  await scenario("AC3", "fixac", "Fix AC: glued Sunday 'le7ad' (closed at Jrad) -> closed-day reply, next open day Mon 19-10 proposed (Jrad)", JRA, async (ctx) => {
    const r1 = await ctx.say("nheb rendez-vous le7ad");
    const rr = String(r1 || "");
    ctx.chk.hard(/msakra/.test(rr), `Sunday is closed at Jrad — the closed-day reply must fire; got: ${rr}`, "high");
    ctx.chk.hard(hasDate(rr, "19-10-2026"), `the next open day (Mon 19-10-2026) is proposed instead; got: ${rr}`, "high");
    ctx.chk.hard(!/18-10-2026,\s*\d{2}:\d{2}/.test(rr), `no concrete slot may be proposed on the closed Sunday; got: ${rr}`, "high");
    const prop = ctx.proposal();
    ctx.chk.hard(!!prop && hasDate(prop.display || "", "19-10-2026"),
      "the pending proposal is the Monday, not the closed Sunday", "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking on a closed day", "high");
  });

  await scenario("AC4", "fixac", "Fix AC: misspelled 'randez-vous' + glued Saturday 'lasabt' + hour -> concrete proposal Sat 17-10 10:00 (Jrad)", JRA, async (ctx) => {
    const r1 = await ctx.say("randez-vous lasabt el 10");
    const rr = String(r1 || "");
    ctx.chk.hard(hasDate(rr, "17-10-2026") && rr.includes("10:00"),
      `glued 'lasabt' + 'el 10' must propose Sat 17-10-2026 at 10:00; got: ${rr}`, "high");
    ctx.chk.hard(!/9olli el wa9t/.test(rr), `a concrete slot is proposed, not a time question; got: ${rr}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "proposal only — no booking before acceptance", "medium");
  });

  await scenario("AC5", "fixac", "Fix AC: glued Friday 'lajom3a' + 9h -> concrete proposal Fri 16-10 09:00 (Mahjoub)", MAH, async (ctx) => {
    const r1 = await ctx.say("nheb rdv lajom3a 9h");
    const rr = String(r1 || "");
    ctx.chk.hard(hasDate(rr, "16-10-2026") && rr.includes("09:00"),
      `glued 'lajom3a' + '9h' must propose Fri 16-10-2026 at 09:00; got: ${rr}`, "high");
    ctx.chk.hard(ctx.bookings().length === 0, "proposal only — no booking before acceptance", "medium");
  });

  await scenario("AC6", "fixac", "Fix AC: glued Thursday variant 'l5mis' -> time question for Thu 15-10 (Jrad)", JRA, async (ctx) => {
    const r1 = await ctx.say("nheb na7jez l5mis");
    const rr = String(r1 || "");
    ctx.chk.hard(rr === TQ("15-10-2026"),
      `glued 'l5mis' must resolve to Thu 15-10-2026 with the catalog time question; got: ${rr}`, "high");
  });

  await scenario("AC7", "fixac", "Fix AC: glued Thursday variant 'le5mis' + hour -> concrete proposal Thu 15-10 10:00 (Jrad)", JRA, async (ctx) => {
    const r1 = await ctx.say("n7b rdv le5mis el 10");
    const rr = String(r1 || "");
    ctx.chk.hard(hasDate(rr, "15-10-2026") && rr.includes("10:00"),
      `glued 'le5mis' + 'el 10' must propose Thu 15-10-2026 at 10:00; got: ${rr}`, "high");
    ctx.chk.hard(ctx.bookings().length === 0, "proposal only — no booking before acceptance", "medium");
  });
}

// ================= Fix AD family: STUBBED-AI instance =================
// index.js reads AI_API_KEY / AI_BASE_URL at require time, so this family
// re-requires it with a stub key and a fetch router that answers the
// chat-completions call from AI_STUB (the language-detector call gets its
// own canned answer). The stub db (require cache) and the frozen dates
// module are SHARED with the main instance — proposals/bookings carry
// over — and the family runs LAST, after every no-key family.
const AI_STUB = { reply: "", langDetect: "NON" };
let botAi = null;
function loadBotAi() {
  if (botAi) return botAi;
  const prevFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes("ai.stub.test")) {
      let sys = "";
      try { sys = (JSON.parse(opts.body).messages || [])[0].content || ""; } catch {}
      const content = sys.includes("détecteur de langue") ? AI_STUB.langDetect : AI_STUB.reply;
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
    }
    return prevFetch(url, opts);
  };
  process.env.AI_API_KEY = "stub-ai-key";
  process.env.AI_BASE_URL = "https://ai.stub.test/v1";
  process.env.PORT = "43129";
  const idxPath = require.resolve(path.join(__dirname, "index.js"));
  delete require.cache[idxPath];
  botAi = require("./index.js");
  return botAi;
}

async function scenarioAi(id, title, clinicId, fn) {
  dates.setNow(DEFAULT_NOW_MS);
  const b = loadBotAi();
  const phone = newPhone();
  const log = [];
  const say = async (text, cid) => {
    const r = await b.processPatientText(phone, text, cid || clinicId);
    log.push({ inn: text, out: r });
    return r;
  };
  const chk = {
    problems: [], verdict: "PASS",
    hard(cond, msg, sev) { if (!cond) { this.problems.push({ kind: "FAIL", msg, sev: sev || "medium" }); this.verdict = "FAIL"; } },
    soft(cond, msg, sev) { if (!cond) { this.problems.push({ kind: "GAP", msg, sev: sev || "low" }); if (this.verdict === "PASS") this.verdict = "GAP"; } },
  };
  const ctx = {
    phone, say, chk,
    bookings: () => stubDb._inspect().bookings.filter((x) => x.phone === phone),
    proposal: () => stubDb._inspect().proposals.get(phone) || null,
    last: () => (log.length ? log[log.length - 1].out : null),
  };
  try { await fn(ctx); }
  catch (e) { chk.problems.push({ kind: "FAIL", msg: "EXCEPTION: " + (e && e.message), sev: "high" }); chk.verdict = "FAIL"; }
  const res = { id, family: "fixad", title, clinicId, verdict: chk.verdict, problems: chk.problems, log, bookings: ctx.bookings() };
  results.push(res);
  console.log(`\n===== ${id} [${chk.verdict}] (fixad) ${title}`);
  for (const t of log) {
    console.log("  Patient: " + t.inn);
    console.log("  Bot: " + String(t.out == null ? "(null)" : t.out).replace(/\n/g, " / "));
  }
  for (const bk of res.bookings) console.log(`  >> booking: ${bk.slot} | at=${bk.slot_at} | status=${bk.status} | name=${bk.patient_name || "-"}`);
  for (const p of chk.problems) console.log(`  !! ${p.kind} (${p.sev}): ${p.msg}`);
  return res;
}

async function runFixAD() {
  const WIFI_Q = "el wifi mawjoud fel 9a3et el intidhar?";
  const bookTomorrow10 = async (ctx) => {
    await ctx.say("nheb na7jez ghodwa el 10 mta3 sbe7");
    const prop = ctx.proposal();
    ctx.chk.hard(!!prop && !!prop.slot_at && hasDate(prop.display || "", "15-10-2026"),
      "setup: a complete proposal (15-10-2026, 10:00) is pending", "high");
    return prop;
  };

  await scenarioAi("AD1", "Fix AD: AI invents a price mid-flow -> price sentence stripped, benign answer kept, catalog re-ask appended (Jrad, stubbed AI)", JRA, async (ctx) => {
    const prop = await bookTomorrow10(ctx);
    AI_STUB.reply = "Ey, el wifi mawjoud fel 9a3a. El consultation b 90 dinars.";
    const r = String(await ctx.say(WIFI_Q) || "");
    ctx.chk.hard(!/90/.test(r), `the invented price must never reach the patient; got: ${r}`, "high");
    ctx.chk.hard(/wifi/.test(r), `the benign part of the AI answer survives; got: ${r}`, "high");
    const reAsk = bot.msg("reask_proposal", "az", { disp: prop.display });
    ctx.chk.hard(r.endsWith(reAsk), `the pending proposal is re-presented with the CATALOG re-ask (not the AI's wording); got: ${r}`, "high");
    ctx.chk.hard(!!ctx.proposal(), "the proposal is still pending after the off-flow question", "medium");
  });

  await scenarioAi("AD2", "Fix AD: AI invents a time different from the active proposal -> stripped, proposal time intact via catalog re-ask (Jrad, stubbed AI)", JRA, async (ctx) => {
    const prop = await bookTomorrow10(ctx);
    AI_STUB.reply = "El rendez-vous mte3ek el 14:30. El wifi mawjoud fel 9a3a.";
    const r = String(await ctx.say(WIFI_Q) || "");
    ctx.chk.hard(!/14:30/.test(r), `the invented 14:30 must be stripped; got: ${r}`, "high");
    ctx.chk.hard(/wifi/.test(r), `the benign sentence survives; got: ${r}`, "high");
    const reAsk = bot.msg("reask_proposal", "az", { disp: prop.display });
    ctx.chk.hard(r.endsWith(reAsk) && /10:00/.test(r), `the patient sees the REAL proposal time (10:00) in the catalog re-ask; got: ${r}`, "high");
  });

  await scenarioAi("AD3", "Fix AD: AI invents a date -> stripped (the phantom patterns alone did not catch this shape) (Jrad, stubbed AI)", JRA, async (ctx) => {
    const prop = await bookTomorrow10(ctx);
    AI_STUB.reply = "N7ajzlek le 25 octobre. El wifi mawjoud fel 9a3a.";
    const r = String(await ctx.say(WIFI_Q) || "");
    ctx.chk.hard(!/25/.test(r), `the invented date (25 octobre) must be stripped; got: ${r}`, "high");
    ctx.chk.hard(/wifi/.test(r), `the benign sentence survives; got: ${r}`, "high");
    const reAsk = bot.msg("reask_proposal", "az", { disp: prop.display });
    ctx.chk.hard(r.endsWith(reAsk) && hasDate(r, "15-10-2026"), `the real proposal date is re-presented by the catalog; got: ${r}`, "high");
  });

  await scenarioAi("AD4", "Fix AD: booking intent reaching the AI path (B0 first ask) -> the CATALOG ask_day_time verbatim, never the AI's composed question (Jrad, stubbed AI)", JRA, async (ctx) => {
    AI_STUB.reply = "Ahla! N7ajzlek ghodwa el 18:30, mriguel?";
    const r = String(await ctx.say("nheb na7jez rendez-vous") || "");
    ctx.chk.hard(r === bot.msg("ask_day_time", "az"),
      `the flow-driving question must be the catalog text verbatim; got: ${r}`, "high");
    ctx.chk.hard(!/18:30/.test(r), `the AI's invented slot must not appear; got: ${r}`, "high");
    ctx.chk.hard(!ctx.proposal() && ctx.bookings().length === 0, "the ask creates no proposal and no booking", "medium");
  });

  await scenarioAi("AD5", "Fix AD: off-flow chit-chat, benign AI reply (no facts) -> passes through unchanged (Jrad, stubbed AI)", JRA, async (ctx) => {
    AI_STUB.reply = "Ahla bik, nchallah weslet b5ir! Kifech najmou n3awnouk?";
    const r = String(await ctx.say("rani raja3 mel safar, kont fi tounes el 3assima w el jaw ken skhoun") || "");
    ctx.chk.hard(r === AI_STUB.reply, `a benign off-flow AI reply must pass through byte-for-byte; got: ${r}`, "high");
  });

  await scenarioAi("AD6", "Fix AD: patient states a price figure and the AI echoes it -> NOT stripped (mirror, not invention) (Jrad, stubbed AI)", JRA, async (ctx) => {
    await bookTomorrow10(ctx);
    AI_STUB.reply = "El 90 dinars elli 5allasthom kanou lel visite. El wifi mawjoud.";
    const r = String(await ctx.say("5allast 90 dinars 3and tbib e5er, w el wifi mawjoud 3andkom?") || "");
    ctx.chk.hard(/90 dinars/.test(r), `the patient's own figure, echoed back, must survive the guard; got: ${r}`, "high");
    ctx.chk.hard(/wifi/.test(r), `the answer part survives too; got: ${r}`, "medium");
  });

  await scenarioAi("AD7", "Fix AD: French path — AI invents a price off-flow -> stripped, benign French sentence kept (Jrad, stubbed AI)", JRA, async (ctx) => {
    AI_STUB.reply = "Merci pour votre confiance ! La consultation coûte 90 dinars.";
    const r = String(await ctx.say("Un ami m'a recommandé votre cabinet, il m'a dit que vous étiez très professionnels") || "");
    ctx.chk.hard(!/90/.test(r), `the invented French price must be stripped; got: ${r}`, "high");
    ctx.chk.hard(/Merci pour votre confiance/.test(r), `the benign French sentence survives; got: ${r}`, "medium");
  });

  await scenarioAi("AD8", "Fix AD: AI reply is ONLY an invented price -> patient gets the catalog safe fallback in their language (Jrad, stubbed AI)", JRA, async (ctx) => {
    AI_STUB.reply = "El consultation b 90 dinars.";
    const r = String(await ctx.say("rani raja3 mel safar, kont fi tounes el 3assima w el jaw ken skhoun") || "");
    ctx.chk.hard(r === bot.msg("ai_safe_fallback", "az"),
      `a fully-stripped reply falls back to the catalog deflection, never silence; got: ${r}`, "high");
  });
}

async function runFixAE() {
  await scenario("AE1", "FixAE", "Fix AE: outbound phone normalization — TN local 8-digit numbers get the 216 prefix (the auto-rapport 131026 bug)", JRA, async (ctx) => {
    const n = bot.normalizePhoneIntl;
    ctx.chk.hard(typeof n === "function", "normalizePhoneIntl is exported", "high");
    ctx.chk.hard(n("28192232") === "21628192232", `Jrad supervisor local -> intl; got ${n("28192232")}`, "high");
    ctx.chk.hard(n("98800749") === "21698800749", `Mahjoub supervisor local -> intl; got ${n("98800749")}`, "high");
    ctx.chk.hard(n("0021628192232") === "21628192232", `00-prefix dropped, no double prefix; got ${n("0021628192232")}`, "medium");
    ctx.chk.hard(n("+216 28 192 232") === "21628192232", `plus/spaces stripped; got ${n("+216 28 192 232")}`, "medium");
  });

  await scenario("AE2", "FixAE", "Fix AE: already-international numbers pass through untouched (patients, FR, US)", JRA, async (ctx) => {
    const n = bot.normalizePhoneIntl;
    ctx.chk.hard(n("21628192232") === "21628192232", "TN intl unchanged", "high");
    ctx.chk.hard(n("21653180566") === "21653180566", "TN patient intl unchanged", "high");
    ctx.chk.hard(n("33649329426") === "33649329426", "FR intl unchanged", "high");
    ctx.chk.hard(n("17174204057") === "17174204057", "US intl unchanged", "high");
    ctx.chk.hard(n("") === "", "empty stays empty", "low");
  });
}

(async () => {
  await runLong();
  await runEdge();
  await runMed();
  await runMoney();
  await runOthers();
  await runDates3();
  await runSecPow();
  await runConsist();
  await runLangChaos();
  await runFixX();
  await runFixY();
  await runFixZ();
  await runFixAA();
  await runFixAB();
  await runFixAC();
  await runFixAD();
  await runFixAE();
  const by = { PASS: 0, GAP: 0, FAIL: 0 };
  const fam = {};
  for (const r of results) {
    by[r.verdict]++;
    fam[r.family] = fam[r.family] || { PASS: 0, GAP: 0, FAIL: 0, n: 0 };
    fam[r.family][r.verdict]++;
    fam[r.family].n++;
  }
  console.log("\n\n================ SUMMARY ================");
  console.log(`TOTAL ${results.length} — PASS ${by.PASS} — GAP ${by.GAP} — FAIL ${by.FAIL}`);
  for (const [f, c] of Object.entries(fam)) console.log(`  ${f}: ${c.n} — PASS ${c.PASS} GAP ${c.GAP} FAIL ${c.FAIL}`);
  for (const r of results) if (r.verdict !== "PASS") console.log(`${r.id} [${r.verdict}] ${r.title}`);
  console.log("=== JSON_RESULTS_START ===");
  console.log(JSON.stringify(results.map((r) => ({
    id: r.id, family: r.family, title: r.title, clinic: r.clinicId === MAH ? "Mahjoub" : "Jrad",
    verdict: r.verdict, problems: r.problems,
    log: r.log, bookings: r.bookings.map((b) => ({ slot: b.slot, status: b.status, name: b.patient_name || null })),
  })), null, 1));
  console.log("=== JSON_RESULTS_END ===");
  process.exit(0);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
