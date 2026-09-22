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

// ---------- Bookings (stage 2) ----------

async function saveBooking(phone, slot, slot_at = null) {
  const p = getPool();
  if (!p) return null;
  const r = await p.query(
    "INSERT INTO bookings(phone, slot, slot_at) VALUES($1,$2,$3) RETURNING id",
    [phone, slot, slot_at]
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

// ---------- Proposals: the concrete slot the bot offered, awaiting "ey" ----------
async function saveProposal(phone, slot_text, slot_at, display) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO proposals(phone, slot_text, slot_at, display, updated_at)
       VALUES($1,$2,$3,$4,NOW())
       ON CONFLICT (phone) DO UPDATE
       SET slot_text=$2, slot_at=$3, display=$4, updated_at=NOW()`,
      [phone, slot_text, slot_at, display]
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
      "SELECT slot_text, slot_at, display FROM proposals WHERE phone=$1 AND updated_at > NOW() - INTERVAL '30 minutes'",
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

module.exports = {
  initDb,
  saveMessage,
  getHistory,
  saveBooking,
  findPendingBooking,
  getBooking,
  getLatestBooking,
  getPendingBookings,
  setBookingStatus,
  saveProposal,
  getProposal,
  clearProposal,
  hasDb: () => !!DATABASE_URL,
};
