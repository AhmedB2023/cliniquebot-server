// db.js — Postgres persistence for clinic-bot
// Stage 1: messages table (conversation memory per patient)
// Stage 2: bookings table (pending/confirmed/cancelled rendez-vous)
// If DATABASE_URL is not set, everything becomes a safe no-op and the bot
// keeps working exactly like before (stateless).

const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || "";
let pool = null;

function getPool() {
  if (!DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Render Postgres requires SSL
    });
    pool.on("error", (e) => console.error("[db:ERROR]", e.message));
  }
  return pool;
}

async function initDb() {
  const p = getPool();
  if (!p) {
    console.log("[db] no DATABASE_URL — running WITHOUT memory (stateless)");
    return false;
  }
  await p.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      role TEXT NOT NULL,              -- 'user' | 'assistant'
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone, id);
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,             -- patient phone (or 'webtest')
      slot TEXT NOT NULL,              -- e.g. 'ba3d ghodwa 10'
      status TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | cancelled
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status, id);
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS slot_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS proposals (
      phone TEXT PRIMARY KEY,
      slot_text TEXT NOT NULL,
      slot_at TIMESTAMPTZ,
      display TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Patient identity: nom + prenom, remembered per phone number.
    CREATE TABLE IF NOT EXISTS patients (
      phone TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS patient_name TEXT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS number_id TEXT;
    ALTER TABLE proposals ADD COLUMN IF NOT EXISTS awaiting_name BOOLEAN DEFAULT FALSE;
    ALTER TABLE proposals ADD COLUMN IF NOT EXISTS partial_name TEXT;
    -- Signup form: doctors who fill the /formulaire page.
    CREATE TABLE IF NOT EXISTS signups (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      clinic_name TEXT NOT NULL,
      city TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_signups_created ON signups(created_at DESC);
    -- Vendor (sales) leads: dentists who wrote "جرّب" — staged pitch flow per phone.
    CREATE TABLE IF NOT EXISTS vendor_leads (
      phone TEXT PRIMARY KEY,
      stage TEXT NOT NULL,              -- asked_clinic | asked_call | done
      clinic_name TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Per-number clinic configuration: every bot number (phone_number_id) carries
    -- its own identity — clinic name, address, greeting, hours, secretary number.
    CREATE TABLE IF NOT EXISTS clinic_configs (
      phone_number_id TEXT PRIMARY KEY,
      clinic_name TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      greeting TEXT NOT NULL DEFAULT '',
      hours TEXT NOT NULL DEFAULT '',
      secretary_number TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Explicit script preference per patient ("aktebli bel 3arbi"): 'ar' | 'latin'.
    CREATE TABLE IF NOT EXISTS script_prefs (
      phone TEXT PRIMARY KEY,
      script TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("[db] Postgres ready — memory ON");
  return true;
}

async function saveMessage(phone, role, text) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query("INSERT INTO messages(phone, role, text) VALUES($1,$2,$3)", [
      phone,
      role,
      text,
    ]);
  } catch (e) {
    console.error("[db:ERROR] save:", e.message);
  }
}

// Last N messages for one patient, oldest-first (ready for the AI call).
async function getHistory(phone, limit = 15) {
  const p = getPool();
  if (!p) return [];
  try {
    const r = await p.query(
      "SELECT role, text FROM messages WHERE phone = $1 ORDER BY id DESC LIMIT $2",
      [phone, limit]
    );
    return r.rows.reverse();
  } catch (e) {
    console.error("[db:ERROR] history:", e.message);
    return [];
  }
}

// All conversations: phone + message count + last message time, most recent first.
async function getConversations() {
  const p = getPool();
  if (!p) return [];
  try {
    const r = await p.query(
      `SELECT phone, COUNT(*) AS count, MAX(created_at) AS last_at
       FROM messages GROUP BY phone ORDER BY last_at DESC`
    );
    return r.rows;
  } catch (e) {
    console.error("[db:ERROR] conversations:", e.message);
    return [];
  }
}

// Full conversation for one phone, oldest first (for the dashboard).
async function getFullHistory(phone) {
  return getHistory(phone, 500);
}

// Forget everything about one phone: messages + pending slot proposal + remembered name.
// After this the bot has no memory of that conversation.
async function deleteConversation(phone) {
  const p = getPool();
  if (!p) return 0;
  try {
    const r = await p.query("DELETE FROM messages WHERE phone=$1", [phone]);
    await p.query("DELETE FROM proposals WHERE phone=$1", [phone]);
    await p.query("DELETE FROM patients WHERE phone=$1", [phone]);
    await p.query("DELETE FROM vendor_leads WHERE phone=$1", [phone]);
    await p.query("DELETE FROM script_prefs WHERE phone=$1", [phone]);
    return r.rowCount;
  } catch (e) {
    console.error("[db:ERROR] delete:", e.message);
    return 0;
  }
}

// ---------- Per-number clinic configuration ----------

async function getClinicConfig(numberId) {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query(
      "SELECT phone_number_id, clinic_name, address, greeting, hours, secretary_number FROM clinic_configs WHERE phone_number_id=$1",
      [numberId]
    );
    return r.rows[0] || null;
  } catch (e) {
    console.error("[db:ERROR] clinicConfig:", e.message);
    return null;
  }
}

async function saveClinicConfig(numberId, cfg) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO clinic_configs(phone_number_id, clinic_name, address, greeting, hours, secretary_number, updated_at)
       VALUES($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (phone_number_id) DO UPDATE
       SET clinic_name=$2, address=$3, greeting=$4, hours=$5, secretary_number=$6, updated_at=NOW()`,
      [numberId, cfg.clinic_name || "", cfg.address || "", cfg.greeting || "", cfg.hours || "", cfg.secretary_number || ""]
    );
  } catch (e) {
    console.error("[db:ERROR] clinicConfig:", e.message);
  }
}

async function listClinicConfigs() {
  const p = getPool();
  if (!p) return [];
  try {
    const r = await p.query("SELECT phone_number_id, clinic_name, address, greeting, hours, secretary_number FROM clinic_configs ORDER BY updated_at DESC");
    return r.rows;
  } catch (e) {
    console.error("[db:ERROR] clinicConfigs:", e.message);
    return [];
  }
}

// ---------- Explicit script preference ("aktebli bel 3arbi") ----------

async function getScriptPref(phone) {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query("SELECT script FROM script_prefs WHERE phone=$1", [phone]);
    return (r.rows[0] && r.rows[0].script) || null;
  } catch (e) {
    console.error("[db:ERROR] scriptPref:", e.message);
    return null;
  }
}

async function saveScriptPref(phone, script) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO script_prefs(phone, script, updated_at) VALUES($1,$2,NOW())
       ON CONFLICT (phone) DO UPDATE SET script=$2, updated_at=NOW()`,
      [phone, script]
    );
  } catch (e) {
    console.error("[db:ERROR] scriptPref:", e.message);
  }
}

