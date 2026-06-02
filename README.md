# CrowdPlay: Real-Time, Mobile-Controlled Big-Screen Activities

**CrowdPlay** is a real-time, mobile-controlled platform for big-screen audience activities, built with Node.js, Express, and Socket.io. A shared **Big Screen** (TV/projector) displays the activity while players join from their **phones** via a 4-character room code.

**🔴 Live demo:** **https://crowdplay-nfxt.onrender.com** — open `/admin` (password `admin123`) and `/screen/DEMO` in separate tabs to host, and `/join/DEMO` to play. *(Free tier sleeps after ~15 min idle, so the first request may take ~30s to wake.)*

It ships with two modes:
- 🧩 **Collaborative Jigsaw** — the room solves one puzzle together, dragging pieces from their phones.
- ☁️ **Live Audience Word Cloud** — attendees submit short responses that build a living word cloud on screen (with upvoting, sentiment, moderation, and a reveal summary).

---

## ✨ What's New in This Fork

This fork makes two meaningful additions to the upstream project, plus cleanup.

### 1. A redesigned interface (UI/UX)
A complete visual redesign in a warm **paper / neo-brutalist** style — chunky borders, hard offset shadows, expressive display type (Bricolage Grotesque) — across the landing, admin, big-screen, and mobile pages, with a **light/dark theme toggle** persisted to `localStorage`. *(The visual design was produced with AI assistance; it reskins the existing screens while preserving their structure and behaviour.)*

### 2. A new game mode — Live Audience Word Cloud
Implements the maintainer's own roadmap spec, [`docs/better-word-cloud-prd.md`](docs/better-word-cloud-prd.md), as a new activity plugged into the existing `BaseActivity` architecture — **the jigsaw mode is untouched.**

| Feature | Detail |
| :--- | :--- |
| 📡 **Live updates** | Submissions appear on the big screen instantly over Socket.io. |
| 🔤 **Term merging** | `AI`, `A.I.`, and `artificial intelligence` collapse into one word; filler words are ignored. |
| 👍 **Upvoting** | Players tap words on their phone to upvote; the cloud sizes by **frequency + votes** and shows a `▲` badge. |
| 🎨 **Sentiment mode** | One click tints words positive/neutral/negative with a live distribution bar. |
| 🏁 **Close & reveal** | The host closes the session to a summary screen: top-words podium, totals, unique participants. |
| 🚫 **Profanity filter** | Flagged words are auto-hidden (still recorded for the host). |
| 🛡️ **Moderation** | The admin console shows a live response list with one-click hide. |
| 📊 **CSV export** | One click on the big screen downloads all responses. |
| ✅ **Tests** | `npm test` covers the text engine (merging, stop words, profanity, votes-as-weight, sentiment). |

### 3. Repo hygiene & fixes
- Added `.gitignore`; stopped committing `node_modules`, the local SQLite DB, and uploaded images.
- Updated `sqlite3` to 6.x (prebuilt binaries for current Node.js).
- Hardened LAN-IP detection for the join QR so it skips virtual adapters (WSL/Docker/VPNs) and prefers the real Wi-Fi/Ethernet.

---

## 🚀 Quick Start

```bash
npm install
npm run dev
```

The dev server runs over **HTTPS** on port **3000** (self-signed cert — needed so phones can use interactive browser APIs on the LAN).

| Role | URL |
| :--- | :--- |
| Landing | `https://localhost:3000/` |
| Admin   | `https://localhost:3000/admin` (password `admin123`) |
| Big screen | `https://localhost:3000/screen/DEMO` |
| Player  | `https://localhost:3000/join/DEMO` |

> On phones, open the join URL with your computer's LAN IP (the admin/screen show the correct join QR automatically) and accept the one-time "connection is not private" warning (**Advanced → Proceed**) — that's the self-signed dev cert.

### Run the tests
```bash
npm test
```

---

## 🧩 Playing the Jigsaw
1. Open the big screen at `/screen/DEMO`.
2. In `/admin`, log in, choose **Collaborative Jigsaw**, set rows/columns (optionally upload an image), and **Create room → Start game**.
3. Players join, drag pieces on their phones, and snap them into place together.

