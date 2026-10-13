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
    // Religious filler never carries scheduling info ("ghodwa inchallah ken 7ab rabbi"
    // = tomorrow). Strip it so the date survives.
    .replace(/\b(inchallah|inchaallah|inshallah|nchallah|inchala)\b/g, " ")
    .replace(/\bken 7ab (rabbi|rabi|allah)\b/g, " ")
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
  ["se3tin", 2], ["sa3tin", 2], ["sa3tine", 2], ["sa3teen", 2], // "ghodwa se3tin" = 2 (PM by clinic rule)
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
  // Arabic ordinal hour words ("elsa3a el 3achra" = 10 o'clock) — the
  // " ال" split in the time search turns these into "العاشرة" etc. (L5).
  ["عاشرة", 10], ["تاسعة", 9], ["ثامنة", 8], ["سابعة", 7], ["سادسة", 6],
  ["خامسة", 5], ["رابعة", 4], ["ثالثة", 3], ["ثانية", 2],
];

// weekday name -> JS day number (0 = Sunday)
const DAYS = [
  ["la7ad", 0], ["l7ad", 0], ["lahad", 0], ["el 7ad", 0], ["dimanche", 0],
  ["ethnin", 1], ["ethinin", 1], ["thnin", 1], ["tnin", 1], ["thenin", 1], ["lundi", 1],
  ["thletha", 2], ["thleth", 2], ["tletha", 2], ["tlata", 2], ["mardi", 2],
  ["erb3a", 3], ["larb3a", 3], ["lerb3a", 3], ["mercredi", 3],
  ["khmis", 4], ["5mis", 4], ["khemis", 4], ["khamis", 4], ["kmis", 4], ["jeudi", 4],
  ["jem3a", 5], ["jom3a", 5], ["vendredi", 5], ["venderdi", 5],
  ["sebt", 6], ["sibt", 6], ["sabt", 6], ["samedi", 6],
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

// Numeric date display everywhere: "25-09-2026" (Tunis wall time).
function fmtNum(d) {
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

function resolveSlot(rawText, preferAr) {
  const now = tunisNow();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const t = " " + norm(rawText) + " ";
  // Script: explicit caller preference (saved "aktebli bel 3arbi") wins;
  // otherwise Arabic characters in the message -> Arabic-script answer.
  const ar = !!preferAr || /[\u0600-\u06FF]/.test(t); // patient wrote in Arabic script -> answer in Arabic script

  let dateUTC = null;
  let dateDisplay = null;
  let explicitPast = false; // an explicit date (10 septembre, 21/09...) that already
  // passed: report it as PAST so the bot asks for a future date — never roll it
  // silently into next year.

  // ---- 1) explicit date: "21 septembre" or "25/09" or "21 سبتمبر" ----
  const dm = t.match(/(\d{1,2})\s+(janvier|janfi|fevrier|fev|mars|avril|mai|juin|juillet|juil|aout|septembre|sept|octobre|oct|novembre|nov|decembre|dec)\b/);
  const dsl = !dm && t.match(/\b(\d{1,2})[\/-](\d{1,2})\b/); // DD/MM or DD-MM
  const dma = !dm && !dsl && t.match(/(\d{1,2})\s+(جانفي|فيفري|مارس|أفريل|افريل|ماي|جوان|جويلية|أوت|اوت|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)(?=\s)/);
  let rest = t;
  if (dm) {
    const day = parseInt(dm[1], 10);
    const mon = MONTHS[dm[2]];
    // Fix T (D26): a month NAME already past this year ("le 5 janvier"
    // said in October) means NEXT year — a named month is a plan, not a
    // typo. Only the month decides: a past DAY in the current month stays
    // past ("le 10 septembre" mid-September), and DD/MM keeps the old
    // no-roll rule below.
    const yr = mon < now.getUTCMonth() ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
    const probe = new Date(Date.UTC(yr, mon, day));
    if (probe.getUTCMonth() === mon && probe.getUTCDate() === day && day >= 1 && day <= 31) {
      const dms = Date.UTC(yr, mon, day);
      explicitPast = dms < todayStart;
      dateUTC = dms;
      dateDisplay = fmtNum(probe);
    }
    rest = t.replace(dm[0], " ");
  } else if (dma) {
    const day = parseInt(dma[1], 10);
    const mon = MONTHS_AR[dma[2]];
    const yr = mon < now.getUTCMonth() ? now.getUTCFullYear() + 1 : now.getUTCFullYear(); // D26, same rule
    const probe = new Date(Date.UTC(yr, mon, day));
    if (probe.getUTCMonth() === mon && probe.getUTCDate() === day && day >= 1 && day <= 31) {
      const dms = Date.UTC(yr, mon, day);
      explicitPast = dms < todayStart;
      dateUTC = dms;
      dateDisplay = fmtNum(probe);
    }
    rest = t.replace(dma[0], " ");
  } else if (dsl) {
    const day = parseInt(dsl[1], 10);
    const mon = parseInt(dsl[2], 10) - 1; // Tunisian order: day first
    if (mon >= 0 && mon <= 11) {
      const probe = new Date(Date.UTC(now.getUTCFullYear(), mon, day));
      if (probe.getUTCMonth() === mon && probe.getUTCDate() === day && day >= 1 && day <= 31) {
        const dms = Date.UTC(now.getUTCFullYear(), mon, day);
        explicitPast = dms < todayStart;
        dateUTC = dms;
        dateDisplay = fmtNum(probe);
      }
    }
    rest = t.replace(dsl[0], " ");
  }

  // ---- 2) weekday / relative day ----
  // The FIRST weekday word in the TEXT wins (not the first in the DAYS list):
  // in "jem3a larb3a", "jem3a" is the day and "larb3a" may be 4 o'clock.
  let dayWord = null; // matched weekday name — blanked before number-word -> digit
  // "jem3a jeya" = NEXT WEEK in Tunisian usage (not next Friday) — same for
  // "semaine/smena/simana jeya" and "osbou3 ejjey". No specific day, so the
  // bot must ask which day; never let the weekday matcher below read the
  // "jem3a" inside it as Friday.
  const nextWeek = dateUTC === null && (
    /\b(el\s+)?(jem3a(t)?|semaine|smena|simana)\s+e?jj?eya\b/.test(t) || // "jem3a jeya", "el jem3a ejjeya", "semaine jeya"
    /\b(el\s+)?(osbou3|osbo3)\s+e?jj?ey\b/.test(t));                     // "osbou3 ejjey"
  let fromWeekday = false; // the date came from a weekday word (Fix T: D5/D10)
  let dayPos = -1; // position of the weekday word in t (Fix T: D10)
  if (dateUTC === null && !nextWeek) {
    let dow = null;
    // Fix U (CHA8): weekday words BEFORE the last booking verb are filler
    // ("...el thleth ... el arba3 ... a7jezli el jom3a" = Friday). Weekday
    // words at/after the verb keep the first-wins rule (round 1: "jem3a
    // larb3a" = Friday, larb3a = 4 o'clock). No verb -> unchanged.
    let verbPos = -1;
    for (const v of ["a7jez", "e7jez", "na7jez", "ne7jez", "احجز", "نحجز"]) {
      const vp = t.lastIndexOf(v);
      if (vp > verbPos) verbPos = vp;
    }
    for (const [name, d] of DAYS) {
      const p = t.indexOf(" " + name + " ", Math.max(0, verbPos));
      if (p !== -1 && (dayPos === -1 || p < dayPos)) { dow = d; dayWord = name; dayPos = p; }
    }
    if (dow !== null) {
      const diff = (dow - now.getUTCDay() + 7) % 7; // 0 = today
      dateUTC = todayStart + diff * 86400000;
      fromWeekday = true;
      // Fix T (D5): "<weekday> el jay" when today IS that weekday means
      // NEXT week — "el thleth el jay" on a Tuesday is never today (the
      // patient means the coming one; today's slots are already gone).
      const afterDay = t.slice(dayPos + dayWord.length + 2);
      if (diff === 0 && /^\s*(el\s+)?(jay|jey|jeya|ejjey|ejjeya)\b/.test(afterDay)) {
        dateUTC += 7 * 86400000;
      }
      const dd = new Date(dateUTC);
      const dname = ar ? AR_DAY[dow] : DERJA_DAY[dow];
      dateDisplay = fmtNum(dd);
    } else if (t.includes(" ba3d ghodwa ") || t.includes(" ba3d ghadwa ") || t.includes(" apres ghodwa ") || t.includes(" بعد غدوة ")) {
      dateUTC = todayStart + 2 * 86400000;
      // Fix U (DAT4): "ba3d ghodwa b nhar" = day after tomorrow PLUS one day.
      if (/\bb\s+nhar\b/.test(t)) dateUTC += 86400000;
      const dd = new Date(dateUTC);
      const mname = ar ? AR_MONTH[dd.getUTCMonth()] : FR_MONTH[dd.getUTCMonth()];
      dateDisplay = fmtNum(dd);
    } else if (/\bbera7\b/.test(t) || t.includes(" البارح ") || t.includes(" البارحة ")) {
      // Yesterday — always PAST: the bot must ask for a future date instead of
      // booking something already gone.
      dateUTC = todayStart - 86400000;
      explicitPast = true;
      const dd = new Date(dateUTC);
      const mname = ar ? AR_MONTH[dd.getUTCMonth()] : FR_MONTH[dd.getUTCMonth()];
      dateDisplay = fmtNum(dd);
    } else if (t.includes(" apres demain ") || t.includes(" apres-demain ")) {
      // French "après-demain" (norm() already folded è -> e; the hyphenated
      // spelling is the correct French one) = day after tomorrow.
      dateUTC = todayStart + 2 * 86400000;
      if (/\bb\s+nhar\b/.test(t)) dateUTC += 86400000; // Fix U (DAT4), same rule
      const dd = new Date(dateUTC);
      const mname = ar ? AR_MONTH[dd.getUTCMonth()] : FR_MONTH[dd.getUTCMonth()];
      dateDisplay = fmtNum(dd);
    } else if (t.includes(" demain ") || t.includes(" demin ") || t.includes(" demen ") || t.includes(" tomorrow ")) {
      // French "demain" / English "tomorrow" = tomorrow.
      dateUTC = todayStart + 86400000;
      const dd = new Date(dateUTC);
      const mname = ar ? AR_MONTH[dd.getUTCMonth()] : FR_MONTH[dd.getUTCMonth()];
      dateDisplay = fmtNum(dd);
    } else if (t.includes(" ghodwa ") || t.includes(" ghadwa ") || t.includes(" ghdwa ") || t.includes(" غدوة ") || t.includes(" غدوا ") || t.includes(" غدا ") || t.includes(" غداً ")) {
      dateUTC = todayStart + 86400000;
      const dd = new Date(dateUTC);
      const mname = ar ? AR_MONTH[dd.getUTCMonth()] : FR_MONTH[dd.getUTCMonth()];
      dateDisplay = fmtNum(dd);
    } else if (/(a5er|a5ir|akhir)\s+(el\s+)?(chhar|chaher)/.test(t) || t.includes(" آخر الشهر ")) {
      // Fix U (DAT10): "a5er el chhar" = last day of the current month.
      dateUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0);
      const dd = new Date(dateUTC);
      const mname = ar ? AR_MONTH[dd.getUTCMonth()] : FR_MONTH[dd.getUTCMonth()];
      dateDisplay = fmtNum(dd);
    } else if (t.includes(" lyoum ") || t.includes(" elyoum ") || t.includes(" اليوم ") || t.includes(" today ") || /\baujourd['’]?hui\b/.test(t) || t.includes(" aujourdhui ")) {
      // Fix U (DAT19): French "aujourd'hui" / English "today" = today.
      dateUTC = todayStart;
      const dd = new Date(dateUTC);
      const mname = ar ? AR_MONTH[dd.getUTCMonth()] : FR_MONTH[dd.getUTCMonth()];
      dateDisplay = fmtNum(dd);
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
  // Fix T (D10): "<weekday> 23 <time>" — a 13-31 number directly after the
  // weekday is the DAY OF THE MONTH, not an hour: "el jom3a 23 el 10 mta3
  // el sbe7" = Friday the 23rd at 10:00. Fires only when another time
  // signal follows; a lone "jem3a 21" keeps the old 21:00 reading (G1).
  if (fromWeekday && dayPos >= 0) {
    const afterDay = rest.slice(dayPos + dayWord.length + 2); // rest === t on this path
    const dmNum = afterDay.match(/^\s*(?:el\s+)?(\d{1,2})(?=\s)/);
    if (dmNum) {
      const dom = parseInt(dmNum[1], 10);
      if (dom >= 13 && dom <= 31) {
        const cand = restTime.replace(" " + dom + " ", " ");
        if (cand !== restTime && (/\d/.test(cand) || /heure/.test(cand) || /\bnos\b/.test(cand))) {
          let probe = dateUTC;
          for (let i = 0; i < 6; i++) {
            probe += 7 * 86400000; // same weekday, one week later
            if (new Date(probe).getUTCDate() === dom) {
              dateUTC = probe;
              dateDisplay = fmtNum(new Date(probe));
              restTime = cand;
              break;
            }
          }
        }
      }
    }
  }
  let hour = null;
  let minute = 0;
  let badHour = null; // an explicit invalid time ("ghodwa 25", "10:99") — never silently clarified
  if (/\bnos\s+(el\s+)?nhar\b/.test(t) || t.includes(" نص النهار ")) { hour = 12; minute = 0; }
  else if (/\bnos\s+(el\s+)?lil\b/.test(t) || t.includes(" نص الليل ")) { hour = 0; minute = 0; }
  else {
    // French spelled-out hours ("dix heures", "quinze heures trente",
    // "dix heures et demie", "trois heures moins le quart") — anchored on
    // the word "heure(s)", which never appears in Derja/Arabic, so this can
    // never steal a Derja time. French "midi" = 12:00 (but NOT inside
    // "après-midi") and "minuit" = 0:00.
    const FR_HOUR_WORDS = { une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16, "dix sept": 17, "dix huit": 18, "dix neuf": 19, vingt: 20, "vingt et une": 21, "vingt deux": 22, "vingt trois": 23 };
    const frm = restTime.match(/\b(dix[- ]sept|dix[- ]huit|dix[- ]neuf|vingt et une|vingt[- ]deux|vingt[- ]trois|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt)\s+heures?\b\s*(et\s+demie|et\s+quart|moins\s+le\s+quart|trente|quinze|\d{1,2})?/);
    if (frm) {
      hour = FR_HOUR_WORDS[frm[1].replace(/-/g, " ")];
      const mins = (frm[2] || "").replace(/\s+/g, " ").trim();
      if (mins === "et demie" || mins === "trente") minute = 30;
      else if (mins === "et quart" || mins === "quinze") minute = 15;
      else if (mins === "moins le quart") { hour -= 1; minute = 45; }
      else if (/^\d{1,2}$/.test(mins)) minute = parseInt(mins, 10);
      if (minute > 59) { badHour = frm[0]; hour = null; minute = 0; }
    } else if (/\bmidi\b/.test(restTime.replace(/apres[-\s]midi/g, " "))) { hour = 12; minute = 0; }
    else if (/\bminuit\b/.test(restTime)) { hour = 0; minute = 0; }
    else {
      // "10h30" / "10:30" first, then the bare French "10h" — the hour glued
      // to its "h" has no word boundary after the digit, so the bare-number
      // fallback can't see it ("9h" looped the time question forever) — then
      // the old bare-number fallback.
      const tm = restTime.match(/(\d{1,2})\s*[:h]\s*(\d{2})/) || restTime.match(/\b(\d{1,2})\s*h(?![0-9])/) || restTime.match(/\b(\d{1,2})\b/);
      if (tm) {
        hour = parseInt(tm[1], 10);
        minute = tm[2] ? parseInt(tm[2], 10) : 0;
        if (minute > 59) { badHour = tm[1] + ":" + tm[2]; hour = null; minute = 0; }
        // ">23" can only be an hour when a date is already fixed ("ghodwa 25");
        // a bare number with no date ("25") keeps the old not-found behavior.
        else if (hour > 23 && dateUTC !== null) { badHour = String(tm[1]); hour = null; }
      }
    }
  }

  // Fix U (DAT13/DAT14): half-hours trailing an hour — "el wa7da w nos"
  // (13:30), "midi et demi" (12:30), "العشرة ونص". Only when no minutes
  // were parsed yet (French "dix heures et demie" already set 30 above).
  // "nos el nhar" (noon) can't match: the pattern needs w/et BEFORE nos.
  if (hour !== null && minute === 0 && badHour === null &&
      (/\b(w|et)\s+(nos{1,2}|noss|demi|demie)\b/.test(restTime) || restTime.includes(" ونص"))) {
    minute = 30;
  }

  // \b doesn't work on Arabic letters (non-\w), so Arabic period words use includes().
  // French period words included (2026-10-13): a French patient answers the
  // time question with "le matin" / "l'après-midi" / "le soir" — norm() has
  // already folded "après" -> "apres". None of these words exist in Derja.
  const morning = /\bsbe7\b|\bsbah\b|\bmatin\b/.test(t) || t.includes(" صباح ") || t.includes(" الصباح ") || t.includes(" صباحا ") || t.includes(" صباحاً ");
  const afternoon = /\b3chiya\b|\bl3chiya\b|\bla3chiya\b|\b3chya\b|\bl3chya\b|\bla3chya\b|\b3achiya\b|\b3vhiya\b|\bl3vhiya\b|\bla3vhiya\b|\b3chwa\b|\bl3chwa\b|\bla3chwa\b|\bapres[-\s]midi\b/.test(t) || t.includes(" عشية ") || t.includes(" العشية ");
  const night = /\blil\b|\bsoir\b/.test(t) || t.includes(" ليل ") || t.includes(" الليل ");

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

  const found = dateUTC !== null || hour !== null || nextWeek;
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
  // An explicit date that already passed this year ("10 septembre", "el bera7"):
  // report it as PAST even without a time, so the bot asks for a future date
  // instead of silently rolling it into next year or inventing a time.
  if (explicitPast) past = true;

  return { found: true, date: dateUTC !== null, needs, past, dateDisplay, display, iso,
    morning, afternoon, night, ar, nextWeek, // nextWeek: "jem3a jeya" = next week (Tunisian), no specific day
    hour: finalHour, minute, // 24h hour (null when no time parsed) — for the no-date out-of-hours reject
    badHour, // explicit invalid time ("25", "10:99") — the bot must flag it, never clarify around it
    dateUTC, // Tunis-midnight ms (null when no date) — for weekday/hours checks
    dow: dateUTC !== null ? new Date(dateUTC).getUTCDay() : null }; // 0 = Sunday
}

// ---------- Formatting helpers for bot-suggested open slots ----------

function fmtDate(dateUTC, ar) {
  return fmtNum(new Date(dateUTC)); // "25-09-2026" in both scripts
}

function dayName(dow, ar) {
  return ar ? AR_DAY[dow] : DERJA_DAY[dow];
}

// Build display + ISO for a concrete slot the bot suggests (e.g. after a
// closed-day / outside-hours rejection): "28-09-2026, 09:00".
function slotDisplay(dateUTC, hour, minute, ar) {
  const dow = new Date(dateUTC).getUTCDay();
  const datePart = fmtNum(new Date(dateUTC));
  const hm = `${pad(hour)}:${pad(minute)}`;
  const display = ar ? `${datePart}، ${hm}` : `${datePart}, ${hm}`;
  const iso = new Date(dateUTC + hour * 3600000 + minute * 60000 - 3600000).toISOString();
  return { display, iso, dateUTC, dow };
}

module.exports = { resolveSlot, tunisNow, setNow, fmtDate, dayName, slotDisplay };
