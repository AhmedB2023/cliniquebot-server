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

async function saveBooking(phone, slot) {
  const p = getPool();
  if (!p) return null;
  const r = await p.query(
    "INSERT INTO bookings(phone, slot) VALUES($1,$2) RETURNING id",
    [phone, slot]
  );
  return r.rows[0].id;
}

async function findPendingBooking(phone, slot) {
  const p = getPool();
  if (!p) return null;
  const r = await p.query(
    "SELECT id FROM bookings WHERE phone=$1 AND slot=$2 AND status='pending' LIMIT 1",
    [phone, slot]
  );
  return r.rows[0] || null;
}

async function getBooking(id) {
  const p = getPool();
  if (!p) return null;
  const r = await p.query("SELECT * FROM bookings WHERE id=$1", [id]);
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

module.exports = {
  initDb,
  saveMessage,
  getHistory,
  saveBooking,
  findPendingBooking,
  getBooking,
  getPendingBookings,
  setBookingStatus,
  hasDb: () => !!DATABASE_URL,
};