## ☁️ Running a Word Cloud
1. Open the big screen at `/screen/DEMO`.
2. In `/admin`, choose **Live Audience Word Cloud**, enter a prompt, pick a response length and submissions-per-person, then **Create room → Start game**.
3. Players join, type a word or short phrase, and **Send to Screen**. They can **tap any word to upvote it**.
4. On the big screen, the **Mode** button toggles Classic ↔ Sentiment colours; **Export CSV** downloads responses.
5. Use the admin **Live responses** list to hide anything inappropriate.
6. Hit **🏁 Close & Reveal** in the admin to show the final summary on the big screen.

> Tip: open a few `/join/DEMO` tabs to simulate a crowd on one machine. Existing tabs are unaffected when a new player joins.

---

## ⚙️ Configuration

Set via environment variables (all optional in development):

| Variable | Description | Default |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` or `production` | `development` |
| `PORT` | Listen port | `3000` |
| `HOST_IP` | Force the LAN IP used in join URLs/QR (useful behind VPNs) | *(auto-detected)* |
| `DATABASE_URL` | Postgres connection string; falls back to SQLite | *None* |
| `REDIS_URL` | Redis URL; falls back to an in-memory mock | *None* |
| `ADMIN_PASSWORD` | Admin panel password | `admin123` |
| `JWT_SECRET` | Secret for admin session tokens | *(dev default — set in prod)* |

---

## ☁️ Deployment & CI/CD

- **CI:** GitHub Actions (`.github/workflows/ci.yml`) installs deps and runs `npm test` on every push to `main` and on PRs.
- **CD (Render):** a [`render.yaml`](render.yaml) blueprint is included and the app is **live at https://crowdplay-nfxt.onrender.com**. On Render: **New → Blueprint → connect this repo**; Render builds the `Dockerfile` and, with `autoDeploy`, **redeploys on every push to `main`**. It runs a persistent container with **native WebSocket support** and terminates TLS at the edge, so the Socket.io server works unchanged. The blueprint sets `USE_SQLITE_FALLBACK=false` so it runs in-memory (Render's free disk is ephemeral); set `DATABASE_URL` to a Postgres instance for real persistence.
- **Note on Vercel:** Vercel's serverless model can't host this app as-is — it's a long-lived Socket.io server with in-memory room state, which needs a persistent process and WebSockets. Container hosts (Render/Railway/Fly, or the included AWS ECS workflow) are the right fit. Vercel could only host a split-out static frontend with the realtime server elsewhere.

---

## 📝 Design Notes, Assumptions & Limitations

- **Purely additive.** The word cloud is a new `BaseActivity`; jigsaw is unchanged and still passes an end-to-end test. `admin-start-activity` defaults to `jigsaw`, so older clients keep working.
- **Zero new runtime dependencies.** The cloud is plain DOM + CSS; the text engine is hand-rolled and unit-tested.
- **MVP scope by design.** Covers the PRD's "Must Have" set plus several "Should Have" items (upvoting, sentiment, profanity filter). Deferred per the PRD's own phasing: theme clustering, timeline-pulse view, AI-based grouping.
- **Term merging is lightweight** (lower-casing, punctuation stripping, stop words, a small synonym map) — not semantic clustering.
- **Sentiment is a small word-level lexicon**, not NLP; words outside it read as neutral. Easily extended in `src/activities/wordcloud/textUtils.js`.
- **Upvoting** is one vote per word per participant, deduped server-side against in-memory session state. Votes are keyed by word string, so a word's tally persists even if the host later hides the response that introduced it (harmless for a live session).
- **In-memory state.** Like the jigsaw mode, live activity state resets if the host disconnects; multi-server scaling would need the Redis pub/sub path fleshed out.

---

## 📂 Where the changes live

| Area | Files |
| :--- | :--- |
| Word cloud activity | `src/activities/wordcloud/{index,textUtils,textUtils.test}.js` |
| Real-time events | `src/socket/index.js`, `src/socket/roomManager.js` |
| Frontend (redesign + word cloud) | `public/{index,admin,mobile,screen}.html`, `public/{admin,mobile,screen,desktop}.js` |
| LAN IP fix | `src/routes/room.js` |
