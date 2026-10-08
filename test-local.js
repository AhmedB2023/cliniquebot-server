// test-local.js — full regression test for the clinic bot. No network, no Postgres.
// Drives the REAL processPatientText / processSecretaryText with an in-memory db stub,
// plus a wide matrix of Derja date/time expressions through the REAL dates.js.
// Usage: node test-local.js   (exit 0 = all green)
process.env.PORT = "43117";
// VIXA sales test number (fake): the real 52150093 moved to the Dr Mahjoub
// dentist pilot on 2026-10-07, so S21 drives the vixa vertical via env var.
process.env.VIXA_NUMBERS = "52999999";

const path = require("path");

// ---------- in-memory db stub (same interface as db.js) ----------
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
    getPendingBookings: async () => bookings.filter((b) => b.status === "pending"),
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
    saveClinicConfig: async (numberId, cfg) => { clinicConfigs.set(numberId, { phone_number_id: numberId, ...cfg }); },
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

// ---------- PART A: dates.js matrix ----------
// expected: [display] | "needs:<dateDisplay>" | "PAST" | "NONE"
const dateCases = [
  // [input, expected]
  ["Ghodwa m3a khamsa mte3 l3chwa", "23-09-2026, 17:00"], // the reported bug
  ["ghodwa m3a 5 mte3 l3chiya", "23-09-2026, 17:00"],
  ["ghodwa 10 mta3 sbe7", "23-09-2026, 10:00"],
  ["ghodwa m3a 10", "23-09-2026, 10:00"], // 8-12 bare = morning
  ["ghodwa sbe7", "needs:23-09-2026"],
  ["ghodwa", "needs:23-09-2026"],
  ["ba3d ghodwa", "needs:24-09-2026"],
  ["ba3d ghodwa m3a 4 mte3 l3chiya", "24-09-2026, 16:00"],
  ["jem3a", "needs:25-09-2026"],
  ["jem3a 10", "25-09-2026, 10:00"], // 8-12 bare = morning
  ["jem3a 3", "25-09-2026, 15:00"], // 1-6 bare = afternoon
  ["jem3a 6", "25-09-2026, 18:00"],
  ["jem3a 12", "25-09-2026, 12:00"],
  ["jem3a 7", "needs:25-09-2026"], // only bare 7 is ambiguous
  ["jem3a el khamsa mte3 l3chiya", "25-09-2026, 17:00"],
  // word-hour "larb3a" = 4 o'clock (the live case); bare "larb3a" stays Wednesday
  ["jem3a larb3a mte3 la3vhiya", "25-09-2026, 16:00"],
  ["khmis larb3a", "24-09-2026, 16:00"], // bare 4 = afternoon (clinic hours)
  ["jem3a 4 mte3 la3vhiya", "25-09-2026, 16:00"],
  ["larb3a", "needs:23-09-2026"], // Wednesday, NOT 4 o'clock
  ["larb3a m3a 10 mta3 sbe7", "23-09-2026, 10:00"],
  ["sibt", "needs:26-09-2026"], // canonical spelling
  ["sebt m3a 11 mta3 sbe7", "26-09-2026, 11:00"],
  ["la7ad", "needs:27-09-2026"], // canonical spelling
  ["ethnin", "needs:28-09-2026"],
  ["thnin m3a 9 mta3 sbe7", "28-09-2026, 09:00"], // canonical spelling
  ["ethnin el 10", "28-09-2026, 10:00"], // Monday must NOT read as "2 o'clock"
  ["ethnin m3a zouz", "28-09-2026, 14:00"], // 1-6 bare = afternoon
  ["khmis", "needs:24-09-2026"],
  ["khemis 10", "24-09-2026, 10:00"], // "khemis" spelling variant of Thursday
  ["khamis 10", "24-09-2026, 10:00"], // more Thursday spellings patients use
  ["kmis 10", "24-09-2026, 10:00"],
  ["erb3a", "needs:23-09-2026"],
  ["21 septembre", "needs:21-09-2026"],
  ["25/09 m3a 3 mte3 l3chiya", "25-09-2026, 15:00"],
  ["ghodwa m3a 8 mte3 lil", "23-09-2026, 20:00"],
  ["ghodwa m3a tes3a mte3 lil", "23-09-2026, 21:00"],
  ["ghodwa m3a seb3a mte3 sbe7", "23-09-2026, 07:00"],
  ["ghodwa m3a 5:30 mte3 l3chiya", "23-09-2026, 17:30"],
  ["ghodwa m3a 17:30", "23-09-2026, 17:30"],
  ["ghodwa nos el nhar", "23-09-2026, 12:00"],
  ["ghodwa nos el lil", "23-09-2026, 00:00"],
  ["ghodwa m3a 12", "23-09-2026, 12:00"],
  ["ghodwa m3a 12 mte3 lil", "23-09-2026, 00:00"],
  ["ghodwa m3a zouz", "23-09-2026, 14:00"], // 2 bare = afternoon
  ["ghodwa khamsa", "23-09-2026, 17:00"],   // 5 bare = afternoon
  ["lyoum m3a el wa7da mte3 lil", "PAST"],          // 01:00 today < 19:30 now
  ["lyoum m3a 8 mta3 sbe7", "PAST"],
  ["lyoum m3a 9 mte3 lil", "22-09-2026, 21:00"], // 21:00 > 19:30, future
  ["sbe7", "NONE"],
  ["l3chiya", "NONE"],
  ["Khamsa l3chiya", "FOUND-NODATE"], // number words now parse it as a time
  ["10", "FOUND-NODATE"],
  // Arabic-script dates
  ["غدوة مع الخمسة متاع العشية", "23-09-2026، 17:00"],
  ["غدوة مع خمسة متاع العشية", "23-09-2026، 17:00"],
  ["الجمعة 10", "25-09-2026، 10:00"],
  ["الجمعة مع العشرة متاع الصباح", "25-09-2026، 10:00"],
  ["اليوم", "needs:22-09-2026"],
  ["غدوة", "needs:23-09-2026"],
  ["بعد غدوة", "needs:24-09-2026"],
  ["نحب نحجز", "NONE"],
  ["غدوة مع 12 متاع الليل", "23-09-2026، 00:00"],
  ["٢٥/٠٩ مع 3 متاع العشية", "25-09-2026، 15:00"], // Arabic-Indic digits
  ["21 سبتمبر 15:30", "PAST"], // explicit date already passed -> PAST, never next-year
  ["غدوة نص النهار", "23-09-2026، 12:00"],
  // batch 2026-09-25: Sunday phrase, French demain, filler-tolerant hours
  ["n7eb rendez-vous nhar lahad", "needs:27-09-2026"],
  ["nchallah ghodwa se3tin", "23-09-2026, 14:00"],
  ["demain se3tin", "23-09-2026, 14:00"],
  ["demain", "needs:23-09-2026"],
  ["apres demain", "needs:24-09-2026"],
  ["n7eb rendez-vous nos el lil", "FOUND-NODATE"], // midnight, no date -> out-of-hours branch
];

for (const [input, expected] of dateCases) {
  const r = dates.resolveSlot(input);
  const tag = `dates: ${JSON.stringify(input)}`;
  if (expected === "NONE") ok(tag, !r.found, JSON.stringify(r));
  else if (expected === "PAST") ok(tag, r.found && r.past === true, JSON.stringify(r));
  else if (expected === "FOUND-NODATE") ok(tag, r.found && !r.date, JSON.stringify(r));
  else if (expected.startsWith("needs:")) {
    const dd = expected.slice(6);
    ok(tag, r.found && r.date && r.needs === "time" && r.dateDisplay === dd,
      `got found=${r.found} needs=${r.needs} dateDisplay=${JSON.stringify(r.dateDisplay)}`);
  } else {
    ok(tag, r.found && !r.needs && !r.past && r.display === expected,
      `got display=${JSON.stringify(r.display)} needs=${r.needs} past=${r.past}`);
  }
}

// morning/afternoon/night flags are exposed for the smart follow-up question
{
  const r = dates.resolveSlot("ghodwa sbe7");
  ok("dates: ghodwa sbe7 -> morning flag", r.found && r.morning === true && r.needs === "time");
  const r2 = dates.resolveSlot("ghodwa m3a 5");
  ok("dates: ghodwa m3a 5 -> afternoon by default", r2.found && !r2.morning && !r2.afternoon && !r2.night && r2.display === "23-09-2026, 17:00");
}

