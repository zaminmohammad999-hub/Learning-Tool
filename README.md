# Vibe Coding Learning Command Centre

A local dashboard for the 12-week **Vibe Coding & AI Development Mastery** programme. It tracks what was taught, what was practised, what is still missing, and which competencies have been **verified as mastered** through practical tests. The curriculum has 6 domains, 24 competencies, 96 exercises and 24 lessons of 60 minutes each.

- **Frontend:** React (JavaScript) + Vite, in `client/`
- **Backend:** Node.js + Express, in `server/`
- **Database:** SQLite, using Node's built-in `node:sqlite` (no native build tools needed). It uses FTS5 full-text search over transcripts.
- **AI (optional):** Claude via the Anthropic SDK, called **only from the server**. Everything else works without it.

> **Claude Code vs this app:** Claude Code is the assistant you use in VS Code to *build and change* this project. The running dashboard does **not** use Claude Code. Its optional AI features call the Claude API directly from `server/`, using your own `ANTHROPIC_API_KEY`.

---

## 1. Setup (Windows PowerShell, in the VS Code integrated terminal)

You need **Node.js 22.13 or newer** (24 or 26 recommended) and Git.

```powershell
node -v                       # must be v22.13+ (node:sqlite)
cd "$HOME\OneDrive\Desktop\Learning-Tool"
npm run setup                 # installs root, server and client dependencies
Copy-Item .env.example .env   # optional: only needed for AI or custom ports
npm run validate:curriculum   # checks 6/24/96/12/24, 2 lessons/week, 60 min, no bad ids
```

## 2. Start the app

**Development** (auto-reload; two processes):

```powershell
npm run dev
```

Open **http://127.0.0.1:5173**. The API runs on http://127.0.0.1:4000, and Vite forwards `/api` requests to it.

**Single-process production mode:**

```powershell
npm start        # builds the client, then serves UI + API together
```

Open **http://127.0.0.1:4000**.

Stop either mode with `Ctrl+C`. Both servers listen on `127.0.0.1` only, so private transcripts are not reachable from your network. Your data is in `data/db/learning.sqlite` and survives restarts and browser closes.

The database is seeded automatically on start. You can also run `npm run seed`. **Seeding is idempotent:** it refreshes the canonical curriculum from `data/vibe_coding_curriculum.json` but never resets your progress, transcripts, edits or assessments.

## 3. Optional: enable Claude

1. Get an API key from https://console.anthropic.com/ and put it in `.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
2. Restart `npm run dev`.
3. Go to **Settings & Data → AI**, tick **Enable Claude**, and save. The sidebar indicator changes to **AI on**.

**Defaults:** model `claude-opus-5-5`, effort `medium`. Both can be changed in Settings.

**Key handling:** the key is only read on the server. It is never sent to the browser, logged or stored in the database, and `.env` is git-ignored.

**Cost awareness:** about 4 characters ≈ 1 token. A 60-minute transcript of roughly 50,000 characters is about 15–20k input tokens per analysis, typically well under US$0.20 on Opus 5.5 ($4 per million input tokens, $20 per million output). The app shows an estimate before every Claude analysis. Chat questions send only the retrieved excerpts.

**Refusal fallback:** requests are sent with the server-side refusal fallback (`fallbacks: "default"`). If Claude declines a request, it is re-run on a fallback model.

**Without a key:** transcript import, the rule-based matcher, manual mapping, assessments, briefings and the search-based Q&A all keep working. The Q&A is clearly labelled "rule-based, no AI".

## 4. Automate after-lesson updates (Hearsay + Google Calendar)

Once this is set up, the app does the following around each lesson:

1. **Before the lesson.** It reads your Google Calendar and fills in lesson dates and times. Ten minutes before a lesson, you get a Windows notification to start recording in Hearsay.
2. **During the lesson.** It reads Hearsay's log. If Hearsay isn't recording after the start, or reports "no audio captured", you get a notification.
3. **After the lesson.** When Hearsay saves `transcript_YYYYMMDD_HHMMSS.md`, the app:
   - imports it into the lesson whose calendar slot the recording started in;
   - translates Urdu to English with Claude, if enabled;
   - runs the matcher;
   - notifies you that proposed matches are ready.
4. **You review the proposals** in Tutor Intelligence. **Coverage changes only when you approve a match.**

**Hearsay can't be started automatically.** It has no command-line or hotkey trigger, so you still press Record yourself. The reminders cover that step.

### Setup

