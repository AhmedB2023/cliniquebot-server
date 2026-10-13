// test-round2.js — ROUND-2 adversarial battery (2026-10-13). No network, no Postgres.
// Drives the REAL processPatientText / processSecretaryText with an in-memory db stub.
// NEW scenarios only (round 1 = test-deep.js, 87 scenarios, all PASS after Fix T).
// Frozen clock: Wed 2026-10-14 09:00 Tunis (= 2026-10-14T08:00:00Z).
// Oct 2026 calendar: 14 Wed, 15 Thu, 16 Fri, 17 Sat, 18 Sun, 19 Mon, 20 Tue,
// 21 Wed, 22 Thu, 23 Fri, 24 Sat, 25 Sun, 26 Mon, 27 Tue, 28 Wed, 29 Thu,
// 30 Fri, 31 Sat. Nov: 1 Sun, 2 Mon, 11 Wed, 12 Thu. Dec: 11 Fri, 12 Sat.
// NO AI key -> deterministic layer only (production fallback path).
// Usage: node test-round2.js
process.env.PORT = "43119";
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
dates.setNow(new Date("2026-10-14T08:00:00Z").getTime());

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

// Single-turn date probe (patient side).
async function probe(id, title, clinicId, text, expect = {}) {
  return scenario(id, "dates2", title, clinicId, async (ctx) => {
    const r = await ctx.say(text);
    const rr = String(r || "");
    if (expect.date) ctx.chk.hard(hasDate(rr, expect.date), `reply should resolve to ${expect.date}; got: ${rr}`, expect.sev || "medium");
    if (expect.time) ctx.chk.soft(hasDate(rr, expect.time), `time should be ${expect.time}; got: ${rr}`, expect.sev || "medium");
    if (expect.notDate) ctx.chk.hard(!hasDate(rr, expect.notDate), `reply must NOT propose ${expect.notDate}; got: ${rr}`, expect.sev || "medium");
    if (expect.noSlot) ctx.chk.hard(!/\d{2}-\d{2}-\d{4}, \d{2}:\d{2}/.test(rr), `reply must NOT propose a concrete slot; got: ${rr}`, expect.sev || "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking should exist after a single probe turn");
    if (expect.extra) expect.extra(ctx, rr);
  });
}

