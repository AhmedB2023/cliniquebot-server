// test-extreme.js — adversarial extreme-case conversations (multi-turn personas).
// Drives the REAL processPatientText / processSecretaryText with an in-memory
// db stub. Asserts INVARIANTS after every turn (never exact wording):
//   - no crash, always a non-empty reply
//   - red lines: medical never answered, prices never invented, no blind confirms
//   - state integrity: stages/bookings/leads advance only on valid answers
//   - language mirror: Arabic-script in -> Arabic-script out
// No network, no Postgres, no AI key (AI paths fall back deterministically).
// Usage: node test-extreme.js   (exit 0 = all green)
process.env.PORT = "43118";
process.env.VIXA_NUMBERS = "52999999";

const path = require("path");

function makeStubDb() {
  const messages = [];
  const bookings = [];
  const proposals = new Map();
  const patients = new Map();
  const vendorLeads = new Map();
  const signups = [];
  const clinicConfigs = new Map();
  const scriptPrefs = new Map();
  const suggestions = [];
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
      proposals.delete(phone); patients.delete(phone); vendorLeads.delete(phone);
      return n;
    },
    saveBooking: async (phone, slot, slot_at = null, patient_name = null, number_id = null) => {
      const b = { id: seq++, phone, slot, slot_at, patient_name, number_id, status: "pending" };
      bookings.push(b); return b.id;
    },
    findPendingBooking: async (phone, slot_at) =>
      bookings.find((b) => b.phone === phone && b.slot_at === slot_at && b.status === "pending") || null,
    getBooking: async (id) => bookings.find((b) => b.id === id) || null,
    getLatestBooking: async (phone) => { const l = bookings.filter((b) => b.phone === phone); return l[l.length - 1] || null; },
    getPendingBookings: async (numberId) => bookings.filter((b) => b.status === "pending" && (!numberId || b.number_id === numberId)),
    setBookingStatus: async (id, status) => { const b = bookings.find((b) => b.id === id); if (b) b.status = status; },
    updateBookingSlot: async (id, slot, slot_at) => { const b = bookings.find((b) => b.id === id); if (b) { b.slot = slot; b.slot_at = slot_at; } },
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
      signups.push(s); return s.id;
    },
    getSignups: async () => [...signups].reverse(),
    deleteSignup: async (id) => { const i = signups.findIndex((s) => s.id === id); if (i >= 0) { signups.splice(i, 1); return 1; } return 0; },
    hasDb: () => true,
    saveSuggestion: async (numberId, fromPhone, text) => {
      const s = { id: seq++, number_id: numberId || null, from_phone: fromPhone || null, text, status: "new", created_at: "test" };
      suggestions.push(s); return s.id;
    },
    getSuggestions: async (numberId = null) => suggestions.filter((s) => !numberId || s.number_id === numberId).slice().reverse(),
    deleteSuggestion: async (id) => { const i = suggestions.findIndex((s) => s.id === id); if (i >= 0) { suggestions.splice(i, 1); return 1; } return 0; },
    getClinicConfig: async (numberId) => clinicConfigs.get(numberId) || null,
    saveClinicConfig: async (numberId, cfg) => { clinicConfigs.set(numberId, { phone_number_id: numberId, ...cfg }); },
    listClinicConfigs: async () => [...clinicConfigs.values()],
    getScriptPref: async (phone) => scriptPrefs.get(phone) || null,
    saveScriptPref: async (phone, script) => { scriptPrefs.set(phone, script); },
    clearClinicConfig: async (numberId) => { clinicConfigs.delete(numberId); },
  };
}
const stubDb = makeStubDb();
const dbPath = require.resolve(path.join(__dirname, "db.js"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: stubDb };

const bot = require("./index.js");
const dates = bot.dates;
dates.setNow(new Date("2026-09-22T18:30:00Z").getTime()); // Tue 19:30 Tunis

// ---------- assert framework ----------
let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; }
  else { fail++; console.log(`FAIL: ${name}${extra ? "\n  " + extra : ""}`); }
}