// ---------- PART B: full conversation flows (real processPatientText) ----------
async function run() {
  // Flow 1 — the exact reported bug, then accept -> name gate -> booked with name
  {
    const p = "21600000001";
    const r1 = await bot.processPatientText(p, "Ghodwa m3a khamsa mte3 l3chwa");
    has("flow1: direct proposal 17:00", r1, "23-09-2026, 17:00");
    has("flow1: asks ey", r1, "ey");
    const r2 = await bot.processPatientText(p, "ey");
    has("flow1: asks for name", r2, "esm wel la9ab");
    has("flow1: name question keeps slot", r2, "23-09-2026, 17:00");
    const b0 = await stubDb.getLatestBooking(p);
    ok("flow1: no booking before name", !b0, JSON.stringify(b0));
    const r3 = await bot.processPatientText(p, "ahmed ben salah");
    has("flow1: booked", r3, "n2akkedlek");
    has("flow1: d'accord wording", r3, "D'accord");
    has("flow1: uses first name", r3, "D'accord Ahmed");
    const b = await stubDb.getLatestBooking(p);
    ok("flow1: pending in db", b && b.status === "pending" && b.slot === "23-09-2026, 17:00", JSON.stringify(b));
    ok("flow1: name on booking", b && b.patient_name === "ahmed ben salah", JSON.stringify(b));
    const saved = await stubDb.getPatientName(p);
    ok("flow1: name remembered", saved === "ahmed ben salah", saved);
    // double "ey" must NOT create a duplicate
    const r4 = await bot.processPatientText(p, "ey");
    has("flow1: no duplicate on 2nd ey", r4, "deja yestanna");
    const n = (await stubDb.getPendingBookings()).filter((x) => x.phone === p).length;
    ok("flow1: exactly 1 pending", n === 1, `n=${n}`);
  }

  // Flow 2 — ambiguous hour (bare 7), clarify with an evening word, then accept
  {
    const p = "21600000002";
    const r1 = await bot.processPatientText(p, "jem3a 7");
    has("flow2: asks sbe7 walla 3chiya", r1, "el 7 hethi mta3 sbe7 walla mta3 l3chiya");
    const r2 = await bot.processPatientText(p, "l3chiya");
    has("flow2: merged to 19:00", r2, "25-09-2026, 19:00"); // 7 + l3chiya = 19:00
    await stubDb.savePatientName(p, "Test Testi"); // known name -> no name question
    const r3 = await bot.processPatientText(p, "ey");
    has("flow2: booked", r3, "n2akkedlek");
    const b = await stubDb.getLatestBooking(p);
    ok("flow2: slot in db", b && b.slot === "25-09-2026, 19:00", JSON.stringify(b));
  }

  // Flow 3 — number word + morning
  {
    const p = "21600000003";
    const r1 = await bot.processPatientText(p, "ghodwa m3a 10 mta3 sbe7");
    has("flow3: 10:00", r1, "23-09-2026, 10:00");
    await stubDb.savePatientName(p, "Test Testi"); // known name -> no name question
    const r2 = await bot.processPatientText(p, "ey");
    has("flow3: booked", r2, "n2akkedlek");
  }

  // Flow 4 — pure refusal clears the proposal
  {
    const p = "21600000004";
    const r1 = await bot.processPatientText(p, "ghodwa 7");
    has("flow4: asks time", r1, "el 7 hethi mta3 sbe7 walla mta3 l3chiya");
    const r2 = await bot.processPatientText(p, "le");
    has("flow4: refusal acknowledged", r2, "l4it el i9tira7");
    const prop = await stubDb.getProposal(p);
    ok("flow4: proposal cleared", prop === null, JSON.stringify(prop));
    // then a fresh request still works
    const r3 = await bot.processPatientText(p, "jem3a 9 mta3 sbe7");
    has("flow4: fresh request works", r3, "25-09-2026, 09:00");
  }

  // Flow 5 — hour-only follow-up keeps the proposed date
  {
    const p = "21600000005";
    const r1 = await bot.processPatientText(p, "jem3a");
    has("flow5: date kept, asks time", r1, "25-09-2026");
    const r2 = await bot.processPatientText(p, "7");
    has("flow5: hour merged, asks period", r2, "el 7 hethi mta3 sbe7 walla mta3 l3chiya");
    ok("flow5: date not lost", r2.includes("25-09-2026"), `reply was: ${JSON.stringify(r2)}`);
    const r3 = await bot.processPatientText(p, "sbe7");
    has("flow5: concrete 07:00", r3, "25-09-2026, 07:00");
    await stubDb.savePatientName(p, "Test Testi"); // known name -> no name question
    const r4 = await bot.processPatientText(p, "ey");
    has("flow5: booked", r4, "n2akkedlek");
  }

  // Flow 5b — word-hour "larb3a" + "la3vhiya": auto 16:00, no sbe7/l3chiya question
  {
    const p = "21600000006";
    const r1 = await bot.processPatientText(p, "jem3a larb3a mte3 la3vhiya");
    has("flow5b: proposes 16:00 directly", r1, "25-09-2026, 16:00");
    ok("flow5b: no sbe7/l3chiya question", !r1.includes("sbe7 walla"), `reply was: ${JSON.stringify(r1)}`);
    await stubDb.savePatientName(p, "Test Testi"); // known name -> no name question
    const r2 = await bot.processPatientText(p, "ey");
    has("flow5b: booked", r2, "n2akkedlek");
    const b = await stubDb.getLatestBooking(p);
    ok("flow5b: slot in db", b && b.slot === "25-09-2026, 16:00", JSON.stringify(b));
  }

  // Flow 6 — status question reads the REAL db status + secretary validates
  {
    const p = "21600000002"; // has a pending jem3a booking from flow 2
    const r1 = await bot.processPatientText(p, "ca y est?");
    has("flow6: pending status", r1, "mazel yestanna");
    const b = await stubDb.getLatestBooking(p);
    const sec = await bot.processSecretaryText(`ok ${b.id}`);
    has("flow6: secretary ok", sec, "T2akked");
    const r2 = await bot.processPatientText(p, "ca y est?");
    has("flow6: confirmed status", r2, "t2akked");
    // a NEW booking request that starts with "t2akkedli" is not a status question
    const r3 = await bot.processPatientText(p, "t2akkedli ghodwa 10 mta3 sbe7");
    has("flow6: t2akkedli+slot = booking flow", r3, "23-09-2026, 10:00");
  }

  // Flow 7 — greeting + medical redirect + booking prompt (fallback mode)
  {
    const p = "21600000007";
    const r1 = await bot.processPatientText(p, "salem");
    has("flow7: neutral greeting", r1, "Kifech najmou n3awnouk");
    const r2 = await bot.processPatientText(p, "3andi wji3a, chnowa el dwe?");
    has("flow7: medical redirect", r2, "doktor");
    const r3 = await bot.processPatientText(p, "n7eb na7jez");
    has("flow7: booking prompt", r3, "nhar w wa9t");
  }

  // Flow 8 — two patients never mix memories/proposals
  {
    const a = "21600000008", b2 = "21600000009";
    await bot.processPatientText(a, "ghodwa 7");
    await bot.processPatientText(b2, "jem3a 7");
    const ra = await bot.processPatientText(a, "sbe7");
    has("flow8: patient A keeps ghodwa", ra, "23-09-2026, 07:00");
    const rb = await bot.processPatientText(b2, "l3chiya");
    has("flow8: patient B keeps jem3a", rb, "25-09-2026, 19:00");
  }

  // Flow 9 — secretary list / reject / unknown id
  {
    const list = await bot.processSecretaryText("list");
    has("flow9: list shows pending", list, "Pending");
    const pend = await stubDb.getPendingBookings();
    ok("flow9: pending exist", pend.length > 0, `n=${pend.length}`);
    const rej = await bot.processSecretaryText(`le ${pend[0].id}`);
    has("flow9: reject works", rej, "Tl4a");
    const rp = await bot.processPatientText(pend[0].phone, "ca y est?");
    has("flow9: patient sees cancellation", rp, "ma 3adech disponible");
    const unk = await bot.processSecretaryText("ok 99999");
    has("flow9: unknown id", unk, "Ma l9it");
  }

  // Flow 9c — supervisor "rapport" builds a daily PDF (2026-10-08)
  {
    // Pure PDF builder: valid PDF, clinic name inside, works with empty list.
    const empty = await bot.buildRapportPdf({ clinicName: "Cabinet Test", dateLabel: "2026-10-08", bookings: [] });
    ok("flow9c: pdf is a Buffer", Buffer.isBuffer(empty));
    ok("flow9c: pdf header", empty.slice(0, 4).toString() === "%PDF", empty.slice(0, 4).toString());
    const withB = await bot.buildRapportPdf({
      clinicName: "Cabinet Test", dateLabel: "2026-10-08",
      bookings: [{ slot_at: "2026-10-08T09:00:00", slot: "08-10-2026, 09:00", patient_name: "Ahmed", phone: "21600000001", status: "confirmed" }],
    });
    ok("flow9c: pdf with booking", withB.length > empty.length, `${withB.length} vs ${empty.length}`);
    // Command path: supervisor asks "rapport" -> confirmation text mentions PDF.
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tunis", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    await stubDb.saveBooking("21600000002", `${day} 10:00`, `${day}T10:00:00`, "Meriem", "CLINIC1");
    const r1 = await bot.processSecretaryText("rapport", { id: "CLINIC1", name: "Cabinet Test" }, "21699999999");
    has("flow9c: rapport confirms", r1, "rapport");
    ok("flow9c: rapport counts booking", /1 rendez-vous/.test(r1), `reply was: ${JSON.stringify(r1)}`);
    // Other clinic's bookings don't leak in.
    await stubDb.saveBooking("21600000003", `${day} 11:00`, `${day}T11:00:00`, "Ali", "CLINIC2");
    const r2 = await bot.processSecretaryText("rapport", { id: "CLINIC1", name: "Cabinet Test" }, "21699999999");
    ok("flow9c: rapport is per-clinic", /1 rendez-vous/.test(r2), `reply was: ${JSON.stringify(r2)}`);
    // Empty day still answers.
    const r3 = await bot.processSecretaryText("rapport", { id: "EMPTY", name: "Cabinet Vide" }, "21699999999");
    ok("flow9c: rapport empty day", /0 rendez-vous/.test(r3), `reply was: ${JSON.stringify(r3)}`);
    // Country-code-agnostic supervisor match (2026-10-08): US + TN numbers.
    ok("flow9c: samePhone US", bot.samePhone("17174204057", "7174204057"));
    ok("flow9c: samePhone US reversed", bot.samePhone("7174204057", "17174204057"));
    ok("flow9c: samePhone TN", bot.samePhone("21698800749", "98800749"));
    ok("flow9c: samePhone TN reversed", bot.samePhone("98800749", "21698800749"));
    ok("flow9c: samePhone different", !bot.samePhone("17174204057", "17174204058"));
    ok("flow9c: samePhone empty", !bot.samePhone("", "7174204057"));
  }

  // Flow 9b — secretary deletes a conversation by message
  {
    const p = "21600000019";
    await bot.processPatientText(p, "slm, n7eb na7jez rendez-vous");
    await bot.processPatientText(p, "ghodwa 10");
    const before = await stubDb.getHistory(p);
    ok("flow9b: conversation exists", before.length > 0, `n=${before.length}`);
    const propBefore = await stubDb.getProposal(p);
    ok("flow9b: proposal exists", !!propBefore, "has proposal");
    const del = await bot.processSecretaryText(`fassa5 ${p}`);
    has("flow9b: delete confirms", del, "Tfass5et");
    const after = await stubDb.getHistory(p);
    ok("flow9b: history cleared", after.length === 0, `n=${after.length}`);
    const propAfter = await stubDb.getProposal(p);
    ok("flow9b: proposal cleared", !propAfter, "no proposal");
    const del2 = await bot.processSecretaryText(`fassa5 ${p}`);
    has("flow9b: delete empty -> not found", del2, "Ma l9it");
    // patient starts fresh, no old memory
    const r = await bot.processPatientText(p, "slm");
    has("flow9b: fresh start after delete", r, "Kifech najmou n3awnouk");
  }

  // Flow 9c — supervisor free-text becomes a suggestion ("badel hedhi...")
  {
    const clinic = { id: "1364750653386950", secretary: "21698800749" };
    const r1 = await bot.processSecretaryText("badel el message mta3 el 7ajz", clinic, "21698800749");
    has("flow9c: ack reply", r1, "modification en cours");
    const all = await stubDb.getSuggestions();
    ok("flow9c: suggestion saved", all.length === 1, `n=${all.length}`);
    ok("flow9c: suggestion text", all[0].text === "badel el message mta3 el 7ajz", JSON.stringify(all[0]));
    ok("flow9c: suggestion number", all[0].number_id === "1364750653386950", JSON.stringify(all[0]));
    ok("flow9c: suggestion from", all[0].from_phone === "21698800749", JSON.stringify(all[0]));
    // commands still work — not saved as suggestions
    const nBefore = (await stubDb.getSuggestions()).length;
    await bot.processSecretaryText("list", clinic, "21698800749");
    const nAfter = (await stubDb.getSuggestions()).length;
    ok("flow9c: 'list' not saved as suggestion", nAfter === nBefore, `${nBefore} -> ${nAfter}`);
    // delete works
    const del = await stubDb.deleteSuggestion(all[0].id);
    ok("flow9c: delete returns 1", del === 1, `del=${del}`);
    ok("flow9c: deleted", (await stubDb.getSuggestions()).length === 0, "empty");
    // no clinic (admin test path) -> ack but no save
    const r2 = await bot.processSecretaryText("hedhi test mel admin");
    has("flow9c: admin path acks", r2, "modification en cours");
    ok("flow9c: admin path not saved", (await stubDb.getSuggestions()).length === 0, "empty");
  }

  // Flow 10 — past slot is refused clearly
  {
    const p = "21600000010";
    const r1 = await bot.processPatientText(p, "lyoum m3a 8 mta3 sbe7");
    has("flow10: past refused", r1, "El wa9t hedha fet");
  }

  // Flow 11 — full Arabic-script booking flow: proposal, accept, pending, status
  {
    const p = "21600000011";
    const r1 = await bot.processPatientText(p, "نحب نحجز");
    has("flow11: ar booking invite", r1, "باش نحجزلك");
    const r2 = await bot.processPatientText(p, "غدوة مع الخمسة متاع العشية");
    has("flow11: ar proposal", r2, "داكور — 23-09-2026، 17:00");
    has("flow11: ar proposal says ey", r2, "اي");
    const r3 = await bot.processPatientText(p, "اي");
    has("flow11: ar asks name", r3, "الاسم واللقب");
    const r3b = await bot.processPatientText(p, "أحمد بن صالح");
    has("flow11: ar booked", r3b, "نأكدلك رونديفو (23-09-2026، 17:00)");
    has("flow11: ar d'accord wording", r3b, "داكور");
    has("flow11: ar merhba bik", r3b, "مرحبا بيك");
    const b = await stubDb.getLatestBooking(p);
    ok("flow11: ar slot in db", b && b.slot === "23-09-2026، 17:00", JSON.stringify(b));
    const r4 = await bot.processPatientText(p, "تأكد الحجز؟");
    has("flow11: ar status pending", r4, "مازال يستنى");
  }

  // Flow 12 — Arabic script sticks across Latin follow-ups ("7")
  {
    const p = "21600000012";
    const r1 = await bot.processPatientText(p, "غدوة 7");
    has("flow12: ar asks time", r1, "الـ7 هاذي متاع الصباح ولا متاع العشية");
    const r2 = await bot.processPatientText(p, "7");
    has("flow12: rephrased, not repeated", r2, "باش نتأكد");
    ok("flow12: not verbatim repeat", r2 !== r1, r2);
    const r3 = await bot.processPatientText(p, "متاع الصباح");
    has("flow12: ar proposal 07:00", r3, "23-09-2026، 07:00");
  }

  // Flow 13 — Arabic refusal + Arabic fallback greeting
  {
    const p = "21600000013";
    await bot.processPatientText(p, "غدوة 10");
    const r1 = await bot.processPatientText(p, "لا");
    has("flow13: ar refusal ack", r1, "فسخت الاقتراح");
    const r2 = await bot.processPatientText(p, "عسلامة");
    has("flow13: ar greeting fallback", r2, "وعليكم السلام");
    const r3 = await bot.processPatientText(p, "عندي وجيعة، شنو الدواء؟");
    has("flow13: ar medical redirect", r3, "للطبيب");
  }

  // Flow 14 — AI prompt carries the script-matching rule (used once AI_API_KEY is set)
  {
    has("flow14: prompt has script rule", bot.SYSTEM_PROMPT, "script");
    has("flow14: prompt mentions arabic script", bot.SYSTEM_PROMPT, "3arabiya");
    ok("flow14: isAr helper", bot.isAr("نحب نحجز") === true && bot.isAr("n7eb na7jez") === false);
  }

  // Flow 15 — conversation memory: never repeat the day/time question.
  // (the exact bug from the live demo: "n7eb na7jez" twice -> same question twice)
  {
    const p = "21600000015";
    await stubDb.saveMessage(p, "user", "slm, n7eb na7jez 3and el dentiste");
    await stubDb.saveMessage(p, "assistant", "D'accord! anhou nhar w anhou wa9t yse3dek?");
    const r = await bot.processPatientText(p, "nheb na5jez rendez vous");
    has("flow15: rephrased nudge", r, "Fhemtek t7eb ta7jez");
    has("flow15: nudge has example", r, "jem3a 10 mta3 sbe7");
    ok("flow15: no repeated question", !/anhou nhar w anhou wa9t yse3dek/.test(r), r);
    // first-time ask (no prior question in history) still goes to the AI
    const p2 = "21600000017";
    const r2 = await bot.processPatientText(p2, "n7eb na7jez");
    ok("flow15: first ask goes to AI", !/Fhemtek t7eb ta7jez/.test(r2), r2);
    // Arabic version
    const pa = "21600000016";
    await stubDb.saveMessage(pa, "user", "سلام، نحب نحجز");
    await stubDb.saveMessage(pa, "assistant", "داكور! أنهو نهار وأنهو وقت يساعدك؟");
    const ra = await bot.processPatientText(pa, "نحب نحجز رونديفو");
    has("flow15: ar rephrased nudge", ra, "فهمتك تحب تحجز");
    ok("flow15: ar no repeated question", ra !== "داكور! أنهو نهار وأنهو وقت يساعدك؟", ra);
    // prompt carries the no-repeat memory rule
    has("flow15: prompt has memory rule", bot.SYSTEM_PROMPT, "MAMNOU3 t3awed nafs el sou2el");
  }

  // Flow 16 — dashboard: list conversations, view one, delete (forget) it
  {
    const p = "21600000020";
    await bot.processPatientText(p, "slm");
    await bot.processPatientText(p, "n7eb na7jez ghodwa 10 mta3 sbe7");
    const convs = await stubDb.getConversations();
    ok("flow16: conversation listed", convs.some((c) => c.phone === p && c.count >= 2), JSON.stringify(convs));
    const full = await stubDb.getFullHistory(p);
    ok("flow16: full history oldest-first", full.length >= 2 && full[0].role === "user", String(full.length));
    ok("flow16: proposal exists before delete", (await stubDb.getProposal(p)) !== null);
    const n = await stubDb.deleteConversation(p);
    ok("flow16: deleted count", n >= 2, String(n));
    const after = await stubDb.getFullHistory(p);
    ok("flow16: forgotten", after.length === 0, String(after.length));
    ok("flow16: proposal cleared", (await stubDb.getProposal(p)) === null);
    const convs2 = await stubDb.getConversations();
    ok("flow16: gone from list", !convs2.some((c) => c.phone === p), JSON.stringify(convs2.map((c) => c.phone)));
  }

  // Flow 17 — bare 7 after the sbe7/3chiya question: ask about THAT hour,
  // never repeat the generic question verbatim (live bug 2026-09-22 21:07).
  // (Bare 8-12 = morning, 1-6 = afternoon, only 7 is ambiguous.)
  {
    const p = "21600000021";
    const r1 = await bot.processPatientText(p, "nhar jem3a");
    has("flow17: asks sbe7/3chiya", r1, "mta3 sbe7 walla mta3 l3chiya");
    const r2 = await bot.processPatientText(p, "7");
    has("flow17: asks about 7", r2, "el 7 hethi mta3 sbe7 walla mta3 l3chiya");
    ok("flow17: not verbatim repeat", r2 !== r1, r2);
    const r3 = await bot.processPatientText(p, "mta3 sbe7");
    has("flow17: proposes 07:00", r3, "07:00");
    // 10 bare now resolves straight to morning — no question at all
    const r4 = await bot.processPatientText("21600000023", "jem3a 10");
    has("flow17: bare 10 = morning", r4, "25-09-2026, 10:00");
    const r5 = await bot.processPatientText("21600000024", "jem3a 3");
    has("flow17: bare 3 = afternoon", r5, "25-09-2026, 15:00");
    // Arabic version
    const pa = "21600000022";
    const a1 = await bot.processPatientText(pa, "نهار الجمعة");
    const a2 = await bot.processPatientText(pa, "7");
    has("flow17: ar asks about 7", a2, "الـ7 هاذي");
    ok("flow17: ar not verbatim repeat", a2 !== a1, a2);
  }

  // Flow 18 — name gate: "ey" asks nom+prenom, no booking before the name
  {
    const p = "21600000030";
    const r1 = await bot.processPatientText(p, "ghodwa 10 mta3 sbe7");
    has("flow18: proposal", r1, "23-09-2026, 10:00");
    const r2 = await bot.processPatientText(p, "ey");
    has("flow18: asks name", r2, "esm wel la9ab");
    has("flow18: name question keeps slot", r2, "23-09-2026, 10:00");
    const b0 = await stubDb.getLatestBooking(p);
    ok("flow18: no booking before name", !b0, JSON.stringify(b0));
    const r3 = await bot.processPatientText(p, "ahmed ben salah");
    has("flow18: booked with first name", r3, "D'accord Ahmed");
    has("flow18: booked", r3, "n2akkedlek");
    const b = await stubDb.getLatestBooking(p);
    ok("flow18: name on booking", b && b.patient_name === "ahmed ben salah", JSON.stringify(b));
    ok("flow18: name remembered", (await stubDb.getPatientName(p)) === "ahmed ben salah", "");
  }

  // Flow 19 — single word -> asks family name, then completes
  {
    const p = "21600000031";
    await bot.processPatientText(p, "ghodwa 10 mta3 sbe7");
    await bot.processPatientText(p, "ey");
    const r = await bot.processPatientText(p, "ahmed");
    has("flow19: asks family name", r, "la9ab");
    const r2 = await bot.processPatientText(p, "ben salah");
    has("flow19: booked", r2, "n2akkedlek");
    const b = await stubDb.getLatestBooking(p);
    ok("flow19: full name assembled", b && b.patient_name === "ahmed ben salah", JSON.stringify(b));
  }

  // Flow 20 — "esmi" prefix stripped; Arabic script name
  {
    const p = "21600000032";
    await bot.processPatientText(p, "ghodwa 10 mta3 sbe7");
    await bot.processPatientText(p, "ey");
    const r = await bot.processPatientText(p, "esmi ahmed ben salah");
    has("flow20: booked", r, "D'accord Ahmed");
    const b = await stubDb.getLatestBooking(p);
    ok("flow20: prefix stripped", b && b.patient_name === "ahmed ben salah", JSON.stringify(b));

    const pa = "21600000033";
    const a1 = await bot.processPatientText(pa, "غدوة 10 متاع الصباح");
    has("flow20: ar proposal", a1, "23-09-2026");
    const a2 = await bot.processPatientText(pa, "اي");
    has("flow20: ar asks name", a2, "الاسم واللقب");
    const a3 = await bot.processPatientText(pa, "أحمد بن صالح");
    has("flow20: ar confirmation", a3, "داكور");
    const ba = await stubDb.getLatestBooking(pa);
    ok("flow20: ar name saved", ba && ba.patient_name === "أحمد بن صالح", JSON.stringify(ba));
  }

  // Flow 21 — refusal while awaiting name cancels the proposal
  {
    const p = "21600000034";
    await bot.processPatientText(p, "ghodwa 10 mta3 sbe7");
    await bot.processPatientText(p, "ey");
    const r = await bot.processPatientText(p, "le");
    has("flow21: refusal cancels", r, "l4it el i9tira7");
    ok("flow21: proposal cleared", (await stubDb.getProposal(p)) === null, "");
    ok("flow21: no booking", !(await stubDb.getLatestBooking(p)), "");
  }

  // Flow 22 — known name: next booking skips the name question
  {
    const p = "21600000030"; // booked in flow 18, name known
    const r1 = await bot.processPatientText(p, "jem3a 10 mta3 sbe7");
    has("flow22: proposal", r1, "25-09-2026, 10:00");
    const r2 = await bot.processPatientText(p, "ey");
    has("flow22: booked directly", r2, "D'accord Ahmed");
    ok("flow22: no name question", !r2.includes("esm wel la9ab"), r2);
    const b = await stubDb.getLatestBooking(p);
    ok("flow22: name on 2nd booking", b && b.patient_name === "ahmed ben salah", JSON.stringify(b));
  }

  // Flow 23 — non-name while awaiting (a question) -> AI answers, still waiting
  {
    const p = "21600000035";
    await bot.processPatientText(p, "ghodwa 10 mta3 sbe7");
    await bot.processPatientText(p, "ey");
    const r = await bot.processPatientText(p, "b9adech el consultation?");
    has("flow23: price answered", r, "aswem"); // fallback reply, booking still open
    ok("flow23: still no booking", !(await stubDb.getLatestBooking(p)), "");
    const r2 = await bot.processPatientText(p, "ahmed ben salah");
    has("flow23: books after answer", r2, "n2akkedlek");
  }

  // Flow 24 — fassa5 forgets the remembered name too
  {
    const p = "21600000030"; // has a remembered name from flow 18
    const del = await bot.processSecretaryText(`fassa5 ${p}`);
    has("flow24: delete confirms", del, "Tfass5et");
    ok("flow24: name forgotten", (await stubDb.getPatientName(p)) === null, "");
    const r1 = await bot.processPatientText(p, "ghodwa 10 mta3 sbe7");
    has("flow24: proposal again", r1, "23-09-2026, 10:00");
    const r2 = await bot.processPatientText(p, "ey");
    has("flow24: asks name again", r2, "esm wel la9ab");
  }

  // ---------- PART C: signup form (/formulaire + /signups) ----------
  // The server from index.js listens on 127.0.0.1:43117 during this test,
  // so we drive the real HTTP routes end-to-end with the stub db.
  {
    const base = "http://127.0.0.1:43117";
    const TEST_PW = "clinic-bot-verify-123"; // VERIFY_TOKEN default (env not set in test)

    const page = await fetch(base + "/formulaire");
    ok("signup: /formulaire is 200", page.status === 200, `status=${page.status}`);
    const html = await page.text();
    has("signup: /formulaire has submit button", html, "اطلب تجربة بلاش");
    has("signup: /formulaire mentions price", html, "2 دينار");

    const valid = { name: "Ahmed Ben Salah", phone: "21650123456", clinic_name: "3yedet Ennour", city: "Tunis" };
    const r1 = await fetch(base + "/api/signups", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(valid),
    });
    ok("signup: valid POST is 200", r1.status === 200, `status=${r1.status}`);
    const j1 = await r1.json();
    ok("signup: valid POST returns ok", j1.ok === true, JSON.stringify(j1));

    const missing = { name: "X" }; // no phone -> still required
    const r2 = await fetch(base + "/api/signups", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(missing),
    });
    ok("signup: missing field is 400", r2.status === 400, `status=${r2.status}`);

    const optionalOnly = { name: "X", phone: "21650123456" }; // clinic/city now optional
    const r2b = await fetch(base + "/api/signups", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(optionalOnly),
    });
    ok("signup: name+phone only is 200", r2b.status === 200, `status=${r2b.status}`);

    const badPhone = { name: "X", phone: "abc", clinic_name: "Y", city: "Z" };
    const r3 = await fetch(base + "/api/signups", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(badPhone),
    });
    ok("signup: bad phone is 400", r3.status === 400, `status=${r3.status}`);

    const noPw = await fetch(base + "/api/signups");
    ok("signup: /api/signups without password is 403", noPw.status === 403, `status=${noPw.status}`);

    const list = await fetch(base + "/api/signups?password=" + TEST_PW);
    const lj = await list.json();
    ok("signup: /api/signups with password is 200", list.status === 200, `status=${list.status}`);
    ok("signup: saved entry visible in list", lj.signups && lj.signups.some((s) => s.name === "Ahmed Ben Salah" && s.clinic_name === "3yedet Ennour"), JSON.stringify(lj));

    const id = lj.signups.find((s) => s.name === "Ahmed Ben Salah").id;
    const del = await fetch(base + "/api/signups/" + id + "/delete", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: TEST_PW }),
    });
    const dj = await del.json();
    ok("signup: delete works", del.status === 200 && dj.deleted === 1, `status=${del.status} ${JSON.stringify(dj)}`);
    const after = await (await fetch(base + "/api/signups?password=" + TEST_PW)).json();
    ok("signup: deleted entry gone", !after.signups.some((s) => s.id === id), "");

    // validateSignup unit checks
    const v1 = bot.validateSignup({ name: "  Ali  ", phone: " +216 50 123 456 ", clinic_name: "C", city: "T" });
    ok("signup: validator trims + strips phone", v1.name === "Ali" && v1.phone === "+216 50 123 456", JSON.stringify(v1));
    ok("signup: validator rejects empty", !!bot.validateSignup({ name: "", phone: "21650123456", clinic_name: "C", city: "T" }).error, "");
    ok("signup: validator rejects short phone", !!bot.validateSignup({ name: "A", phone: "123", clinic_name: "C", city: "T" }).error, "");
  }

  // ---------- PART D: vendor (sales) mode — dentist wrote "جرّب" ----------
  {
    // D1: Arabic trigger -> Arabic pitch asking for the clinic name
    const p1 = "vendor1";
    const d1 = await bot.processPatientText(p1, "جرّب");
    has("vendor: AR trigger pitches the offer", d1, "2 دنانير");
    has("vendor: AR trigger asks clinic name", d1, "اسم العيادة");

    // D2: Arabizi trigger -> Arabizi pitch
    const p2 = "vendor2";
    const d2 = await bot.processPatientText(p2, "jareb");
    has("vendor: arabizi trigger pitches the offer", d2, "2 dinars");
    has("vendor: arabizi trigger asks clinic name", d2, "esm el 3iyada");

    // D3: quoted trigger «جرّب» also works
    const d3 = await bot.processPatientText("vendor3", "«جرّب»");
    has("vendor: quoted trigger works", d3, "اسم العيادة");

    // D4: clinic name -> asks for a call time, lead saved at asked_call
    const d4 = await bot.processPatientText(p1, "عيادة النور");
    has("vendor: clinic name -> asks call time", d4, "10 دقايق");

    // D5: time answer -> confirmation, stage done, further msgs get quiet fallback
    const d5 = await bot.processPatientText(p1, "غدوة العشية");
    has("vendor: time -> confirms callback", d5, "باش نتصلو بيك");
    const d6 = await bot.processPatientText(p1, "أوك");
    has("vendor: after done -> quiet fallback", d6, "باش تتصل بيك");

    // D6: re-trigger after done restarts the pitch
    const d7 = await bot.processPatientText(p1, "جرّب");
    has("vendor: re-trigger restarts pitch", d7, "اسم العيادة");

    // D7: non-exact "n7eb njareb" does NOT trigger vendor mode (booking flow intact)
    const p7 = "vendor7";
    const d8 = await bot.processPatientText(p7, "n7eb njareb ghodwa m3a 10");
    ok("vendor: 'n7eb njareb ghodwa m3a 10' stays in booking flow", /23-09-2026, 10:00/.test(d8), `reply was: ${JSON.stringify(d8)}`);

    // D8: normal patient booking still works on the same server (no interference)
    const p8 = "vendor8";
    const d9 = await bot.processPatientText(p8, "ghodwa m3a 10 mta3 sbe7");
    ok("vendor: patient booking unaffected", /T7eb n7ajzlek/.test(d9), `reply was: ${JSON.stringify(d9)}`);

    // D9: fassa5 clears the vendor lead -> fresh trigger restarts
    await bot.processPatientText("vendor9", "جرّب");
    const n = await stubDb.deleteConversation("vendor9");
    ok("vendor: fassa5 clears conversation", n > 0, "");
    const leadGone = await stubDb.getVendorLead("vendor9");
    ok("vendor: fassa5 clears vendor lead", leadGone === null, JSON.stringify(leadGone));

    // D10: neutral greeting — no vendeur pitch, no receptionist steering
    const n1 = await bot.processPatientText("neut1", "slm");
    has("vendor: 'slm' -> neutral greeting", n1, "Kifech najmou n3awnouk");
    ok("vendor: neutral greeting steers nothing", !/jareb|rendez-vous|7ajz/i.test(n1), `reply was: ${JSON.stringify(n1)}`);
    const n2 = await bot.processPatientText("neut2", "عسلامة");
    has("vendor: AR greeting -> neutral", n2, "كيفاش نجمو نعاونوك");

    // D11: next message decides — dentist path
    await bot.processPatientText("neut3", "salut");
    const n3 = await bot.processPatientText("neut3", "jareb");
    has("vendor: greeting -> jareb -> pitch", n3, "2 dinars");

    // D12: next message decides — patient path
    await bot.processPatientText("neut4", "bonjour");
    const n4 = await bot.processPatientText("neut4", "n7eb na7jez ghodwa m3a 10");
    ok("vendor: greeting -> booking still proposes", /T7eb n7ajzlek/.test(n4), `reply was: ${JSON.stringify(n4)}`);

    // D13: "sbe7" alone is NOT a pure greeting (time-of-day ambiguity) — old flow intact
    const n5 = await bot.processPatientText("neut5", "sbe7");
    ok("vendor: 'sbe7' not treated as greeting", !/Kifech najmou n3awnouk/.test(n5), `reply was: ${JSON.stringify(n5)}`);
  }

  // Flow 10 — availability question is NEVER an acceptance (live bug 2026-09-23:
  // "Ok nhar thleth mawjoud?" -> bot wrongly replied "N2akkedlek w narja3lek")
  {
    const p = "21600000110";
    ok("availq: question not acceptance", bot.looksLikeAcceptance("Ok nhar thleth mawjoud?") === false);
    ok("availq: ey? not acceptance", bot.looksLikeAcceptance("ey?") === false);
    ok("availq: question words not acceptance", bot.looksLikeAcceptance("ok fama blasa ghodwa") === false);
    ok("availq: pure ey still acceptance", bot.looksLikeAcceptance("ey") === true);
    ok("availq: pure ok still acceptance", bot.looksLikeAcceptance("ok") === true);
    ok("availq: ok+slot still acceptance", bot.looksLikeAcceptance("ok, ghodwa 10 mta3 sbe7") === true);
    ok("availq: thleth resolves", bot.dates.resolveSlot("nhar thleth").found === true);
    await bot.processPatientText(p, "Je Veux fixer un rendez-vous");
    const r = await bot.processPatientText(p, "Ok nhar thleth mawjoud?");
    ok("availq: no fake confirm", !/n2akkedlek/i.test(r), `reply was: ${JSON.stringify(r)}`);
    has("availq: asks for the hour instead", r, "9olli el wa9t");
  }

  // Flow 11 — script safety net: AI must never leak Arabic letters into a Latin reply
  // (live bug 2026-09-23: "Kif nجم n3awnk elyoum?"), and "3aslema" is a pure greeting
  {
    const g = await bot.processPatientText("neut6", "3aslema");
    has("script: 3aslema -> fixed greeting", g, "Kifech najmou n3awnouk");
    ok("script: greeting has no arabic", !/[\u0600-\u06FF]/.test(g), `reply was: ${JSON.stringify(g)}`);
    const fixed = bot.enforceScript("3aslema! Kif nجم n3awnk elyoum?", "3aslema");
    ok("script: no arabic letters left", !/[\u0600-\u06FF]/.test(fixed), `got: ${JSON.stringify(fixed)}`);
    ok("script: stays readable", fixed.includes("njm"), `got: ${JSON.stringify(fixed)}`);
    const same = bot.enforceScript("3aslema! Kif najem n3awnek?", "3aslema");
    ok("script: clean latin untouched", same === "3aslema! Kif najem n3awnek?", `got: ${JSON.stringify(same)}`);
    const ar = bot.enforceScript("WhatsApp متاح", "اكتبلي بالعربي");
    ok("script: arabic mode untouched", ar === "WhatsApp متاح", `got: ${JSON.stringify(ar)}`);
  }

  // ============ PART C: batch fix 2026-09-24 (13 fixes + reschedule + ok5) ============

  // F1 — emergency: chest pain -> urgent care, never a booking
  {
    ok("f1: detector", bot.looksLikeEmergency("3andi wji3a kbira fi sedri tawa") === true);
    ok("f1: plain wji3a not emergency", bot.looksLikeEmergency("3andi wji3a, chnowa el dwe?") === false);
    ok("f1: t3ebna not emergency", bot.looksLikeEmergency("t3ebna") === false);
    // False-positive guard (Ahmed 2026-09-24): a bad toothache is a normal
    // dentist booking, NOT an emergency — red flags only.
    ok("f1: toothache not emergency", bot.looksLikeEmergency("3andi wji3a kbira fi senni") === false);
    ok("f1: back pain not emergency", bot.looksLikeEmergency("dhahri youja3 barcha") === false);
    ok("f1: cant breathe is emergency", bot.looksLikeEmergency("manajmch netnafes") === true);
    const p = "21600000121";
    const r = await bot.processPatientText(p, "3andi wji3a kbira fi sedri tawa");
    has("f1: urgent-care direction", r, "190");
    ok("f1: no booking created", !(await stubDb.getLatestBooking(p)), "");
    ok("f1: no rendez-vous offered", !/rendez-vous/i.test(r) || /matestanech rendez-vous/.test(r), `reply was: ${JSON.stringify(r)}`);
    // toothache -> normal handling, never the ER path
    const rt = await bot.processPatientText("21600000139", "3andi wji3a kbira fi senni, n7eb na7jez");
    ok("f1: toothache not sent to ER", !/190/.test(rt), `reply was: ${JSON.stringify(rt)}`);
  }

  // F2 — correction after "le": new info wins
  {
    const c = bot.stripCorrectionPrefix("le, 10 mta3 l3chiya");
    ok("f2: strip le prefix", c.hadLe === true && c.corr === "10 mta3 l3chiya", JSON.stringify(c));
    const c2 = bot.stripCorrectionPrefix("le le, après ghodwa");
    ok("f2: strip double le", c2.hadLe === true && c2.corr === "après ghodwa", JSON.stringify(c2));
    ok("f2: hasTimeSignal", bot.hasTimeSignal("10 mta3 l3chiya") === true);
    ok("f2: no time signal in date-only", bot.hasTimeSignal("après ghodwa") === false);
    const st = bot.stripTimeTokens("ghodwa 10 mta3 sbe7");
    ok("f2: strip old time", st === "ghodwa", JSON.stringify(st));
    const sd = bot.stripDateTokens("ghodwa 10 mta3 sbe7");
    ok("f2: strip old date", sd === "10 mta3 sbe7", JSON.stringify(sd));
    // time correction: "ghodwa 10 mta3 sbe7" -> "le, 11 mta3 sbe7"
    const p = "21600000122";
    await bot.processPatientText(p, "ghodwa 10 mta3 sbe7");
    const r = await bot.processPatientText(p, "le, 11 mta3 sbe7");
    has("f2: corrected hour wins", r, "23-09-2026, 11:00");
    ok("f2: old hour gone", !r.includes("10:00"), `reply was: ${JSON.stringify(r)}`);
    // date correction: "ghodwa" -> "le le, après ghodwa"
    const p2 = "21600000123";
    await bot.processPatientText(p2, "ghodwa");
    const r2 = await bot.processPatientText(p2, "le le, après ghodwa");
    has("f2: corrected day wins", r2, "24-09-2026");
    ok("f2: old day gone", !r2.includes("23-09-2026"), `reply was: ${JSON.stringify(r2)}`);
  }

  // F3 — past / explicit dates: "el bera7" is past, "10 septembre" is a date not 10:00
  {
    const rb = dates.resolveSlot("el bera7");
    ok("f3: bera7 is past", rb.found && rb.past === true, JSON.stringify(rb.display));
    const r10 = dates.resolveSlot("10 septembre");
    ok("f3: 10 septembre is a date", r10.found && r10.date && r10.needs === "time" && r10.past === true,
      `got display=${JSON.stringify(r10.display)} past=${r10.past}`);
    ok("f3: no silent 2027", !/2027/.test(r10.display || ""), JSON.stringify(r10.display));
    const p = "21600000124";
    const r = await bot.processPatientText(p, "el bera7 la3chiya");
    has("f3: past -> fet", r, "fet");
    const r2 = await bot.processPatientText(p, "10 septembre");
    has("f3: explicit past date -> fet", r2, "fet");
    ok("f3: not treated as 10:00", !/10:00/.test(r2), `reply was: ${JSON.stringify(r2)}`);
  }

  // F4 — two appointments: both acknowledged, first one first
  {
    const p = "21600000125";
    ok("f4: detector", bot.looksLikeTwoAppointments("zouz rendez-vous, wa7ed liya w wa7ed l omi") === true);
    ok("f4: single not two", bot.looksLikeTwoAppointments("n7eb na7jez rendez-vous") === false);
    const r1 = await bot.processPatientText(p, "zouz rendez-vous, wa7ed liya w wa7ed l omi");
    has("f4: both acknowledged", r1, "zouz rendez-vous");
    has("f4: one at a time", r1, "wa7ed b wa7ed");
    await bot.processPatientText(p, "ghodwa 10 mta3 sbe7");
    await bot.processPatientText(p, "ey");
    const rname = await bot.processPatientText(p, "ahmed ben salah");
    has("f4: first booked, second prompted", rname, "ethani");
    const b1 = await stubDb.getLatestBooking(p);
    ok("f4: first slot in db", b1 && b1.slot === "23-09-2026, 10:00", JSON.stringify(b1));
    await bot.processPatientText(p, "jem3a 10 mta3 sbe7");
    const r2 = await bot.processPatientText(p, "ey"); // name known now
    has("f4: second booked", r2, "n2akkedlek");
    ok("f4: no third prompt", !/ethani/.test(r2), `reply was: ${JSON.stringify(r2)}`);
    const n = (await stubDb.getPendingBookings()).filter((x) => x.phone === p).length;
    ok("f4: exactly 2 bookings", n === 2, `n=${n}`);
  }

  // F5 — fresh booking request clears a stale proposal (no inherited time)
  {
    const p = "21600000126";
    await bot.processPatientText(p, "ghodwa 10 mta3 sbe7"); // concrete proposal 10:00
    const r = await bot.processPatientText(p, "n7eb jem3a");
    has("f5: new day asked", r, "25-09-2026");
    ok("f5: stale 10:00 not inherited", !r.includes("10:00"), `reply was: ${JSON.stringify(r)}`);
    const prop = await stubDb.getProposal(p);
    ok("f5: proposal has no stale time", prop && !/10/.test(prop.slot_text || ""), JSON.stringify(prop));
  }

  // F6 — frustration: brief "sama7ni", ask what failed
  {
    ok("f6: detector", bot.looksLikeFrustration("ya kalb el bot mte3ek me5demch") === true);
    ok("f6: greeting not frustration", bot.looksLikeFrustration("3aslema") === false);
    const r = await bot.processPatientText("21600000127", "ya kalb el bot mte3ek me5demch");
    has("f6: sama7ni", r, "Sama7ni");
    has("f6: asks what failed", r, "chnowa saret");
  }

  // F7 — cancellation detected before status: cancels + notifies
  {
    ok("f7: detector", bot.looksLikeCancellation("n7eb nfassakh el rendez-vous") === true);
    ok("f7: reschedule is not cancel", bot.looksLikeCancellation("n7eb nbadal el wa9t") === false);
    const p = "21600000128";
    const id = await stubDb.saveBooking(p, "23-09-2026, 10:00", "2026-09-23T09:00:00.000Z", "Test Testi");
    const r = await bot.processPatientText(p, "n7eb nfassakh el rendez-vous mte3i");
    has("f7: cancelled", r, "fassakht");
    const b = await stubDb.getBooking(id);
    ok("f7: status cancelled in db", b && b.status === "cancelled", JSON.stringify(b));
    // no booking -> honest answer, no crash
    const r2 = await bot.processPatientText("21600000129", "n7eb nfassakh el rendez-vous");
    has("f7: no booking to cancel", r2, "Ma l9it 7atta rendez-vous");
  }

  // F7b — "ey" answering a NON-booking question is never hijacked by the
  // booking-acceptance logic (live bug 2026-09-29: "ey" after the address
  // question and after the cancel question both got "deja yestanna").
  {
    // 1) address question: "ey" falls through to the AI, no hijack
    const p1 = "21600000140";
    await stubDb.saveBooking(p1, "30-09-2026, 09:00", "2026-09-30T08:00:00.000Z", "Test Testi");
    await stubDb.saveMessage(p1, "assistant", "Cabinet Dr Ines mawjouda fi Tunis. T7eb ma3loumét akthar 3la l'address?");
    const r1 = await bot.processPatientText(p1, "ey");
    ok("f7b: ey-after-address not hijacked", typeof r1 === "string" && !r1.includes("yestanna"), JSON.stringify(r1));

    // 2) cancellation question: "ey" falls through, no hijack
    const p2 = "21600000141";
    await stubDb.saveBooking(p2, "30-09-2026, 09:00", "2026-09-30T08:00:00.000Z", "Test Testi");
    await stubDb.saveMessage(p2, "assistant", "Nchallah labes! T7eb nfassakh el rendez-vous mta3ek?");
    const r2 = await bot.processPatientText(p2, "ey");
    ok("f7b: ey-after-cancel-question not hijacked", typeof r2 === "string" && !r2.includes("yestanna"), JSON.stringify(r2));

    // 3) booking context still works: "ey" after a booking question -> reminder
    const p3 = "21600000142";
    await stubDb.saveBooking(p3, "30-09-2026, 09:00", "2026-09-30T08:00:00.000Z", "Test Testi");
    await stubDb.saveMessage(p3, "assistant", "D'accord — 30-09-2026, 09:00, n2akkedlek?");
    const r3 = await bot.processPatientText(p3, "ey");
    ok("f7b: ey-after-booking-question still reminds", typeof r3 === "string" && r3.includes("yestanna"), JSON.stringify(r3));
  }

  // F7c — "anulih/anuliha" (cancel it) detected as cancellation, cancels direct
  {
    ok("f7c: anulih detected", bot.looksLikeCancellation("anulih") === true);
    ok("f7c: anuliha detected", bot.looksLikeCancellation("anuliha") === true);
    const p = "21600000143";
    const id = await stubDb.saveBooking(p, "30-09-2026, 09:00", "2026-09-30T08:00:00.000Z", "Test Testi");
    const r = await bot.processPatientText(p, "anulih");
    has("f7c: anulih cancels", r, "fassakht");
    const b = await stubDb.getBooking(id);
    ok("f7c: anulih status cancelled in db", b && b.status === "cancelled", JSON.stringify(b));
  }

  // F7d — "fasa5li/tafsa5li/nfasa5" (cancel it for me) detected as cancellation
  {
    ok("f7d: fasa5li detected", bot.looksLikeCancellation("le juste fasa5li rendez vous eli 3andi") === true);
    ok("f7d: tafsa5li detected", bot.looksLikeCancellation("momken tafsa5li rendez vous?") === true);
    ok("f7d: nfasa5 detected", bot.looksLikeCancellation("n7eb nfasa5 el rendez-vous mte3i") === true);
    const p = "21600000144";
    const id = await stubDb.saveBooking(p, "30-09-2026, 09:00", "2026-09-30T08:00:00.000Z", "Test Testi");
    const r = await bot.processPatientText(p, "momken tafsa5li rendez vous?");
    has("f7d: tafsa5li cancels", r, "fassakht");
    const b = await stubDb.getBooking(id);
    ok("f7d: tafsa5li status cancelled in db", b && b.status === "cancelled", JSON.stringify(b));
  }

  // F7e — root-based matching: any vowel spelling of the f-s-5 root is caught
  {
    ok("f7e: nefsa5 detected", bot.looksLikeCancellation("n7eb nefsa5 el rendez-vous") === true);
    ok("f7e: yefsa5 detected", bot.looksLikeCancellation("yefsa5 el 7ajz mte3i") === true);
    ok("f7e: tafsakh detected", bot.looksLikeCancellation("tafsakh el rendez-vous") === true);
    ok("f7e: arabic root detected", bot.looksLikeCancellation("ممكن تفسخلي الرونديفو؟") === true);
    ok("f7e: reschedule still not cancel", bot.looksLikeCancellation("n7eb nbadal el wa9t") === false);
    ok("f7e: book root ne7jez", bot.looksLikeBookingIntent("n7eb ne7jez rendez-vous") === true);
    ok("f7e: book root te7jezli", bot.looksLikeBookingIntent("te7jezli rendez-vous") === true);
    ok("f7e: bare noun 7ajz is not booking intent", bot.looksLikeBookingIntent("el 7ajz mte3i wa9tech?") === false);
    ok("f7e: reschedule root nbadel", bot.looksLikeReschedule("n7eb nbadel el wa9t") === true);
    ok("f7e: name Abdallah is not reschedule", bot.looksLikeReschedule("el rendez-vous mta3 abdallah wa9tech?") === false);
  }

  // F7f — bare cancel verb (no noun, no pronoun) still cancels:
  // the f-s-5 root is unambiguous in Derja.
  {
    ok("f7f: fasa5 tawa", bot.looksLikeCancellation("fasa5 tawa") === true);
    ok("f7f: fasa5 sil te plait", bot.looksLikeCancellation("fasa5 sil te plait") === true);
    ok("f7f: bare fasa5", bot.looksLikeCancellation("fasa5") === true);
    const p = "21600000145";
    const id = await stubDb.saveBooking(p, "30-09-2026, 09:00", "2026-09-30T08:00:00.000Z", "Test Testi");
    const r = await bot.processPatientText(p, "fasa5 tawa");
    has("f7f: fasa5 tawa cancels", r, "fassakht");
    const b = await stubDb.getBooking(id);
    ok("f7f: fasa5 tawa status cancelled in db", b && b.status === "cancelled", JSON.stringify(b));
  }

  // F8 — FAQ/identity answered before any stale-proposal merge
  {
    ok("f8: price kind", bot.faqKind("9adech el soum?") === "price");
    ok("f8: hours kind", bot.faqKind("wa9tech t7ellou?") === "hours");
    ok("f8: who kind", bot.faqKind("chkoun enti?") === "who");
    ok("f8: greeting not faq", bot.faqKind("3aslema") === null);
    const p = "21600000130";
    await bot.processPatientText(p, "ghodwa"); // proposal waiting for a time
    const r1 = await bot.processPatientText(p, "9adech el soum?");
    has("f8: price answered", r1, "consultation loula");
    const prop = await stubDb.getProposal(p);
    ok("f8: proposal preserved", prop && prop.slot_text === "ghodwa", JSON.stringify(prop));
    const r2 = await bot.processPatientText(p, "chkoun enti?");
    has("f8: identity answered", r2, "assistant mta3 el 3iyada");
    const r3 = await bot.processPatientText(p, "wa9tech t7ellou?");
    has("f8: hours answered", r3, "el sebt");
  }

  // F9 — bare "ey" on an incomplete proposal repeats the question, invents nothing
  {
    ok("f9: ok 5 not acceptance", bot.looksLikeAcceptance("ok 5") === false);
    const p = "21600000131";
    const r1 = await bot.processPatientText(p, "ghodwa");
    has("f9: asks time", r1, "9olli el wa9t");
    const r2 = await bot.processPatientText(p, "ey");
    has("f9: question repeated", r2, "9olli el wa9t");
    ok("f9: no invented 10:00", !/10:00/.test(r2), `reply was: ${JSON.stringify(r2)}`);
    ok("f9: no booking invented", !(await stubDb.getLatestBooking(p)), "");
  }

  // F10 — outside-hours rejected + open slot offered; Sunday closed -> next open day
  {
    const hc1 = bot.hoursCheck(dates.resolveSlot("ghodwa 23:00"));
    ok("f10: 23:00 rejected", hc1 && hc1.reason === "hours", JSON.stringify(hc1));
    const hc2 = bot.hoursCheck(dates.resolveSlot("el 7ad 10:00"));
    ok("f10: sunday rejected", hc2 && hc2.reason === "closed", JSON.stringify(hc2));
    ok("f10: 10:00 wednesday ok", bot.hoursCheck(dates.resolveSlot("ghodwa 10:00")) === null);
    const p = "21600000132";
    const r = await bot.processPatientText(p, "lyoum 23:00");
    has("f10: rejection + suggestion", r, "23-09-2026, 09:00");
    ok("f10: 23:00 never proposed", !/23:00/.test(r.split("Najem n9tar7lek")[0] || ""), `reply was: ${JSON.stringify(r)}`);
    const prop = await stubDb.getProposal(p);
    ok("f10: proposal is the open slot", prop && prop.display === "23-09-2026, 09:00", JSON.stringify(prop));
    // Sunday: must not inherit a stale time, redirects to Monday
    const p2 = "21600000133";
    await bot.processPatientText(p2, "ghodwa 10 mta3 sbe7"); // stale 10:00 proposal
    const r2 = await bot.processPatientText(p2, "n7eb nhar el 7ad");
    has("f10: sunday closed", r2, "msakra");
    has("f10: redirected to monday", r2, "28-09-2026");
    ok("f10: no stale 10:00", !/10:00/.test(r2), `reply was: ${JSON.stringify(r2)}`);
  }

  // F11 — walk-in: explained once, offered a reserved time, no question loop
  {
    ok("f11: detector", bot.looksLikeWalkin("n7eb nji tawa") === true);
    ok("f11: booking not walkin", bot.looksLikeWalkin("n7eb na7jez ghodwa") === false);
    const p = "21600000134";
    const r1 = await bot.processPatientText(p, "n7eb nji tawa");
    has("f11: walk-in explained", r1, "mathmoun");
    const r2 = await bot.processPatientText(p, "n7eb nji tawa");
    ok("f11: no loop, same answer", r1 === r2, `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`);
    const r3 = await bot.processPatientText(p, "ghodwa 10 mta3 sbe7");
    has("f11: booking still works", r3, "23-09-2026, 10:00");
  }

  // F12 — religious filler keeps tomorrow
  {
    const rr = dates.resolveSlot("ghodwa inchallah ken 7ab rabbi");
    ok("f12: parser keeps ghodwa", rr.found && rr.date && rr.needs === "time" && rr.dateDisplay === "23-09-2026",
      `got ${JSON.stringify(rr.dateDisplay)} needs=${rr.needs}`);
    const r = await bot.processPatientText("21600000135", "ghodwa inchallah ken 7ab rabbi");
    has("f12: tomorrow preserved", r, "23-09-2026");
    has("f12: asks time", r, "9olli el wa9t");
  }

  // F13 — third-party privacy: only this number's bookings
  {
    ok("f13: detector", bot.looksLikeThirdPartyQuery("3and omi rendez-vous lyoum?") === true);
    ok("f13: own booking not third-party", bot.looksLikeThirdPartyQuery("3andi rendez-vous?") === false);
    const r = await bot.processPatientText("21600000136", "3and omi rendez-vous lyoum?");
    has("f13: privacy-safe reply", r, "numero hetha");
  }

  // Reschedule — updates the existing booking, never a duplicate row
  {
    ok("fR: detector", bot.looksLikeReschedule("n7eb nbadal el rendez-vous") === true);
    ok("fR: cancel is not reschedule", bot.looksLikeReschedule("n7eb nfassakh") === false);
    const p = "21600000137";
    await stubDb.savePatientName(p, "Test Testi");
    await bot.processPatientText(p, "ghodwa 10 mta3 sbe7");
    await bot.processPatientText(p, "ey"); // booked: ghodwa 10:00
    const before = await stubDb.getLatestBooking(p);
    ok("fR: booking exists", before && before.slot === "23-09-2026, 10:00", JSON.stringify(before));
    const r1 = await bot.processPatientText(p, "n7eb nbadal el rendez-vous");
    has("fR: reschedule acknowledged", r1, "nbadlou");
    await bot.processPatientText(p, "jem3a 10 mta3 sbe7");
    const r2 = await bot.processPatientText(p, "ey");
    has("fR: moved", r2, "Tbadal el rendez-vous: 25-09-2026, 10:00");
    const all = (await stubDb.getPendingBookings()).filter((x) => x.phone === p);
    ok("fR: no duplicate row", all.length === 1, `n=${all.length}`);
    ok("fR: slot updated", all[0].slot === "25-09-2026, 10:00", JSON.stringify(all[0]));
  }

  // Patient-side "ok 5" never validates
  {
    const p = "21600000138";
    await stubDb.savePatientName(p, "Test Testi");
    await bot.processPatientText(p, "ghodwa 10 mta3 sbe7");
    await bot.processPatientText(p, "ey"); // one pending booking
    const before = (await stubDb.getPendingBookings()).filter((x) => x.phone === p);
    const r = await bot.processPatientText(p, "ok 5");
    ok("f5ok: not validated", before[0] && before[0].status === "pending", JSON.stringify(before[0]));
    ok("f5ok: explained", /commande mta3 el 3iyada/.test(r), `reply was: ${JSON.stringify(r)}`);
  }

  // ============ PART D: batch fix 2026-09-25 ============

  // F1 — AI phantom-booking guard: deterministic, prompt-independent
  {
    ok("f1: invented booking claim detected", bot.aiClaimsBooking("N7ajzlek rendez-vous ghodwa la3chiya") === true);
    ok("f1: invented confirmation detected", bot.aiClaimsBooking("rendez-vous m7ajouz") === true);
    ok("f1: invented slot detected", bot.aiClaimsBooking("tnjem tji ghodwa") === true);
    ok("f1: invented price detected", bot.aiClaimsBooking("el consultation 50 dt") === true);
    ok("f1: invented secretary msg detected", bot.aiClaimsBooking("el secretaire bech teklmek") === true);
    ok("f1: arabic phantom detected", bot.aiClaimsBooking("حجزتلك رونديفو غدوة") === true);
    ok("f1: legit proposal text passes", bot.aiClaimsBooking("D'accord — 23-09-2026, 14:00. T7eb n7ajzlek? Ekteb \"ey\".") === false);
    ok("f1: safe fallback passes", bot.aiClaimsBooking(bot.AI_SAFE_FALLBACK.latin) === false);
    ok("f1: guard replaces phantom", bot.guardAiOutput("N7ajzlek rendez-vous ghodwa", false, "SAFE") === "SAFE");
    ok("f1: guard passes clean text", bot.guardAiOutput("Ahlan, kifech n3awnek?", false, "SAFE") === "Ahlan, kifech n3awnek?");
    ok("f1: guard on AI failure", bot.guardAiOutput("", true, "SAFE") === "SAFE");
  }

  // F2 — signup phone validation: lenient (Ahmed filters himself)
  {
    const base = "http://127.0.0.1:43117";
    const fr = { name: "محمد المشيشي", phone: "+33 97993062" };
    const rFr = await fetch(base + "/api/signups", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fr),
    });
    ok("f2: foreign-format accepted over HTTP", rFr.status === 200, `status=${rFr.status}`);
    ok("f2: unit accepts +33", !bot.validateSignup({ name: "X", phone: "+33 97993062" }).error);
    ok("f2: unit accepts 9 digits", !bot.validateSignup({ name: "X", phone: "543327122" }).error);
    ok("f2: unit accepts local 8 digits", !bot.validateSignup({ name: "X", phone: "53180566" }).error);
    ok("f2: unit accepts +216", !bot.validateSignup({ name: "X", phone: "+216 53 180 566" }).error);
    ok("f2: unit rejects too-short", !!bot.validateSignup({ name: "X", phone: "123" }).error);
    ok("f2: unit rejects non-numeric", !!bot.validateSignup({ name: "X", phone: "abc" }).error);
  }

  // F3 — multi-booking never invents the beneficiary
  {
    const r = await bot.processPatientText("21600000201", "n7eb zouz rendez-vous");
    has("f3: asks who the first is for", r, "lchkoun");
    ok("f3: no invented mother", !/ommek|ommi/.test(r), `reply was: ${JSON.stringify(r)}`);
    const r2 = await bot.processPatientText("21600000202", "n7eb zouz rendez-vous, wa7ed liya w wa7ed l omi");
    has("f3: keeps explicit lik", r2, "lik");
    has("f3: keeps explicit ommek", r2, "ommek");
    ok("f3: detector finds both", JSON.stringify(bot.detectExplicitBeneficiaries("wa7ed liya w wa7ed l omi")) === JSON.stringify(["lik", "ommek"]));
    ok("f3: detector finds none", bot.detectExplicitBeneficiaries("n7eb zouz rendez-vous").length === 0);
  }

  // F4 — slot echo: "demain se3tin" is understood and repeated back
  {
    const r = await bot.processPatientText("21600000203", "demain se3tin");
    has("f4: repeats the slot", r, "23-09-2026, 14:00");
    has("f4: asks ey", r, "ey");
  }

  // F5 — per-number clinic configuration
  {
    await stubDb.saveClinicConfig("NUM_A", { clinic_name: "3iyedet Ennour", address: "Tunis, rue X", greeting: "Ahla w sahla fi 3iyedet Ennour! Kifech n3awnek?", hours: "8:00 - 18:00", secretary_number: "21611111111" });
    await stubDb.saveClinicConfig("NUM_B", { clinic_name: "Cabinet Dr Ben Ammar", address: "Sfax", greeting: "", hours: "", secretary_number: "21622222222" });
    const cA = await bot.getClinic("NUM_A");
    ok("f5: config loads per number", cA.name === "3iyedet Ennour" && cA.secretary === "21611111111");
    const r1 = await bot.processPatientText("21600000204", "chnowa esm el 3iyada?", "NUM_A");
    has("f5: answers clinic name", r1, "3iyedet Ennour");
    const r2 = await bot.processPatientText("21600000205", "te5dem m3a chkoun?", "NUM_B");
    has("f5: answers works-with", r2, "Cabinet Dr Ben Ammar");
    const r3 = await bot.processPatientText("21600000206", "win el 3iyada?", "NUM_A");
    has("f5: answers address", r3, "Tunis, rue X");
    const r4 = await bot.processPatientText("21600000207", "wa9t el 5edma?", "NUM_A");
    has("f5: answers custom hours", r4, "8:00 - 18:00");
    const r5 = await bot.processPatientText("21600000208", "3aslema", "NUM_A");
    has("f5: custom greeting", r5, "3iyedet Ennour");
    const r6 = await bot.processPatientText("21600000209", "chnowa esm el 3iyada?");
    ok("f5: fallback invents no name", !/3iyedet Ennour|Cabinet Dr/.test(r6), `reply was: ${JSON.stringify(r6)}`);
    // HTTP admin surface
    const base = "http://127.0.0.1:43117";
    const TEST_PW = "clinic-bot-verify-123";
    const noPw = await fetch(base + "/api/clinics");
    ok("f5: /api/clinics without password is 403", noPw.status === 403, `status=${noPw.status}`);
    const save = await fetch(base + "/api/clinics", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: TEST_PW, phone_number_id: "NUM_HTTP", clinic_name: "Test Clinic", address: "A", greeting: "G", hours: "H", secretary_number: "+216 33 333 333" }),
    });
    ok("f5: /api/clinics POST is 200", save.status === 200, `status=${save.status}`);
    const list = await (await fetch(base + "/api/clinics?password=" + TEST_PW)).json();
    ok("f5: saved config listed", list.clinics && list.clinics.some((c) => c.phone_number_id === "NUM_HTTP" && c.clinic_name === "Test Clinic" && c.secretary_number === "21633333333"), JSON.stringify(list.clinics));
  }

  // F6 — Sunday phrase: "nhar lahad" redirects, never a Sunday booking
  {
    const r = dates.resolveSlot("n7eb rendez-vous nhar lahad");
    ok("f6: lahad detected as Sunday", r.found && r.date && r.dow === 0 && r.needs === "time", JSON.stringify({ dow: r.dow, display: r.dateDisplay }));
    const r2 = await bot.processPatientText("21600000210", "n7eb rendez-vous nhar lahad");
    has("f6: Sunday-closed redirect", r2, "msakra");
    ok("f6: no Sunday booking offered", !/27-09-2026/.test(r2), `reply was: ${JSON.stringify(r2)}`);
  }

  // F7 — filler-tolerant hour: "nchallah ghodwa se3tin" -> 14:00
  {
    const r = await bot.processPatientText("21600000211", "nchallah ghodwa se3tin");
    has("f7: se3tin understood as 14:00", r, "23-09-2026, 14:00");
  }

  // F8 — explicit script request ("aktebli bel 3arbi") is remembered and honored
  {
    ok("f8: detector", bot.looksLikeScriptRequest("aktebli bel 3arbi") === true);
    ok("f8: bel 3arbi variant", bot.looksLikeScriptRequest("ektebli bel 3arbi svp") === true);
    const p = "21600000212";
    const r1 = await bot.processPatientText(p, "aktebli bel 3arbi");
    ok("f8: reply in Arabic script", /[\u0600-\u06FF]/.test(r1) && !/[a-zA-Z]/.test(r1), `reply was: ${JSON.stringify(r1)}`);
    const r2 = await bot.processPatientText(p, "n7eb rendez-vous ghodwa");
    ok("f8: booking flow honors saved pref", /[\u0600-\u06FF]/.test(r2), `reply was: ${JSON.stringify(r2)}`);
    ok("f8: pref saved", (await bot.scriptAr(p, "n7eb")) === true);
    const r3 = await bot.processPatientText(p, "aktebli b 7rouf");
    ok("f8: latin request honored", /[a-zA-Z]/.test(r3) && !/[\u0600-\u06FF]/.test(r3), `reply was: ${JSON.stringify(r3)}`);
  }

  // F9 — "nos el lil" rejected immediately as out-of-hours, valid slot suggested
  {
    const r = await bot.processPatientText("21600000213", "n7eb rendez-vous nos el lil");
    has("f9: rejected as out-of-hours", r, "5arej wa9t el 5edma");
    ok("f9: no day asked", !/anhou nhar/.test(r), `reply was: ${JSON.stringify(r)}`);
    ok("f9: suggests open future slot", /09:00/.test(r), `reply was: ${JSON.stringify(r)}`);
    // Mocked now = Tue 22 Sept 19:30 Tunis: today's 09:00 already passed, so
    // the suggestion must be Wed 23 Sept 09:00 — never a past 09:00.
    ok("f9: suggestion is future-dated", /23-09-2026/.test(r) && !/22-09-2026/.test(r),
      `reply was: ${JSON.stringify(r)}`);
  }

  // F9b — when today's 09:00 is still ahead, suggest today (not tomorrow)
  {
    dates.setNow(new Date("2026-09-22T06:30:00Z").getTime()); // Tue 07:30 Tunis
    const r = await bot.processPatientText("21600000214", "n7eb rendez-vous nos el lil");
    ok("f9b: suggests today 09:00 while still future", /22-09-2026, 09:00/.test(r),
      `reply was: ${JSON.stringify(r)}`);
    dates.setNow(new Date("2026-09-22T18:30:00Z").getTime()); // restore suite clock
  }

  // G1 — numeric date format: "jem3a 21" -> "25-09-2026" in both scripts, no
  // Latin/French month or weekday words leaking anywhere (Arabic reply uses
  // the Arabic comma separator).
  {
    const arD = dates.resolveSlot("jem3a 21", true).display;
    ok("g1: preferAr -> numeric Arabic display", arD === "25-09-2026، 21:00",
      `display was: ${JSON.stringify(arD)}`);
    const latD = dates.resolveSlot("jem3a 21", false).display;
    ok("g1: no pref -> numeric Latin display", latD === "25-09-2026, 21:00",
      `display was: ${JSON.stringify(latD)}`);
    const p = "21600000215";
    await bot.processPatientText(p, "aktebli bel 3arbi");
    const r = await bot.processPatientText(p, "n7eb rendez-vous jem3a 10");
    ok("g1: booking proposal date numeric, no Latin leak",
      /25-09-2026/.test(r) && !/septembre|jem3a/i.test(r),
      `reply was: ${JSON.stringify(r)}`);
  }

  // G2 — "jem3a jeya" = NEXT WEEK (Tunisian usage), not Friday: the bot must
  // ask which day AND time, never book Friday.
  {
    const u1 = dates.resolveSlot("n7eb rendez-vous jem3a jeya");
    ok("g2: unit flags nextWeek, no date", u1.found === true && u1.nextWeek === true && u1.date === false,
      JSON.stringify({ found: u1.found, nextWeek: u1.nextWeek, date: u1.date }));
    const u2 = dates.resolveSlot("n7eb rendez-vous el jem3a ejjeya");
    ok("g2: 'el jem3a ejjeya' variant", u2.nextWeek === true && u2.date === false);
    const u3 = dates.resolveSlot("n7eb rendez-vous jem3a");
    ok("g2: bare 'jem3a' still means Friday", u3.nextWeek !== true && u3.date === true,
      JSON.stringify({ nextWeek: u3.nextWeek, dateDisplay: u3.dateDisplay }));
    const r = await bot.processPatientText("21600000216", "n7eb rendez-vous jem3a jeya");
    ok("g2: asks day AND time", /anhou nhar w anhou wa9t/.test(r),
      `reply was: ${JSON.stringify(r)}`);
    ok("g2: no Friday booked", !/25-09-2026/.test(r),
      `reply was: ${JSON.stringify(r)}`);
    const p2 = "21600000217";
    await bot.processPatientText(p2, "aktebli bel 3arbi");
    const r2 = await bot.processPatientText(p2, "n7eb rendez-vous jem3a jeya");
    ok("g2: Arabic reply asks day+time", /أنهو نهار وأنهو وقت/.test(r2),
      `reply was: ${JSON.stringify(r2)}`);
  }

  // FR — French text path (2026-09-29: voice note removed, text-only).
  // 2026-10-01: French auto-detect is GLOBAL. Whoever writes in French gets
  // French, whoever writes Derja gets Derja — per message, no per-clinic flag.
  // The lenient detector (looksLikeFrenchAuto, wired into the flow) keeps real
  // Derja out: any Derja marker (n7eb, chnowa, 9adech...) vetoes French.
  // The strict looksLikeFrench stays as a utility (unchanged behavior).
  {
    // strict detector (utility, unchanged)
    ok("fr: detector 'Bonjour'", bot.looksLikeFrench("Bonjour") === true);
    ok("fr: detector full sentence",
      bot.looksLikeFrench("Bonjour, vous avez une Clio disponible ?") === true);
    ok("fr: detector diacritics", bot.looksLikeFrench("Combien ça coûte ?") === true);
    ok("fr: detector derja stays derja",
      bot.looksLikeFrench("n7eb na7jez rendez-vous") === false);
    ok("fr: detector 'rendez-vous' = derja",
      bot.looksLikeFrench("Je veux fixer un rendez-vous") === false);
    // lenient detector (this is what the flow uses for auto-detect)
    ok("fr-auto: lenient 'Bonjour' = French",
      bot.looksLikeFrenchAuto("Bonjour") === true);
    ok("fr-auto: lenient 'je voudrais un rendez-vous' = French",
      bot.looksLikeFrenchAuto("Bonjour, je voudrais un rendez-vous") === true);
    ok("fr-auto: lenient 'n7eb na7jez rendez-vous' = Derja",
      bot.looksLikeFrenchAuto("n7eb na7jez rendez-vous") === false);
    ok("fr-auto: lenient 'Bonjour n7eb na7jez' = Derja",
      bot.looksLikeFrenchAuto("Bonjour n7eb na7jez") === false);
    // explicit-request trigger (this is what the flow uses)
    ok("fr: req 'jewbni bel français'", bot.looksLikeFrenchRequest("jewbni bel français") === true);
    ok("fr: req 'ektebli bel français'", bot.looksLikeFrenchRequest("ektebli bel français") === true);
    ok("fr: req 'parle en français'", bot.looksLikeFrenchRequest("parle en français") === true);
    ok("fr: req 'en français'", bot.looksLikeFrenchRequest("ktebli en français") === true);
    ok("fr: req derja stays derja", bot.looksLikeFrenchRequest("n7eb na7jez") === false);
    ok("fr: req 'Bonjour' alone is NOT a request",
      bot.looksLikeFrenchRequest("Bonjour") === false);
    ok("fr: req incidental mention not a request",
      bot.looksLikeFrenchRequest("el ordonnance bel français") === false);
    // flow: GLOBAL auto-detect (2026-10-01) — "Bonjour" alone -> French
    const pf = "21600000fr1";
    const fr0 = await bot.processPatientText(pf, "Bonjour");
    has("fr: 'Bonjour' alone -> French reply (global auto-detect)", fr0, "Bonjour");
    ok("fr: French auto reply is not Derja", !/n3awnek|n3awnouk/.test(fr0),
      `reply was: ${JSON.stringify(fr0)}`);
    // flow: full French sentence -> French
    const pf3 = "21600000fr3";
    const fr3 = await bot.processPatientText(pf3, "Bonjour, je voudrais un rendez-vous");
    ok("fr: French sentence -> French reply", /Bonjour/.test(fr3),
      `reply was: ${JSON.stringify(fr3)}`);
    // flow: Derja marker wins over auto-detect
    const pf4 = "21600000fr4";
    const fr4 = await bot.processPatientText(pf4, "Bonjour n7eb na7jez");
    ok("fr: Derja marker wins over auto-detect", !/Bonjour/.test(fr4),
      `reply was: ${JSON.stringify(fr4)}`);
    // regression 2026-10-01 (seen live): "bonjour" -> French, then
    // "j'ai besoin 'un rendez vous" flipped back to Derja because the
    // detector didn't know "j'ai besoin". Fixed in the detector itself —
    // the language is decided PER MESSAGE, no cross-message memory
    // (a Derja follow-up like "Ok nhar thleth mawjoud?" must stay Derja).
    ok("fr: detector 'j\\'ai besoin d\\'un rendez vous' = French",
      bot.looksLikeFrenchAuto("j'ai besoin d'un rendez vous") === true);
    ok("fr: detector 'je cherche un rendez-vous' = French",
      bot.looksLikeFrenchAuto("je cherche un rendez-vous") === true);
    ok("fr: hasDerjaMarker('n7eb na7jez')", bot.hasDerjaMarker("n7eb na7jez") === true);
    ok("fr: hasDerjaMarker('bonjour') is false", bot.hasDerjaMarker("bonjour") === false);
    // live case, detector-only: both messages French -> both replies French
    const pm = "21600000frm";
    const pmr1 = await bot.processPatientText(pm, "bonjour");
    ok("fr: 'bonjour' -> French", /Bonjour/.test(pmr1), `reply was: ${JSON.stringify(pmr1)}`);
    const pmr2 = await bot.processPatientText(pm, "j'ai besoin 'un rendez vous");
    ok("fr: 'j\\'ai besoin \\'un rendez vous' -> French (no flip to Derja)",
      /Bonjour|puis-je|pouvez|aider/.test(pmr2), `reply was: ${JSON.stringify(pmr2)}`);
    // per-message: a Derja follow-up still gets Derja (no memory carry-over)
    const pmr3 = await bot.processPatientText(pm, "n7eb na7jez nhar lethnin");
    ok("fr: Derja follow-up gets Derja, not French", !/Bonjour|puis-je/.test(pmr3),
      `reply was: ${JSON.stringify(pmr3)}`);
    // semantic fallback (2026-10-01): the word-list matches words, the AI
    // understands meaning. aiLangIsFrench only fires when the word-list is
    // unsure — clear cases never reach the API.
    // (no AI key in tests -> always false, Derja default, no crash)
    ok("fr: aiLangIsFrench false without AI key",
      await bot.aiLangIsFrench("je peux venir demain ?") === false);
    ok("fr: aiLangIsFrench false for Arabic script",
      await bot.aiLangIsFrench("اكتبلي بالعربي") === false);
    ok("fr: aiLangIsFrench false for Derja markers",
      await bot.aiLangIsFrench("n7eb na7jez") === false);
    ok("fr: aiLangIsFrench false for empty text",
      await bot.aiLangIsFrench("   ") === false);
    // unsure message without key -> Derja (the old per-message contract holds)
    const pu = "21600000fru";
    const pur = await bot.processPatientText(pu, "je peux venir demain ?");
    ok("fr: unsure message without AI key -> Derja", !/Bonjour|puis-je/.test(pur),
      `reply was: ${JSON.stringify(pur)}`);
    // flow: explicit request -> French
    const pf2 = "21600000fr2";
    const fr1 = await bot.processPatientText(pf2, "jewbni bel français");
    has("fr: explicit request -> French reply", fr1, "Bonjour");
    ok("fr: French reply is not Derja", !/n3awnek|n3awnouk/.test(fr1),
      `reply was: ${JSON.stringify(fr1)}`);
    // regression 2026-09-27: the French system prompt must be standalone —
    // layering it on the Derja base prompt made the live AI answer
    // "je ne peux répondre qu'en derja tunisienne ou en arabe".
    ok("fr: standalone prompt has no derja-only rule",
      !/jaweb dima bel derja/i.test(bot.FRENCH_SYSTEM_PROMPT));
    ok("fr: standalone prompt mandates French",
      /TOUJOURS EN FRANÇAIS/.test(bot.FRENCH_SYSTEM_PROMPT));
    // regression 2026-09-29: the French voice note was REMOVED — French is
    // text-only now. No TTS call, no queued voice, no voice machinery left.
    const _src = require("fs").readFileSync(__dirname + "/index.js", "utf8");
    ok("fr: no voice machinery left in source",
      !/pendingVoice|ttsFrench|sendVoiceNote|TTS_ATTEMPTS|mai-voice/.test(_src));
    ok("fr: voice helpers not exported",
      bot.pendingVoice === undefined && bot.ttsFrench === undefined);
    ok("fr: prompt tells the AI not to apologize for speaking French",
      /Ne vous excusez jamais de parler français/.test(bot.FRENCH_SYSTEM_PROMPT));
  }

  // GR — greeting phrasing (2026-09-29): the AI greeting must be
  // "kifech najmou n3awnouk" style, never "chnowa n9dar n3awnek",
  // and never the "Nchalllah" typo.
  {
    ok("gr: prompt has exact greeting rule",
      /EL GREETING/.test(bot.SYSTEM_PROMPT));
    ok("gr: prompt mandates 'Kifech najmou n3awnouk'",
      /Kifech najmou n3awnouk/.test(bot.SYSTEM_PROMPT));
    ok("gr: prompt bans 'chnowa n9dar n3awnek'",
      /MAMNOU3[^.]*n9dar n3awnek/.test(bot.SYSTEM_PROMPT));
    ok("gr: prompt bans 'Nchalllah' typo",
      /"Nchalllah" ghalta/.test(bot.SYSTEM_PROMPT));
    const pg = await bot.processPatientText("21600000gr1", "slm");
    has("gr: pure greeting uses new phrasing", pg, "Kifech najmou n3awnouk");
    // regression 2026-10-01 (seen live): "salut cv" fell through to the AI,
    // which invented "3aslema! Nchalllah labes, kifech najmou n3awnouk?" — the
    // Nchalllah typo the prompt bans. Greeting + small-talk now uses the
    // deterministic greeting; the typo guard fixes it in code as backup.
    const pg2 = await bot.processPatientText("21600000gr2", "salut cv");
    has("gr: 'salut cv' uses deterministic greeting", pg2, "Kifech najmou n3awnouk");
    ok("gr: 'salut cv' has no Nchalllah typo", !/nchall+ah/i.test(pg2),
      `reply was: ${JSON.stringify(pg2)}`);
    const pg3 = await bot.processPatientText("21600000gr3", "slm labes");
    has("gr: 'slm labes' uses deterministic greeting", pg3, "Kifech najmou n3awnouk");
    const pg5 = await bot.processPatientText("21600000gr5", "salut comment cava");
    has("gr: 'salut comment cava' uses deterministic greeting", pg5, "Kifech najmou n3awnouk");
    ok("gr: 'salut comment cava' has no Nchalllah typo", !/nchall{2,}ah/i.test(pg5),
      `reply was: ${JSON.stringify(pg5)}`);
    // booking content is NOT a greeting
    const pg4 = await bot.processPatientText("21600000gr4", "slm n7eb na7jez");
    ok("gr: 'slm n7eb na7jez' is not a pure greeting", !/Kifech najmou n3awnouk/.test(pg4),
      `reply was: ${JSON.stringify(pg4)}`);
    // regression 2026-10-07 (seen live on 52): the AI greeted "3aslema! Kif
    // int? Kifech najmou n3awnouk?" — no clinic name, and the "kif int?" small
    // talk a clinic bot should never ask. The greeting must carry the clinic
    // name and never ask after the patient's health.
    ok("gr: AI greeting rule uses {CLINIC_NAME}",
      /EL GREETING[^]*\{CLINIC_NAME\}/.test(bot.SYSTEM_PROMPT));
    ok("gr: AI greeting bans 'kif int'",
      /MAMNOU3[^]*kif int/.test(bot.SYSTEM_PROMPT));
    ok("gr: aiReply substitutes {CLINIC_NAME}",
      /split\("\{CLINIC_NAME\}"\)/.test(require("fs").readFileSync(__dirname + "/index.js", "utf8")));
    ok("gr: French prompt greeting uses {CLINIC_NAME}",
      /l'assistant de \{CLINIC_NAME\}/.test(bot.FRENCH_SYSTEM_PROMPT));
    ok("gr: French prompt bans 'comment allez-vous'",
      /INTERDIT[^]*comment allez-vous/i.test(bot.FRENCH_SYSTEM_PROMPT));
    const mc52 = await bot.getClinic("1364750653386950", "21652150093");
    ok("gr: 52 seed greeting carries the clinic name",
      /Cabinet Dr Issam Mahjoub/.test(mc52.greeting), mc52.greeting.slice(0, 60));
    ok("gr: 52 seed greeting never asks 'kif int'",
      !/kif int/i.test(mc52.greeting));
    const ff = bot.frenchFallback("bonjour", "Cabinet Dr Issam Mahjoub");
    has("gr: frenchFallback greeting carries the clinic name", ff, "Cabinet Dr Issam Mahjoub");
    ok("gr: frenchFallback greeting never asks 'comment allez-vous'",
      !/comment allez-vous/i.test(ff));
    // typo guard unit tests (prompts are words, not law)
    ok("gr: fixKnownTypos fixes 'Nchalllah'",
      bot.fixKnownTypos("3aslema! Nchalllah labes") === "3aslema! Nchallah labes");
    ok("gr: fixKnownTypos leaves clean text alone",
      bot.fixKnownTypos("nchallah ghodwa") === "nchallah ghodwa");
    ok("gr: guardAiOutput applies the typo fix",
      bot.guardAiOutput("Nchalllah labes", false, "fallback") === "Nchallah labes");
  }

  // QQ — THE GENERAL RULE (2026-10-07, seen live on 52): a question is NEVER
  // booking info. "win mawjouda el3iyeda?" asked mid-proposal was merged into
  // the slot and the bot re-sent the proposal without answering. Now: any
  // question during a pending proposal is answered, the proposal stays alive.
  // One rule for every phrasing — no more per-message whack-a-mole.
  {
    // unit: question detection
    ok("qq: 'win mawjouda el3iyeda?' is a question", bot.looksLikeQuestion("win mawjouda el3iyeda?"));
    ok("qq: '9adech el consultation' is a question", bot.looksLikeQuestion("9adech el consultation"));
    ok("qq: 'comment ça va' is a question", bot.looksLikeQuestion("comment ça va?"));
    ok("qq: 'شكون انت؟' is a question", bot.looksLikeQuestion("شكون انت؟"));
    ok("qq: 'sbe7' is not a question", !bot.looksLikeQuestion("sbe7"));
    ok("qq: '10' is not a question", !bot.looksLikeQuestion("10"));
    ok("qq: 'ey' is not a question", !bot.looksLikeQuestion("ey"));
    ok("qq: 'le' is not a question", !bot.looksLikeQuestion("le"));
    ok("qq: 'ghodwa 10' is not a question", !bot.looksLikeQuestion("ghodwa 10"));
    ok("qq: 'jem3a 10 mta3 sbe7' is not a question", !bot.looksLikeQuestion("jem3a 10 mta3 sbe7"));

    // integration: the exact live scenario — proposal pending, patient asks
    // where the clinic is. The bot must ANSWER (address), not re-send the
    // proposal. Uses the 52/Mahjoub number so the real address is expected.
    const q = "21600000qq1";
    const q1 = await bot.processPatientText(q, "ghodwa 10 mta3 sbe7", "1364750653386950", "21652150093");
    has("qq: proposal created", q1, "T7eb n7ajzlek?");
    const q2 = await bot.processPatientText(q, "win mawjouda el3iyeda?", "1364750653386950", "21652150093");
    has("qq: question mid-proposal gets the address", q2, "Ghannouchi");
    ok("qq: question mid-proposal is not the bare re-send",
      !/^D'accord — .*T7eb n7ajzlek\? Ekteb "ey"\.$/.test(q2.trim()), q2.slice(0, 70));
    const propQ = await stubDb.getProposal(q);
    ok("qq: proposal still alive after the question", propQ && !!propQ.slot_text, JSON.stringify(propQ && propQ.slot_text));
    // ...and the booking thread continues: "ey" still books.
    const q3 = await bot.processPatientText(q, "ey", "1364750653386950", "21652150093");
    ok("qq: 'ey' after the question still advances the booking",
      /esm|nom|chkon/i.test(q3) || /t2akked|n2akkedlek/i.test(q3), q3.slice(0, 80));

    // unknown (non-FAQ) question mid-proposal: answered by the AI path, the
    // proposal survives, never merged into the slot.
    const qB = "21600000qq2";
    await bot.processPatientText(qB, "ghodwa 10 mta3 sbe7", "1364750653386950", "21652150093");
    const qB2 = await bot.processPatientText(qB, "3andkom parking?", "1364750653386950", "21652150093");
    ok("qq: unknown question mid-proposal is not the bare re-send",
      !/^D'accord — .*T7eb n7ajzlek\? Ekteb "ey"\.$/.test(qB2.trim()), qB2.slice(0, 70));
    const propQB = await stubDb.getProposal(qB);
    ok("qq: proposal alive after unknown question", propQB && !!propQB.slot_text);
    ok("qq: unknown question not glued into the slot",
      !/parking/i.test(propQB.slot_text || ""), propQB.slot_text);

    // guards: acceptance / refusal / slot info still bypass the Q rule.
    const qC = "21600000qq3";
    await bot.processPatientText(qC, "ghodwa 10 mta3 sbe7", "1364750653386950", "21652150093");
    const qC2 = await bot.processPatientText(qC, "sbe7", "1364750653386950", "21652150093");
    ok("qq: 'sbe7' follow-up still merges (not treated as question)",
      /T7eb n7ajzlek\?/.test(qC2), qC2.slice(0, 60));
  }

  // GF — guard strips, not nukes (2026-10-07, seen live on 52): the AI
  // answered "wa9tech tsakrou la3chia?" with true hours + one invented
  // booking sentence — the guard nuked the WHOLE reply and the patient got
  // the dumb fallback. Now only the invented sentence is stripped.
  {
    const g1 = bot.guardAiOutput("Nsakrou el 17:30. T7eb n7ajzlek rendez-vous ghodwa?", false, "FALLBACK");
    ok("gf: true answer survives, invented sentence stripped",
      g1 === "Nsakrou el 17:30.", JSON.stringify(g1));
    const g2 = bot.guardAiOutput("n7ajzlek rendez-vous ghodwa 10", false, "FALLBACK");
    ok("gf: all-phantom reply still falls back", g2 === "FALLBACK", JSON.stringify(g2));
    const g3 = bot.guardAiOutput("El 3onwen: Sousse. tnjem tji ghodwa?", false, "FALLBACK");
    ok("gf: invented slot sentence stripped, address kept",
      g3 === "El 3onwen: Sousse.", JSON.stringify(g3));
    const g4 = bot.guardAiOutput("Nchalllah labes", false, "fallback");
    ok("gf: typo guard still applies after strip", g4 === "Nchallah labes", JSON.stringify(g4));

    // faqKind now catches "tsakrou" (close) — the exact live question.
    ok("gf: faqKind('wa9tech tsakrou') is hours",
      bot.faqKind("sou2l wa9tech tsakrou la3chia?") === "hours");
    // ...so the deterministic path answers it with the real hours, no AI needed.
    const h1 = await bot.processPatientText("21600000gf1", "wa9tech tsakrou la3chia?", "1364750653386950", "21652150093");
    has("gf: 'wa9tech tsakrou' gets the real hours", h1, "17:30");
    ok("gf: 'wa9tech tsakrou' never hits the dumb fallback",
      !/chnowa t7eb bedhabt/.test(h1), h1.slice(0, 60));
  }

  // PILOT — per-number config (2026-09-29, mechanism test): a dentist number
  // carries its own booking hours (Mon-Fri 8-16, Sat 8-13, Sun closed), its
  // own greeting (incl. Arabic-script), and a handoff rule for the other
  // doctor sharing the clinic (Dr Dakhlaoui).
  // NOTE 2026-10-06: the real pilot number 1364750653386950 is now the VIXA
  // SALES number, so this block uses a fake dentist id + DB row instead.
  {
    const PILOT = "999888777666555";
    await stubDb.saveClinicConfig(PILOT, {
      clinic_name: "Cabinet Dr Ines",
      address: "Test address",
      greeting: "Ahla w sahla fi Cabinet Dr Ines! Kifech najmou n3awnouk?",
      greeting_ar: "أهلا وسهلا في عيادة الدكتورة إيناس! كيفاش نجمو نعاونوك؟",
      hours: "Ethneyn–Jem3a: 8:00–16:00, Sebt: 8:00–13:00, 7ad: msakra",
      booking_hours: "1:8-16;2:8-16;3:8-16;4:8-16;5:8-16;6:8-13",
      secretary_number: "",
      other_doctor: "Dakhlaoui",
      vertical: "dentist",
    });
    // parseBookingHours unit checks
    ok("pilot: parse valid", JSON.stringify(bot.parseBookingHours("1:8-16;2:8-16;6:8-13")) === JSON.stringify({ 1: [8, 16], 2: [8, 16], 6: [8, 13] }));
    ok("pilot: parse rejects garbage", bot.parseBookingHours("foo") === null);
    ok("pilot: parse rejects inverted range", bot.parseBookingHours("1:16-8") === null);
    ok("pilot: parse rejects dow 7", bot.parseBookingHours("7:8-16") === null);
    ok("pilot: parse rejects empty", bot.parseBookingHours("") === null);
    // seed config loads with no DB row
    const c = await bot.getClinic(PILOT);
    ok("pilot: row name", c.name === "Cabinet Dr Ines", JSON.stringify(c.name));
    ok("pilot: row secretary empty until the partner confirms the number", c.secretary === "", JSON.stringify(c.secretary));
    ok("pilot: row otherDoctor", c.otherDoctor === "Dakhlaoui", JSON.stringify(c.otherDoctor));
    ok("pilot: row bookingHours", JSON.stringify(c.bookingHours) === JSON.stringify({ 1: [8, 16], 2: [8, 16], 3: [8, 16], 4: [8, 16], 5: [8, 16], 6: [8, 13] }), JSON.stringify(c.bookingHours));
    ok("pilot: row greetingAr", /إيناس/.test(c.greetingAr || ""), JSON.stringify(c.greetingAr));
    ok("pilot: default number has no override", (await bot.getClinic("no-such-number")).bookingHours === null
      && (await bot.getClinic("no-such-number")).otherDoctor === "");
    // booking hours enforced: Wed 17:30 is outside 8-16 -> rejected
    const r1 = await bot.processPatientText("21600000px1", "n7eb rendez-vous ghodwa m3a 17:30", PILOT);
    has("pilot: 17:30 rejected as out-of-hours", r1, "5arej wa9t el 5edma");
    has("pilot: reject shows her hours", r1, "16:00");
    has("pilot: suggests next open slot", r1, "23-09-2026, 09:00");
    // inside hours: Wed 10:00 -> proposed
    const r2 = await bot.processPatientText("21600000px2", "n7eb rendez-vous larb3a m3a 10 mta3 sbe7", PILOT);
    has("pilot: 10:00 proposed", r2, "23-09-2026, 10:00");
    // Saturday 15:00 is outside Sat 8-13 -> rejected
    const r3 = await bot.processPatientText("21600000px3", "n7eb rendez-vous sebt m3a 3 mte3 l3chiya", PILOT);
    has("pilot: Sat 15:00 rejected", r3, "5arej wa9t el 5edma");
    // Saturday 11:00 inside -> proposed
    const r4 = await bot.processPatientText("21600000px4", "n7eb rendez-vous sebt m3a 11 mta3 sbe7", PILOT);
    has("pilot: Sat 11:00 proposed", r4, "26-09-2026, 11:00");
    // Sunday closed -> her hours text, not the default range
    const r5 = await bot.processPatientText("21600000px5", "n7eb rendez-vous nhar lahad", PILOT);
    has("pilot: Sunday closed", r5, "msakra");
    has("pilot: Sunday shows her hours", r5, "16:00");
    ok("pilot: Sunday hides default range", !/mel ethneyn lel sebt/.test(r5), `reply was: ${JSON.stringify(r5)}`);
    // the default (demo) number is untouched: 17:30 still inside 7-21
    const r6 = await bot.processPatientText("21600000px6", "n7eb rendez-vous ghodwa m3a 17:30");
    has("pilot: default number still accepts 17:30", r6, "23-09-2026, 17:30");
    // other-doctor handoff: never books, hands to the secretary
    const r7 = await bot.processPatientText("21600000px7", "Dr Dakhlaoui mawjoud ghodwa?", PILOT);
    has("pilot: Dakhlaoui hands to secretary", r7, "secretaire");
    ok("pilot: Dakhlaoui never books", !/D'accord/.test(r7), `reply was: ${JSON.stringify(r7)}`);
    // Arabic-script greeting uses greeting_ar
    const r8 = await bot.processPatientText("21600000px8", "عسلامة", PILOT);
    ok("pilot: Arabic greeting is Arabic script", /[\u0600-\u06FF]/.test(r8) && /إيناس/.test(r8), `reply was: ${JSON.stringify(r8)}`);
    // a DB row overrides the seed (partner corrections via /api/clinics)
    await stubDb.saveClinicConfig(PILOT, { booking_hours: "1:9-12", hours: "custom" });
    const c2 = await bot.getClinic(PILOT);
    ok("pilot: DB row updates bookingHours", JSON.stringify(c2.bookingHours) === JSON.stringify({ 1: [9, 12] }), JSON.stringify(c2.bookingHours));
    ok("pilot: DB row updates hours text", c2.hours === "custom");
  }

  // VW — dentist viewer: private per-number link, read-only, isolated
  // NOTE 2026-10-06: 1364750653386950 is now the VIXA sales number, so the
  // viewer isolation test uses a fake dentist id instead.
  {
    const base = "http://127.0.0.1:43117";
    const TEST_PW = "clinic-bot-verify-123";
    const PILOT = "111222333444555";
    const OTHER = "9999999999999999";
    await stubDb.saveClinicConfig(PILOT, { clinic_name: "Cabinet Viewer Test", vertical: "dentist" });
    const tokP = bot.viewerToken(PILOT);
    const tokO = bot.viewerToken(OTHER);
    ok("vw: token is 32 hex chars", /^[0-9a-f]{32}$/.test(tokP), tokP);
    ok("vw: tokens differ per number", tokP !== tokO);

    // chats on two different bot numbers
    await bot.processPatientText("21600000901", "3aslema", PILOT);
    await bot.processPatientText("21600000901", "n7eb rendez-vous ghodwa", PILOT);
    await bot.processPatientText("21600000902", "3aslema", OTHER);

    // stub-level isolation
    const convP = await stubDb.getConversations(PILOT);
    ok("vw: pilot viewer sees only pilot chats",
      convP.some((c) => c.phone === "21600000901") && !convP.some((c) => c.phone === "21600000902"),
      JSON.stringify(convP.map((c) => c.phone)));
    const convO = await stubDb.getConversations(OTHER);
    ok("vw: other viewer sees only its chats",
      convO.some((c) => c.phone === "21600000902") && !convO.some((c) => c.phone === "21600000901"),
      JSON.stringify(convO.map((c) => c.phone)));
    ok("vw: own history non-empty", (await stubDb.getFullHistory("21600000901", PILOT)).length >= 2);
    ok("vw: cross-number history is empty", (await stubDb.getFullHistory("21600000901", OTHER)).length === 0);

    // HTTP: conversations API with good token
    const rOk = await fetch(`${base}/api/view/${PILOT}/${tokP}/conversations`);
    ok("vw: viewer API 200 with good token", rOk.status === 200, `status=${rOk.status}`);
    const jOk = await rOk.json();
    ok("vw: viewer API isolated",
      jOk.conversations.some((c) => c.phone === "21600000901") && !jOk.conversations.some((c) => c.phone === "21600000902"),
      JSON.stringify(jOk.conversations.map((c) => c.phone)));
    // bad token -> 403
    const rBad = await fetch(`${base}/api/view/${PILOT}/deadbeefdeadbeefdeadbeefdeadbeef/conversations`);
    ok("vw: viewer API 403 with bad token", rBad.status === 403, `status=${rBad.status}`);

    // thread endpoint
    const rTh = await fetch(`${base}/api/view/${PILOT}/${tokP}/conversations/21600000901`);
    ok("vw: thread 200", rTh.status === 200, `status=${rTh.status}`);
    ok("vw: thread has messages", (await rTh.json()).messages.length >= 2);
    const rThBad = await fetch(`${base}/api/view/${PILOT}/0/conversations/21600000901`);
    ok("vw: thread 403 with bad token", rThBad.status === 403, `status=${rThBad.status}`);

    // HTML page
    const rPage = await fetch(`${base}/v/${PILOT}/${tokP}`);
    ok("vw: viewer page 200", rPage.status === 200, `status=${rPage.status}`);
    const pageTxt = await rPage.text();
    ok("vw: page shows clinic name", pageTxt.includes("Cabinet Viewer Test"), pageTxt.slice(0, 120));
    ok("vw: page is read-only (no delete)", !/fassa5|delete/i.test(pageTxt));
    // the page's inline script must be syntactically valid — a broken script = blank page
    const scriptM = pageTxt.match(/<script>([\s\S]*)<\/script>/);
    let scriptOk = false, scriptErr = "no <script> block";
    try { if (scriptM) { new Function(scriptM[1]); scriptOk = true; scriptErr = ""; } }
    catch (e) { scriptErr = e.message; }
    ok("vw: page script is valid JS", scriptOk, scriptErr);
    const rPageBad = await fetch(`${base}/v/${PILOT}/wrongtoken`);
    ok("vw: viewer page 403 with bad token", rPageBad.status === 403, `status=${rPageBad.status}`);

    // admin surface still sees everything (no filter)
    const jAdmin = await (await fetch(`${base}/api/conversations?password=${TEST_PW}`)).json();
    ok("vw: admin sees all numbers",
      jAdmin.conversations.some((c) => c.phone === "21600000901") && jAdmin.conversations.some((c) => c.phone === "21600000902"));

    // viewer_url carried in /api/clinics for Ahmed to copy
    await stubDb.saveClinicConfig("NUM_VW", { clinic_name: "Viewer Test" });
    const jClinics = await (await fetch(`${base}/api/clinics?password=${TEST_PW}`)).json();
    const vwEntry = (jClinics.clinics || []).find((c) => c.phone_number_id === "NUM_VW");
    ok("vw: /api/clinics carries viewer_url",
      !!(vwEntry && vwEntry.viewer_url && vwEntry.viewer_url.includes("/v/NUM_VW/")),
      JSON.stringify(vwEntry && vwEntry.viewer_url));
  }

  // ADMIN — clinic label per conversation + clinic filter on /messages
  {
    const base = "http://127.0.0.1:43117";
    const TEST_PW = "clinic-bot-verify-123";
    const jAdmin = await (await fetch(`${base}/api/conversations?password=${TEST_PW}`)).json();
    const p = jAdmin.conversations.find((c) => c.phone === "21600000901");
    ok("admin: conversation carries clinic label", p && p.clinic === "Cabinet Viewer Test", JSON.stringify(p && p.clinic));
    ok("admin: conversation carries number_id", !!(p && p.number_id === "111222333444555"), JSON.stringify(p && p.number_id));
    const o = jAdmin.conversations.find((c) => c.phone === "21600000902");
    ok("admin: other-number conversation labelled", !!(o && o.clinic), JSON.stringify(o && o.clinic));
    const rPage = await fetch(`${base}/messages`);
    ok("admin: page 200", rPage.status === 200, `status=${rPage.status}`);
    const pageTxt = await rPage.text();
    ok("admin: page has clinic filter", pageTxt.includes('id="filter"') && pageTxt.includes('renderList('), "no filter");
    const scriptM = pageTxt.match(/<script>([\s\S]*)<\/script>/);
    let scriptOk = false, scriptErr = "no <script> block";
    try { if (scriptM) { new Function(scriptM[1]); scriptOk = true; scriptErr = ""; } }
    catch (e) { scriptErr = e.message; }
    ok("admin: page script is valid JS", scriptOk, scriptErr);
  }

  // =================================================================
  // PART S — SALON vertical (2026-10-01): the 53 180 566 demo number.
  // The dentist path must be 100% unchanged; every salon test below also
  // guards that no dental vocabulary or dentist flow leaks into the salon.
  // =================================================================
  {
    const DENTAL_RE = /(3iyada|3yada|tbib|mridh|maridh|mardh|\bdwe\b|douleur|mal de dent|secretaire|سكرتيرة|طبيب|مريض|دواء|وجيعة|سنّة|اسنان|عيادة|dentiste|dentaire|cabinet dentaire|consultation)/i;
    const zeroDental = (r) => ok("salon: zero dental vocab", !DENTAL_RE.test(r), r.slice(0, 90));
    const SALON = "21653180566"; // the Meta ad number (display form)

    // S1 — display-number detection
    ok("S1: localNumber strips 216", bot.localNumber("21653180566") === "53180566");
    ok("S1: localNumber strips +/spaces", bot.localNumber("+216 53 180 566") === "53180566");
    ok("S1: salon display number detected", bot.isSalonDisplayNumber(SALON) === true);
    ok("S1: salon local form detected", bot.isSalonDisplayNumber("53180566") === true);
    ok("S1: other number not salon", bot.isSalonDisplayNumber("21652123456") === false);
    ok("S1: empty not salon", bot.isSalonDisplayNumber("") === false);
    ok("S1: seed vertical is salon", bot.SEED_SALON_BY_NUMBER["53180566"].vertical === "salon");

    // S2 — vertical resolution
    const vcSalon = await bot.getClinic(undefined, SALON);
    ok("S2: salon number resolves to salon", vcSalon.vertical === "salon", vcSalon.vertical);
    const vcDent = await bot.getClinic(undefined, "21652123456");
    ok("S2: other number stays dentist", vcDent.vertical === "dentist", vcDent.vertical);
    const vcNone = await bot.getClinic(undefined, undefined);
    ok("S2: no display number stays dentist", vcNone.vertical === "dentist", vcNone.vertical);
    // DB row beats the display-number seed (either direction)
    await stubDb.saveClinicConfig("21600000077", { clinic_name: "X", vertical: "salon" });
    const vcDbSalon = await bot.getClinic("21600000077", "21652123456");
    ok("S2: DB salon row wins over non-salon number", vcDbSalon.vertical === "salon");
    await stubDb.saveClinicConfig("21600000078", { clinic_name: "Y", vertical: "dentist" });
    const vcDbDent = await bot.getClinic("21600000078", SALON);
    ok("S2: DB dentist row wins over salon seed", vcDbDent.vertical === "dentist");
    await stubDb.clearClinicConfig("21600000077");
    await stubDb.clearClinicConfig("21600000078");

    // S3 — salon greeting (latin + arabic script), no dental vocab
    const g1 = await bot.processPatientText("salS1", "slm", undefined, SALON);
    has("S3: latin greeting", g1, "Assistant Salon");
    zeroDental(g1);
    const g2 = await bot.processPatientText("salS2", "عسلامة", undefined, SALON);
    has("S3: arabic greeting", g2, "مساعد الصالون");
    ok("S3: arabic greeting no demo/robot words", !/ديمو|روبوت|demo|robot/i.test(g2), g2.slice(0, 80));
    zeroDental(g2);

    // S4 — salon FAQ: services / prix / who / subscribe (example price list)
    const f1 = await bot.processPatientText("salS3", "chnowa el services?", undefined, SALON);
    has("S4: services FAQ", f1, "brushing");
    ok("S4: services FAQ no demo word", !/demo/i.test(f1), f1.slice(0, 80));
    has("S4: services FAQ says mthel", f1, "mthel");
    zeroDental(f1);
    const f2 = await bot.processPatientText("salS3", "b9adech el brushing?", undefined, SALON);
    has("S4: prix FAQ", f2, "25 DT");
    zeroDental(f2);
    const f3 = await bot.processPatientText("salS3", "chkoun enti", undefined, SALON);
    has("S4: who FAQ", f3, "Assistant Salon");
    zeroDental(f3);
    const f4 = await bot.processPatientText("salS4", "chnowa el ichtirak?", undefined, SALON);
    has("S4: subscribe FAQ has offer", f4, "3 DT");
    has("S4: subscribe FAQ 15 days free", f4, "15 jours");
    zeroDental(f4);

    // S5 — demo booking, multi-step (service -> slot -> simulated)
    const b1a = await bot.processPatientText("salB1", "n7eb na7jez", undefined, SALON);
    has("S5: demo booking asks service", b1a, "service");
    zeroDental(b1a);
    const b1b = await bot.processPatientText("salB1", "brushing", undefined, SALON);
    has("S5: demo booking asks slot", b1b, "nhar");
    zeroDental(b1b);
    const b1c = await bot.processPatientText("salB1", "ghodwa 10 mta3 sbe7", undefined, SALON);
    has("S5: demo booking simulated", b1c, "tajrba");
    has("S5: demo booking names service", b1c, "brushing");
    zeroDental(b1c);
    const demoB = stubDb._inspect().bookings.find((b) => b.phone === "salB1");
    ok("S5: demo booking saved", !!demoB, JSON.stringify(demoB && demoB.slot_text));
    ok("S5: demo booking tagged status=demo", demoB && demoB.status === "demo", demoB && demoB.status);
    const pendB = (await stubDb.getPendingBookings()).filter((x) => x.phone === "salB1");
    ok("S5: demo booking NOT in secretary pending list", pendB.length === 0, `n=${pendB.length}`);

    // S6 — demo booking, one-shot (service + slot in one message)
    const b2 = await bot.processPatientText("salB2", "n7eb na7jez chignon ghodwa 11 mta3 sbe7", undefined, SALON);
    has("S6: one-shot demo booking", b2, "chignon");
    has("S6: one-shot is a tajrba", b2, "tajrba");
    zeroDental(b2);
    const demoB2 = stubDb._inspect().bookings.find((b) => b.phone === "salB2");
    ok("S6: one-shot tagged demo", demoB2 && demoB2.status === "demo");

    // S7 — lead capture: owner wants the bot for their salon
    const _log = [];
    const _origLog = console.log;
    console.log = (...a) => { _log.push(a.join(" ")); };
    const l1 = await bot.processPatientText("salL1", "n7eb lel salon mte3i", undefined, SALON);
    has("S7: lead trigger asks name", l1, "esmek");
    zeroDental(l1);
    const l2 = await bot.processPatientText("salL1", "Ahmed", undefined, SALON);
    has("S7: lead asks salon name", l2, "salon");
    zeroDental(l2);
    const l3 = await bot.processPatientText("salL1", "Salon Lumière", undefined, SALON);
    has("S7: lead asks city", l3, "mdina");
    zeroDental(l3);
    const l4 = await bot.processPatientText("salL1", "Tounes", undefined, SALON);
    has("S7: lead asks phone", l4, "nafsou");
    zeroDental(l4);
    const l5 = await bot.processPatientText("salL1", "nafsou", undefined, SALON);
    console.log = _origLog;
    has("S7: lead handoff confirms", l5, "nettaslou");
    zeroDental(l5);
    const leadSignup = stubDb._inspect().signups.find((s) => s.phone === "salL1");
    ok("S7: lead saved as signup", !!leadSignup, JSON.stringify(leadSignup));
    ok("S7: signup kind=salon", leadSignup && leadSignup.kind === "salon", leadSignup && leadSignup.kind);
    ok("S7: signup keeps salon + city", leadSignup && leadSignup.clinic_name === "Salon Lumière" && leadSignup.city === "Tounes", JSON.stringify(leadSignup));
    ok("S7: sales notified of salon lead", _log.some((m) => m.includes("Lead SALON") && m.includes("salL1")), _log.filter((m) => m.includes("sales:SKIP")).slice(-1)[0] || "none");

    // S8 — "جرّب" on the salon number must NOT enter the dentist sales pitch
    const v1 = await bot.processPatientText("salV1", "جرّب", undefined, SALON);
    has("S8: jarreb on salon stays salon", v1, "صالون");
    zeroDental(v1);
    ok("S8: no dentist vendor pitch on salon number", !/(3iyada|عيادة|tbib|طبيب|دكتور)/i.test(v1), v1.slice(0, 90));

    // S9 — French on the salon number: salon fallback, never the dentist French prompt
    const fr1 = await bot.processPatientText("salF1", "Bonjour", undefined, SALON);
    has("S9: french on salon gets salon fallback", fr1, "assistant");
    ok("S9: french fallback no demo word", !/démo/i.test(fr1), fr1.slice(0, 80));
    zeroDental(fr1);
    ok("S9: no dentist french prompt", !/clinique \(dentiste\)/i.test(fr1), fr1.slice(0, 90));

    // S10 — no-AI fallback for the salon vertical: random msg -> qualify redirect
    const fb1 = await bot.processPatientText("salX1", "bla bla ma fhemtch", undefined, SALON);
    has("S10: random msg funnels to qualify", fb1, "3andek salon?");
    zeroDental(fb1);

    // S11 — dentist regression: a dentist number is 100% dentist
    // (NOTE 2026-10-06: 1364750653386950 is now the VIXA sales number, so a
    // generic dentist id is used here.)
    const DENTIST_ID = "777666555444333"; // default vertical = dentist
    const d1 = await bot.processPatientText("dentT1", "slm", DENTIST_ID);
    has("S11: dentist greeting works", d1, "3alikom salam!");
    ok("S11: dentist greeting has no salon/vixa leak", !/salon|صالون|Assistant Salon|VIXA|Ines/i.test(d1), d1.slice(0, 90));
    const d2 = await bot.processPatientText("dentT1", "n7eb na7jez ghodwa 10 mta3 sbe7", DENTIST_ID);
    has("S11: dentist booking flow confirms slot", d2, "D'accord");
    ok("S11: dentist booking never says demo", !/demo/i.test(d2), d2.slice(0, 90));
    const propD = await stubDb.getProposal("dentT1");
    ok("S11: dentist proposal saved", !!propD, "no proposal");
    const d3 = await bot.processPatientText("dentV1", "جرّب", DENTIST_ID);
    ok("S11: dentist vendor pitch still works", !/salon|صالون|Assistant Salon/i.test(d3), d3.slice(0, 90));
  }

  // ---- S12-S17 — batch fix 2026-10-01: qualify flow + wording ----
  {
    const DENTAL_RE = /(3iyada|3yada|tbib|mridh|maridh|mardh|\bdwe\b|douleur|mal de dent|secretaire|سكرتيرة|طبيب|مريض|دواء|وجيعة|سنّة|اسنان|عيادة|dentiste|dentaire|cabinet dentaire|consultation)/i;
    const zeroDental = (r) => ok("salon: zero dental vocab", !DENTAL_RE.test(r), r.slice(0, 90));
    const SALON = "21653180566";

    // S12 — info-seeking questions go deterministic (no AI freestyle)
    ok("S12: faqKind ma3loumet=who", bot.salonFaqKind("مرحبا هل يمكنني الحصول على مزيد من المعلومات حول هذا؟") === "who");
    ok("S12: faqKind more info=who", bot.salonFaqKind("I want more info please") === "who");
    ok("S12: faqKind c'est quoi=who", bot.salonFaqKind("c'est quoi hedha?") === "who");
    ok("S12: faqKind chnowa hedha=who", bot.salonFaqKind("chnowa hedha b dhabt?") === "who");
    ok("S12: faqKind kifech ye5dem=who", bot.salonFaqKind("kifech ye5dem?") === "who");
    const q1 = await bot.processPatientText("salQ1", "مرحبا هل يمكنني الحصول على مزيد من المعلومات حول هذا؟", undefined, SALON);
    has("S12: arabic info -> qualify question", q1, "عندك صالون؟");
    ok("S12: arabic qualify no demo/robot", !/ديمو|روبوت|demo|robot/i.test(q1), q1.slice(0, 100));
    zeroDental(q1);
    const q1lead = await stubDb.getVendorLead("salQ1");
    ok("S12: qualify stage saved", q1lead && q1lead.stage === "salon_qualify", q1lead && q1lead.stage);
    const q2 = await bot.processPatientText("salQ2", "c'est quoi hedha?", undefined, SALON);
    has("S12: latin info -> qualify question", q2, "3andek salon?");
    zeroDental(q2);

    // S13 — qualify "yes" (salon owner) -> pitch + prix + CTA -> lead flow
    // Arabic path: "أي" keeps the arabic script (kif-kif mirrors the message).
    const p1 = await bot.processPatientText("salQ1", "أي", undefined, SALON);
    has("S13: owner pitch has prix", p1, "3 دنانير");
    has("S13: owner pitch has 15 days", p1, "15 يوم");
    has("S13: owner pitch asks name", p1, "شنوة اسمك؟");
    ok("S13: pitch says assistant not robot", /مساعد/.test(p1) && !/روبوت/.test(p1), p1.slice(0, 60));
    zeroDental(p1);
    const p1lead = await stubDb.getVendorLead("salQ1");
    ok("S13: owner enters lead flow", p1lead && p1lead.stage === "salon_ask_name", p1lead && p1lead.stage);
    // Latin path: "oui" -> latin pitch, then the lead flow continues.
    const p2lat = await bot.processPatientText("salQ2", "oui", undefined, SALON);
    has("S13: latin oui -> pitch", p2lat, "3 DT");
    has("S13: latin pitch asks name", p2lat, "Chnowa esmek?");
    ok("S13: latin pitch no demo/robot", !/demo|robot/i.test(p2lat), p2lat.slice(0, 80));
    const p2 = await bot.processPatientText("salQ2", "Mariem", undefined, SALON);
    has("S13: lead continues to salon name", p2, "salon");

    // S14 — qualify "le" (7arifa) -> demo trial only, transparency first
    const n1 = await bot.processPatientText("salQ3", "n7eb na3ref ma3loumet", undefined, SALON);
    has("S14: info -> qualify", n1, "3andek salon?");
    const n2 = await bot.processPatientText("salQ3", "le", undefined, SALON);
    has("S14: 7arifa gets tajrba transparency", n2, "tajrba");
    has("S14: 7arifa asked service", n2, "service");
    ok("S14: no prix sold to 7arifa", !/3 DT|دنانير/.test(n2), n2.slice(0, 80));
    zeroDental(n2);
    const n3 = await bot.processPatientText("salQ3", "brushing", undefined, SALON);
    has("S14: 7arifa trial continues", n3, "nhar");
    zeroDental(n3);

    // S15 — qualify unclear answer -> re-ask simply
    await bot.processPatientText("salQ4", "chnowa hedha?", undefined, SALON);
    const u1 = await bot.processPatientText("salQ4", "xyz", undefined, SALON);
    has("S15: unclear -> re-ask", u1, "3andek salon?");
    const u2 = await bot.processPatientText("salQ4", "le salon", undefined, SALON);
    has("S15: 'le salon' not misread as no", u2, "3andek salon?");

    // S16 — wording: no demo/robot anywhere in salon user-visible replies
    const NO_BAD = /demo|démo|robot|ديمو|روبوت/i;
    const salonReplies = [
      bot.salonFaqAnswer("who", true), bot.salonFaqAnswer("who", false),
      bot.salonFaqAnswer("services", true), bot.salonFaqAnswer("services", false),
      bot.salonFaqAnswer("prix", true), bot.salonFaqAnswer("prix", false),
      bot.salonFaqAnswer("subscribe", true), bot.salonFaqAnswer("subscribe", false),
      bot.salonFrenchFallback(),
      bot.salonFallbackReply("xyz", true), bot.salonFallbackReply("xyz", false),
      bot.salonOwnerPitch(true), bot.salonOwnerPitch(false),
    ];
    salonReplies.forEach((r, i) => ok(`S16: reply ${i} no demo/robot`, !NO_BAD.test(r), r.slice(0, 80)));
    ok("S16: prompt bans robot/demo", /MAMNOU3 kelmet "robot" w "demo"/.test(bot.SALON_SYSTEM_PROMPT));

    // S17 — salonYesNo unit
    ok("S17: ey=yes", bot.salonYesNo("ey") === "yes");
    ok("S17: Ey=yes", bot.salonYesNo("Ey") === "yes");
    ok("S17: oui=yes", bot.salonYesNo("oui") === "yes");
    ok("S17: نعم=yes", bot.salonYesNo("نعم") === "yes");
    ok("S17: 3andi salon=yes", bot.salonYesNo("3andi salon") === "yes");
    ok("S17: le=no", bot.salonYesNo("le") === "no");
    ok("S17: non=no", bot.salonYesNo("non") === "no");
    ok("S17: لا=no", bot.salonYesNo("لا") === "no");
    ok("S17: ma 3andich=no", bot.salonYesNo("ma 3andich") === "no");
    ok("S17: xyz=null", bot.salonYesNo("xyz") === null);
    ok("S17: le salon=null (not misread)", bot.salonYesNo("le salon") === null);
  }

  // ---- S18 — French qualify: short question, oui/non branch ----
  {
    const DENTAL_RE = /(3iyada|3yada|tbib|mridh|maridh|mardh|\bdwe\b|douleur|mal de dent|secretaire|سكرتيرة|طبيب|مريض|دواء|وجيعة|سنّة|اسنان|عيادة|dentiste|dentaire|cabinet dentaire|consultation)/i;
    const zeroDental = (r) => ok("salon: zero dental vocab", !DENTAL_RE.test(r), r.slice(0, 90));
    const SALON = "21653180566";

    const fq1 = await bot.processPatientText("salQ5", "Bonjour ! Puis-je en savoir plus à ce sujet ?", undefined, SALON);
    has("S18: french info -> short qualify", fq1, "Vous avez un salon ?");
    ok("S18: french qualify is short", fq1.length < 160, `len=${fq1.length}`);
    ok("S18: french qualify no arabizi CTA", !/n7eb lel salon/.test(fq1), fq1.slice(0, 120));
    zeroDental(fq1);
    const fq1lead = await stubDb.getVendorLead("salQ5");
    ok("S18: qualify lang=fr saved", fq1lead && fq1lead.stage === "salon_qualify", fq1lead && fq1lead.stage);
    const fq2 = await bot.processPatientText("salQ5", "oui", undefined, SALON);
    has("S18: oui -> french pitch prix", fq2, "3 DT");
    has("S18: oui -> french pitch asks name", fq2, "Quel est votre nom ?");
    ok("S18: french pitch no demo/robot", !/démo|robot/i.test(fq2), fq2.slice(0, 80));
    zeroDental(fq2);
    const fq2lead = await stubDb.getVendorLead("salQ5");
    ok("S18: oui enters lead flow", fq2lead && fq2lead.stage === "salon_ask_name", fq2lead && fq2lead.stage);
    const fq3 = await bot.processPatientText("salQ6", "Bonjour", undefined, SALON);
    has("S18: bonjour -> qualify", fq3, "Vous avez un salon ?");
    const fq4 = await bot.processPatientText("salQ6", "non", undefined, SALON);
    has("S18: non -> french trial transparency", fq4, "essai");
    ok("S18: french trial asks service", /service/.test(fq4), fq4.slice(0, 80));
    zeroDental(fq4);
    await bot.processPatientText("salQ7", "Bonjour", undefined, SALON);
    const fq6 = await bot.processPatientText("salQ7", "xyz", undefined, SALON);
    has("S18: french unclear -> re-ask", fq6, "Vous avez un salon ?");
    ok("S18: french pitch fn has no banned words", !/demo|démo|robot|ديمو|روبوت/i.test(bot.salonOwnerPitchFr()));
  }

  // ---- S19 — info question mid-lead-flow: answer it, return to pending Q ----
  {
    const SALON = "21653180566";

    // Exact live case (2026-10-01): ask_name + arabic info question.
    await stubDb.saveVendorLead("salM1", "salon_ask_name", JSON.stringify({ lang: "ar" }));
    const m1 = await bot.processPatientText("salM1", "مرحبا هل يمكنني الحصول على مزيد من المعلومات حول هذا؟", undefined, SALON);
    ok("S19: mid-flow who answered (intro)", /مساعد الصالون/.test(m1), m1.slice(0, 60));
    ok("S19: mid-flow who has no qualify Q", !/عندك صالون/.test(m1), m1.slice(0, 120));
    has("S19: mid-flow returns to name Q", m1, "شنوة اسمك؟");
    const m1s = await stubDb.getVendorLead("salM1");
    ok("S19: stage unchanged", m1s && m1s.stage === "salon_ask_name", m1s && m1s.stage);

    // Prix question mid-flow (latin).
    await stubDb.saveVendorLead("salM2", "salon_ask_salon", JSON.stringify({ lang: "latin", name: "Mariem" }));
    const m2 = await bot.processPatientText("salM2", "b9adech el brushing?", undefined, SALON);
    has("S19: mid-flow prix answered", m2, "25 DT");
    has("S19: mid-flow returns to salon Q", m2, "Chnowa esm el salon?");

    // French mid-flow.
    await stubDb.saveVendorLead("salM3", "salon_ask_name", JSON.stringify({ lang: "fr" }));
    const m3 = await bot.processPatientText("salM3", "c'est quoi exactement ?", undefined, SALON);
    ok("S19: french mid-flow intro", /Assistant Salon/.test(m3), m3.slice(0, 60));
    has("S19: french mid-flow returns to name Q", m3, "Quel est votre nom ?");

    // Normal answers still flow (no regression).
    const m4 = await bot.processPatientText("salM1", "مريم", undefined, SALON);
    has("S19: name still accepted after interrupt", m4, "صالون");
  }

  // ---- S20 — no AI on the salon number: random msg -> deterministic qualify ----
  {
    const SALON = "21653180566";
    // Latin gibberish -> deterministic redirect, qualify state saved.
    const r1 = await bot.processPatientText("salR1", "haha lol 123 ???", undefined, SALON);
    has("S20: random latin -> qualify redirect", r1, "3andek salon?");
    ok("S20: no AI leak (short reply)", r1.length < 120, String(r1.length));
    const r1s = await stubDb.getVendorLead("salR1");
    ok("S20: qualify state saved", r1s && r1s.stage === "salon_qualify", r1s && r1s.stage);
    // Funnel continues: "ey" -> owner pitch.
    const r2 = await bot.processPatientText("salR1", "ey", undefined, SALON);
    has("S20: ey after redirect -> pitch", r2, "3 DT");
    // Arabic gibberish -> arabic redirect.
    const r3 = await bot.processPatientText("salR2", "هههه شنوة هالخراب", undefined, SALON);
    has("S20: random arabic -> qualify redirect", r3, "عندك صالون؟");
  }

  // ---- S21 — VIXA sales vertical (fake 52999999 via VIXA_NUMBERS env): never Dr Ines, blech only ----
  // (2026-10-07: the real 52150093 moved back to the Dr Mahjoub dentist pilot.)
  {
    const VIXA = "21652999999";
    const vixReplies = [];
    const vix = async (ph, txt, numId, disp) => {
      const r = await bot.processPatientText(ph, txt, numId, disp === undefined ? VIXA : disp);
      vixReplies.push(r);
      return r;
    };

    // Identity: vertical + name via display number.
    const c1 = await bot.getClinic(undefined, VIXA);
    ok("S21: vertical is vixa", c1.vertical === "vixa", c1.vertical);
    ok("S21: name is VIXA", c1.name === "VIXA", c1.name);
    ok("S21: greeting is VIXA (no Ines)", /VIXA/.test(c1.greeting) && !/ines/i.test(c1.greeting), c1.greeting.slice(0, 60));
    // Stale DB row on a vixa display number: display-number seed wins for
    // vertical, and the Ines-leak guard forces the VIXA identity.
    await stubDb.saveClinicConfig("99999999999999999", { clinic_name: "Cabinet Dr Ines", vertical: "dentist", greeting: "Ahla w sahla fi Cabinet Dr Ines!" });
    const c3 = await bot.getClinic("99999999999999999", VIXA);
    ok("S21: stale DB row cannot change vertical", c3.vertical === "vixa", c3.vertical);
    ok("S21: stale DB row cannot leak Ines name", c3.name === "VIXA", c3.name);
    ok("S21: stale DB row cannot leak Ines greeting", !/ines/i.test(c3.greeting), c3.greeting.slice(0, 60));
    await stubDb.clearClinicConfig("99999999999999999");

    // Greeting -> VIXA + qualify state.
    const g1 = await vix("vixG1", "slm");
    has("S21: greeting says VIXA", g1, "Assistant VIXA");
    has("S21: greeting qualifies", g1, "3iyada/cabinet?");
    const g1s = await stubDb.getVendorLead("vixG1");
    ok("S21: greeting saves vixa_qualify", g1s && g1s.stage === "vixa_qualify", g1s && g1s.stage);

    // Qualify yes -> pitch (blech, NO price) -> lead flow.
    const q1 = await vix("vixG1", "ey");
    has("S21: pitch has blech", q1, "blech");
    ok("S21: pitch has no price", !/\d+\s*(DT|dt|dinar|tnd)/i.test(q1) && !/2 dinars|3 DT/.test(q1), q1.slice(0, 120));
    has("S21: pitch asks name", q1, "Chnowa esmek?");
    const q1s = await stubDb.getVendorLead("vixG1");
    ok("S21: yes -> vixa_ask_name", q1s && q1s.stage === "vixa_ask_name", q1s && q1s.stage);

    // French "je suis un dentiste" (live ad case 2026-10-07) -> yes + French pitch.
    const qf = await vix("vixFR1", "slm");
    ok("S21: fr greet qualifies", qf.includes("3iyada"), qf.slice(0, 60));
    const qf2 = await vix("vixFR1", "je suis un dentiste");
    const qf2s = await stubDb.getVendorLead("vixFR1");
    ok("S21: 'je suis un dentiste' -> vixa_ask_name", qf2s && qf2s.stage === "vixa_ask_name", qf2s && qf2s.stage);
    ok("S21: fr yes -> lang fr", qf2s && JSON.parse(qf2s.clinic_name || "{}").lang === "fr", qf2s && qf2s.clinic_name);
    // vixaYesNo unit checks
    ok("S21: yesno je suis dentiste", bot.vixaYesNo("je suis dentiste") === "yes");
    ok("S21: yesno dentiste", bot.vixaYesNo("dentiste") === "yes");
    ok("S21: yesno je suis médecin", bot.vixaYesNo("je suis médecin") === "yes");
    ok("S21: yesno ena dentiste", bot.vixaYesNo("ena dentiste") === "yes");
    ok("S21: yesno still no", bot.vixaYesNo("ma 3andich") === "no");

    // Full lead flow: name -> clinic -> phone -> time -> signup + notify.
    const n1 = await vix("vixG1", "Mohamed Trabelsi");
    has("S21: asks clinic name", n1, "esm el 3iyada");
    const n2 = await vix("vixG1", "Centre Dentaire El Manar");
    has("S21: asks phone", n2, "nafsou");
    const n3 = await vix("vixG1", "nafsou");
    has("S21: asks call time", n3, "10 d9aye9");
    const n4 = await vix("vixG1", "ghodwa 10 mta3 sbe7");
    has("S21: confirms callback", n4, "nettaslou bik");
    const signups = stubDb._inspect().signups;
    const last = signups[signups.length - 1];
    ok("S21: signup saved kind=clinic", last && last.kind === "clinic" && /Trabelsi/i.test(last.name), JSON.stringify(last));

    // Qualify no -> patient redirect, nothing sold.
    const r1 = await vix("vixN1", "3aslema");
    const r2 = await vix("vixN1", "le");
    has("S21: non-owner redirected", r2, "propriétaires des cliniques");
    ok("S21: non-owner sells nothing", !/blech|pitch|esm/i.test(r2) || /3iyada mte3ek direct/.test(r2), r2.slice(0, 80));

    // Unclear -> re-ask.
    await vix("vixU1", "salam");
    const u1 = await vix("vixU1", "mmm chnowa?");
    has("S21: unclear -> re-ask qualify", u1, "3andek 3iyada?");

    // Medical question -> redirect, NEVER a medical answer.
    const m1 = await vix("vixM1", "3andi wji3a kbira fel senna, chnowa el dwe?");
    has("S21: medical redirected", m1, "ma njewbch 3la as2la tibbiya");
    ok("S21: medical gives no diagnosis", !/diagnostic|تشخيص|ordonnance/i.test(m1), m1.slice(0, 100));

    // Prix -> blech, no numbers.
    const p1 = await vix("vixP1", "b9adech el ichtirak?");
    has("S21: prix -> blech", p1, "blech");
    ok("S21: prix has no amount", !/\d+\s*(dt|dinar|tnd|€|\$)/i.test(p1) && !/2 dinars|50 TND/.test(p1), p1.slice(0, 80));

    // who -> intro + qualify.
    const w1 = await vix("vixW1", "chkoun enti?");
    has("S21: who -> intro", w1, "Assistant VIXA");
    has("S21: who -> qualify Q", w1, "3andek 3iyada?");

    // French: qualify -> oui -> French pitch (gratuit, no price).
    const f1 = await vix("vixF1", "Bonjour");
    has("S21: french qualify", f1, "une clinique ? (oui/non)");
    const f2 = await vix("vixF1", "oui");
    has("S21: french pitch gratuit", f2, "gratuit");
    ok("S21: french pitch no price", !/\d+\s*(DT|dt|€)/.test(f2), f2.slice(0, 100));
    has("S21: french pitch asks name", f2, "Quel est votre nom ?");

    // Arabic: qualify -> pitch with بلاش.
    const a1 = await vix("vixA1", "شكون انت؟");
    has("S21: arabic who -> intro", a1, "مساعد VIXA");
    const a2 = await vix("vixA1", "أي");
    has("S21: arabic pitch blech", a2, "بلاش");

    // Random gibberish -> deterministic qualify redirect (no AI, short).
    const z1 = await vix("vixZ1", "haha xyz 123 ???");
    has("S21: random -> qualify redirect", z1, "3andek 3iyada?");
    ok("S21: vixa no AI leak (short)", z1.length < 120, String(z1.length));

    // Old dentist "جرّب" trigger must NOT fire the stale 2-dinar pricing here.
    const j1 = await vix("vixJ1", "جرّب");
    ok("S21: no stale vendor pricing", !/2 dinars|2 دنانير|3 DT/.test(j1), j1.slice(0, 100));

    // Mid-flow info interrupt: answer + return to pending Q, stage unchanged.
    await stubDb.saveVendorLead("vixI1", "vixa_ask_name", JSON.stringify({ lang: "latin" }));
    const i1 = await vix("vixI1", "b9adech?");
    has("S21: mid-flow prix answered", i1, "blech");
    has("S21: mid-flow returns to name Q", i1, "Chnowa esmek?");
    const i1s = await stubDb.getVendorLead("vixI1");
    ok("S21: vixa stage unchanged", i1s && i1s.stage === "vixa_ask_name", i1s && i1s.stage);

    // Off-script mid-flow ("chnowa a7welek enti") -> AI nudge; without an AI
    // key it falls back to the pending question, stage unchanged.
    await stubDb.saveVendorLead("vixN1", "vixa_ask_name", JSON.stringify({ lang: "latin" }));
    const w9a = await vix("vixN1", "chnowa a7welek enti");
    has("S21: off-script -> pending Q (no AI key)", w9a, "Chnowa esmek?");
    const w9as = await stubDb.getVendorLead("vixN1");
    ok("S21: off-script stage unchanged", w9as && w9as.stage === "vixa_ask_name", w9as && w9as.stage);

    // Real names still parse (no false nudge).
    const w9b = await vix("vixN1", "Mohamed Ben Salah");
    const w9bs = await stubDb.getVendorLead("vixN1");
    ok("S21: name still advances", w9bs && w9bs.stage === "vixa_ask_clinic", w9bs && w9bs.stage);

    // Qualify unclear -> nudge falls back to the qualify question.
    await stubDb.saveVendorLead("vixQ1", "vixa_qualify", JSON.stringify({ lang: "latin" }));
    const w9q = await vix("vixQ1", "hmm ???");
    has("S21: qualify unclear -> qualify Q", w9q, "3andek 3iyada?");

    // "nafs enoumrou" counts as same number -> advances to ask_time.
    await stubDb.saveVendorLead("vixP1", "vixa_ask_phone",
      JSON.stringify({ lang: "latin", name: "Ahmed", clinic: "Test" }));
    const w8a = await vix("vixP1", "nafs enoumrou");
    const w8as = await stubDb.getVendorLead("vixP1");
    ok("S21: 'nafs enoumrou' -> ask_time", w8as && w8as.stage === "vixa_ask_time", w8as && w8as.stage);

    // "ma7ajtich b appel" -> graceful close, lead cleared, no sales ping.
    await stubDb.saveVendorLead("vixT1", "vixa_ask_time",
      JSON.stringify({ lang: "latin", name: "Ahmed", clinic: "Test", finalPhone: "21600000000" }));
    const w8b = await vix("vixT1", "ma7ajtich b appel");
    has("S21: call refusal -> graceful close", w8b, "blech appel");
    const w8bs = await stubDb.getVendorLead("vixT1");
    ok("S21: call refusal clears lead", !w8bs || !w8bs.stage, w8bs && w8bs.stage);

    // Gibberish time -> nudge (pending Q), not a blind confirmation.
    await stubDb.saveVendorLead("vixT2", "vixa_ask_time",
      JSON.stringify({ lang: "latin", name: "Ahmed", clinic: "Test", finalPhone: "21600000000" }));
    const w8c = await vix("vixT2", "bla bla");
    has("S21: gibberish time -> re-ask", w8c, "10 d9aye9");
    const w8cs = await stubDb.getVendorLead("vixT2");
    ok("S21: gibberish time keeps stage", w8cs && w8cs.stage === "vixa_ask_time", w8cs && w8cs.stage);

    // Real time still confirms.
    const w8d = await vix("vixT2", "ghodwa 10");
    has("S21: real time confirms", w8d, "Bech nettaslou");

    // Arabizi digit-letters ("3aslema") are NOT times -> nudge, not confirm.
    await stubDb.saveVendorLead("vixT3", "vixa_ask_time",
      JSON.stringify({ lang: "latin", name: "Ahmed", clinic: "Test", finalPhone: "21600000000" }));
    const w8e = await vix("vixT3", "3aslema");
    has("S21: '3aslema' not a time", w8e, "10 d9aye9");

    // "ma3andich clinique" is a denial, not a clinic name -> not-owner redirect.
    await stubDb.saveVendorLead("vixC1", "vixa_ask_clinic",
      JSON.stringify({ lang: "latin", name: "Ahmed" }));
    const w8f = await vix("vixC1", "ma3andich clinique");
    has("S21: denies clinic -> not-owner", w8f, "propriétaires");
    const w8fs = await stubDb.getVendorLead("vixC1");
    ok("S21: denies clinic clears lead", !w8fs || !w8fs.stage, w8fs && w8fs.stage);

    // A real clinic name still advances.
    await stubDb.saveVendorLead("vixC2", "vixa_ask_clinic",
      JSON.stringify({ lang: "latin", name: "Ahmed" }));
    const w8g = await vix("vixC2", "Clinique El Amen");
    const w8gs = await stubDb.getVendorLead("vixC2");
    ok("S21: real clinic name advances", w8gs && w8gs.stage === "vixa_ask_phone", w8gs && w8gs.stage);

    // General dismissal at ANY stage -> cancel, never taken as an answer.
    await stubDb.saveVendorLead("vixD1", "vixa_ask_clinic",
      JSON.stringify({ lang: "latin", name: "Ahmed" }));
    const w8h = await vix("vixD1", "manheb chay tawa");
    has("S21: 'manheb chay' -> cancel", w8h, "l4it el demande");
    const w8hs = await stubDb.getVendorLead("vixD1");
    ok("S21: dismissal clears lead", !w8hs || !w8hs.stage, w8hs && w8hs.stage);

    await stubDb.saveVendorLead("vixD2", "vixa_ask_name", JSON.stringify({ lang: "latin" }));
    const w8i = await vix("vixD2", "sayeb 3laya");
    has("S21: 'sayeb 3laya' -> cancel", w8i, "l4it el demande");

    // "juste nes2el" is a sentence, never a name (ask_name) or clinic (ask_clinic).
    await stubDb.saveVendorLead("vixE1", "vixa_ask_name", JSON.stringify({ lang: "latin" }));
    const w8j = await vix("vixE1", "juste nes2el");
    has("S21: 'juste nes2el' not a person name", w8j, "Chnowa esmek?");
    const w8js = await stubDb.getVendorLead("vixE1");
    ok("S21: sentence keeps name stage", w8js && w8js.stage === "vixa_ask_name", w8js && w8js.stage);

    await stubDb.saveVendorLead("vixE2", "vixa_ask_clinic",
      JSON.stringify({ lang: "latin", name: "Ahmed" }));
    const w8k = await vix("vixE2", "juste nes2el");
    has("S21: 'juste nes2el' not a clinic", w8k, "esm el 3iyada");
    const w8ks = await stubDb.getVendorLead("vixE2");
    ok("S21: sentence keeps clinic stage", w8ks && w8ks.stage === "vixa_ask_clinic", w8ks && w8ks.stage);

    await stubDb.saveVendorLead("vixE3", "vixa_ask_clinic",
      JSON.stringify({ lang: "latin", name: "Ahmed" }));
    const w8l = await vix("vixE3", "nheb na3ref akther");
    has("S21: 'nheb na3ref' not a clinic", w8l, "esm el 3iyada");

    // "Cabinet Dr Ines" must appear in ZERO vixa replies.
    ok("S21: Ines never appears", vixReplies.every((r) => !/ines/i.test(r || "")),
      vixReplies.find((r) => /ines/i.test(r || "")));

    // Salon number untouched by the vixa change.
    const s1 = await bot.processPatientText("vixS1", "slm", undefined, "21653180566");
    has("S21: salon still salon", s1, "Assistant Salon");
  }

  // ---- S22 — Dr Mahjoub dentist pilot (+216 52 150 093): receptionist, never sales ----
  {
    const MAH = "21652150093";
    const mah = async (ph, txt, numId, disp) => {
      const r = await bot.processPatientText(ph, txt, numId, disp === undefined ? MAH : disp);
      return r;
    };

    // Identity: dentist vertical, Mahjoub name/address/hours, no VIXA sales.
    const m1 = await bot.getClinic(undefined, MAH);
    ok("S22: vertical is dentist", m1.vertical === "dentist", m1.vertical);
    ok("S22: name is Mahjoub", /Mahjoub/.test(m1.name), m1.name);
    ok("S22: address is Sousse", /Ghannouchi/.test(m1.address), m1.address);
    ok("S22: hours mention Sebt", /Sebt/.test(m1.hours), m1.hours);
    ok("S22: secretary is the doctor", m1.secretary === "98800749", m1.secretary);
    ok("S22: no VIXA sales pitch", !/VIXA/.test(m1.greeting), m1.greeting.slice(0, 40));
    // Identity via phone_number_id too (viewer path).
    const m2 = await bot.getClinic("1364750653386950", undefined);
    ok("S22: id seed vertical is dentist", m2.vertical === "dentist", m2.vertical);
    ok("S22: id seed name is Mahjoub", /Mahjoub/.test(m2.name), m2.name);
    // Booking hours parsed: Mon-Fri 8-17, Sat 8-13, Sun closed.
    ok("S22: bookingHours Mon", m1.bookingHours && m1.bookingHours[1] && m1.bookingHours[1][0] === 8 && m1.bookingHours[1][1] === 17, JSON.stringify(m1.bookingHours));
    ok("S22: bookingHours Sat", m1.bookingHours && m1.bookingHours[6] && m1.bookingHours[6][1] === 13, JSON.stringify(m1.bookingHours));
    ok("S22: bookingHours Sun closed", !m1.bookingHours || !m1.bookingHours[0], JSON.stringify(m1.bookingHours));

    // Patient flow: greeting names the clinic, booking intent proposes slots.
    const g = await mah("mahG1", "slm");
    has("S22: greeting names Mahjoub", g, "Mahjoub");
    ok("S22: greeting has no sales qualify", typeof g === "string" && !/3andek 3iyada/.test(g), JSON.stringify(g));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