// ================= Family 1: secretary-side commands =================
async function runSecretary() {
  await scenario("SEC1", "secretary", "Secretary 'ey <id>' validates a Jrad booking, patient notified", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez el jom3a el 10 mta3 el sbe7", "Yassine Gharbi");
    const b = ctx.bookings()[0];
    ctx.chk.hard(!!b && b.status === "pending", "setup: pending booking exists");
    const before = ctx.textsTo(ctx.phone).length;
    const r = await ctx.sec(`ey ${b.id}`);
    const after = ctx.bookings()[0];
    ctx.chk.hard(after.status === "confirmed", `booking should be confirmed after secretary ey; got ${after.status}`, "high");
    ctx.chk.hard(/T2akked/.test(String(r || "")), `secretary should get a confirmation ack; got: ${r}`);
    ctx.chk.hard(ctx.textsTo(ctx.phone).length > before, "patient should receive the settle confirmation message", "medium");
  });

  await scenario("SEC2", "secretary", "Secretary bare 'ok' with exactly ONE pending booking (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Sami Ben Salah");
    const b = ctx.bookings()[0];
    ctx.chk.hard(!!b && b.status === "pending", "setup: pending booking exists");
    const r = await ctx.sec("ok");
    ctx.chk.soft(ctx.bookings()[0].status === "confirmed",
      `bare 'ok' with a single pending booking does not settle it (status=${ctx.bookings()[0].status}); reply: ${r}`);
    ctx.chk.soft(!ctx.suggestions().some((s) => s.text === "ok"),
      `bare 'ok' was filed as a SUGGESTION instead of being handled as a command; reply: ${r}`);
    ctx.chk.hard(ctx.bookings().length === 1, "no extra booking created");
  });

  await scenario("SEC3", "secretary", "Secretary bare 'ey' with exactly ONE pending booking (Jrad)", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez el jom3a el 11 mta3 el sbe7", "Leila Mansour");
    const b = ctx.bookings()[0];
    ctx.chk.hard(!!b && b.status === "pending", "setup: pending booking exists");
    const r = await ctx.sec("ey");
    ctx.chk.soft(ctx.bookings()[0].status === "confirmed",
      `bare 'ey' with a single pending booking does not settle it (status=${ctx.bookings()[0].status}); reply: ${r}`);
    ctx.chk.soft(!ctx.suggestions().some((s) => s.text === "ey"),
      `bare 'ey' was filed as a SUGGESTION; reply: ${r}`);
  });

  await scenario("SEC4", "secretary", "wasel immediate to a known patient (name resolved)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Sami Trabelsi");
    const r = await ctx.sec(`wasel ${ctx.phone} El rendez-vous mte3ek t2akked, ijana 5 minutes abkar.`);
    ctx.chk.hard(/Woslet lel patient/.test(String(r || "")), `wasel should confirm delivery; got: ${r}`, "medium");
    const t = ctx.templatesTo(ctx.phone, "message_docteur");
    ctx.chk.hard(t.length === 1, `exactly one message_docteur template should go to the patient; got ${t.length}`, "high");
    if (t.length) {
      const comp = (t[0].template.components || []).find((c) => c.type === "body");
      const params = comp ? comp.parameters.map((p) => p.text) : [];
      ctx.chk.soft(params.some((p) => /Sami/.test(p || "")), `template should greet the patient by his saved name; params: ${JSON.stringify(params)}`);
      ctx.chk.hard(params.some((p) => /t2akked/.test(p || "")), `template should carry the secretary's text; params: ${JSON.stringify(params)}`);
    }
  }, { phone: "21655600101" });

  await scenario("SEC5", "secretary", "wasel malformed: bare 'wasel'", MAH, async (ctx) => {
    const r = await ctx.sec("wasel");
    ctx.chk.hard(ctx.sent().length === 0, "nothing may be sent for a bare 'wasel'", "high");
    ctx.chk.soft(/format|numero|message/i.test(String(r || "")),
      `bare 'wasel' should get the format help, not a suggestion ack; got: ${r}`);
  });

  await scenario("SEC6", "secretary", "wasel with a too-short number 'wasel 12345 hello'", MAH, async (ctx) => {
    const r = await ctx.sec("wasel 12345 hello");
    ctx.chk.hard(ctx.sentTo("12345").length === 0 && ctx.sent().length === 0, "nothing may be sent to an invalid number", "high");
    ctx.chk.soft(/format|numero|ghalet|valide/i.test(String(r || "")),
      `invalid wasel should be flagged, not silently filed; got: ${r}`);
  });

  await scenario("SEC7", "secretary", "wasel where the MESSAGE starts with a time 'wasel <num> 10:00 rendez-vous confirmé...'", MAH, async (ctx) => {
    const r = await ctx.sec(`wasel ${ctx.phone} 10:00 rendez-vous confirmé ghodwa`);
    ctx.chk.hard(ctx.scheduled().length + ctx.templatesTo(ctx.phone).length >= 1, "the command must do something (send or schedule)");
    ctx.chk.soft(ctx.templatesTo(ctx.phone, "message_docteur").length === 1,
      `a message whose text starts with '10:00' is treated as a SCHEDULED send (reply: ${r}; scheduled=${JSON.stringify(ctx.scheduled().map((s) => s.message))}) instead of being sent now with its full text`, "medium");
  }, { phone: "21655600102" });

  await scenario("SEC8", "secretary", "wasel with INVALID time 'wasel <num> 25:00 message urgent...'", MAH, async (ctx) => {
    const r = await ctx.sec(`wasel ${ctx.phone} 25:00 message urgent, ehtej na3ref el reponse tawa`);
    const t = ctx.templatesTo(ctx.phone, "message_docteur");
    ctx.chk.soft(t.length === 0 && ctx.scheduled().length === 0,
      `invalid time 25:00 should be rejected with an error; actual: sent=${t.length}, scheduled=${ctx.scheduled().length}, reply: ${r}`, "medium");
    if (t.length) {
      const comp = (t[0].template.components || []).find((c) => c.type === "body");
      const params = comp ? comp.parameters.map((p) => p.text || "") : [];
      ctx.chk.soft(params.some((p) => /25:00/.test(p)), `the '25:00' token was silently EATEN from the message; params: ${JSON.stringify(params)}`);
    }
  }, { phone: "21655600103" });

  await scenario("SEC9", "secretary", "wasel scheduled at a valid future time 21:30", MAH, async (ctx) => {
    const r = await ctx.sec(`wasel ${ctx.phone} 21:30 ntfakkrek b rendez-vous mte3ek ghodwa el 10`);
    ctx.chk.hard(ctx.templatesTo(ctx.phone).length === 0, "a scheduled wasel must NOT be sent immediately", "medium");
    ctx.chk.hard(ctx.scheduled().length === 1, `exactly one scheduled message should be saved; got ${ctx.scheduled().length}`, "medium");
    if (ctx.scheduled().length) {
      const s = ctx.scheduled()[0];
      ctx.chk.hard(s.phone === ctx.phone && /ntfakkrek/.test(s.message), `scheduled message should keep number + text; got ${JSON.stringify(s)}`);
      ctx.chk.soft(new Date(s.sendAt).getTime() > Date.now(), `sendAt should be in the future; got ${s.sendAt}`);
    }
    ctx.chk.soft(/Tebrmej|21:30/.test(String(r || "")), `reply should confirm the scheduling; got: ${r}`);
  }, { phone: "21655600104" });

  await scenario("SEC10", "secretary", "wasel scheduled at a PAST time today (07:00) rolls to tomorrow", MAH, async (ctx) => {
    const r = await ctx.sec(`wasel ${ctx.phone} 07:00 tfakkir lel patient`);
    ctx.chk.hard(ctx.scheduled().length === 1, `past-time wasel should still schedule (tomorrow); got ${ctx.scheduled().length}`, "low");
    if (ctx.scheduled().length) {
      ctx.chk.soft(new Date(ctx.scheduled()[0].sendAt).getTime() > Date.now(),
        `sendAt must be future (tomorrow), got ${ctx.scheduled()[0].sendAt}`);
    }
    ctx.chk.soft(/Tebrmej/.test(String(r || "")), `reply should confirm scheduling; got: ${r}`);
  }, { phone: "21655600105" });

  await scenario("SEC11", "secretary", "Secretary cancels in French: 'annule le <id>'", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez el jom3a el 10 mta3 el sbe7", "Omar Haddad");
    const b = ctx.bookings()[0];
    const r = await ctx.sec(`annule le ${b.id}`);
    ctx.chk.soft(ctx.bookings()[0].status === "cancelled",
      `French 'annule le <id>' does not cancel (status=${ctx.bookings()[0].status}) — it falls through to the suggestion box; reply: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 1, "no extra booking");
  });

  await scenario("SEC12", "secretary", "Secretary validates in French: 'validez le <id> svp'", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Nadia Ben Ammar");
    const b = ctx.bookings()[0];
    const r = await ctx.sec(`validez le ${b.id} svp`);
    ctx.chk.soft(ctx.bookings()[0].status === "confirmed",
      `French 'validez le <id> svp' does not validate (status=${ctx.bookings()[0].status}); reply: ${r}`, "medium");
  });

  await scenario("SEC13", "secretary", "Secretary 'liste' (French spelling) lists pending bookings", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez el jom3a el 10 mta3 el sbe7", "Omar Haddad");
    const r = await ctx.sec("liste");
    ctx.chk.hard(/En cours/.test(String(r || "")) && String(r || "").includes(String(ctx.bookings()[0].id)),
      `'liste' should list the pending booking with its id; got: ${r}`, "medium");
  });

  await scenario("SEC14", "secretary", "Secretary 'rapport svp' (extra word breaks the anchored command)", MAH, async (ctx) => {
    const r = await ctx.sec("rapport svp");
    ctx.chk.soft(/rapport/i.test(String(r || "")) && !/modification en cours/i.test(String(r || "")),
      `'rapport svp' is not recognized as the rapport command (anchored regex) and gets filed as a suggestion; got: ${r}`, "low");
    ctx.chk.hard(ctx.sent().filter((b) => b.type === "document").length === 0 || /rapport/i.test(String(r || "")), "no stray document send");
  });

  await scenario("SEC15", "secretary", "Secretary 'تقرير' (Arabic) triggers the rapport", MAH, async (ctx) => {
    const r = await ctx.sec("تقرير");
    ctx.chk.hard(/rapport/i.test(String(r || "")),
      `Arabic 'تقرير' should produce the daily rapport reply; got: ${r}`, "medium");
  });

  await scenario("SEC16", "secretary", "fassa5 with the LOCAL number of a patient stored under INTL number", MAH, async (ctx) => {
    await ctx.say("slm");
    await ctx.say("nheb na7jez ghodwa el 10 mta3 el sbe7");
    ctx.chk.hard(ctx.messagesOf(ctx.phone).length >= 2, "setup: patient has messages");
    const r = await ctx.sec("fassa5 55600106");
    ctx.chk.soft(ctx.messagesOf(ctx.phone).length === 0,
      `fassa5 with the local 8-digit number deleted nothing (patient is stored as ${ctx.phone}); reply: ${r}`, "medium");
  }, { phone: "21655600106" });

  await scenario("SEC17", "secretary", "fassa5 with the exact INTL number deletes messages but keeps bookings", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Sami Trabelsi");
    ctx.chk.hard(ctx.bookings().length === 1, "setup: booking exists");
    const r = await ctx.sec(`fassa5 ${ctx.phone}`);
    ctx.chk.hard(ctx.messagesOf(ctx.phone).length === 0, `conversation messages should be deleted; got ${ctx.messagesOf(ctx.phone).length}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 1, "bookings must survive fassa5 (by design)", "medium");
    ctx.chk.soft(/Tfass5et/.test(String(r || "")), `reply should confirm the deletion; got: ${r}`);
  }, { phone: "21655600107" });

  await scenario("SEC18", "secretary", "Settle twice + reject after confirm: no duplicate patient notification", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Sami Trabelsi");
    const b = ctx.bookings()[0];
    await ctx.sec(`ok ${b.id}`);
    const sendsAfterFirst = ctx.textsTo(ctx.phone).length;
    const r2 = await ctx.sec(`ok ${b.id}`);
    ctx.chk.hard(ctx.bookings()[0].status === "confirmed", "booking stays confirmed");
    ctx.chk.hard(ctx.textsTo(ctx.phone).length === sendsAfterFirst,
      `re-validating an already-confirmed booking must NOT re-notify the patient (sends ${sendsAfterFirst} -> ${ctx.textsTo(ctx.phone).length})`, "medium");
    ctx.chk.soft(/deja/i.test(String(r2 || "")), `second ok should say 'already settled'; got: ${r2}`);
    const r3 = await ctx.sec(`le ${b.id}`);
    ctx.chk.hard(ctx.bookings()[0].status === "confirmed",
      `a confirmed booking must not flip to cancelled via 'le' (status=${ctx.bookings()[0].status}); reply: ${r3}`, "medium");
  });

  await scenario("SEC19", "secretary", "Mixed settle 'ok <validId> 99999' settles the valid one and reports the unknown", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez el jom3a el 10 mta3 el sbe7", "Omar Haddad");
    const b = ctx.bookings()[0];
    const r = await ctx.sec(`ok ${b.id} 99999`);
    ctx.chk.hard(ctx.bookings()[0].status === "confirmed", `the valid id should be settled; status=${ctx.bookings()[0].status}`, "medium");
    ctx.chk.soft(/Ma l9it/.test(String(r || "")), `the unknown id should be reported in the same reply; got: ${r}`);
  });

  await scenario("SEC20", "secretary", "Secretary smalltalk 'merci' / '👍' gets filed as a suggestion", MAH, async (ctx) => {
    const r1 = await ctx.sec("merci");
    const r2 = await ctx.sec("👍");
    ctx.chk.hard(ctx.sent().length === 0, "smalltalk must not trigger sends", "medium");
    ctx.chk.soft(!ctx.suggestions().some((s) => s.text === "merci" || s.text === "👍"),
      `secretary smalltalk is silently filed as a bot 'suggestion' (suggestions: ${JSON.stringify(ctx.suggestions().map((s) => s.text))}); acks: ${r1} / ${r2}`, "low");
  });

  await scenario("SEC21", "secretary", "EXPIRED doctor answer (>2h): secretary free text must NOT be forwarded", JRA, async (ctx) => {
    bot._pendingDoctorAnswer.set(JRA, { patientPhone: ctx.phone, ts: Date.now() - 3 * 3600 * 1000 });
    const r = await ctx.sec("El reponse lel sou2el: ey, na3mlou el implants.");
    ctx.chk.hard(ctx.sentTo(ctx.phone).length === 0,
      `an expired doctor answer must not be forwarded to the patient; sends: ${JSON.stringify(ctx.sent().map((b) => b.to))}`, "high");
    ctx.chk.soft(!/Woslet lel patient/.test(String(r || "")), `reply must not claim delivery; got: ${r}`);
  }, { phone: "21655600108" });

  await scenario("SEC22", "secretary", "Secretary asks in French: 'Combien de rendez-vous en attente ?'", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Sami Trabelsi");
    const r = await ctx.sec("Combien de rendez-vous en attente ?");
    ctx.chk.soft(/en cours|attente|1 rendez-vous/i.test(String(r || "")),
      `a French status question from the secretary gets no useful answer; got: ${r}`, "low");
    ctx.chk.soft(!ctx.suggestions().some((s) => /Combien/.test(s.text)),
      `the question was filed as a suggestion instead of answered; got: ${r}`, "low");
  });

  await scenario("SEC23", "secretary", "Admin (no clinic) 'list' sees BOTH clinics' pending + can settle cross-clinic", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Sami Trabelsi");
    const p2 = "21655600109";
    await bot.processPatientText(p2, "nheb na7jez el jom3a el 10 mta3 el sbe7", JRA);
    await bot.processPatientText(p2, "ey", JRA);
    await bot.processPatientText(p2, "Omar Haddad", JRA);
    const bMah = ctx.bookings()[0];
    const bJra = stubDb._inspect().bookings.find((b) => b.phone === p2);
    ctx.chk.hard(!!bMah && !!bJra, "setup: one pending booking per clinic");
    const rList = await bot.processSecretaryText("list", undefined, "17174204057");
    ctx.chk.hard(String(rList || "").includes(String(bMah.id)) && String(rList || "").includes(String(bJra.id)),
      `admin list should show both clinics' pending bookings; got: ${rList}`, "medium");
    const rOk = await bot.processSecretaryText(`ok ${bJra.id}`, undefined, "17174204057");
    ctx.chk.hard(stubDb._inspect().bookings.find((b) => b.phone === p2).status === "confirmed",
      `admin should be able to settle a Jrad booking; reply: ${rOk}`, "medium");
  });
}

