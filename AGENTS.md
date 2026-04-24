# AGENTS.md

This file is the working reference for AI agents in this repository.
Use it to keep implementation consistent and reduce repeated explanations.

## 1) Project Identity (fill these)

- Project name: `<TAXI FOR KIDS>`
- Owner: `<STARTUP TEAM>`
- Primary goal: `<Dashboard  for admin to control the drivers and trips  so admin can choose driver for trips   while the driver get a schedule  and parent just make the rides for thier children and the admin choose the driver for the trip and there is algorithm that help the admin to choose the driver for each trip bases on his  position   >`
- Current phase: `< PRODUCTION>`


## 2) Product Context (fill these)

- Target users: `<the admin to control the app for drivers and parents >`
- Main workflows:
  - `<flexiple dashboard for smooth control over the app >`

- Non-goals (what we should avoid building):
  - `<complexity in code and alot of lines>`


## 3) Current Tech Snapshot (prefilled)

- Frontend: `index.html`, `styles.css`, `script.js` (vanilla HTML/CSS/JS)
- Firebase config present: `firebase-config.js`
- Reporting module files:
  - `driver-report.html`
  - `driver-report.css`
  - `driver-report.js`
  - `driver-normalize.js`
- No package manager or test runner detected in repo root.

## 4) Repository Map (prefilled, edit if needed)

- `index.html`: Main admin dashboard page
- `styles.css`: Global dashboard styling
- `script.js`: Main dashboard logic and interactions
- `firebase-config.js`: Firebase initialization/config wiring
- `driver-report.*`: Driver report UI + behavior
- `driver-normalize.js`: Driver report data normalization



## 6) Coding Rules For Agents

- Keep changes minimal and scoped to the request.
- Preserve existing naming and file organization unless refactor is requested.
- Do not introduce frameworks/build tools unless explicitly requested.
- Treat `firebase-config.js` and credentials as sensitive.
- Add concise comments only where logic is not obvious.

## 7) UI/UX Direction (fill these)

- Brand tone: `<EX: PROFESSIONAL, CLEAN, DATA-FOCUSED>`
- Colors to use/avoid:
  - Use: `<PRIMARY_COLORS>`
  - Avoid: `<RESTRICTED_COLORS>`
- Typography preference: `<FONT_PREFERENCE>`
- Layout preference: `<DENSE | SPACIOUS | BALANCED>`
- Mobile requirement: `<YES/NO + EXPECTED BREAKPOINTS>`




## 11) Agent Working Preferences (fill these)

- Preferred response style: `<SHORT >`
- Ask-before-doing threshold: `<LOW | MEDIUM | HIGH>`
- Safe-to-autofix areas:
  - `<script.js>`
  - `<index.html>`


## 12) Change Log

- `2026-04-03`: Initial AGENTS.md scaffold created.

