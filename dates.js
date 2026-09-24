// dates.js — deterministic Derja date/time resolver (no AI, pure rules).
// Tunisia wall time (UTC+1 all year, no DST).
//
// resolveSlot("jem3a 10")           -> date found, hour ambiguous only for bare 7 -> asks "sbe7 walla 3chiya?"
// resolveSlot("jem3a 10 mta3 sbe7") -> { display: "jem3a 25 septembre, 10:00", iso }
// resolveSlot("21 septembre 15:30") -> { display: "21 septembre, 15:30", iso }
// resolveSlot("sbe7")               -> { found: false }

function tunisNow() {
  // Shift so that getUTC*() reads Tunisia wall time.
  return new Date(nowMs() + 3600000);
}

// Overridable clock for the local regression test. Production never calls it.
let nowOverride = null;
function nowMs() { return nowOverride !== null ? nowOverride : Date.now(); }
function setNow(ms) { nowOverride = ms; }

function norm(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[éèê]/g, "e")
    .replace(/[ûü]/g, "u")
    .replace(/[îï]/g, "i")
    .replace(/[ôö]/g, "o")
    .replace(/[àâ]/g, "a")
    .replace(/ç/g, "c")
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)) // Arabic-Indic digits -> 0-9
    .replace(/[.,!?;]/g, " ") // NOTE: ":" is kept — it belongs to times like 15:30
    .replace(/\s+/g, " ")
    .trim();
}

// Derja number words -> digits, so "khamsa mte3 l3chiya" reads as 5pm.
// Applied to the time search only, AFTER the weekday word is blanked,
// so "ethnin" (Tuesday) is never misread as "2 o'clock".
const NUM_WORDS = [
  ["thenach", 12], ["thnach", 12], ["tnach", 12],
  ["7dach", 11], ["7dech", 11],
  ["3achra", 10], ["3echra", 10],
  ["tes3a", 9], ["tis3a", 9],
  ["thmenya", 8], ["tmenya", 8],
  ["seb3a", 7], ["sab3a", 7],
  ["setta", 6], ["satta", 6],
  ["khamsa", 5],
  ["arb3a", 4], ["arba3a", 4], ["larb3a", 4], // "larb3a" after a day = 4 o'clock ("thleth larb3a"); the weekday word is blanked first, so bare "larb3a" still = Wednesday
  ["tletha", 3], ["tlata", 3], ["theltha", 3],
  ["zouz", 2], ["thnin", 2], ["tnin", 2], ["ethnin", 2],
  ["wa7ed", 1], ["wa7da", 1], ["wahed", 1],
  // Arabic-script number words
  ["اثناش", 12], ["أثناش", 12],
  ["احداش", 11], ["أحداش", 11],
  ["عشرة", 10],
  ["تسعة", 9],
  ["ثمانية", 8],
  ["سبعة", 7],
  ["ستة", 6],
  ["خمسة", 5],
  ["أربعة", 4], ["اربعة", 4],
  ["ثلاثة", 3],
  ["اثنين", 2], ["إثنين", 2],
  ["واحد", 1], ["واحدة", 1],
];

// weekday name -> JS day number (0 = Sunday)
const DAYS = [
  ["la7ad", 0], ["l7ad", 0], ["dimanche", 0],
  ["ethnin", 1], ["thnin", 1], ["tnin", 1], ["lundi", 1],
  ["thletha", 2], ["thleth", 2], ["tletha", 2], ["tlata", 2], ["mardi", 2],
  ["erb3a", 3], ["larb3a", 3], ["mercredi", 3],
  ["khmis", 4], ["5mis", 4], ["jeudi", 4],
  ["jem3a", 5], ["jom3a", 5], ["vendredi", 5],
  ["sebt", 6], ["sibt", 6], ["samedi", 6],
  // Arabic-script weekday names
  ["الأحد", 0], ["الاحد", 0],
  ["الاثنين", 1], ["الإثنين", 1],
  ["الثلاثاء", 2],
  ["الأربعاء", 3], ["الاربعاء", 3],
  ["الخميس", 4],
  ["الجمعة", 5],
  ["السبت", 6],
];
// NOTE: bare "a7ad" is intentionally NOT here — it also means "someone"
// ("ma fammech a7ad"). Use "la7ad"/"l7ad" for Sunday.

