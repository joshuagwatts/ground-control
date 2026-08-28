# Ground Control

Field app for roofing and construction.

**HailScope** is the home screen: fullscreen map, tap a house for its address and owner links, open storm dates when you want them. **Lens** identifies shingles and marks damage. **Chat** is multi-API Super Chat.

This folder is the app: [joshuagwatts/ground-control](https://github.com/joshuagwatts/ground-control).

## What it does

- **HailScope** ? boots fullscreen on satellite. Tap a roof or search an address: the address peek slides up with Zillow, county assessor, and any owner contact links. Tap the address line for storm dates (NOAA SPC + SWDI + IEM); tap a date to draw hail zones. Swipe up to go back fullscreen. Done addresses auto-geocode into yellow pins.
- **Lens** ? three modes:
  - **Shingle** ? certain-only product ID from a photo sequence. It will **not** name manufacturer, product, color, or date until the catalog match is unique and the required shots exist.
  - **Damage** ? circles and arrows on hail bruises / granule loss / lifts. After Snap you can tap and scale extra marks.
  - **Field** ? ID flashing, vents, penetrations, plants, hardware ? not just shingles.
- **Discontinued** ? catalog includes pulled lines (GAF Timberline HD, CertainTeed Independence / Hatteras, OC Duration COOL, Atlas GlassMaster, and more). A discontinued ID is only claimed when the match is unique.
- **Chat** ? Super Chat: Gemini, OpenAI, Anthropic, OpenRouter, Groq, Grok, Cerebras, DeepSeek, Mistral, COMPARE, multi-photo attach.
- **Jobs** ? save a Lens read or a HailScope pin onto an inspection.

## Run

```bash
npm test
npm start
```

Open http://127.0.0.1:4173

Paste a **Gemini / OpenAI / Anthropic / OpenRouter** key in Settings, leave **Cloud** on, then use Lens. On phone, shingle ID uses **Lens ? ChatGPT share** ? no keys required.

## Certainty rules

Lens is not a guessing model with a roof prompt. A local gate throws out any product name that is not a unique row in `www/catalog.js`. One photo is never enough. Exact **date** requires a readable back stamp or bundle wrapper ? weathering is era, not a date.

## Android APK

**[Latest phone build](https://github.com/joshuagwatts/ground-control/releases/latest)** ? `GroundControl.apk`

After the first signed install, **tap the APK to update**. Do not uninstall. Your keys stay on the phone.

Every push to `main` (or **Ship**) builds a new APK with a higher version code, signed with the same key.