// ---------- invariant helpers ----------
const hasAr = (s) => /[\u0600-\u06FF]/.test(s || "");
const isNonEmpty = (r) => typeof r === "string" && r.trim().length > 0;
// Language mirror: Arabic-script in -> Arabic-script out (the strict direction).
const mirrorAr = (u) => (r) => (hasAr(u) && !hasAr(r) ? `user wrote Arabic script but reply has none: ${r.slice(0, 80)}` : null);
// Medical red line: reply must redirect to a doctor, never advise.
const MED_ADVICE = /(5oudh|echreb|na3tik|a3tik) (el )?dwe|chouf tbib/i;
const medicalSafe = (r) => {
  if (!/tbib/.test(r || "")) return `medical question not redirected to a doctor: ${(r || "").slice(0, 90)}`;
  return null;
};
// Price red line (VIXA): never invent a price; offer is always blech/gratuit.
const PRICE_NUM = /\d+\s*(DT|dinars?|دنانير|€|\$)/i;
const noPriceInvented = (r) => (PRICE_NUM.test(r || "") ? `price invented: ${(r || "").slice(0, 90)}` : null);

// Conversation runner: steps = [{u, c}] ; c(reply, api) -> error string | null.
async function convo(name, id, numId, disp, steps) {
  const api = {
    lead: () => stubDb.getVendorLead(id),
    stage: async () => ((await stubDb.getVendorLead(id)) || {}).stage || null,
    signups: () => stubDb.getSignups(),
    bookings: () => stubDb.getPendingBookings(),
    proposal: () => stubDb.getProposal(id),
    patientName: () => stubDb.getPatientName(id),
  };
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    let r;
    try {
      r = await bot.processPatientText(id, s.u, numId, disp);
    } catch (e) {
      ok(`${name} t${i} no-crash`, false, `threw: ${e.message} (user: ${s.u})`);
      continue;
    }
    ok(`${name} t${i} reply non-empty`, isNonEmpty(r), `user: ${s.u} -> ${JSON.stringify(r)}`);
    if (isNonEmpty(r)) {
      const mErr = mirrorAr(s.u)(r);
      ok(`${name} t${i} mirror`, !mErr, mErr || "");
    }
    if (s.c && isNonEmpty(r)) {
      let err = null;
      try { err = await s.c(r, api); } catch (e) { err = `check threw: ${e.message}`; }
      ok(`${name} t${i} ${s.d || "check"}`, !err, err ? `${err}\n  user: ${s.u}\n  reply: ${r.slice(0, 120)}` : "");
    }
  }
}

const VIXA = "21652999999";
const DENTIST = "777666555444333";
const vixStage = async (id) => ((await stubDb.getVendorLead(id)) || {}).stage || null;

