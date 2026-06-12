// Murtaza Medical Complex — appointments API
// Runs as a Netlify Function (storage: Netlify Blobs).
// Falls back to file storage (.data/) when run locally via dev-server.mjs.

import crypto from "node:crypto";

// ---------------------------------------------------------------- config

const DEFAULT_PASSWORD = "mmc-admin-2026"; // override with ADMIN_PASSWORD env var!
const PASSWORD = process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD;
const SECRET =
  process.env.SESSION_SECRET ||
  crypto.createHash("sha256").update("mmc-session::" + PASSWORD).digest("hex");
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h sessions
const MAX_DAYS_AHEAD = 30;
const PK_OFFSET_MS = 5 * 60 * 60 * 1000; // clinic timezone: Pakistan, UTC+5

export const DEPARTMENTS = [
  { id: "general",    name: "General Medicine",          doctor: "Dr. Prof. G. M. Gondal",        room: "ROOM 1" },
  { id: "diabetes",   name: "Diabetes & Endocrinology",  doctor: "Dr. Prof. G. M. Gondal",        room: "ROOM 1" },
  { id: "gastro",     name: "Gastroenterology",          doctor: "Dr. Prof. G. M. Gondal",        room: "ROOM 2" },
  { id: "radiology",  name: "Radiology & Ultrasound",    doctor: "Dr. Sumera Mushtaq Ch.",        room: "IMAGING" },
  { id: "psychology", name: "Psychology & Counselling",  doctor: "Ms. A. Fatima / Ms. F. Tariq",  room: "ROOM 3" },
];

const STATUSES = ["pending", "confirmed", "completed", "cancelled"];

// ---------------------------------------------------------------- storage
// One interface, two backends: Netlify Blobs in production, JSON files locally.

async function makeStore() {
  if (process.env.NETLIFY || process.env.NETLIFY_BLOBS_CONTEXT || process.env.NETLIFY_DEV) {
    try {
      const { getStore } = await import("@netlify/blobs");
      const s = getStore("mmc-data");
      return {
        async get(key)       { return await s.get(key, { type: "json" }); },
        async set(key, val)  { await s.setJSON(key, val); },
        async del(key)       { await s.delete(key); },
        async list(prefix)   { const { blobs } = await s.list({ prefix }); return blobs.map(b => b.key); },
      };
    } catch (e) {
      console.error("Netlify Blobs unavailable, using file store:", e.message);
    }
  }
  // local file-backed store (dev only)
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const ROOT = path.resolve(".data");
  const fileFor = (key) => path.join(ROOT, encodeURIComponent(key) + ".json");
  return {
    async get(key) {
      try { return JSON.parse(await fs.readFile(fileFor(key), "utf8")); } catch { return null; }
    },
    async set(key, val) {
      await fs.mkdir(ROOT, { recursive: true });
      await fs.writeFile(fileFor(key), JSON.stringify(val));
    },
    async del(key) {
      try { await fs.unlink(fileFor(key)); } catch {}
    },
    async list(prefix) {
      try {
        const files = await fs.readdir(ROOT);
        return files
          .filter(f => f.endsWith(".json"))
          .map(f => decodeURIComponent(f.slice(0, -5)))
          .filter(k => k.startsWith(prefix));
      } catch { return []; }
    },
  };
}

// ---------------------------------------------------------------- time helpers

const pad = (n) => String(n).padStart(2, "0");
const toTime = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const parseTime = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

function nowPK() { return new Date(Date.now() + PK_OFFSET_MS); }
function todayPK() { return nowPK().toISOString().slice(0, 10); }
function minutesNowPK() { const d = nowPK(); return d.getUTCHours() * 60 + d.getUTCMinutes(); }

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Mon–Sat 09:00–21:00, Sun 10:00–16:00 (30-minute slots)
function hoursFor(dateStr) {
  const day = new Date(dateStr + "T00:00:00Z").getUTCDay();
  return day === 0 ? { start: 600, end: 960 } : { start: 540, end: 1260 };
}

function slotTimesFor(dateStr) {
  const { start, end } = hoursFor(dateStr);
  const out = [];
  for (let m = start; m < end; m += 30) out.push(toTime(m));
  return out;
}

function isPastSlot(dateStr, time) {
  const today = todayPK();
  if (dateStr < today) return true;
  if (dateStr > today) return false;
  return parseTime(time) <= minutesNowPK();
}

// ---------------------------------------------------------------- auth

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();

