# Ground Control

Field OS for a roofing and construction company.

Broken out of Phone Pip: **CHAT** (multi-API Super Chat), **WX** (live NOW map + NOAA hail trace), and **LENS** (shingle ID, damage circles, field ID).

This folder is the app. It is meant to live in its own GitHub repository: [joshuagwatts/ground-control](https://github.com/joshuagwatts/ground-control).

## What it does

- **LENS** — three modes:
  - **SHINGLE** — certain-only product ID from a photo sequence. It will **not** name manufacturer, product, color, or date until the catalog match is unique and the required shots exist.
  - **DAMAGE** — auto red circles (and arrows) on hail bruises / granule loss / lifts. After SNAP you can tap and scale extra marks on the photo.
  - **FIELD** — ID flashing, vents, penetrations, plants, hardware — not just shingles.
- **Discontinued** — catalog includes pulled lines (GAF Timberline HD, CertainTeed Independence / Hatteras, OC Duration COOL, Atlas GlassMaster, and more). A discontinued ID is only claimed when the match is unique; the current equivalent is listed when we have one.
- **WX** — **NOW** is sat + live RainViewer radar with a temp HUD. **HAIL** is the insurance-grade trace (NOAA SPC + SWDI + IEM, 25 km / 365 days / 0.75").
- **CHAT** — Super Chat: Gemini, OpenAI, Anthropic, OpenRouter, Groq, Grok, Cerebras, DeepSeek, Mistral, COMPARE tabs, multi-photo attach.
- **JOBS** — save a LENS read (and later a hail pin) onto an inspection.

## Run

```bash
npm test
npm start
```

Open http://127.0.0.1:4173

Paste a **Gemini / OpenAI / Anthropic / OpenRouter** key in KEYS, flip **LEAKY**, then use LENS.

## Certainty rules

LENS is not a guessing model with a roof prompt. A local gate throws out any product name that is not a unique row in `www/catalog.js`. One photo is never enough. Exact **date** requires a readable back stamp or bundle wrapper — weathering is era, not a date.

## Repo / Cursor workspace

This app lives at [joshuagwatts/ground-control](https://github.com/joshuagwatts/ground-control). Open this folder in Cursor (or start a Cloud Agent on that repo). That is the Ground Control workspace.

## Android APK

**[Latest release](https://github.com/joshuagwatts/ground-control/releases/latest)** — `GroundControl.apk`

Install over the last build. Keys stay on the phone. Push to `main` (or run **Ship**) builds a new APK.

```bash
npm install
npx cap sync android
npx cap open android
```
