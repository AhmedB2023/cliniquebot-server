// dates.js — deterministic Derja date/time resolver (no AI, pure rules).
// Tunisia wall time (UTC+1 all year, no DST).
//
// resolveSlot("jem3a 10")           -> date found, time ambiguous -> asks "sbe7 walla lil?"
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
  ["arb3a", 4], ["arba3a", 4],
  ["tletha", 3], ["tlata", 3], ["theltha", 3],
  ["zouz", 2], ["thnin", 2], ["tnin", 2], ["ethnin", 2],
  ["wa7ed", 1], ["wa7da", 1], ["wahed", 1],
];

// weekday name -> JS day number (0 = Sunday)
const DAYS = [
  ["la7ad", 0], ["l7ad", 0], ["dimanche", 0],
  ["ethnin", 1], ["thnin", 1], ["tnin", 1], ["lundi", 1],
  ["thletha", 2], ["tletha", 2], ["tlata", 2], ["mardi", 2],
  ["erb3a", 3], ["larb3a", 3], ["mercredi", 3],
  ["khmis", 4], ["5mis", 4], ["jeudi", 4],
  ["jem3a", 5], ["jom3a", 5], ["vendredi", 5],
  ["sebt", 6], ["sibt", 6], ["samedi", 6],
];
// NOTE: bare "a7ad" is intentionally NOT here — it also means "someone"
// ("ma fammech a7ad"). Use "la7ad"/"l7ad" for Sunday.

const DERJA_DAY = ["l7ad", "ethnin", "thletha", "erb3a", "khmis", "jem3a", "sebt"];
const FR_MONTH = ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre"];
const MONTHS = {
  janvier: 0, janfi: 0, fevrier: 1, fev: 1, mars: 2, avril: 3, mai: 4,
  juin: 5, juillet: 6, juil: 6, aout: 7, septembre: 8, sept: 8,
  octobre: 9, oct: 9, novembre: 10, nov: 10, decembre: 11, dec: 11,
};

function pad(n) {
  return String(n).padStart(2, "0");
}

function resolveSlot(rawText) {
  const now = tunisNow();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const t = " " + norm(rawText) + " ";

  let dateUTC = null;
  let dateDisplay = null;

  // ---- 1) explicit date: "21 septembre" or "25/09" ----
  const dm = t.match(/(\d{1,2})\s+(janvier|janfi|fevrier|fev|mars|avril|mai|juin|juillet|juil|aout|septembre|sept|octobre|oct|novembre|nov|decembre|dec)\b/);
  const dsl = !dm && t.match(/\b(\d{1,2})[\/-](\d{1,2})\b/); // DD/MM or DD-MM
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
  } else if (dsl) {
    const day = parseInt(dsl[1], 10);
    const mon = parseInt(dsl[2], 10) - 1; // Tunisian order: day first
    if (mon >= 0 && mon <= 11) {
      const probe = new Date(Date.UTC(now.getUTCFullYear(), mon, day));
      if (probe.getUTCMonth() === mon && probe.getUTCDate() === day && day >= 1 && day <= 31) {
        let dms = Date.UTC(now.getUTCFullYear(), mon, day);
        if (dms < todayStart) dms = Date.UTC(now.getUTCFullYear() + 1, mon, day);
        dateUTC = dms;
        dateDisplay = `${day} ${FR_MONTH[mon]}`;
      }
    }
    rest = t.replace(dsl[0], " ");
  }

  // ---- 2) weekday / relative day ----
  let dayWord = null; // matched weekday name — blanked before number-word -> digit
  if (dateUTC === null) {
    let dow = null;
    for (const [name, d] of DAYS) {
      if (t.includes(" " + name + " ")) { dow = d; dayWord = name; break; }
    }
    if (dow !== null) {
      const diff = (dow - now.getUTCDay() + 7) % 7; // 0 = today
      dateUTC = todayStart + diff * 86400000;
      const dd = new Date(dateUTC);
      dateDisplay = `${DERJA_DAY[dow]} ${dd.getUTCDate()} ${FR_MONTH[dd.getUTCMonth()]}`;
    } else if (t.includes(" ba3d ghodwa ") || t.includes(" ba3d ghadwa ")) {
      dateUTC = todayStart + 2 * 86400000;
      const dd = new Date(dateUTC);
      dateDisplay = `ba3d ghodwa ${dd.getUTCDate()} ${FR_MONTH[dd.getUTCMonth()]}`;
    } else if (t.includes(" ghodwa ") || t.includes(" ghadwa ")) {
      dateUTC = todayStart + 86400000;
      const dd = new Date(dateUTC);
      dateDisplay = `ghodwa ${dd.getUTCDate()} ${FR_MONTH[dd.getUTCMonth()]}`;
    } else if (t.includes(" lyoum ") || t.includes(" elyoum ")) {
      dateUTC = todayStart;
      const dd = new Date(dateUTC);
      dateDisplay = `lyoum ${dd.getUTCDate()} ${FR_MONTH[dd.getUTCMonth()]}`;
    }
  }

  // ---- 3) time ----
  // Number words -> digits for the time search ("khamsa" -> 5).
  // The weekday word is blanked first so "ethnin" (Tuesday) isn't read as 2.
  let restTime = rest;
  if (dayWord) restTime = restTime.replace(" " + dayWord + " ", " "); // first occurrence = the day
  for (const [w, d] of NUM_WORDS) {
    restTime = restTime.split(" " + w + " ").join(" " + d + " ");
  }
  let hour = null;
  let minute = 0;
  if (/\bnos\s+(el\s+)?nhar\b/.test(t)) { hour = 12; minute = 0; }
  else if (/\bnos\s+(el\s+)?lil\b/.test(t)) { hour = 0; minute = 0; }
  else {
    const tm = restTime.match(/(\d{1,2})\s*[:h]\s*(\d{2})/) || restTime.match(/\b(\d{1,2})\b/);
    if (tm) {
      hour = parseInt(tm[1], 10);
      minute = tm[2] ? parseInt(tm[2], 10) : 0;
      if (minute > 59) { hour = null; minute = 0; }
    }
  }

  const morning = /\bsbe7\b|\bsbah\b/.test(t);
  const afternoon = /\b3chiya\b|\bl3chiya\b|\b3chwa\b|\bl3chwa\b/.test(t);
  const night = /\blil\b/.test(t);

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
    else { needs = "time"; } // "10" alone — sbe7 walla lil?
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
    display = `${dateDisplay}, ${pad(finalHour)}:${pad(minute)}`;
    past = wallMs <= Date.now() + 3600000;
  }

  return { found: true, date: dateUTC !== null, needs, past, dateDisplay, display, iso, morning, afternoon, night };
}

module.exports = { resolveSlot, tunisNow, setNow };