// ================= Family 2: multi-turn state chaos =================
async function runChaos() {
  await scenario("CHA1", "chaos", "Book -> cancel -> rebook the SAME slot (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Karim Ben Ammar");
    ctx.chk.hard(ctx.bookings().length === 1, "setup: booking exists");
    await ctx.say("nheb nlaghi el rendez-vous mte3i");
    ctx.chk.hard(ctx.bookings()[0].status === "cancelled", `booking should be cancelled; got ${ctx.bookings()[0].status}`, "medium");
    await ctx.say("nheb na7jez ghodwa el 10 mta3 el sbe7");
    await ctx.say("ey");
    await ctx.say("Karim Ben Ammar");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 2 && bs[1].status === "pending" && hasDate(bs[1].slot, "15-10-2026"),
      `the same slot should be rebookable after a cancellation; bookings: ${JSON.stringify(bs)}`, "high");
  });

  await scenario("CHA2", "chaos", "Reschedule TWICE in a row (Jrad): Thu 10h -> Fri 11h -> Sat 12h", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Omar Haddad");
    await ctx.say("nheb nbaddel el rendez-vous lel jom3a el 11");
    let r = ctx.last();
    if (/t7eb|ey|confirme/i.test(String(r || ""))) await ctx.say("ey");
    await ctx.say("nheb nbaddlou lel sabt el 12");
    r = ctx.last();
    if (/t7eb|ey|confirme/i.test(String(r || ""))) await ctx.say("ey");
    const active = ctx.bookings().filter((b) => b.status === "pending" || b.status === "confirmed");
    ctx.chk.hard(active.length === 1 && hasDate(active[0].slot, "17-10-2026") && hasDate(active[0].slot, "12:00"),
      `after two reschedules exactly one active booking should remain, Sat 17-10 12:00; bookings: ${JSON.stringify(ctx.bookings())}`, "high");
  });

  await scenario("CHA3", "chaos", "Duplicate accepts: propose -> ey -> ey -> ey -> name", MAH, async (ctx) => {
    await ctx.say("nheb na7jez ghodwa el 10 mta3 el sbe7");
    await ctx.say("ey");
    await ctx.say("ey");
    await ctx.say("ey");
    await ctx.say("Karim Ben Ammar");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length <= 1, `duplicate 'ey' must not create multiple bookings; got ${bs.length}`, "high");
    if (bs.length === 1) ctx.chk.soft(/Karim/.test(bs[0].patient_name || ""),
      `the real name should win over the stray 'ey' answers; booking name: ${bs[0].patient_name}`);
  });

  await scenario("CHA4", "chaos", "Duplicate cancels x3 after booking (Jrad)", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Omar Haddad");
    await ctx.say("nheb nlaghi el rendez-vous mte3i");
    await ctx.say("nheb nlaghi el rendez-vous mte3i");
    const r3 = await ctx.say("nheb nlaghi el rendez-vous mte3i");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && bs[0].status === "cancelled", `booking stays cancelled, nothing resurrected; bookings: ${JSON.stringify(bs)}`, "medium");
    ctx.chk.hard(typeof r3 === "string" && r3.length > 0, "third cancel still gets a reply");
  });

  await scenario("CHA5", "chaos", "Answer to a question never asked: fresh patient opens with 'ey' / 'oui'", MAH, async (ctx) => {
    const r1 = await ctx.say("ey");
    ctx.chk.hard(ctx.bookings().length === 0, "a bare 'ey' with no proposal must not book anything", "high");
    ctx.chk.hard(typeof r1 === "string" && r1.length > 0, `bot should respond (greeting/menu); got: ${r1}`);
    const p2 = "33631009901";
    const r2 = await bot.processPatientText(p2, "oui", MAH);
    ctx.chk.hard(stubDb._inspect().bookings.filter((b) => b.phone === p2).length === 0, "a bare 'oui' must not book anything", "high");
    ctx.chk.hard(typeof r2 === "string" && r2.length > 0, `bot should respond to a bare 'oui'; got: ${r2}`);
  });

  await scenario("CHA6", "chaos", "Fresh patient opens with a bare name only", JRA, async (ctx) => {
    const r = await ctx.say("Mohamed Trabelsi");
    ctx.chk.hard(ctx.bookings().length === 0, "a bare name must not create a booking", "high");
    ctx.chk.soft(/kifech|n3awnek|rendez-vous|t7eb|na7jez/i.test(String(r || "")),
      `bot should ask what the patient needs; got: ${r}`);
  });

  await scenario("CHA7", "chaos", "Two topics in one message: cancel + price question (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Karim Ben Ammar");
    const r = await ctx.say("nheb nlaghi el rendez-vous mte3i, w zid 9olli 9adech el consultation?");
    ctx.chk.hard(ctx.bookings()[0].status === "cancelled",
      `the cancel half of the message must still be executed; status=${ctx.bookings()[0].status}`, "high");
    ctx.chk.soft(/consultation|soum|prix|tbib|nes2el/i.test(String(r || "")),
      `the price half should also be addressed (answer or doctor-question offer); got: ${r}`);
  });

  await scenario("CHA8", "chaos", "2000+ char message, distractor dates, real request at the very end (Mahjoub)", MAH, async (ctx) => {
    const filler = "ena kont bech nji el thleth el fat ama el thleth ma yse3ednich, w el arba3 kif kif, ".repeat(30);
    const msg = filler + "fi el a5er a7jezli el jom3a el 10 mta3 el sbe7";
    ctx.chk.hard(msg.length > 2000, "setup: message is 2000+ chars");
    const r = await ctx.say(msg);
    ctx.chk.soft(hasDate(r, "16-10-2026"),
      `the FINAL instruction (Friday) should win over distractor weekdays in the filler; got: ${String(r).slice(0, 200)}`);
    ctx.chk.hard(ctx.bookings().length === 0, "no booking after one turn");
  });

  await scenario("CHA9", "chaos", "Emoji-only messages", MAH, async (ctx) => {
    const r1 = await ctx.say("😀😀😀");
    const r2 = await ctx.say("🦷❓");
    ctx.chk.hard(typeof r1 === "string" && r1.length > 0 && typeof r2 === "string" && r2.length > 0,
      `emoji-only messages need a graceful reply; got: ${r1} / ${r2}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "emojis must not book");
  });

  await scenario("CHA10", "chaos", "Punctuation-only messages '???' / '....'", JRA, async (ctx) => {
    const r1 = await ctx.say("???");
    const r2 = await ctx.say("....");
    ctx.chk.hard(typeof r1 === "string" && r1.length > 0 && typeof r2 === "string" && r2.length > 0,
      `punctuation-only messages need a graceful reply; got: ${r1} / ${r2}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "punctuation must not book");
  });

  await scenario("CHA11", "chaos", "Whitespace / empty message", MAH, async (ctx) => {
    const r1 = await ctx.say("   ");
    const r2 = await ctx.say("");
    ctx.chk.hard(ctx.bookings().length === 0, "empty input must not book");
    ctx.chk.soft(typeof r1 === "string" && typeof r2 === "string",
      `empty input should still return a string reply, not null/undefined; got: ${JSON.stringify(r1)} / ${JSON.stringify(r2)}`, "low");
  });

  await scenario("CHA12", "chaos", "ALL CAPS cancel after a normal booking (Jrad)", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Omar Haddad");
    const r = await ctx.say("NHEB NLAGHI EL RENDEZ-VOUS MTE3I");
    ctx.chk.hard(ctx.bookings()[0].status === "cancelled",
      `an ALL-CAPS cancel should work like lowercase; status=${ctx.bookings()[0].status}; reply: ${r}`, "medium");
  });

  await scenario("CHA13", "chaos", "Voice-note placeholder texts", MAH, async (ctx) => {
    const r1 = await ctx.say("[Audio]");
    const r2 = await ctx.say("(رسالة صوتية)");
    const r3 = await ctx.say("[voice note]");
    ctx.chk.hard(ctx.bookings().length === 0, "placeholders must not book");
    ctx.chk.hard([r1, r2, r3].every((x) => typeof x === "string" && x.length > 0), "each placeholder gets a reply", "medium");
    ctx.chk.soft(/ekteb|écris|texte|ktib|message maktoub/i.test([r1, r2, r3].join(" ")),
      `the bot should ask the patient to write the request as text (it cannot hear voice notes); got: ${r1} / ${r2} / ${r3}`, "low");
  });

  await scenario("CHA14", "chaos", "Message is only a phone number / only the word 'test'", JRA, async (ctx) => {
    const r1 = await ctx.say("22123456");
    const r2 = await ctx.say("test");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking from a number or 'test'", "medium");
    ctx.chk.hard(typeof r1 === "string" && r1.length > 0 && typeof r2 === "string" && r2.length > 0, "graceful replies expected");
  });

  await scenario("CHA15", "chaos", "Patient cancels AFTER the secretary already CONFIRMED the booking (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Karim Ben Ammar");
    const b = ctx.bookings()[0];
    await ctx.sec(`ok ${b.id}`);
    ctx.chk.hard(ctx.bookings()[0].status === "confirmed", "setup: booking confirmed by secretary");
    const r = await ctx.say("nheb nlaghi el rendez-vous mte3i");
    const now = ctx.bookings()[0];
    if (now.status === "confirmed") {
      ctx.chk.hard(!/tlagha|tfaskh|annulé/i.test(String(r || "")),
        `bot claims it cancelled but the confirmed booking is untouched (status=confirmed); reply: ${r}`, "medium");
      ctx.chk.soft(/secrétaire|tbib|contact|appelez|nizem tetwasel/i.test(String(r || "")),
        `if the bot cannot cancel a confirmed booking it should say the clinic must handle it; got: ${r}`);
    } else {
      ctx.chk.hard(now.status === "cancelled", `expected cancelled or confirmed-with-explanation; got ${now.status}`);
    }
  });

  await scenario("CHA16", "chaos", "Slot hopping: propose Fri -> 'le, el sabt' -> 'le, el thenin' -> ey (Jrad)", JRA, async (ctx) => {
    await ctx.say("nheb na7jez el jom3a el 10 mta3 el sbe7");
    await ctx.say("le, el sabt el 11 mta3 el sbe7");
    const r3 = await ctx.say("le, el thenin el 9 mta3 el sbe7");
    ctx.chk.soft(hasDate(r3, "19-10-2026"), `the proposal should track the LAST counter-proposal (Mon 19-10); got: ${r3}`);
    await ctx.say("ey");
    await ctx.say("Omar Haddad");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "19-10-2026") && hasDate(bs[0].slot, "09:00"),
      `exactly one booking, on the last hopped slot Mon 19-10 09:00; bookings: ${JSON.stringify(bs)}`, "high");
  });

  await scenario("CHA17", "chaos", "Patient fires secretary-shaped commands as a PATIENT: 'ok 1', 'list', 'rapport', 'fassa5 <num>'", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Karim Ben Ammar");
    const b = ctx.bookings()[0];
    const msgsBefore = ctx.messagesOf(ctx.phone).length;
    const r1 = await ctx.say(`ok ${b.id}`);
    const r2 = await ctx.say("list");
    const r3 = await ctx.say("rapport");
    const r4 = await ctx.say(`fassa5 ${ctx.phone}`);
    ctx.chk.hard(ctx.bookings()[0].status === "pending",
      `a patient must never settle his own booking (status=${ctx.bookings()[0].status})`, "high");
    ctx.chk.hard(ctx.messagesOf(ctx.phone).length > msgsBefore, "a patient 'fassa5' must not delete the conversation", "high");
    ctx.chk.hard(ctx.sent().filter((x) => x.type === "document").length === 0, "a patient 'rapport' must not trigger a document send", "high");
    ctx.chk.hard(!/Tsajlou|Tfass5et el conversation|Tbe3ath el rapport/.test([r1, r2, r3, r4].join(" ")),
      `patient-side command shapes must not produce secretary confirmations; replies: ${r1} / ${r4}`, "medium");
  }, { phone: "21655600110" });
}