// ---------- Bookings (stage 2) ----------

async function saveBooking(phone, slot, slot_at = null, patient_name = null, number_id = null) {
  const p = getPool();
  if (!p) return null;
  const r = await p.query(
    "INSERT INTO bookings(phone, slot, slot_at, patient_name, number_id) VALUES($1,$2,$3,$4,$5) RETURNING id",
    [phone, slot, slot_at, patient_name, number_id]
  );
  return r.rows[0].id;
}

// Same patient + same instant + still pending = duplicate.
// Compares slot_at (the instant), NOT the display text — "ghodwa 23 septembre, 17:00"
// and "23 septembre, 17:00" are the same slot and must not double-book.
async function findPendingBooking(phone, slot_at) {
  const p = getPool();
  if (!p) return null;
  const r = await p.query(
    "SELECT id FROM bookings WHERE phone=$1 AND slot_at=$2 AND status='pending' LIMIT 1",
    [phone, slot_at]
  );
  return r.rows[0] || null;
}

async function getBooking(id) {
  const p = getPool();
  if (!p) return null;
  const r = await p.query("SELECT * FROM bookings WHERE id=$1", [id]);
  return r.rows[0] || null;
}

async function getLatestBooking(phone) {
  const p = getPool();
  if (!p) return null;
  const r = await p.query(
    "SELECT * FROM bookings WHERE phone=$1 ORDER BY created_at DESC LIMIT 1",
    [phone]
  );
  return r.rows[0] || null;
}

async function getPendingBookings() {
  const p = getPool();
  if (!p) return [];
  const r = await p.query(
    "SELECT * FROM bookings WHERE status='pending' ORDER BY created_at DESC"
  );
  return r.rows;
}

async function setBookingStatus(id, status) {
  const p = getPool();
  if (!p) return;
  await p.query("UPDATE bookings SET status=$1 WHERE id=$2", [status, id]);
}

// Rescheduling moves an EXISTING booking to a new slot (no duplicate row).
async function updateBookingSlot(id, slot, slot_at) {
  const p = getPool();
  if (!p) return;
  await p.query("UPDATE bookings SET slot=$1, slot_at=$2 WHERE id=$3", [slot, slot_at, id]);
}

