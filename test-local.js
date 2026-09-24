// test-local.js — full regression test for the clinic bot. No network, no Postgres.
// Drives the REAL processPatientText / processSecretaryText with an in-memory db stub,
// plus a wide matrix of Derja date/time expressions through the REAL dates.js.
// Usage: node test-local.js   (exit 0 = all green)
process.env.PORT = "43117";

const path = require("path");

// ---------- in-memory db stub (same interface as db.js) ----------
function makeStubDb() {
  const messages = [];
  const bookings = [];
  const proposals = new Map();
  const patients = new Map();
  const vendorLeads = new Map();
  const signups = [];
  let seq = 1;
  return {
    initDb: async () => true,
    saveMessage: async (phone, role, text) => { messages.push({ phone, role, text }); },
    getHistory: async (phone, limit = 15) =>
      messages.filter((m) => m.phone === phone).slice(-limit).map((m) => ({ role: m.role, text: m.text })),
    getConversations: async () =>
      [...new Set(messages.map((m) => m.phone))].map((phone) => ({
        phone,
        count: messages.filter((m) => m.phone === phone).length,
        last_at: "test",
      })),
    getFullHistory: async (phone) =>
      messages.filter((m) => m.phone === phone).map((m) => ({ role: m.role, text: m.text })),
    deleteConversation: async (phone) => {
      let n = 0;
      for (let i = messages.length - 1; i >= 0; i--)
        if (messages[i].phone === phone) { messages.splice(i, 1); n++; }
      proposals.delete(phone);
      patients.delete(phone);
      vendorLeads.delete(phone);
      return n;
    },
    saveBooking: async (phone, slot, slot_at = null, patient_name = null) => {
      const b = { id: seq++, phone, slot, slot_at, patient_name, status: "pending" };
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
    setBookingStatus: async (id, status) => {
      const b = bookings.find((b) => b.id === id);
      if (b) b.status = status;
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
    saveSignup: async (name, phone, clinic_name, city) => {
      const s = { id: seq++, name, phone, clinic_name, city, created_at: "test" };
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
    _inspect: () => ({ messages, bookings, proposals }),
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
  ["Ghodwa m3a khamsa mte3 l3chwa", "ghodwa 23 septembre, 17:00"], // the reported bug
  ["ghodwa m3a 5 mte3 l3chiya", "ghodwa 23 septembre, 17:00"],
  ["ghodwa 10 mta3 sbe7", "ghodwa 23 septembre, 10:00"],
  ["ghodwa m3a 10", "ghodwa 23 septembre, 10:00"], // 8-12 bare = morning
  ["ghodwa sbe7", "needs:ghodwa 23 septembre"],
  ["ghodwa", "needs:ghodwa 23 septembre"],
  ["ba3d ghodwa", "needs:ba3d ghodwa 24 septembre"],
  ["ba3d ghodwa m3a 4 mte3 l3chiya", "ba3d ghodwa 24 septembre, 16:00"],
  ["jem3a", "needs:jem3a 25 septembre"],
  ["jem3a 10", "jem3a 25 septembre, 10:00"], // 8-12 bare = morning
  ["jem3a 3", "jem3a 25 septembre, 15:00"], // 1-6 bare = afternoon
  ["jem3a 6", "jem3a 25 septembre, 18:00"],
  ["jem3a 12", "jem3a 25 septembre, 12:00"],
  ["jem3a 7", "needs:jem3a 25 septembre"], // only bare 7 is ambiguous
  ["jem3a el khamsa mte3 l3chiya", "jem3a 25 septembre, 17:00"],
  // word-hour "larb3a" = 4 o'clock (the live case); bare "larb3a" stays Wednesday
  ["jem3a larb3a mte3 la3vhiya", "jem3a 25 septembre, 16:00"],
  ["khmis larb3a", "khmis 24 septembre, 16:00"], // bare 4 = afternoon (clinic hours)
  ["jem3a 4 mte3 la3vhiya", "jem3a 25 septembre, 16:00"],
  ["larb3a", "needs:erb3a 23 septembre"], // Wednesday, NOT 4 o'clock
  ["larb3a m3a 10 mta3 sbe7", "erb3a 23 septembre, 10:00"],
  ["sibt", "needs:sebt 26 septembre"], // canonical spelling
  ["sebt m3a 11 mta3 sbe7", "sebt 26 septembre, 11:00"],
  ["la7ad", "needs:l7ad 27 septembre"], // canonical spelling
  ["ethnin", "needs:ethnin 28 septembre"],
  ["thnin m3a 9 mta3 sbe7", "ethnin 28 septembre, 09:00"], // canonical spelling
  ["ethnin el 10", "ethnin 28 septembre, 10:00"], // Monday must NOT read as "2 o'clock"
  ["ethnin m3a zouz", "ethnin 28 septembre, 14:00"], // 1-6 bare = afternoon
  ["khmis", "needs:khmis 24 septembre"],
  ["erb3a", "needs:erb3a 23 septembre"],
  ["21 septembre", "needs:21 septembre"],
  ["25/09 m3a 3 mte3 l3chiya", "25 septembre, 15:00"],
  ["ghodwa m3a 8 mte3 lil", "ghodwa 23 septembre, 20:00"],
  ["ghodwa m3a tes3a mte3 lil", "ghodwa 23 septembre, 21:00"],
  ["ghodwa m3a seb3a mte3 sbe7", "ghodwa 23 septembre, 07:00"],
  ["ghodwa m3a 5:30 mte3 l3chiya", "ghodwa 23 septembre, 17:30"],
  ["ghodwa m3a 17:30", "ghodwa 23 septembre, 17:30"],
  ["ghodwa nos el nhar", "ghodwa 23 septembre, 12:00"],
  ["ghodwa nos el lil", "ghodwa 23 septembre, 00:00"],
  ["ghodwa m3a 12", "ghodwa 23 septembre, 12:00"],
  ["ghodwa m3a 12 mte3 lil", "ghodwa 23 septembre, 00:00"],
  ["ghodwa m3a zouz", "ghodwa 23 septembre, 14:00"], // 2 bare = afternoon
  ["ghodwa khamsa", "ghodwa 23 septembre, 17:00"],   // 5 bare = afternoon
  ["lyoum m3a el wa7da mte3 lil", "PAST"],          // 01:00 today < 19:30 now
  ["lyoum m3a 8 mta3 sbe7", "PAST"],
  ["lyoum m3a 9 mte3 lil", "lyoum 22 septembre, 21:00"], // 21:00 > 19:30, future
  ["sbe7", "NONE"],
  ["l3chiya", "NONE"],
  ["Khamsa l3chiya", "FOUND-NODATE"], // number words now parse it as a time
  ["10", "FOUND-NODATE"],
  // Arabic-script dates
  ["غدوة مع الخمسة متاع العشية", "غدوة 23 سبتمبر، 17:00"],
  ["غدوة مع خمسة متاع العشية", "غدوة 23 سبتمبر، 17:00"],
  ["الجمعة 10", "الجمعة 25 سبتمبر، 10:00"],
  ["الجمعة مع العشرة متاع الصباح", "الجمعة 25 سبتمبر، 10:00"],
  ["اليوم", "needs:اليوم 22 سبتمبر"],
  ["غدوة", "needs:غدوة 23 سبتمبر"],
  ["بعد غدوة", "needs:بعد غدوة 24 سبتمبر"],
  ["نحب نحجز", "NONE"],
  ["غدوة مع 12 متاع الليل", "غدوة 23 سبتمبر، 00:00"],
  ["٢٥/٠٩ مع 3 متاع العشية", "25 سبتمبر، 15:00"], // Arabic-Indic digits
  ["21 سبتمبر 15:30", "21 سبتمبر، 15:30"],
  ["غدوة نص النهار", "غدوة 23 سبتمبر، 12:00"],
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
  ok("dates: ghodwa m3a 5 -> afternoon by default", r2.found && !r2.morning && !r2.afternoon && !r2.night && r2.display === "ghodwa 23 septembre, 17:00");
}

// ---------- PART B: full conversation flows (real processPatientText) ----------
async function run() {
  // Flow 1 — the exact reported bug, then accept -> name gate -> booked with name
  {
    const p = "21600000001";
    const r1 = await bot.processPatientText(p, "Ghodwa m3a khamsa mte3 l3chwa");
    has("flow1: direct proposal 17:00", r1, "ghodwa 23 septembre, 17:00");
    has("flow1: asks ey", r1, "ey");
    const r2 = await bot.processPatientText(p, "ey");
    has("flow1: asks for name", r2, "esm wel la9ab");
    has("flow1: name question keeps slot", r2, "ghodwa 23 septembre, 17:00");
    const b0 = await stubDb.getLatestBooking(p);
    ok("flow1: no booking before name", !b0, JSON.stringify(b0));
    const r3 = await bot.processPatientText(p, "ahmed ben salah");
    has("flow1: booked", r3, "n2akkedlek");
    has("flow1: d'accord wording", r3, "D'accord");
    has("flow1: uses first name", r3, "D'accord Ahmed");
    const b = await stubDb.getLatestBooking(p);
    ok("flow1: pending in db", b && b.status === "pending" && b.slot === "ghodwa 23 septembre, 17:00", JSON.stringify(b));
    ok("flow1: name on booking", b && b.patient_name === "ahmed ben salah", JSON.stringify(b));
    const saved = await stubDb.getPatientName(p);
    ok("flow1: name remembered", saved === "ahmed ben salah", saved);
    // double "ey" must NOT create a duplicate
    const r4 = await bot.processPatientText(p, "ey");
    has("flow1: no duplicate on 2nd ey", r4, "deja pending");
    const n = (await stubDb.getPendingBookings()).filter((x) => x.phone === p).length;
    ok("flow1: exactly 1 pending", n === 1, `n=${n}`);
  }

  // Flow 2 — ambiguous hour (bare 7), clarify with an evening word, then accept
  {
    const p = "21600000002";
    const r1 = await bot.processPatientText(p, "jem3a 7");
    has("flow2: asks sbe7 walla 3chiya", r1, "el 7 hethi mta3 sbe7 walla mta3 l3chiya");
    const r2 = await bot.processPatientText(p, "l3chiya");
    has("flow2: merged to 19:00", r2, "jem3a 25 septembre, 19:00"); // 7 + l3chiya = 19:00
    await stubDb.savePatientName(p, "Test Testi"); // known name -> no name question
    const r3 = await bot.processPatientText(p, "ey");
    has("flow2: booked", r3, "n2akkedlek");
    const b = await stubDb.getLatestBooking(p);
    ok("flow2: slot in db", b && b.slot === "jem3a 25 septembre, 19:00", JSON.stringify(b));
  }

  // Flow 3 — number word + morning
  {
    const p = "21600000003";
    const r1 = await bot.processPatientText(p, "ghodwa m3a 10 mta3 sbe7");
    has("flow3: 10:00", r1, "ghodwa 23 septembre, 10:00");
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
    has("flow4: fresh request works", r3, "jem3a 25 septembre, 09:00");
  }

  // Flow 5 — hour-only follow-up keeps the proposed date
  {
    const p = "21600000005";
    const r1 = await bot.processPatientText(p, "jem3a");
    has("flow5: date kept, asks time", r1, "jem3a 25 septembre");
    const r2 = await bot.processPatientText(p, "7");
    has("flow5: hour merged, asks period", r2, "el 7 hethi mta3 sbe7 walla mta3 l3chiya");
    ok("flow5: date not lost", r2.includes("jem3a 25 septembre"), `reply was: ${JSON.stringify(r2)}`);
    const r3 = await bot.processPatientText(p, "sbe7");
    has("flow5: concrete 07:00", r3, "jem3a 25 septembre, 07:00");
    await stubDb.savePatientName(p, "Test Testi"); // known name -> no name question
    const r4 = await bot.processPatientText(p, "ey");
    has("flow5: booked", r4, "n2akkedlek");
  }

  // Flow 5b — word-hour "larb3a" + "la3vhiya": auto 16:00, no sbe7/l3chiya question
  {
    const p = "21600000006";
    const r1 = await bot.processPatientText(p, "jem3a larb3a mte3 la3vhiya");
    has("flow5b: proposes 16:00 directly", r1, "jem3a 25 septembre, 16:00");
    ok("flow5b: no sbe7/l3chiya question", !r1.includes("sbe7 walla"), `reply was: ${JSON.stringify(r1)}`);
    await stubDb.savePatientName(p, "Test Testi"); // known name -> no name question
    const r2 = await bot.processPatientText(p, "ey");
    has("flow5b: booked", r2, "n2akkedlek");
    const b = await stubDb.getLatestBooking(p);
    ok("flow5b: slot in db", b && b.slot === "jem3a 25 septembre, 16:00", JSON.stringify(b));
  }

  // Flow 6 — status question reads the REAL db status + secretary validates
  {
    const p = "21600000002"; // has a pending jem3a booking from flow 2
    const r1 = await bot.processPatientText(p, "ca y est?");
    has("flow6: pending status", r1, "mazel pending");
    const b = await stubDb.getLatestBooking(p);
    const sec = await bot.processSecretaryText(`ok ${b.id}`);
    has("flow6: secretary ok", sec, "T2akked");
    const r2 = await bot.processPatientText(p, "ca y est?");
    has("flow6: confirmed status", r2, "t2akked");
    // a NEW booking request that starts with "t2akkedli" is not a status question
    const r3 = await bot.processPatientText(p, "t2akkedli ghodwa 10 mta3 sbe7");
    has("flow6: t2akkedli+slot = booking flow", r3, "ghodwa 23 septembre, 10:00");
  }

  // Flow 7 — greeting + medical redirect + booking prompt (fallback mode)
  {
    const p = "21600000007";
    const r1 = await bot.processPatientText(p, "salem");
    has("flow7: neutral greeting", r1, "Kifech n3awnek");
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
    has("flow8: patient A keeps ghodwa", ra, "ghodwa 23 septembre, 07:00");
    const rb = await bot.processPatientText(b2, "l3chiya");
    has("flow8: patient B keeps jem3a", rb, "jem3a 25 septembre, 19:00");
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
    has("flow9b: fresh start after delete", r, "Kifech n3awnek");
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
    has("flow11: ar proposal", r2, "داكور — غدوة 23 سبتمبر، 17:00");
    has("flow11: ar proposal says ey", r2, "اي");
    const r3 = await bot.processPatientText(p, "اي");
    has("flow11: ar asks name", r3, "الاسم واللقب");
    const r3b = await bot.processPatientText(p, "أحمد بن صالح");
    has("flow11: ar booked", r3b, "نأكدلك رونديفو (غدوة 23 سبتمبر، 17:00)");
    has("flow11: ar d'accord wording", r3b, "داكور");
    has("flow11: ar merhba bik", r3b, "مرحبا بيك");
    const b = await stubDb.getLatestBooking(p);
    ok("flow11: ar slot in db", b && b.slot === "غدوة 23 سبتمبر، 17:00", JSON.stringify(b));
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
    has("flow12: ar proposal 07:00", r3, "غدوة 23 سبتمبر، 07:00");
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
    has("flow17: bare 10 = morning", r4, "jem3a 25 septembre, 10:00");
    const r5 = await bot.processPatientText("21600000024", "jem3a 3");
    has("flow17: bare 3 = afternoon", r5, "jem3a 25 septembre, 15:00");
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
    has("flow18: proposal", r1, "ghodwa 23 septembre, 10:00");
    const r2 = await bot.processPatientText(p, "ey");
    has("flow18: asks name", r2, "esm wel la9ab");
    has("flow18: name question keeps slot", r2, "ghodwa 23 septembre, 10:00");
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
    has("flow20: ar proposal", a1, "غدوة");
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
    has("flow22: proposal", r1, "jem3a 25 septembre, 10:00");
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
    has("flow24: proposal again", r1, "ghodwa 23 septembre, 10:00");
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
    has("signup: /formulaire has submit button", html, "جرّب — ابعث");
    has("signup: /formulaire mentions price", html, "2 دينار");

    const valid = { name: "Ahmed Ben Salah", phone: "21650123456", clinic_name: "3yedet Ennour", city: "Tunis" };
    const r1 = await fetch(base + "/api/signups", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(valid),
    });
    ok("signup: valid POST is 200", r1.status === 200, `status=${r1.status}`);
    const j1 = await r1.json();
    ok("signup: valid POST returns ok", j1.ok === true, JSON.stringify(j1));

    const missing = { name: "X", phone: "21650123456", clinic_name: "Y" }; // no city
    const r2 = await fetch(base + "/api/signups", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(missing),
    });
    ok("signup: missing field is 400", r2.status === 400, `status=${r2.status}`);

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
    ok("vendor: 'n7eb njareb ghodwa m3a 10' stays in booking flow", /ghodwa 23 septembre, 10:00/.test(d8), `reply was: ${JSON.stringify(d8)}`);

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
    has("vendor: 'slm' -> neutral greeting", n1, "Kifech n3awnek");
    ok("vendor: neutral greeting steers nothing", !/jareb|rendez-vous|7ajz/i.test(n1), `reply was: ${JSON.stringify(n1)}`);
    const n2 = await bot.processPatientText("neut2", "عسلامة");
    has("vendor: AR greeting -> neutral", n2, "كيفاش نجم نعاونك");

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
    ok("vendor: 'sbe7' not treated as greeting", !/Kifech n3awnek/.test(n5), `reply was: ${JSON.stringify(n5)}`);
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
    has("script: 3aslema -> fixed greeting", g, "Kifech n3awnek");
    ok("script: greeting has no arabic", !/[\u0600-\u06FF]/.test(g), `reply was: ${JSON.stringify(g)}`);
    const fixed = bot.enforceScript("3aslema! Kif nجم n3awnk elyoum?", "3aslema");
    ok("script: no arabic letters left", !/[\u0600-\u06FF]/.test(fixed), `got: ${JSON.stringify(fixed)}`);
    ok("script: stays readable", fixed.includes("njm"), `got: ${JSON.stringify(fixed)}`);
    const same = bot.enforceScript("3aslema! Kif najem n3awnek?", "3aslema");
    ok("script: clean latin untouched", same === "3aslema! Kif najem n3awnek?", `got: ${JSON.stringify(same)}`);
    const ar = bot.enforceScript("WhatsApp متاح", "اكتبلي بالعربي");
    ok("script: arabic mode untouched", ar === "WhatsApp متاح", `got: ${JSON.stringify(ar)}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