// ================= Family 3: dates / times torture =================
// Frozen: Wed 2026-10-14 09:00 Tunis.
async function runDates2() {
  await probe("DAT1", "'le 1er novembre à 10h' — Nov 1 is a SUNDAY (Mahjoub)", MAH,
    "Je voudrais un rendez-vous le 1er novembre à 10h", { notDate: "01-11-2026", sev: "high" });
  await probe("DAT2", "'le 31/10 à 10h' — Saturday, Jrad open 9-14", JRA,
    "Je voudrais un rendez-vous le 31/10 à 10h", { date: "31-10-2026", time: "10:00" });
  await probe("DAT3", "'le 01/11 à 10h' — Sunday numeric (Jrad)", JRA,
    "Je voudrais un rendez-vous le 01/11 à 10h", { notDate: "01-11-2026", sev: "high" });
  await probe("DAT4", "Derja 'ba3d ghodwa b nhar' = +3 days = Sat 17-10 (Mahjoub)", MAH,
    "nheb na7jez ba3d ghodwa b nhar el 10 mta3 el sbe7", { date: "17-10-2026", sev: "low" });
  await probe("DAT5", "Derja 'el thleth mta3 el esbou3 el jay' = Tue 20-10 (Mahjoub)", MAH,
    "nheb na7jez el thleth mta3 el esbou3 el jay el 10 mta3 el sbe7", { date: "20-10-2026" });
  await probe("DAT6", "French 'mardi de la semaine prochaine' = Tue 20-10 (Mahjoub)", MAH,
    "Je voudrais un rendez-vous mardi de la semaine prochaine à 10h", { date: "20-10-2026" });
  await probe("DAT7", "Ambiguous 'le 11/12' must read DD/MM = 11 Dec (Mahjoub)", MAH,
    "Je voudrais un rendez-vous le 11/12 à 10h", { date: "11-12-2026", notDate: "12-11-2026", sev: "high" });
  await probe("DAT8", "Vague 'mi-novembre' must not be turned into a concrete slot (Mahjoub)", MAH,
    "Je voudrais un rendez-vous mi-novembre", { noSlot: true });
  await probe("DAT9", "Derja 'awel el chhar' — ambiguous (Oct 1 past / Nov 1 Sunday-closed)", MAH,
    "nheb na7jez awel el chhar el 10 mta3 el sbe7", { notDate: "01-11-2026", sev: "medium",
      extra: (ctx, r) => ctx.chk.hard(!hasDate(r, "01-10-2026"), `must not propose the past Oct 1; got: ${r}`, "medium") });
  await probe("DAT10", "Derja 'a5er el chhar' = Sat 31-10 (Mahjoub)", MAH,
    "nheb na7jez a5er el chhar el 10 mta3 el sbe7", { date: "31-10-2026", sev: "low" });
  await probe("DAT11", "French 'vendredi à 13h30' — Jrad Friday closes 14:00", JRA,
    "Je voudrais un rendez-vous vendredi à 13h30", { date: "16-10-2026", time: "13:30" });
  await probe("DAT12", "French 'vendredi à 1h de l'après-midi' = 13:00 (Jrad)", JRA,
    "Je voudrais un rendez-vous vendredi à 1h de l'après-midi", { date: "16-10-2026", time: "13:00" });
  await probe("DAT13", "Derja 'el wa7da w nos mta3 la3chiya' = 13:30 tomorrow (Mahjoub)", MAH,
    "nheb na7jez ghodwa el wa7da w nos mta3 la3chiya", { date: "15-10-2026", time: "13:30" });
  await probe("DAT14", "French 'jeudi à midi et demi' = 12:30 (Jrad)", JRA,
    "Je voudrais un rendez-vous jeudi à midi et demi", { date: "15-10-2026", time: "12:30" });
  await probe("DAT15", "Five minutes before closing: Jrad Thu 15h55 (closes 16:00)", JRA,
    "Je voudrais un rendez-vous jeudi à 15h55", { date: "15-10-2026", time: "15:55", sev: "low" });
  await probe("DAT16", "Inside displayed hours but past BOOKING end: Mahjoub Fri 17h25 (booking ends 17:00)", MAH,
    "Je voudrais un rendez-vous vendredi à 17h25", { notDate: "16-10-2026, 17:25", sev: "medium" });
  await probe("DAT17", "Five minutes before Saturday close: Mahjoub Sat 12h55 (closes 13:00)", MAH,
    "Je voudrais un rendez-vous samedi à 12h55", { date: "17-10-2026", time: "12:55", sev: "low" });
  await probe("DAT18", "Today but EARLIER than now: Mahjoub 'lyoum el 8 w nos' (now 09:00)", MAH,
    "nheb na7jez lyoum el 8 w nos mta3 el sbe7", { notDate: "14-10-2026, 08:30", sev: "high" });
  await probe("DAT19", "Today later than now (control): Mahjoub 'aujourd'hui à 10h'", MAH,
    "Je voudrais un rendez-vous aujourd'hui à 10h", { date: "14-10-2026", time: "10:00" });
  await probe("DAT20", "Derja 'el 5mis el jay' from Wednesday = TOMORROW 15-10, not +8 (Jrad)", JRA,
    "nheb na7jez el 5mis el jay el 10 mta3 el sbe7", { date: "15-10-2026", notDate: "22-10-2026" });
  await probe("DAT21", "Derja 'el a7ad el jay' = Sun 18-10 — closed (Jrad)", JRA,
    "nheb na7jez el a7ad el jay el 10 mta3 el sbe7", { notDate: "18-10-2026", sev: "high" });
}

