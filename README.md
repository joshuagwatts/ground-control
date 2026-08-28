# Ground Control

Field app for roofing and construction.

**HailScope** is the home screen: pin a place, filter storm dates, tap a date to draw hail zones. **Lens** identifies shingles and marks damage. **Chat** is multi-API Super Chat.

This folder is the app: [joshuagwatts/ground-control](https://github.com/joshuagwatts/ground-control).

## What it does

- **HailScope** — tap the map or search an address. Filter storm dates (radius, hail size, year, search). Tap a date to populate hail zones (NOAA SPC + SWDI + IEM).
- **Lens** — three modes:
  - **Shingle** — certain-only product ID from a photo sequence. It will **not** name manufacturer, product, color, or date until the catalog match is unique and the required shots exist.
  - **Damage** — circles and arrows on hail bruises / granule loss / lifts. After Snap you can tap and scale extra marks.
  - **Field** — ID flashing, vents, penetrations, plants, hardware — not just shingles.
- **Discontinued** — catalog includes pulled lines (GAF Timberline HD, CertainTeed Independence / Hatteras, OC Duration COOL, Atlas GlassMaster, and more). A discontinued ID is only claimed when the match is unique.
- **Chat** — Super Chat: Gemini, OpenAI, Anthropic, OpenRouter, Groq, Grok, Cerebras, DeepSeek, Mistral, COMPARE, multi-photo attach.
- **Jobs** — save a Lens read or a HailScope pin onto an inspection.

## Run

```bash
npm test
npm start
```

Open http://127.0.0.1:4173

Paste a **Gemini / OpenAI / Anthropic / OpenRouter** key in Settings, leave **Cloud** on, then use Lens.

### Control Room (home PC GPU)

On the same Wi‑Fi as your phone, **double-click `Control Room.bat`** in this folder (or run `npm run control-room`).

Install [Ollama](https://ollama.com) and pull a model (`ollama pull llama3.2`; for Lens vision also `ollama pull llava`). The server prints a LAN URL like `http://192.168.x.x:7420` — phone **Settings → Connect**, or let auto-scan find it.

Allow port **7420** through Windows Firewall if Connect fails.

## Certainty rules

Lens is not a guessing model with a roof prompt. A local gate throws out any product name that is not a unique row in `www/catalog.js`. One photo is never enough. Exact **date** requires a readable back stamp or bundle wrapper — weathering is era, not a date.

## Android APK

**[Latest phone build](https://github.com/joshuagwatts/ground-control/releases/latest)** — `GroundControl.apk`

After the first signed install, **tap the APK to update**. Do not uninstall. Your keys stay on the phone.

Every push to `main` (or **Ship**) builds a new APK with a higher version code, signed with the same key.