const DERJA_DAY = ["l7ad", "ethnin", "thletha", "erb3a", "khmis", "jem3a", "sebt"];
const AR_DAY = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const FR_MONTH = ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre"];
const AR_MONTH = ["جانفي", "فيفري", "مارس", "أفريل", "ماي", "جوان", "جويلية", "أوت", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const MONTHS = {
  janvier: 0, janfi: 0, fevrier: 1, fev: 1, mars: 2, avril: 3, mai: 4,
  juin: 5, juillet: 6, juil: 6, aout: 7, septembre: 8, sept: 8,
  octobre: 9, oct: 9, novembre: 10, nov: 10, decembre: 11, dec: 11,
};
const MONTHS_AR = {
  "جانفي": 0, "فيفري": 1, "مارس": 2, "أفريل": 3, "افريل": 3, "ماي": 4,
  "جوان": 5, "جويلية": 6, "أوت": 7, "اوت": 7, "سبتمبر": 8,
  "أكتوبر": 9, "اكتوبر": 9, "نوفمبر": 10, "ديسمبر": 11,
};

function pad(n) {
  return String(n).padStart(2, "0");
}

function resolveSlot(rawText) {
  const now = tunisNow();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const t = " " + norm(rawText) + " ";
  const ar = /[\u0600-\u06FF]/.test(t); // patient wrote in Arabic script -> answer in Arabic script

  let dateUTC = null;
  let dateDisplay = null;

  // ---- 1) explicit date: "21 septembre" or "25/09" or "21 سبتمبر" ----
  const dm = t.match(/(\d{1,2})\s+(janvier|janfi|fevrier|fev|mars|avril|mai|juin|juillet|juil|aout|septembre|sept|octobre|oct|novembre|nov|decembre|dec)\b/);
  const dsl = !dm && t.match(/\b(\d{1,2})[\/-](\d{1,2})\b/); // DD/MM or DD-MM
  const dma = !dm && !dsl && t.match(/(\d{1,2})\s+(جانفي|فيفري|مارس|أفريل|افريل|ماي|جوان|جويلية|أوت|اوت|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)(?=\s)/);
  let rest = t;
  if (dm) {
    const day = parseInt(dm[1], 10);
    const mon = MONTHS[dm[2]];
    const probe = new Date(Date.UTC(now.getUTCFullYear(), mon, day));
    if (probe.getUTCMonth() === mon && probe.getUTCDate() === day && day >= 1 && day <= 31) {
      let dms = Date.UTC(now.getUTCFullYear(), mon, day);
      if (dms < todayStart) dms = Date.UTC(now.getUTCFullYear() + 1, mon, day); // passed -> next year
      dateUTC = dms;
      dateDisplay = `${day} ${FR_MONTH[mon]}`;
    }
    rest = t.replace(dm[0], " ");
  } else if (dma) {
    const day = parseInt(dma[1], 10);
    const mon = MONTHS_AR[dma[2]];
    const probe = new Date(Date.UTC(now.getUTCFullYear(), mon, day));
    if (probe.getUTCMonth() === mon && probe.getUTCDate() === day && day >= 1 && day <= 31) {
      let dms = Date.UTC(now.getUTCFullYear(), mon, day);
      if (dms < todayStart) dms = Date.UTC(now.getUTCFullYear() + 1, mon, day);
      dateUTC = dms;
      dateDisplay = `${day} ${AR_MONTH[mon]}`;
    }
    rest = t.replace(dma[0], " ");
  } else if (dsl) {
    const day = parseInt(dsl[1], 10);
    const mon = parseInt(dsl[2], 10) - 1; // Tunisian order: day first
    if (mon >= 0 && mon <= 11) {
      const probe = new Date(Date.UTC(now.getUTCFullYear(), mon, day));
      if (probe.getUTCMonth() === mon && probe.getUTCDate() === day && day >= 1 && day <= 31) {
        let dms = Date.UTC(now.getUTCFullYear(), mon, day);
        if (dms < todayStart) dms = Date.UTC(now.getUTCFullYear() + 1, mon, day);
        dateUTC = dms;
        dateDisplay = ar ? `${day} ${AR_MONTH[mon]}` : `${day} ${FR_MONTH[mon]}`;
      }
    }
    rest = t.replace(dsl[0], " ");
  }

  // ---- 2) weekday / relative day ----
  // The FIRST weekday word in the TEXT wins (not the first in the DAYS list):
  // in "jem3a larb3a", "jem3a" is the day and "larb3a" may be 4 o'clock.
  let dayWord = null; // matched weekday name — blanked before number-word -> digit
  if (dateUTC === null) {
    let dow = null;
    let dayPos = -1;
    for (const [name, d] of DAYS) {
      const p = t.indexOf(" " + name + " ");
      if (p !== -1 && (dayPos === -1 || p < dayPos)) { dow = d; dayWord = name; dayPos = p; }
    }
    if (dow !== null) {
      const diff = (dow - now.getUTCDay() + 7) % 7; // 0 = today
      dateUTC = todayStart + diff * 86400000;
      const dd = new Date(dateUTC);
      const dname = ar ? AR_DAY[dow] : DERJA_DAY[dow];
      dateDisplay = `${dname} ${dd.getUTCDate()} ${ar ? AR_MONTH[dd.getUTCMonth()] : FR_MONTH[dd.getUTCMonth()]}`;
    } else if (t.includes(" ba3d ghodwa ") || t.includes(" ba3d ghadwa ") || t.includes(" بعد غدوة ")) {
      dateUTC = todayStart + 2 * 86400000;
      const dd = new Date(dateUTC);
      const mname = ar ? AR_MONTH[dd.getUTCMonth()] : FR_MONTH[dd.getUTCMonth()];
      dateDisplay = ar ? `بعد غدوة ${dd.getUTCDate()} ${mname}` : `ba3d ghodwa ${dd.getUTCDate()} ${mname}`;
    } else if (t.includes(" ghodwa ") || t.includes(" ghadwa ") || t.includes(" غدوة ") || t.includes(" غدوا ")) {
      dateUTC = todayStart + 86400000;
      const dd = new Date(dateUTC);
      const mname = ar ? AR_MONTH[dd.getUTCMonth()] : FR_MONTH[dd.getUTCMonth()];
      dateDisplay = ar ? `غدوة ${dd.getUTCDate()} ${mname}` : `ghodwa ${dd.getUTCDate()} ${mname}`;
    } else if (t.includes(" lyoum ") || t.includes(" elyoum ") || t.includes(" اليوم ")) {
      dateUTC = todayStart;
      const dd = new Date(dateUTC);
      const mname = ar ? AR_MONTH[dd.getUTCMonth()] : FR_MONTH[dd.getUTCMonth()];
      dateDisplay = ar ? `اليوم ${dd.getUTCDate()} ${mname}` : `lyoum ${dd.getUTCDate()} ${mname}`;
    }
  }

  // ---- 3) time ----
  // Number words -> digits for the time search ("khamsa" -> 5).
  // The weekday word is blanked first so "ethnin" (Tuesday) isn't read as 2.
  let restTime = rest;
  if (dayWord) restTime = restTime.replace(" " + dayWord + " ", " "); // first occurrence = the day
  for (const [w, d] of NUM_WORDS) {
    restTime = restTime.split(" " + w + " ").join(" " + d + " ");
    restTime = restTime.split(" ال" + w + " ").join(" " + d + " "); // "الخمسة" -> 5
  }
  let hour = null;
  let minute = 0;
  if (/\bnos\s+(el\s+)?nhar\b/.test(t) || t.includes(" نص النهار ")) { hour = 12; minute = 0; }
  else if (/\bnos\s+(el\s+)?lil\b/.test(t) || t.includes(" نص الليل ")) { hour = 0; minute = 0; }
  else {
    const tm = restTime.match(/(\d{1,2})\s*[:h]\s*(\d{2})/) || restTime.match(/\b(\d{1,2})\b/);
    if (tm) {
      hour = parseInt(tm[1], 10);
      minute = tm[2] ? parseInt(tm[2], 10) : 0;
      if (minute > 59) { hour = null; minute = 0; }
    }
  }

  // \b doesn't work on Arabic letters (non-\w), so Arabic period words use includes().
  const morning = /\bsbe7\b|\bsbah\b/.test(t) || t.includes(" صباح ") || t.includes(" الصباح ");
  const afternoon = /\b3chiya\b|\bl3chiya\b|\bla3chiya\b|\b3chya\b|\bl3chya\b|\bla3chya\b|\b3achiya\b|\b3vhiya\b|\bl3vhiya\b|\bla3vhiya\b|\b3chwa\b|\bl3chwa\b|\bla3chwa\b/.test(t) || t.includes(" عشية ") || t.includes(" العشية ");
  const night = /\blil\b/.test(t) || t.includes(" ليل ") || t.includes(" الليل ");

  let needs = null; // 'time' when the hour is ambiguous (e.g. bare "10")
  let finalHour = hour;
  if (hour === null) {
    needs = dateUTC !== null ? "time" : null;
  } else if (hour === 0 || (hour >= 13 && hour <= 23)) {
    // concrete: midnight or 24h time
  } else if (hour === 12) {
    finalHour = night ? 0 : 12; // "12 mte3 lil" = midnight, "12" alone = noon
  } else if (hour >= 1 && hour <= 11) {
    if (morning) { /* AM as-is */ }
    else if (afternoon) { finalHour = hour + 12; }
    else if (night) { finalHour = hour <= 5 ? hour : hour + 12; } // 1-5 = after midnight
    // Clinic hours: 8-12 bare = morning, 1-6 bare = afternoon. Only 7 is
    // ambiguous (7am vs 7pm), so only it asks "sbe7 walla 3chiya?".
    else if (hour === 7) { needs = "time"; }
    else if (hour >= 8) { /* 8-11: morning, AM as-is */ }
    else { finalHour = hour + 12; } // 1-6: afternoon
  } else {
    hour = null;
    needs = dateUTC !== null ? "time" : null;
  }

  const found = dateUTC !== null || hour !== null;
  if (!found) return { found: false };

  let iso = null;
  let display = null;
  let past = false;
  if (dateUTC !== null && !needs) {
    const wallMs = dateUTC + finalHour * 3600000 + minute * 60000; // Tunis wall clock
    iso = new Date(wallMs - 3600000).toISOString(); // -> real UTC instant
    display = ar ? `${dateDisplay}، ${pad(finalHour)}:${pad(minute)}` : `${dateDisplay}, ${pad(finalHour)}:${pad(minute)}`;
    past = wallMs <= nowMs() + 3600000; // mockable clock (was Date.now(): broke tests after 21:00 Tunis time)
  }

  return { found: true, date: dateUTC !== null, needs, past, dateDisplay, display, iso, morning, afternoon, night, ar };
}

module.exports = { resolveSlot, tunisNow, setNow };