// ---------- Proposals: the concrete slot the bot offered, awaiting "ey" ----------
async function saveProposal(phone, slot_text, slot_at, display, awaiting_name = false, partial_name = null) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO proposals(phone, slot_text, slot_at, display, awaiting_name, partial_name, updated_at)
       VALUES($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (phone) DO UPDATE
       SET slot_text=$2, slot_at=$3, display=$4, awaiting_name=$5, partial_name=$6, updated_at=NOW()`,
      [phone, slot_text, slot_at, display, awaiting_name, partial_name]
    );
  } catch (e) {
    console.error("[db:ERROR] proposal:", e.message);
  }
}

// A proposal older than 30 minutes is forgotten (stale context).
async function getProposal(phone) {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query(
      "SELECT slot_text, slot_at, display, awaiting_name, partial_name FROM proposals WHERE phone=$1 AND updated_at > NOW() - INTERVAL '30 minutes'",
      [phone]
    );
    return r.rows[0] || null;
  } catch (e) {
    console.error("[db:ERROR] proposal:", e.message);
    return null;
  }
}

async function clearProposal(phone) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query("DELETE FROM proposals WHERE phone=$1", [phone]);
  } catch (e) {
    console.error("[db:ERROR] proposal:", e.message);
  }
}

// ---------- Patient identity: nom + prenom, remembered per phone ----------

async function getPatientName(phone) {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query("SELECT name FROM patients WHERE phone=$1", [phone]);
    return (r.rows[0] && r.rows[0].name) || null;
  } catch (e) {
    console.error("[db:ERROR] getPatientName:", e.message);
    return null;
  }
}

async function savePatientName(phone, name) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO patients(phone, name, updated_at) VALUES($1,$2,NOW())
       ON CONFLICT (phone) DO UPDATE SET name=$2, updated_at=NOW()`,
      [phone, name]
    );
  } catch (e) {
    console.error("[db:ERROR] savePatientName:", e.message);
  }
}

// ---------- Signup form: doctors who filled the /formulaire page ----------
async function saveSignup(name, phone, clinic_name, city) {
  const p = getPool();
  if (!p) return null;
  const r = await p.query(
    "INSERT INTO signups(name, phone, clinic_name, city) VALUES($1,$2,$3,$4) RETURNING id",
    [name, phone, clinic_name, city]
  );
  return r.rows[0].id;
}

// Newest first.
async function getSignups() {
  const p = getPool();
  if (!p) return [];
  try {
    const r = await p.query("SELECT * FROM signups ORDER BY created_at DESC");
    return r.rows;
  } catch (e) {
    console.error("[db:ERROR] signups:", e.message);
    return [];
  }
}

async function deleteSignup(id) {
  const p = getPool();
  if (!p) return 0;
  try {
    const r = await p.query("DELETE FROM signups WHERE id=$1", [id]);
    return r.rowCount;
  } catch (e) {
    console.error("[db:ERROR] deleteSignup:", e.message);
    return 0;
  }
}

// ---------- Vendor (sales) leads: dentists who wrote "جرّب" ----------

async function getVendorLead(phone) {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query("SELECT phone, stage, clinic_name FROM vendor_leads WHERE phone=$1", [phone]);
    return r.rows[0] || null;
  } catch (e) {
    console.error("[db:ERROR] getVendorLead:", e.message);
    return null;
  }
}

async function saveVendorLead(phone, stage, clinic_name = null) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO vendor_leads(phone, stage, clinic_name, updated_at) VALUES($1,$2,$3,NOW())
       ON CONFLICT (phone) DO UPDATE SET stage=$2, clinic_name=$3, updated_at=NOW()`,
      [phone, stage, clinic_name]
    );
  } catch (e) {
    console.error("[db:ERROR] saveVendorLead:", e.message);
  }
}

async function clearVendorLead(phone) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query("DELETE FROM vendor_leads WHERE phone=$1", [phone]);
  } catch (e) {
    console.error("[db:ERROR] clearVendorLead:", e.message);
  }
}

module.exports = {
  initDb,
  saveMessage,
  getHistory,
  getConversations,
  getFullHistory,
  deleteConversation,
  saveBooking,
  findPendingBooking,
  getBooking,
  getLatestBooking,
  getPendingBookings,
  setBookingStatus,
  updateBookingSlot,
  saveProposal,
  getProposal,
  clearProposal,
  getPatientName,
  savePatientName,
  saveSignup,
  getSignups,
  deleteSignup,
  getVendorLead,
  saveVendorLead,
  clearVendorLead,
  getClinicConfig,
  saveClinicConfig,
  listClinicConfigs,
  getScriptPref,
  saveScriptPref,
  hasDb: () => !!DATABASE_URL,
};
