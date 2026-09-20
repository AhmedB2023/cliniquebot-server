// db.js — Postgres persistence for clinic-bot (memory stage 1)
// Stores every patient message + bot reply, per phone number.
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

module.exports = { initDb, saveMessage, getHistory, hasDb: () => !!DATABASE_URL };