function checkPassword(input) {
  return crypto.timingSafeEqual(sha(input), sha(PASSWORD));
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

function requireAuth(req) {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  return verifyToken(token);
}

// ---------------------------------------------------------------- data access

const apptKey = (date, time, id) => `appt/${date}/${time}/${id}`;
const blockKey = (date, time) => `block/${date}/${time}`;

async function appointmentsForDate(store, date) {
  const keys = await store.list(`appt/${date}/`);
  const items = await Promise.all(keys.map(k => store.get(k)));
  return items.filter(Boolean).sort((a, b) => a.time.localeCompare(b.time) || a.createdAt.localeCompare(b.createdAt));
}

async function blocksForDate(store, date) {
  const keys = await store.list(`block/${date}/`);
  const map = {};
  for (const k of keys) {
    const time = k.split("/")[2];
    map[time] = (await store.get(k)) || { reason: "" };
  }
  return map;
}

const isActive = (a) => a.status !== "cancelled";

// ---------------------------------------------------------------- responses

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });
const err = (message, status = 400) => json({ error: message }, status);

// ---------------------------------------------------------------- handler

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  const q = url.searchParams;

  let body = {};
  if (req.method === "POST" || req.method === "PATCH") {
    try { body = await req.json(); } catch { body = {}; }
  }

  try {
    const store = await makeStore();

    // ---------- public ----------

    if (route === "health") {
      return json({ ok: true, ts: Date.now(), today: todayPK() });
    }

    if (route === "meta") {
      return json({ departments: DEPARTMENTS, today: todayPK(), maxDaysAhead: MAX_DAYS_AHEAD });
    }

    if (route === "login" && req.method === "POST") {
      const pw = String(body.password || "");
      if (!pw || !checkPassword(pw)) return err("Incorrect password.", 401);
      const exp = Date.now() + TOKEN_TTL_MS;
      return json({
        token: signToken({ role: "admin", exp }),
        expiresAt: exp,
        defaultPassword: PASSWORD === DEFAULT_PASSWORD,
      });
    }

    if (route === "slots" && req.method === "GET") {
      const date = q.get("date") || todayPK();
      const dept = q.get("dept") || "general";
      if (!isValidDate(date)) return err("Invalid date.");
      if (!DEPARTMENTS.some(d => d.id === dept)) return err("Unknown department.");
      const [appts, blocks] = await Promise.all([
        appointmentsForDate(store, date),
        blocksForDate(store, date),
      ]);
      const slots = slotTimesFor(date).map(time => {
        let status = "open";
        if (isPastSlot(date, time)) status = "past";
        else if (blocks[time]) status = "blocked";
        else if (appts.some(a => a.time === time && a.dept === dept && isActive(a))) status = "full";
        return { time, status };
      });
      return json({ date, dept, slots });
    }

    if (route === "book" && req.method === "POST") {
      // honeypot: bots fill the hidden "website" field — pretend success
      if (body.website) return json({ ok: true, appointment: { id: "MMC-OK" } });

      const name = String(body.name || "").trim().slice(0, 80);
      const phone = String(body.phone || "").trim().slice(0, 24);
      const age = String(body.age || "").trim().slice(0, 3);
      const gender = String(body.gender || "").trim().slice(0, 20);
      const concern = String(body.concern || "").trim().slice(0, 500);
      const dept = String(body.dept || "");
      const date = String(body.date || "");
      const time = String(body.time || "");

      if (name.length < 2) return err("Please enter your full name.");
      if (!/^[\d+\-\s()]{7,}$/.test(phone)) return err("Please enter a valid phone number.");
      if (!DEPARTMENTS.some(d => d.id === dept)) return err("Unknown department.");
      if (!isValidDate(date)) return err("Invalid date.");
      const today = todayPK();
      const max = new Date(Date.now() + PK_OFFSET_MS + MAX_DAYS_AHEAD * 86400000).toISOString().slice(0, 10);
      if (date < today || date > max) return err(`Date must be between ${today} and ${max}.`);
      if (!slotTimesFor(date).includes(time)) return err("Invalid time slot.");
      if (isPastSlot(date, time)) return err("That slot has already passed.");

      const [appts, blocks] = await Promise.all([
        appointmentsForDate(store, date),
        blocksForDate(store, date),
      ]);
      if (blocks[time]) return err("That slot is closed. Please pick another.", 409);
      if (appts.some(a => a.time === time && a.dept === dept && isActive(a)))
        return err("That slot was just taken. Please pick another.", 409);

      const id = `${date}_${time}_${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
      const appointment = {
        id, ref: "MMC-" + id.split("_")[2],
        name, phone, age, gender, concern, dept, date, time,
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      await store.set(apptKey(date, time, id), appointment);
      return json({ ok: true, appointment }, 201);
    }

    // ---------- admin (auth required) ----------

    if (route.startsWith("admin/")) {
      if (!requireAuth(req)) return err("Unauthorized.", 401);
    }

    if (route === "admin/appointments" && req.method === "GET") {
      const from = q.get("from") || todayPK();
      const days = Math.min(Math.max(parseInt(q.get("days") || "14", 10), 1), 31);
      if (!isValidDate(from)) return err("Invalid date.");
      const base = new Date(from + "T00:00:00Z").getTime();
      const dates = Array.from({ length: days }, (_, i) =>
        new Date(base + i * 86400000).toISOString().slice(0, 10));
      const all = (await Promise.all(dates.map(d => appointmentsForDate(store, d)))).flat();
      all.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
      return json({ appointments: all });
    }

    if (route === "admin/appointments" && req.method === "PATCH") {
      const { id, status } = body;
      if (!STATUSES.includes(status)) return err("Invalid status.");
      const [date, time] = String(id || "").split("_");
      if (!isValidDate(date || "") || !time) return err("Invalid appointment id.");
      const key = apptKey(date, time, id);
      const appt = await store.get(key);
      if (!appt) return err("Appointment not found.", 404);
      appt.status = status;
      appt.updatedAt = new Date().toISOString();
      await store.set(key, appt);
      return json({ ok: true, appointment: appt });
    }

    if (route === "admin/appointments" && req.method === "DELETE") {
      const id = q.get("id") || "";
      const [date, time] = id.split("_");
      if (!isValidDate(date || "") || !time) return err("Invalid appointment id.");
      await store.del(apptKey(date, time, id));
      return json({ ok: true });
    }

    if (route === "admin/schedule" && req.method === "GET") {
      const date = q.get("date") || todayPK();
      if (!isValidDate(date)) return err("Invalid date.");
      const [appts, blocks] = await Promise.all([
        appointmentsForDate(store, date),
        blocksForDate(store, date),
      ]);
      const slots = slotTimesFor(date).map(time => ({
        time,
        past: isPastSlot(date, time),
        blocked: !!blocks[time],
        blockReason: blocks[time]?.reason || "",
        appointments: appts.filter(a => a.time === time),
      }));
      return json({ date, slots, departments: DEPARTMENTS });
    }

    if (route === "admin/block" && req.method === "POST") {
      const { date, time, reason } = body;
      if (!isValidDate(String(date || ""))) return err("Invalid date.");
      if (!slotTimesFor(date).includes(String(time || ""))) return err("Invalid time.");
      await store.set(blockKey(date, time), {
        reason: String(reason || "").slice(0, 120),
        createdAt: new Date().toISOString(),
      });
      return json({ ok: true });
    }

    if (route === "admin/block" && req.method === "DELETE") {
      const date = q.get("date") || "", time = q.get("time") || "";
      if (!isValidDate(date) || !time) return err("Invalid date/time.");
      await store.del(blockKey(date, time));
      return json({ ok: true });
    }

    if (route === "admin/stats" && req.method === "GET") {
      const today = todayPK();
      const base = new Date(today + "T00:00:00Z").getTime();
      const dates = Array.from({ length: 7 }, (_, i) =>
        new Date(base + i * 86400000).toISOString().slice(0, 10));
      const perDay = await Promise.all(dates.map(d => appointmentsForDate(store, d)));
      const todayAppts = perDay[0];
      const count = (list, s) => list.filter(a => a.status === s).length;
      return json({
        today: {
          date: today,
          total: todayAppts.filter(isActive).length,
          pending: count(todayAppts, "pending"),
          confirmed: count(todayAppts, "confirmed"),
          completed: count(todayAppts, "completed"),
          cancelled: count(todayAppts, "cancelled"),
        },
        week: dates.map((d, i) => ({ date: d, count: perDay[i].filter(isActive).length })),
        weekTotal: perDay.flat().filter(isActive).length,
        pendingWeek: perDay.flat().filter(a => a.status === "pending").length,
      });
    }

    return err("Not found.", 404);
  } catch (e) {
    console.error("API error:", e);
    return err("Server error. Please try again.", 500);
  }
}

export const config = { path: "/api/*" };