// ================= Family 4: language chaos =================
async function runLang2() {
  await scenario("LNG1", "lang2", "Full ENGLISH booking attempt (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("Hello, I would like to book an appointment tomorrow at 10 am please");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking from one English turn", "medium");
    ctx.chk.hard(typeof r === "string" && r.length > 0, `English patient must get some reply; got: ${r}`);
    ctx.chk.soft(hasDate(r, "15-10-2026") || /quel|which|when|9olli|anhou nhar|jour/i.test(String(r || "")),
      `English request is neither understood (propose Thu 15-10) nor clarified; got: ${r}`, "medium");
  });

  await scenario("LNG2", "lang2", "ONE line mixing French + Arabic script + Arabizi (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("slm, je voudrais نحجز ghodwa à 10h svp");
    ctx.chk.soft(hasDate(r, "15-10-2026"), `the mixed request should still resolve ghodwa + 10h; got: ${r}`);
    ctx.chk.soft(isAR(r), `Arabic script in the message should win the reply language (standing rule); got: ${r}`);
    ctx.chk.hard(ctx.bookings().length === 0, "no booking after one turn");
  });

  await scenario("LNG3", "lang2", "Language switches EVERY message: FR greeting -> Derja slot -> Arabic 'اي' -> name (Mahjoub)", MAH, async (ctx) => {
    await ctx.say("Bonjour");
    await ctx.say("nheb na7jez ghodwa el 10 mta3 el sbe7");
    await ctx.say("اي");
    await ctx.say("Yassine Ben Ammar");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "15-10-2026") && hasDate(bs[0].slot, "10:00"),
      `the booking must survive per-message language switching; bookings: ${JSON.stringify(bs)}`, "high");
  });

  await scenario("LNG4", "lang2", "Typos-heavy Derja: 'slm cv n7b n7jz rndv ghdwa el 10' (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("slm cv n7b n7jz rndv ghdwa el 10");
    ctx.chk.soft(hasDate(r, "15-10-2026"),
      `consonant-only Derja (n7jz/ghdwa) should still resolve tomorrow 15-10; got: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking after one turn");
  });

  await scenario("LNG5", "lang2", "Typos-heavy French: 'bonjor je voudre un randez-vous venderdi a 10h' (Jrad)", JRA, async (ctx) => {
    const r = await ctx.say("bonjor je voudre un randez-vous venderdi a 10h");
    ctx.chk.soft(hasDate(r, "16-10-2026"),
      `misspelled French ('venderdi', 'randez-vous') should still resolve Friday 16-10; got: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking after one turn");
  });

  await scenario("LNG6", "lang2", "Derja with French embedded + vague time: 'nheb na7jez un rendez-vous ghodwa le matin' (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("nheb na7jez un rendez-vous ghodwa le matin");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking without a concrete time", "medium");
    ctx.chk.soft(hasDate(r, "15-10-2026") || /sbe7|matin|wa9t|heure|9olli/i.test(String(r || "")),
      `bot should pin down the morning time for tomorrow; got: ${r}`);
  });

  await scenario("LNG7", "lang2", "Full Arabic (MSA) booking: 'أريد حجز موعد غدا على الساعة العاشرة صباحا' (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("أريد حجز موعد غدا على الساعة العاشرة صباحا");
    ctx.chk.soft(hasDate(r, "15-10-2026") && hasDate(r, "10:00"),
      `MSA booking should resolve tomorrow 15-10 at 10:00; got: ${r}`, "medium");
    ctx.chk.soft(isAR(r), `reply should be in Arabic script; got: ${r}`);
  });

  await scenario("LNG8", "lang2", "English status question after a Derja booking (Jrad)", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Omar Haddad");
    const r = await ctx.say("when is my appointment?");
    ctx.chk.soft(hasDate(r, "15-10-2026"),
      `an English 'when is my appointment?' should still surface the booked slot; got: ${r}`, "medium");
    ctx.chk.hard(ctx.bookings().length === 1, "booking untouched");
  });
}

// ================= Family 5: business-rule probes =================
async function runBusiness() {
  await scenario("BIZ1", "business", "Asking for the OTHER doctor's prices on this line (Mahjoub line, asks about Jrad)", MAH, async (ctx) => {
    const r = await ctx.say("9adech el consultation 3and Dr Jrad?");
    ctx.chk.hard(!String(r || "").includes("28192232"), "must not leak the other clinic's supervisor number", "high");
    ctx.chk.hard(!/\d+\s*(dt|dinar)/i.test(String(r || "")), `must not quote a price for another doctor; got: ${r}`, "medium");
    ctx.chk.soft(/Mahjoub|3iyadetna|el tbib mte3na|houni/i.test(String(r || "")) || ctx.armed(),
      `bot should answer for THIS clinic or offer to ask its own doctor; got: ${r}`);
  });

  await scenario("BIZ2", "business", "'enti robot walla insan?' in Derja (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("enti robot walla insan?");
    ctx.chk.hard(!/ena (insan|bachar)|je suis humain|je suis une personne/i.test(String(r || "")),
      `bot must not claim to be human; got: ${r}`, "medium");
    ctx.chk.soft(/assistant|مساعد|automatique|robot/i.test(String(r || "")),
      `bot should honestly present itself as an assistant; got: ${r}`);
  });

  await scenario("BIZ3", "business", "'هل أنت روبوت؟' in Arabic (Jrad)", JRA, async (ctx) => {
    const r = await ctx.say("هل أنت روبوت؟");
    ctx.chk.hard(!/أنا إنسان|أنا بشر|أنا السكرتيرة/i.test(String(r || "")),
      `bot must not claim to be human (Arabic); got: ${r}`, "medium");
    ctx.chk.soft(/مساعد|assistant/i.test(String(r || "")), `bot should present itself as an assistant; got: ${r}`);
  });

  await scenario("BIZ4", "business", "Polite Derja ask for the doctor's PERSONAL number (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("najem na5ou numero el tbib el personnel bech nkallou directement?");
    ctx.chk.hard(!String(r || "").includes("98800749"), "must not leak the supervisor/personal number", "high");
    ctx.chk.soft(String(r || "").length > 10, `bot should deflect politely; got: ${r}`);
  });

  await scenario("BIZ5", "business", "Hard negotiation, 3 rounds in Derja (Jrad)", JRA, async (ctx) => {
    await ctx.say("9adech el consultation?");
    const r2 = await ctx.say("ghalia barcha, na9assli chwaya");
    const r3 = await ctx.say("ken njib m3aya zouz s7abi, ta3mallehom soum a9al?");
    for (const [i, rr] of [r2, r3].entries()) {
      ctx.chk.hard(!/\d+\s*(dt|dinar|%)/i.test(String(rr || "")),
        `negotiation round ${i + 2} must not invent a price/discount; got: ${rr}`, "medium");
    }
    ctx.chk.soft(String(r3 || "").length > 10, `bot should keep answering politely; got: ${r3}`);
  });

  await scenario("BIZ6", "business", "Discount for two people, French (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("Si je viens avec ma femme, vous faites un tarif pour deux ?");
    ctx.chk.hard(!/\d+\s*(dt|dinar|%)/i.test(String(r || "")), `must not invent a two-person tariff; got: ${r}`, "medium");
    ctx.chk.soft(/docteur|tarif|prix|demander/i.test(String(r || "")), `bot should deflect to the clinic's fixed tariffs / the doctor; got: ${r}`);
  });

  await scenario("BIZ7", "business", "Home-visit question in Derja (Jrad)", JRA, async (ctx) => {
    const r = await ctx.say("el tbib ynajem yji lel dar walla le?");
    ctx.chk.hard(ctx.bookings().length === 0, "a home-visit question must not create a clinic booking", "medium");
    ctx.chk.soft(!/ey, ynajem yji|oui, il peut venir/i.test(String(r || "")),
      `bot must not confirm home visits (unknown service); got: ${r}`);
    ctx.chk.soft(/nes2el|tbib|3iyada|contact|na7jez/i.test(String(r || "")),
      `bot should offer to ask the doctor or redirect to the clinic; got: ${r}`, "low");
  });

  await scenario("BIZ8", "business", "CNAM question in Derja (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("ta5dmou bel CNAM?");
    ctx.chk.hard(!/\d+\s*%/.test(String(r || "")), `must not invent a reimbursement rate; got: ${r}`, "medium");
    ctx.chk.soft(!/ey, n5admou bel CNAM|oui, nous travaillons avec la CNAM/i.test(String(r || "")),
      `bot must not assert CNAM coverage it does not know; got: ${r}`);
  });

  await scenario("BIZ9", "business", "CNAM question in French (Jrad)", JRA, async (ctx) => {
    const r = await ctx.say("Vous travaillez avec la CNAM ?");
    ctx.chk.hard(!/\d+\s*%/.test(String(r || "")), `must not invent a reimbursement rate; got: ${r}`, "medium");
    ctx.chk.soft(!/oui, nous (travaillons|acceptons).*CNAM/i.test(String(r || "")),
      `bot must not assert CNAM coverage it does not know; got: ${r}`);
  });

  await scenario("BIZ10", "business", "Service + price confusion: '9adech blanchiment el asnen?' (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("9adech blanchiment el asnen?");
    ctx.chk.hard(!/\d+\s*(dt|dinar)/i.test(String(r || "")), `must not invent a blanchiment price; got: ${r}`, "medium");
    ctx.chk.soft(/tbib|nes2el|soum|consultation/i.test(String(r || "")), `bot should route to the doctor / consultation tariff; got: ${r}`, "low");
  });

  await scenario("BIZ11", "business", "Booking for a minor child in Derja (Jrad)", JRA, async (ctx) => {
    const r1 = await ctx.say("nheb na7jez l weldi, 3omrou 6 snin, ghodwa el 10 mta3 el sbe7");
    ctx.chk.soft(hasDate(r1, "15-10-2026"), `a child appointment should flow like any booking (Thu 15-10 proposed); got: ${r1}`);
    await ctx.say("ey");
    await ctx.say("Adam Ben Yassine");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 1 && hasDate(bs[0].slot, "15-10-2026"),
      `the child's appointment should be booked; bookings: ${JSON.stringify(bs)}`, "medium");
  });

  await scenario("BIZ12", "business", "Loose 'urgent' (travel tomorrow) — NOT a medical emergency (Mahjoub, French)", MAH, async (ctx) => {
    const r = await ctx.say("C'est urgent svp, je pars en voyage demain, je veux un rendez-vous vendredi à 10h");
    ctx.chk.hard(!/urgence|urgences|est3jeli/i.test(String(r || "")) || hasDate(r, "16-10-2026"),
      `a travel 'urgent' must not trigger the emergency hand-off; got: ${r}`, "medium");
    ctx.chk.soft(hasDate(r, "16-10-2026"), `the booking flow should engage (Fri 16-10 proposed); got: ${r}`);
    ctx.chk.hard(ctx.bookings().length === 0, "no booking after one turn");
  });

  await scenario("BIZ13", "business", "Grief + reschedule: 'je suis en deuil... déplacer mon rendez-vous' (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookFr("Je voudrais un rendez-vous vendredi à 10h", "Paul Martin");
    ctx.chk.hard(ctx.bookings().length === 1, "setup: booking exists");
    const r = await ctx.say("Je suis en deuil, mon père est décédé, je dois déplacer mon rendez-vous");
    ctx.chk.hard(!/urgence médicale|urgences|est3jeli/i.test(String(r || "")),
      `grief wording must not trigger a medical-emergency escalation; got: ${r}`, "medium");
    const r2 = await ctx.say("jeudi à 11h");
    if (/oui|confirme/i.test(String(r2 || ""))) await ctx.say("oui");
    const active = ctx.bookings().filter((b) => b.status === "pending" || b.status === "confirmed");
    ctx.chk.soft(active.some((b) => hasDate(b.slot, "15-10-2026")),
      `the reschedule should land on Thu 15-10; bookings: ${JSON.stringify(ctx.bookings())}`);
  });

  await scenario("BIZ14", "business", "Booking request MENTIONING mild pain (Mahjoub, French)", MAH, async (ctx) => {
    const r = await ctx.say("Je voudrais un rendez-vous samedi à 10h, j'ai une petite douleur à une dent depuis une semaine");
    ctx.chk.hard(!/paracétamol|ibuprofène|antibiotique|prenez|appliquez/i.test(String(r || "")),
      `bot must not give medical advice; got: ${r}`, "high");
    ctx.chk.soft(hasDate(r, "17-10-2026"),
      `a booking request that merely mentions pain should still engage the booking flow (Sat 17-10); got: ${r}`, "medium");
  });
}

