# Murtaza Medical Complex — Website

Marketing site + live appointment system for MMC (Bahria Town Phase 8, Rawalpindi).

## What's here

| File | Purpose |
|---|---|
| `index.html` | Public website with the **live "departures board"** — patients pick a department + day, see real slot availability, and book with one tap. |
| `admin.html` | **Admin panel** (`/admin`) — password login, dashboard KPIs, weekly chart, appointment management (confirm / complete / cancel / delete, WhatsApp the patient), and slot blocking. |
| `netlify/functions/api.mjs` | Backend API (Netlify Function). Stores data in **Netlify Blobs** — no external database needed. |
| `dev-server.mjs` | Local dev server (`npm run dev` → http://localhost:8888) using file storage in `.data/`. |

## Deploy (Netlify)

1. Push to the connected repo — Netlify builds automatically (functions are bundled from `netlify/functions/`).
2. **Set environment variables** in Netlify → Site settings → Environment variables:
   - `ADMIN_PASSWORD` — **required for production.** Until set, the admin login uses a default password and the panel shows a warning.
   - `SESSION_SECRET` — optional; any long random string. Used to sign admin session tokens.
3. Done. The site, `/admin`, and `/api/*` all work on the Netlify URL.

If the API is ever unreachable, the public site degrades gracefully: the board shows all future slots and bookings fall back to WhatsApp (the original behaviour).

## Local development

```
npm run dev
```

Opens http://localhost:8888 with the full stack (API data is stored as JSON files in `.data/`, which is git-ignored).

## API overview

Public: `GET /api/health`, `GET /api/meta`, `GET /api/slots?date&dept`, `POST /api/book`
Admin (Bearer token from `POST /api/login`): `GET/PATCH/DELETE /api/admin/appointments`, `GET /api/admin/schedule?date`, `POST/DELETE /api/admin/block`, `GET /api/admin/stats`

Clinic hours encoded in the API: Mon–Sat 09:00–21:00, Sun 10:00–16:00, 30-minute slots, bookable up to 30 days ahead (Pakistan time).