1. **Calendar:**
   - Open Google Calendar → ⚙ Settings → your calendar → **Integrate calendar**.
   - Copy the **Secret address in iCal format**.
   - In `.env`, set `CALENDAR_ICS_URL=<that address>`, then restart the app.
   - Treat the address like a password. It stays on the server and is never shown, logged or exported.
2. **Lesson events:**
   - Make sure your lesson events have a recognisable word in the title. The default keyword is **Vibe Coding**, and you can change it in Settings → Automation. Only events whose title contains the keyword are read.
   - To pin an event to a specific lesson, include "Lesson 7" (or "L07") in its title. Otherwise, upcoming events are matched in order to lessons not yet held.
   - Dates you type in yourself are never overwritten.
3. **Hearsay folder:**
   - Go to **Settings → Automation**.
   - Set the folder (Hearsay's default is `C:\Users\<you>\Documents\Hearsay`) and tick **Watch this folder**.
   - Files already in the folder at that moment are left alone.
   - A new recording that didn't start during a calendar lesson waits on the Overview, where you **Import** it (choosing the lesson) or **Ignore** it.
4. **Translation (Claude):** tick **Translate Urdu transcripts automatically** and set a spend limit per step.
   - The default translation model is `claude-sonnet-5-5`. A one-hour lesson typically costs a few tens of cents.
   - The original file is stored unchanged. Each line keeps its Urdu text next to the English, and you can see both in Session History.
   - If AI is off, transcripts are still imported, and Session History shows a **Translate to English** button with a cost estimate.
5. **Hearsay settings:**
   - Set **Audio source: both** (microphone + system audio), so the tutor's voice is captured.
   - Keep **Language: Urdu**.
   - Hearsay's `small` model often mis-hears technical words. A larger model gives better Urdu, if your PC can run it. The translation step also corrects common phonetic spellings, for example "گیٹ ہب" becomes GitHub.

Automation pauses while you're in demo mode.

## 5. Daily workflow

### Paste or upload a transcript

1. Go to **Tutor Intelligence → Add transcript**.
2. Paste the text, or upload a `.txt`, `.md`, `.vtt` or `.srt` file (max 2 MB).
3. Fill in the date, tutor and duration.
4. Choose the lesson(s), or click **Suggest matching lessons**.
5. Click **Save transcript**. The original text is stored once and unchanged, with a checksum. Importing the same transcript again is rejected as a duplicate.
6. Click **Propose matches (rule-based)** or **Analyse with Claude**.

### Review proposed matches

Each proposal is shown side by side: **suggestion → curriculum exercise → cited transcript line** (with timestamp).

- Choose **Approve**, **Adjust** (change the category or exercise) or **Reject**. **Nothing changes your progress until you decide.**
- Facet gaps are listed explicitly, for example *"git fetch — not evidenced"*.
- Re-analysing a transcript never double counts. There is one evidence record per exercise per transcript.

### Ask questions

Use **Tutor Intelligence → Ask**. For example:

- *What did we cover?*
- *What did we miss?*
- *Have we demonstrated git fetch?*
- *What mistakes keep recurring?*

Every answer cites the session, timestamp and text it relies on. If there is no supporting evidence, the answer says so.

### Record tutor feedback and homework

Use **Tutor Feedback**. Next priorities, weaknesses and open homework flow into **Gaps & Briefing**, which builds a 60-minute plan for the next lesson with citations.

### Assess a competency (mastery)

1. Open **Practical Assessments** and choose a competency. Its rubric has one mandatory criterion for each of its four exercises. Criteria can be edited or added without touching the curriculum file.
2. Open **Record a practical attempt**. For each criterion, set:
   - pass / fail / not observed
   - independent / assisted
   - evidence type and the evidence itself (what was observed, or a URL / commit / PR)
3. An attempt **fails** if any mandatory criterion is not passed *independently* with recorded evidence. "Transcript only" evidence never counts.
4. When an attempt passes, **Verify Pass** appears. Enter the verifier name, role and an evidence summary. Only then does the competency show **✓ Mastered (verified)**, i.e. 100%.
5. **Request reassessment** keeps the old verification as history. Retakes keep all earlier attempts.
6. Domain assessments are scheduled after lessons 4, 8, 12, 16, 20 and 24 (weeks 2, 4, …, 12). They are tracked separately from competency mastery.

### Five separate concepts

These are never mixed:

| Concept | Where it is set |
|---|---|
| Lesson held / missed | Weekly Schedule |
| Homework completed | Tutor Feedback / lesson |
| Transcript analysed and evidence approved → **coverage** (x/96) | Tutor Intelligence |
| Domain assessment result | Practical Assessments |
| Competency mastered → **verified mastery** (x/24) | Practical Assessments → Verify Pass |

## 6. Back up your data

Go to **Settings & Data → Backup, export & import**:

- **Download export (.json)** downloads every user-owned record: progress, transcripts, analyses, approvals, assessments, feedback, homework, chat and the audit log.
- **Write backup file** saves a snapshot to `data/backups/`.
- **Import / Restore** replaces all current records with a backup file.

> ⚠ Backups contain **private tutoring conversations**. Keep them out of Git (`data/backups/` and the database are git-ignored) and out of shared folders.

You can also copy the database while the app is stopped:

```powershell
Copy-Item data\db\learning.sqlite "data\backups\learning-$(Get-Date -Format yyyyMMdd).sqlite"
```

Note: the project lives in a OneDrive folder. Avoid OneDrive syncing the live database while the app is running. To move it outside OneDrive, set `DB_PATH` in `.env`, for example `DB_PATH=C:\VibeData\learning.sqlite`.

**Privacy controls** (in Settings):

- Transcript retention in days. It is applied at server start and with **Apply now**.
- Deleting individual transcripts or sessions.
- **Delete all transcripts**, which requires typing a confirmation phrase.

**Demo mode** switches to a separate `demo.sqlite` file filled with clearly labelled synthetic data. A banner shows on every page, and real records are never touched.

## 7. Tests

```powershell
npm test
```

This runs both suites:

**Server** (`node:test` + supertest, 26 tests):

- Curriculum counts, the Lesson 6 mapping and the domain assessment schedule
- Persistence across restarts, and seed idempotency
- Transcript import, duplicate detection and immutability
- The clone-proposed / fetch-gap flow
- Approval gating and no double counting
- The no-AI fallback, plus a fake Claude client used to test quote and hallucination filtering and citation validation
- Mastery gating, verification, reassessment and retakes
- Export / import, briefing updates and demo-mode isolation
- Automation: Hearsay parsing, Urdu detection, calendar recurrence and keyword filtering, folder-watch safety gates, translation (mocked Claude), cost caps, reminders and the secret calendar URL never leaking

**Client** (Vitest + Testing Library):

- The Overview shows coverage and mastery separately
- The review UI posts an explicit approval
- The assessment pass/fail preview

The sample transcript `data/fixtures/SYNTHETIC_lesson06_transcript.txt` is synthetic and labelled as such.

## 8. Project layout

```
data/vibe_coding_curriculum.json   canonical seed (source of truth, version-controlled)
data/fixtures/                     synthetic test transcript
server/src/db/                     migrations, validator, idempotent seeder
server/src/services/               progress, transcripts, ruleAnalyzer, aiClient, analysis,
                                   assessments, briefing, chat, feedback, data (backup/demo)
server/src/routes/api.js           REST API (all input validated with zod)
server/test/                       API & logic tests
client/src/pages/                  Overview, Curriculum, Schedule, Intelligence, Sessions,
                                   Assessments, Feedback, Gaps, Settings
```

**Main API routes:**

| Method | Route |
|---|---|
| GET | `/api/curriculum`, `/api/schedule`, `/api/lessons/:id`, `/api/dashboard/stats`, `/api/gaps`, `/api/briefing`, `/api/export` |
| POST | `/api/transcripts`, `/api/transcripts/:id/analyse`, `/api/matches/:id/decision`, `/api/assessments/attempts`, `/api/assessments/verify`, `/api/assistant/chat`, `/api/import` |
| CRUD | `/api/sessions`, `/api/feedback`, `/api/homework` |

## 9. Known limitations

- **Rule-based matcher:** it uses keyword heuristics, so expect some false positives, such as "origin" in a push command suggesting D2-C2-E4. That is why every match needs review.
- **Claude analysis:** it is implemented and unit-tested against a mocked client, but it has **not been run against the live API** in this repository. Try it on one transcript after adding your key.
- **Q&A retrieval:** it uses keyword full-text search (FTS5), not semantic embeddings, so paraphrased questions may miss relevant lines.
- **Deleting a transcript:** this removes its evidence, but exercise statuses it raised are kept (the change is recorded in the audit log). Adjust them manually if needed.
- **Demo mode:** it resets to your real data whenever the server restarts.
- **Single user:** there is no login. It is intended for one learner on one machine.
- **Automation:**
  - It only runs while the app is running. Start `npm start` before lessons, or add it to Windows startup.
  - Language detection spots Urdu script, but not Roman Urdu (Urdu typed in Latin letters).
  - The Claude translation step is tested against a mocked client only.
  - Hearsay transcripts have no per-line timestamps, so citations show line numbers.