// ================= Family 6: question-offer paths, new shapes =================
async function runQuestions2() {
  await scenario("QUE1", "questions2", "Derja doctor question, accepted in FRENCH 'oui' (Jrad)", JRA, async (ctx) => {
    const r1 = await ctx.say("3andi sou2el lel tbib: el tbib ya3mel el implants?");
    ctx.chk.hard(ctx.armed(), `Derja doctor question should arm the offer; reply: ${r1}`, "medium");
    await ctx.say("oui");
    ctx.chk.hard(ctx.forwardsTo(SUP_JRA).some((b) => JSON.stringify(b).toLowerCase().includes("implant")),
      `a French 'oui' should still forward the Derja question; sends: ${JSON.stringify(ctx.sent().map((b) => b.to))}`, "medium");
  });

  await scenario("QUE2", "questions2", "French doctor question, accepted in DERJA 'ey' (Mahjoub)", MAH, async (ctx) => {
    await ctx.say("Bonjour, j'ai une question pour le docteur : est-ce que vous posez les implants dentaires ?");
    ctx.chk.hard(ctx.armed(), "setup: offer armed");
    await ctx.say("ey");
    ctx.chk.hard(ctx.forwardsTo(SUP_MAH).some((b) => JSON.stringify(b).toLowerCase().includes("implant")),
      `a Derja 'ey' should still forward the French question; sends: ${JSON.stringify(ctx.sent().map((b) => b.to))}`, "medium");
  });

  await scenario("QUE3", "questions2", "Polite French decline: 'non merci' (Jrad)", JRA, async (ctx) => {
    await ctx.say("Bonjour, j'ai une question pour le docteur : est-ce que vous posez les implants dentaires ?");
    ctx.chk.hard(ctx.armed(), "setup: offer armed");
    const r = await ctx.say("non merci");
    ctx.chk.hard(ctx.forwardsTo(SUP_JRA).length === 0, "a declined offer must not forward anything", "high");
    ctx.chk.soft(isFR(r), `the decline ack should be in French; got: ${r}`);
  });

  await scenario("QUE4", "questions2", "Polite Derja decline: 'le choukran' (Mahjoub)", MAH, async (ctx) => {
    await ctx.say("3andi sou2el lel tbib: el tbib ya3mel el implants?");
    ctx.chk.hard(ctx.armed(), "setup: offer armed");
    const r = await ctx.say("le choukran");
    ctx.chk.hard(ctx.forwardsTo(SUP_MAH).length === 0, "a declined offer must not forward anything", "high");
    ctx.chk.soft(!isFR(r) || isAR(r), `the decline ack should stay in the patient's language family; got: ${r}`, "low");
  });

  await scenario("QUE5", "questions2", "Arabic question + Arabic polite decline 'لا شكرا' (Jrad)", JRA, async (ctx) => {
    await ctx.say("عندي سؤال للطبيب: هل يقوم بزراعة الأسنان؟");
    ctx.chk.hard(ctx.armed(), `Arabic doctor question should arm the offer; armed=${ctx.armed()}`, "medium");
    const r = await ctx.say("لا شكرا");
    ctx.chk.hard(ctx.forwardsTo(SUP_JRA).length === 0, "a declined offer must not forward anything", "high");
    ctx.chk.soft(isAR(r), `the decline ack should be in Arabic; got: ${r}`);
  });

  await scenario("QUE6", "questions2", "Verbose French accept: 'd'accord, vas-y' (Mahjoub)", MAH, async (ctx) => {
    await ctx.say("Bonjour, j'ai une question pour le docteur : est-ce que vous posez les implants dentaires ?");
    ctx.chk.hard(ctx.armed(), "setup: offer armed");
    await ctx.say("d'accord, vas-y");
    ctx.chk.hard(ctx.forwardsTo(SUP_MAH).some((b) => JSON.stringify(b).toLowerCase().includes("implant")),
      `'d'accord, vas-y' should count as acceptance and forward; sends: ${JSON.stringify(ctx.sent().map((b) => b.to))}`, "medium");
  });

  await scenario("QUE7", "questions2", "Callback request: 'Est-ce que le docteur peut me rappeler ?' (Mahjoub)", MAH, async (ctx) => {
    const r = await ctx.say("Est-ce que le docteur peut me rappeler ?");
    ctx.chk.hard(ctx.bookings().length === 0, "a callback request must not create a booking", "medium");
    ctx.chk.soft(ctx.armed() || /docteur|rappel|secrétaire|transmettre|demander/i.test(String(r || "")),
      `the callback request should be routed to the doctor/secretary (offer or forward), not dropped; got: ${r}; armed=${ctx.armed()}`, "medium");
  });

  await scenario("QUE8", "questions2", "Derja question WHILE a proposal is pending, then 'ey' x2 (Jrad)", JRA, async (ctx) => {
    await ctx.say("nheb na7jez el jom3a el 10 mta3 el sbe7");
    const r2 = await ctx.say("el tbib ye5dem bel CNAM?");
    const r3 = await ctx.say("ey");
    const fwdQ = ctx.sent().some((b) => JSON.stringify(b).includes("CNAM"));
    const propAlive = !!ctx.proposal() || ctx.bookings().length > 0;
    ctx.chk.soft(fwdQ || ctx.armed(),
      `a mid-proposal Derja question should arm/forward the question offer, not vanish (r2: ${r2}; r3: ${r3})`, "medium");
    if (fwdQ) {
      await ctx.say("ey");
      await ctx.say("Omar Haddad");
      ctx.chk.soft(ctx.bookings().length === 1 && hasDate(ctx.bookings()[0].slot, "16-10-2026"),
        `after the question, the original Friday proposal should still be bookable; bookings: ${JSON.stringify(ctx.bookings())}`);
    }
  });

  await scenario("QUE9", "questions2", "Decline question A, ask question B, accept B (Mahjoub)", MAH, async (ctx) => {
    await ctx.say("Bonjour, j'ai une question pour le docteur : est-ce que vous posez les implants dentaires ?");
    await ctx.say("non");
    const sendsAfterDecline = ctx.forwardsTo(SUP_MAH).length;
    ctx.chk.hard(sendsAfterDecline === 0, "declined question A must not be forwarded", "high");
    await ctx.say("J'ai une autre question pour le docteur : faites-vous le blanchiment ?");
    ctx.chk.hard(ctx.armed(), "a fresh question after a decline should re-arm the offer", "medium");
    await ctx.say("oui");
    ctx.chk.hard(ctx.forwardsTo(SUP_MAH).some((b) => JSON.stringify(b).toLowerCase().includes("blanchiment")),
      `question B should be forwarded after acceptance; sends: ${JSON.stringify(ctx.sent().map((b) => b.to))}`, "medium");
    ctx.chk.hard(!ctx.forwardsTo(SUP_MAH).some((b) => JSON.stringify(b).toLowerCase().includes("implant")),
      "question A must stay un-forwarded", "medium");
  });

  await scenario("QUE10", "questions2", "Answering the offer with ANOTHER question, then 'oui' (Jrad)", JRA, async (ctx) => {
    await ctx.say("Bonjour, j'ai une question pour le docteur : est-ce que vous posez les implants dentaires ?");
    ctx.chk.hard(ctx.armed(), "setup: offer armed");
    const r2 = await ctx.say("ça dépend, est-ce que c'est gratuit ?");
    const r3 = await ctx.say("oui");
    ctx.chk.soft(ctx.forwardsTo(SUP_JRA).some((b) => JSON.stringify(b).toLowerCase().includes("implant")),
      `after a clarifying detour, 'oui' should still forward the original question (r2: ${r2}; r3: ${r3})`, "medium");
  });
}

