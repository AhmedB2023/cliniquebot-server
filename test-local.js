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
      return n;
    },
    saveBooking: async (phone, slot, slot_at = null) => {
      const b = { id: seq++, phone, slot, slot_at, status: "pending" };
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
    saveProposal: async (phone, slot_text, slot_at, display) => {
      proposals.set(phone, { slot_text, slot_at, display });
    },
    getProposal: async (phone) => proposals.get(phone) || null,
    clearProposal: async (phone) => { proposals.delete(phone); },
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
  // Flow 1 — the exact reported bug, then accept
  {
    const p = "21600000001";
    const r1 = await bot.processPatientText(p, "Ghodwa m3a khamsa mte3 l3chwa");
    has("flow1: direct proposal 17:00", r1, "ghodwa 23 septembre, 17:00");
    has("flow1: asks ey", r1, "ey");
    const r2 = await bot.processPatientText(p, "ey");
    has("flow1: booked", r2, "n2akkedlek");
    has("flow1: d'accord wording", r2, "D'accord");
    has("flow1: merhba bik", r2, "merhba bik");
    const b = await stubDb.getLatestBooking(p);
    ok("flow1: pending in db", b && b.status === "pending" && b.slot === "ghodwa 23 septembre, 17:00", JSON.stringify(b));
    // double "ey" must NOT create a duplicate
    const r3 = await bot.processPatientText(p, "ey");
    has("flow1: no duplicate on 2nd ey", r3, "deja pending");
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
    const r4 = await bot.processPatientText(p, "ey");
    has("flow5: booked", r4, "n2akkedlek");
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
    has("flow7: salem greeting", r1, "ahla w sahla");
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
    has("flow11: ar booked", r3, "نأكدلك رونديفو (غدوة 23 سبتمبر، 17:00)");
    has("flow11: ar d'accord wording", r3, "داكور");
    has("flow11: ar merhba bik", r3, "مرحبا بيك");
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