async function main() {

  // ================= VIXA (53) extreme personas =================

  // X1 — the joker: joke answers at every stage must never become data.
  await convo("X1 joker", "x1", undefined, VIXA, [
    { u: "slm", c: (r) => (/3iyada/.test(r) ? null : "no qualify q") },
    { u: "ey", c: async (r, api) => (await api.stage() === "vixa_ask_name" ? null : "not at ask_name") },
    { u: "juste nes2el", c: async (r, api) =>
        (await api.stage()) === "vixa_ask_name" ? null : "sentence accepted as name!" },
    { u: "Dr Fola7i", c: async (r, api) =>
        (await api.stage()) === "vixa_ask_clinic" ? null : "name not accepted" },
    { u: "ma3andich clinique", c: async (r, api) =>
        (await api.stage()) !== null ? "denial not cleared!" : (/propriétaires/.test(r) ? null : "no not-owner redirect") },
    { u: "slm", c: (r) => (/3iyada/.test(r) ? null : "no fresh restart") },
  ]);

  // X2 — the interrogator: questions mid-flow get answered, stage preserved.
  await convo("X2 interrogator", "x2", undefined, VIXA, [
    { u: "kifech ye5dem?", c: (r) => (/patients/.test(r) ? null : "how-it-works not explained") },
    { u: "ey", c: async (r, api) => (await api.stage() === "vixa_ask_name" ? null : "no ask_name") },
    { u: "b9adech?", c: async (r, api) =>
        /blech/.test(r) && (await api.stage()) === "vixa_ask_name" ? null : "prix not answered / stage moved" },
    { u: "chkoun enti?", c: async (r, api) =>
        /VIXA/.test(r) && (await api.stage()) === "vixa_ask_name" ? null : "who not answered / stage moved" },
    { u: "t7eb tbi3li chay?", c: async (r, api) =>
        (await api.stage()) === "vixa_ask_name" ? null : "hostile q broke the flow" },
  ]);

  // X3 — French-only doctor, full happy path in French.
  await convo("X3 french doctor", "x3", undefined, VIXA, [
    { u: "bonjour", c: (r) => (/clinique/i.test(r) && !/chnowa|3andek|bech /.test(r) ? null : "not French qualify") },
    { u: "je suis dentiste", c: async (r, api) =>
        /gratuit/.test(r) && (await api.stage()) === "vixa_ask_name" ? null : "no French pitch" },
    { u: "Dr Martin", c: async (r, api) =>
        (await api.stage()) === "vixa_ask_clinic" ? null : "french name not taken" },
    { u: "je suis dentiste", c: async (r, api) =>
        (await api.stage()) === "vixa_ask_clinic" ? null : "'je suis dentiste' taken as clinic name!" },
    { u: "Clinique Saint Louis", c: async (r, api) =>
        (await api.stage()) === "vixa_ask_phone" ? null : "french clinic not taken" },
    { u: "pareil", c: async (r, api) =>
        (await api.stage()) === "vixa_ask_time" ? null : "'pareil' not same-number" },
    { u: "demain 10h", c: async (r, api) => {
        const ss = await api.signups();
        const mine = ss.find((s) => s.phone === "x3");
        if (!mine) return "no signup saved";
        if (mine.clinic_name !== "Clinique Saint Louis") return `wrong clinic saved: ${mine.clinic_name}`;
        return /appellera/.test(r) ? null : "no French confirmation";
      } },
  ]);

  // X4 — medical trap: red line at every stage, flow survives.
  await convo("X4 medical trap", "x4", undefined, VIXA, [
    { u: "3andi wji3a kbira fel dhars, chnowa na3mel?", c: (r) => medicalSafe(r) || noPriceInvented(r) },
    { u: "ey", c: async (r, api) =>
        /blech/.test(r) && (await api.stage()) === "vixa_ask_name" ? null : "bare 'ey' not treated as doctor yes" },
    { u: "Dr Kamel", c: async (r, api) => (await api.stage() === "vixa_ask_clinic" ? null : "no") },
    { u: "ta3tini dwe lel wji3a?", c: async (r, api) =>
        medicalSafe(r) || ((await api.stage()) === "vixa_ask_clinic" ? null : "stage moved on medical!") },
  ]);

  // X5 — the haggler: pricing traps, never invent a number.
  await convo("X5 haggler", "x5", undefined, VIXA, [
    { u: "b9adech el ichtirak?", c: (r) => noPriceInvented(r) || (/blech/.test(r) ? null : "no blech") },
    { u: "a3melli remise", c: (r) => noPriceInvented(r) },
    { u: "soum el assistant 9adech?", c: (r) => noPriceInvented(r) },
    { u: "ey", c: async (r, api) => (await api.stage() === "vixa_ask_name" ? null : "flow broke") },
  ]);

  // X6 — the angry: insults + dismissals close gracefully.
  await convo("X6 angry", "x6", undefined, VIXA, [
    { u: "slm", c: () => null },
    { u: "ey", c: async (r, api) => (await api.stage() === "vixa_ask_name" ? null : "no") },
    { u: "sayeb 3laya ya kalb", c: async (r, api) =>
        (await api.stage()) !== null ? "insult not closed!" : (/l4it/.test(r) ? null : "no graceful close") },
  ]);
  await convo("X6b angry2", "x6b", undefined, VIXA, [
    { u: "n7eb lel 3iyada mte3i", c: async (r, api) => (await api.stage() === "vixa_ask_name" ? null : "no") },
    { u: "manheb chay tawa", c: async (r, api) =>
        (await api.stage()) !== null ? "dismissal not closed!" : null },
  ]);

  // X7 — mixed scripts: mirror each message.
  await convo("X7 mixed scripts", "x7", undefined, VIXA, [
    { u: "slm", c: (r) => (!hasAr(r) ? null : "latin greeting got Arabic reply") },
    { u: "أي", c: async (r, api) =>
        hasAr(r) && (await api.stage()) === "vixa_ask_name" ? null : "arabic not mirrored / no ask_name" },
    { u: "دكتور سامي", c: async (r, api) =>
        (await api.stage()) === "vixa_ask_clinic" ? null : "arabic name not taken" },
    { u: "عيادة النور", c: async (r, api) =>
        (await api.stage()) === "vixa_ask_phone" ? null : "arabic clinic not taken" },
  ]);

  // X8 — the ghost: vanishes mid-flow, returns with noise.
  await convo("X8 ghost", "x8", undefined, VIXA, [
    { u: "slm", c: () => null },
    { u: "ey", c: async (r, api) => (await api.stage() === "vixa_ask_name" ? null : "no") },
    { u: "mazelt mawjoud?", c: async (r, api) =>
        (await api.stage()) === "vixa_ask_name" ? null : "noise moved the stage!" },
    { u: "Ahmed", c: async (r, api) => (await api.stage()) === "vixa_ask_clinic" ? null : "no recovery" },
  ]);

  // X9 — phone traps.
  await stubDb.saveVendorLead("x9", "vixa_ask_phone", JSON.stringify({ lang: "latin", name: "T", clinic: "C" }));
  await convo("X9 phone traps", "x9", undefined, VIXA, [
    { u: "nafs enoumrou", c: async (r, api) =>
        (await api.stage()) === "vixa_ask_time" ? null : "'nafs enoumrou' not same-number" },
  ]);
  await stubDb.saveVendorLead("x9b", "vixa_ask_phone", JSON.stringify({ lang: "latin", name: "T", clinic: "C" }));
  await convo("X9b phone traps", "x9b", undefined, VIXA, [
    { u: "123", c: async (r, api) => (await api.stage()) === "vixa_ask_phone" ? null : "short number accepted!" },
    { u: "abcdef", c: async (r, api) => (await api.stage()) === "vixa_ask_phone" ? null : "letters accepted!" },
    { u: "98 234 567", c: async (r, api) => (await api.stage()) === "vixa_ask_time" ? null : "spaced number rejected" },
  ]);

  // X10 — time traps.
  await stubDb.saveVendorLead("x10", "vixa_ask_time",
    JSON.stringify({ lang: "latin", name: "T", clinic: "C", finalPhone: "21600000000" }));
  await convo("X10 time traps", "x10", undefined, VIXA, [
    { u: "bla bla", c: async (r, api) =>
        (await api.stage()) === "vixa_ask_time" ? null : "gibberish confirmed as time!" },
    { u: "ma7ajtich b appel", c: async (r, api) =>
        (await api.stage()) !== null ? "call refusal not closed!" : (/blech appel/.test(r) ? null : "wrong close msg") },
  ]);
  await stubDb.saveVendorLead("x10b", "vixa_ask_time",
    JSON.stringify({ lang: "latin", name: "T", clinic: "C", finalPhone: "21600000000" }));
  await convo("X10b time ok", "x10b", undefined, VIXA, [
    { u: "ghodwa 10", c: async (r, api) => {
        const ss = await api.signups();
        return ss.find((s) => s.phone === "21600000000") ? null : "no signup on valid time";
      } },
  ]);
  await stubDb.saveVendorLead("x10c", "vixa_ask_time",
    JSON.stringify({ lang: "latin", name: "T", clinic: "C", finalPhone: "21600000000" }));
  await convo("X10c vixa bad hour", "x10c", undefined, VIXA, [
    { u: "ghodwa 25", c: async (r, api) =>
        /10 d9aye9/.test(r) && (await api.stage()) === "vixa_ask_time" ? null : "bad vixa hour accepted!" },
  ]);

  // ================= DENTIST (52) extreme personas =================

  // X11 — booking extremes: past / impossible dates must never become bookings.
  await convo("X11 booking extremes", "y11", DENTIST, undefined, [
    { u: "n7eb na7jez lber7 10", c: async (r, api) =>
        (await api.proposal()) === null ? null : "PAST date became a proposal!" },
    { u: "n7eb na7jez ghodwa 25", c: async (r, api) =>
        /mech wa9t s7i7/.test(r) && (await api.proposal()) === null ? null : "hour 25 not flagged!" },
    { u: "n7eb na7jez ghodwa 10:99", c: async (r, api) =>
        /mech wa9t s7i7/.test(r) ? null : "10:99 not flagged!" },
    { u: "n7eb na7jez ghodwa 10", c: async (r, api) =>
        (await api.proposal()) !== null ? null : "valid slot got no proposal" },
  ]);

  // X12 — dentist medical red line.
  await convo("X12 dentist medical", "y12", DENTIST, undefined, [
    { u: "3andi wji3a fel dhars, chnowa el dwe?", c: async (r, api) =>
        medicalSafe(r) || (await api.proposal()) === null ? null : "medical + proposal!" },
    { u: "n7eb na7jez ghodwa 10", c: async (r, api) =>
        (await api.proposal()) !== null ? null : "flow broke after medical redirect" },
  ]);

  // X13 — name trap in the dentist booking flow.
  await convo("X13 dentist name trap", "y13", DENTIST, undefined, [
    { u: "n7eb na7jez ghodwa 10", c: async (r, api) =>
        (await api.proposal()) !== null ? null : "no proposal" },
    { u: "ey", c: () => null },
    { u: "juste nes2el", c: async (r, api) => {
        const nm = await api.patientName();
        return nm === "juste nes2el" ? "sentence saved as patient name!" : null;
      } },
  ]);

  // X14 — French patient books in French.
  await convo("X14 french patient", "y14", DENTIST, undefined, [
    { u: "bonjour, je veux un rendez-vous demain à 10h", c: (r) =>
        /rendez-vous|Bonjour|désolé|10/.test(r) && !/chnowa|3andek|bech t/.test(r)
          ? null : "not a French reply" },
  ]);

  // X15 — secretary extremes: unknown ids, empty list, bad input.
  {
    const s1 = await bot.processSecretaryText("ok 99999");
    ok("X15 sec unknown id", isNonEmpty(s1) && /Ma l9it/.test(s1), `got: ${(s1 || "").slice(0, 80)}`);
    const s2 = await bot.processSecretaryText("le abc");
    ok("X15 sec bad id", isNonEmpty(s2), `got: ${(s2 || "").slice(0, 80)}`);
    const s3 = await bot.processSecretaryText("fassa5 21600000000");
    ok("X15 sec fassa5 unknown", isNonEmpty(s3), `got: ${(s3 || "").slice(0, 80)}`);
    const s4 = await bot.processSecretaryText("blabla xyz");
    ok("X15 sec gibberish", isNonEmpty(s4), `got: ${(s4 || "").slice(0, 80)}`);
  }

  // X16 — cross-number isolation: VIXA lead state must not leak into dentist flow.
  {
    await stubDb.saveVendorLead("z16", "vixa_ask_name", JSON.stringify({ lang: "latin" }));
    const r = await bot.processPatientText("z16", "n7eb na7jez ghodwa 10", DENTIST);
    ok("X16 dentist ignores vixa lead", isNonEmpty(r) && /D'accord|10/.test(r), `got: ${(r || "").slice(0, 80)}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