// ================= Family 7: identity / memory =================
async function runMemory() {
  await scenario("MEM1", "memory", "Status: 'C'est quand mon rendez-vous ?' after booking (Mahjoub, French)", MAH, async (ctx) => {
    await ctx.bookFr("Je voudrais un rendez-vous vendredi à 10h", "Paul Martin");
    const r = await ctx.say("C'est quand mon rendez-vous ?");
    ctx.chk.hard(hasDate(r, "16-10-2026"), `the status answer must state the booked date 16-10-2026; got: ${r}`, "medium");
    ctx.chk.soft(hasDate(r, "10:00"), `the status answer should include the time; got: ${r}`, "low");
  });

  await scenario("MEM2", "memory", "Status in Derja: 'wa9tech el rendez-vous mte3i?' (Jrad)", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Omar Haddad");
    const r = await ctx.say("wa9tech el rendez-vous mte3i?");
    ctx.chk.hard(hasDate(r, "15-10-2026"), `the status answer must state the booked date 15-10-2026; got: ${r}`, "medium");
  });

  await scenario("MEM3", "memory", "Status in Arabic: 'متى موعدي؟' (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Karim Ben Ammar");
    const r = await ctx.say("متى موعدي؟");
    ctx.chk.hard(hasDate(r, "15-10-2026"), `the Arabic status question must surface the booked date; got: ${r}`, "medium");
    ctx.chk.soft(isAR(r), `the reply should be in Arabic; got: ${r}`, "low");
  });

  await scenario("MEM4", "memory", "TWO bookings on one phone, then status question (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookFr("Je voudrais un rendez-vous vendredi à 10h", "Paul Martin");
    await ctx.bookFr("Je voudrais un rendez-vous samedi à 11h pour ma femme", "Marie Martin");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 2, `setup: two bookings should coexist; got ${bs.length}`, "medium");
    const r = await ctx.say("C'est quand mon rendez-vous ?");
    ctx.chk.soft(hasDate(r, "16-10-2026") || hasDate(r, "17-10-2026"),
      `the status answer should mention at least one of the two real slots; got: ${r}`);
    ctx.chk.soft(hasDate(r, "16-10-2026") && hasDate(r, "17-10-2026"),
      `ideally BOTH bookings are reported; got: ${r}`, "low");
  });

  await scenario("MEM5", "memory", "Cancel by DATE only: 'annule mon rendez-vous de vendredi' (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookFr("Je voudrais un rendez-vous vendredi à 10h", "Paul Martin");
    const r = await ctx.say("Annule mon rendez-vous de vendredi");
    if (ctx.bookings()[0].status !== "cancelled" && /confirme|êtes-vous sûr|voulez-vous/i.test(String(r || ""))) await ctx.say("oui");
    ctx.chk.hard(ctx.bookings()[0].status === "cancelled",
      `cancelling by weekday should cancel the Friday booking; status=${ctx.bookings()[0].status}; reply: ${r}`, "medium");
  });

  await scenario("MEM6", "memory", "Cancel ONE of two bookings by date: 'annule celui de samedi' (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookFr("Je voudrais un rendez-vous vendredi à 10h", "Paul Martin");
    await ctx.bookFr("Je voudrais un rendez-vous samedi à 11h pour ma femme", "Marie Martin");
    ctx.chk.hard(ctx.bookings().length === 2, "setup: two bookings");
    const r = await ctx.say("Annule celui de samedi");
    if (ctx.bookings().filter((b) => b.status === "cancelled").length === 0 && /confirme|lequel|sûr/i.test(String(r || ""))) await ctx.say("celui de samedi");
    const fri = ctx.bookings().find((b) => hasDate(b.slot, "16-10-2026"));
    const sat = ctx.bookings().find((b) => hasDate(b.slot, "17-10-2026"));
    ctx.chk.hard(!!sat && sat.status === "cancelled" && !!fri && fri.status === "pending",
      `only the Saturday booking should be cancelled (fri=${fri && fri.status}, sat=${sat && sat.status}); reply: ${r}`, "high");
  });

  await scenario("MEM7", "memory", "Status after the secretary REJECTED the booking (Mahjoub)", MAH, async (ctx) => {
    await ctx.bookFr("Je voudrais un rendez-vous vendredi à 10h", "Paul Martin");
    const b = ctx.bookings()[0];
    await ctx.sec(`le ${b.id}`);
    ctx.chk.hard(ctx.bookings()[0].status === "cancelled", "setup: booking rejected by secretary");
    const r = await ctx.say("C'est quand mon rendez-vous ?");
    ctx.chk.hard(!(hasDate(r, "16-10-2026") && !/annul|cancel/i.test(String(r || ""))),
      `the bot must not present a rejected booking as an upcoming appointment; got: ${r}`, "high");
  });

  await scenario("MEM8", "memory", "Second booking for the wife on the same phone keeps both names (Jrad)", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez el jom3a el 10 mta3 el sbe7", "Yassine Gharbi");
    await ctx.say("tawa nheb na7jez l marti el sabt el 11 mta3 el sbe7");
    await ctx.say("ey");
    await ctx.say("Fatma Gharbi");
    const bs = ctx.bookings();
    ctx.chk.hard(bs.length === 2, `both bookings should exist; got ${bs.length}`, "medium");
    if (bs.length === 2) {
      ctx.chk.hard(/Yassine/.test(bs[0].patient_name || "") && /Fatma/.test(bs[1].patient_name || ""),
        `each booking keeps its own beneficiary name; names: ${bs.map((b) => b.patient_name).join(" / ")}`, "medium");
    }
  });

  await scenario("MEM9", "memory", "Status after the secretary CONFIRMED: 'mon rendez-vous est bien confirmé ?' (Jrad)", JRA, async (ctx) => {
    await ctx.bookDerja("nheb na7jez ghodwa el 10 mta3 el sbe7", "Omar Haddad");
    const b = ctx.bookings()[0];
    await ctx.sec(`ok ${b.id}`);
    const r = await ctx.say("Mon rendez-vous est bien confirmé ?");
    ctx.chk.hard(/confirm/i.test(String(r || "")) && hasDate(r, "15-10-2026"),
      `after secretary validation the status answer should say CONFIRMED with the slot; got: ${r}`, "medium");
    ctx.chk.soft(!/en attente|pas encore/i.test(String(r || "")),
      `it should no longer claim to be awaiting validation; got: ${r}`, "low");
  });
}

// ================= Family 8: live incident 2026-10-13 (Fix V) =================
// A French patient at the Jrad name gate asked "Vous fermez a quelle heure
// le jeudi" — NO question mark, exactly as WhatsApp delivered it. The F8
// FAQ gate demanded looksLikeQuestion (only "?" / start-anchored question
// words), so the known hours fact fell through to the AI fallthrough and
// came back as an Arabizi non-answer. These scenarios pin the whole class:
// config-known FAQ questions, punctuation or not, at every booking state,
// in French / Derja / Arabic — plus the French doctor-practice question
// taking the escalation offer in French instead of an Arabizi fallback.
async function runLive() {
  await scenario("LV1", "live", "INCIDENT: French hours Q (no '?') at the Jrad name gate — config answer in French, name gate survives", JRA, async (ctx) => {
    await ctx.say("bonjour cv?");
    await ctx.say("Je veux un rendez-vous vendredi a 10h");
    await ctx.say("Oui");
    const r = await ctx.say("Vous fermez a quelle heure le jeudi");
    ctx.chk.hard(isFR(r), `the hours answer must be in French; got: ${r}`, "high");
    ctx.chk.hard(String(r || "").includes("16:00"), `the answer must give the real Thursday closing (16:00); got: ${r}`, "high");
    ctx.chk.hard(!/n2akkedlek|ma fhemtch|Ma 3andich/i.test(String(r || "")), `no Arabizi fallback may leak; got: ${r}`, "high");
    // The booking state is untouched: the awaited name still completes it.
    const r2 = await ctx.say("Ahmed Ben Salah");
    ctx.chk.hard(ctx.bookings().length === 1 && hasDate(ctx.bookings()[0].slot, "16-10-2026"),
      `the pending booking must complete after the FAQ detour; got reply: ${r2}, bookings: ${JSON.stringify(ctx.bookings())}`, "high");
  });

  await scenario("LV2", "live", "French hours Q (no '?'), cold conversation — answered, NOT swallowed into a Thursday slot proposal", JRA, async (ctx) => {
    await ctx.say("bonjour");
    const r = await ctx.say("Vous fermez a quelle heure le jeudi");
    ctx.chk.hard(isFR(r) && String(r || "").includes("16:00"), `expected the French hours answer with 16:00; got: ${r}`, "high");
    ctx.chk.hard(!hasDate(r, "15-10-2026"), `the reply must not turn the question into a 15-10-2026 booking; got: ${r}`, "high");
    ctx.chk.hard(ctx.bookings().length === 0, "no booking may be created");
  });

  await scenario("LV3", "live", "French hours Q (no '?') while a proposal is pending — FAQ answered, proposal still completable", JRA, async (ctx) => {
    await ctx.say("bonjour");
    await ctx.say("Je veux un rendez-vous vendredi a 10h");
    const r = await ctx.say("Vous fermez a quelle heure le jeudi");
    ctx.chk.hard(isFR(r) && String(r || "").includes("16:00"), `expected the French hours answer; got: ${r}`, "high");
    await ctx.say("Oui");
    const r2 = await ctx.say("Ahmed Ben Salah");
    ctx.chk.hard(ctx.bookings().length === 1 && hasDate(ctx.bookings()[0].slot, "16-10-2026"),
      `the proposal must survive the FAQ detour and complete; got: ${r2}`, "medium");
  });

  await scenario("LV4", "live", "Derja hours Q (no '?') at the name gate — Derja config answer, booking completes", JRA, async (ctx) => {
    await ctx.say("slem");
    await ctx.say("nheb na7jez el jom3a el 10 mta3 el sbe7");
    await ctx.say("ey");
    const r = await ctx.say("wa9tech tsakrou el 5amis");
    ctx.chk.hard(String(r || "").includes("Wa9t el 5edma") && String(r || "").includes("16:00"), `expected the Derja hours answer with 16:00; got: ${r}`, "medium");
    await ctx.say("Ahmed Ben Salah");
    ctx.chk.hard(ctx.bookings().length === 1, `the booking must complete after the FAQ detour; bookings: ${JSON.stringify(ctx.bookings())}`, "medium");
  });

  await scenario("LV5", "live", "Arabic hours Q (no '؟') at the name gate — Arabic config answer", JRA, async (ctx) => {
    await ctx.say("سلام");
    await ctx.say("نحب نحجز الجمعة العاشرة صباحا");
    await ctx.say("نعم");
    const r = await ctx.say("وقتاش تسكرو الخميس");
    ctx.chk.hard(isAR(r) && String(r || "").includes("16:00"), `expected the Arabic hours answer with 16:00; got: ${r}`, "medium");
  });

  await scenario("LV6", "live", "French doctor-practice Q, cold — French escalation offer, armed, 'oui' forwards to the supervisor", JRA, async (ctx) => {
    await ctx.say("bonjour");
    const r = await ctx.say("Est-ce que le docteur fait les implants dentaires ?");
    ctx.chk.hard(isFR(r) && /demande au docteur/i.test(String(r || "")),
      `expected the French ask-the-doctor offer; got: ${r}`, "high");
    ctx.chk.hard(ctx.armed(), "the question offer must be armed", "medium");
    const r2 = await ctx.say("oui");
    ctx.chk.hard(/demandé au docteur/i.test(String(r2 || "")), `the acceptance ack must be French; got: ${r2}`, "medium");
    ctx.chk.hard(ctx.forwardsTo(SUP_JRA).length >= 1, "the question must be forwarded to the Jrad supervisor", "medium");
  });

  await scenario("LV7", "live", "French doctor-practice Q at the name gate — French offer; giving the name still completes the booking", JRA, async (ctx) => {
    await ctx.say("bonjour");
    await ctx.say("Je veux un rendez-vous vendredi a 10h");
    await ctx.say("Oui");
    const r = await ctx.say("Est-ce que le docteur fait les implants dentaires ?");
    ctx.chk.hard(isFR(r) && /demande au docteur/i.test(String(r || "")),
      `expected the French ask-the-doctor offer at the name gate; got: ${r}`, "high");
    const r2 = await ctx.say("Ahmed Ben Salah");
    ctx.chk.hard(ctx.bookings().length === 1 && hasDate(ctx.bookings()[0].slot, "16-10-2026"),
      `the name must still complete the booking after the offer detour; got: ${r2}, bookings: ${JSON.stringify(ctx.bookings())}`, "medium");
  });
}

// ================= Family 9: localized rendering of clinic info (Fix W) ==
// Live 2026-10-13 16:47: after Fix V the French hours question WAS answered
// — with the stored hours string verbatim: "Horaires de travail : Thenin
// lel Jom3a: 09:00 - 16:00, Sebt: ..., Ahad: msakker." The stored text is
// authored in Arabizi; a French patient must get the same facts rendered
// in French, an Arabic patient in Arabic, a Derja patient in Arabizi.
// These scenarios pin the rendering on every patient-facing hours path.
async function runRender() {
  await scenario("W1", "render", "French hours Q, Jrad — fully-French rendered hours, no raw Arabizi config text", JRA, async (ctx) => {
    await ctx.say("bonjour");
    const r = await ctx.say("Vous fermez a quelle heure le jeudi");
    ctx.chk.hard(isFR(r), `the hours answer must be fully French; got: ${r}`, "high");
    ctx.chk.hard(String(r || "").includes("Lundi") && String(r || "").includes("16:00"), `expected French day names + the real hours; got: ${r}`, "high");
    ctx.chk.hard(String(r || "").includes("Vendredi et samedi") && String(r || "").includes("14:00"), `Fri+Sat must render as a French pair with 14:00; got: ${r}`, "high");
    ctx.chk.hard(String(r || "").includes("Dimanche") && String(r || "").includes("fermé"), `Sunday must render closed in French; got: ${r}`, "high");
    ctx.chk.hard(!/Thenin|Sebt|msakker|Jom3a/.test(String(r || "")), `no raw stored hours text may leak; got: ${r}`, "high");
  });

  await scenario("W2", "render", "French hours Q, Mahjoub — rendered French hours with half hours preserved", MAH, async (ctx) => {
    await ctx.say("bonjour");
    const r = await ctx.say("Quels sont vos horaires ?");
    ctx.chk.hard(isFR(r), `the hours answer must be fully French; got: ${r}`, "high");
    ctx.chk.hard(String(r || "").includes("08:30 - 17:30"), `the DISPLAYED hours (08:30-17:30), not the booking hours, must be rendered; got: ${r}`, "high");
    ctx.chk.hard(String(r || "").includes("Samedi") && String(r || "").includes("13:00"), `Saturday 08:30-13:00 must be rendered; got: ${r}`, "medium");
    ctx.chk.hard(String(r || "").includes("Dimanche") && String(r || "").includes("fermé"), `Sunday must render closed in French; got: ${r}`, "medium");
    ctx.chk.hard(!/Thenin|Sebt|msakker|Jom3a/.test(String(r || "")), `no raw stored hours text may leak; got: ${r}`, "high");
  });

  await scenario("W3", "render", "Derja hours Q, Jrad — Arabizi answer carrying the stored hours text", JRA, async (ctx) => {
    await ctx.say("slem");
    const r = await ctx.say("chnowa wa9t el 5edma ?");
    ctx.chk.hard(String(r || "").includes("Wa9t el 5edma"), `expected the Derja hours answer; got: ${r}`, "medium");
    ctx.chk.hard(String(r || "").includes(HOURS_JRA), `Derja rendering must carry the stored Arabizi hours text; got: ${r}`, "medium");
  });

  await scenario("W4", "render", "Arabic hours Q, Jrad — Arabic rendered hours, no Arabizi day names", JRA, async (ctx) => {
    await ctx.say("سلام");
    const r = await ctx.say("شنوة وقت الخدمة؟");
    ctx.chk.hard(isAR(r), `the hours answer must be in Arabic script; got: ${r}`, "high");
    ctx.chk.hard(String(r || "").includes("الخميس") && String(r || "").includes("16:00"), `expected Arabic day names + the real hours; got: ${r}`, "high");
    ctx.chk.hard(String(r || "").includes("الأحد"), `Sunday must be rendered in Arabic; got: ${r}`, "medium");
    ctx.chk.hard(!/Thenin|Sebt|Jom3a/.test(String(r || "")), `no Arabizi day names may leak into the Arabic answer; got: ${r}`, "high");
  });

  await scenario("W5", "render", "French hours Q at the Mahjoub name gate — rendered French, name gate survives", MAH, async (ctx) => {
    await ctx.say("bonjour cv?");
    await ctx.say("Je veux un rendez-vous vendredi a 10h");
    await ctx.say("Oui");
    const r = await ctx.say("Vous fermez a quelle heure le jeudi");
    ctx.chk.hard(isFR(r) && String(r || "").includes("17:30"), `expected the rendered French hours (Thu close 17:30); got: ${r}`, "high");
    ctx.chk.hard(!/Thenin|Sebt|msakker/.test(String(r || "")), `no raw stored hours text may leak; got: ${r}`, "high");
    const r2 = await ctx.say("Ahmed Ben Salah");
    ctx.chk.hard(ctx.bookings().length === 1 && hasDate(ctx.bookings()[0].slot, "16-10-2026"),
      `the pending booking must complete after the FAQ detour; got reply: ${r2}, bookings: ${JSON.stringify(ctx.bookings())}`, "high");
  });

  await scenario("W6", "render", "Unparseable stored hours — raw text fallback, the patient still gets an answer", JRA, async (ctx) => {
    await stubDb.saveClinicConfig(JRA, { hours: "Kol youm mel sbe7 lel lil, w el a7ad rou7" });
    await ctx.say("bonjour");
    const r = await ctx.say("Vous fermez a quelle heure le jeudi");
    await stubDb.clearClinicConfig(JRA);
    ctx.chk.hard(String(r || "").length > 0 && String(r || "").includes("rou7"),
      `an unparseable hours text must fall back to the raw stored text, never to silence; got: ${r}`, "high");
  });

  await scenario("W7", "render", "French out-of-hours rejection, Jrad — rendered French hours inside the rejection", JRA, async (ctx) => {
    await ctx.say("bonjour");
    const r = await ctx.say("Je veux un rendez-vous jeudi a 20h");
    ctx.chk.hard(isFR(r), `the rejection must be in French; got: ${r}`, "medium");
    ctx.chk.hard(String(r || "").includes("09:00 - 16:00"), `the rejection must carry the rendered French hours; got: ${r}`, "medium");
    ctx.chk.hard(!/Thenin|Sebt|msakker|Jom3a/.test(String(r || "")), `no raw stored hours text may leak; got: ${r}`, "high");
  });

  await scenario("W8", "render", "French Sunday request, Jrad — closed-day rejection with rendered French hours", JRA, async (ctx) => {
    await ctx.say("bonjour");
    const r = await ctx.say("Je veux un rendez-vous dimanche a 10h");
    ctx.chk.hard(isFR(r), `the closed-day reply must be in French; got: ${r}`, "medium");
    ctx.chk.hard(String(r || "").includes("09:00 - 16:00"), `the reply must carry the rendered French hours; got: ${r}`, "medium");
    ctx.chk.hard(!/Thenin|Sebt|msakker|Jom3a/.test(String(r || "")), `no raw stored hours text may leak; got: ${r}`, "high");
  });
}

// ================= Runner =================
(async () => {
  await runSecretary();
  await runChaos();
  await runDates2();
  await runLang2();
  await runBusiness();
  await runQuestions2();
  await runMemory();
  await runLive();
  await runRender();
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
