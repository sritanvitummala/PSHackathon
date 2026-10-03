# PillPal — PSHackathon

Take a photo of a prescription bottle and PillPal will:

1. **Read the label on your phone.** OCR (text recognition) runs in the browser, so the photo never leaves the device.
2. **Let you check it.** Every detail it found can be edited before it's used.
3. **Explain it in your language.** 12 languages, with read-aloud. Arabic displays right-to-left.
4. **Create reminders.** It downloads a calendar file that works with Google Calendar, Apple Calendar or Outlook, with a repeating event and alert for each dose.

It's free to run: no API keys, no server costs and no accounts.

## How it works

```
photo → Tesseract.js OCR → pattern parser → user confirms → fixed-phrase translation → .ics reminders
```

| File | What it does |
|---|---|
| `frontend/ocr.js` | Image cleanup (grayscale, contrast) and Tesseract.js OCR in the browser |
| `frontend/parser.js` | Turns label text into dose, schedule, duration, food and warnings. It fuzzy-matches ~130 common drug names to survive OCR typos |
| `frontend/i18n.js` | Pre-written translations of standard label phrases (12 languages) |
| `frontend/app.js` | The UI steps, read-aloud and calendar file generation |

**Why fixed-phrase translations instead of AI translation?** US pharmacy directions use a small set of standard phrases ("TAKE 1 TABLET BY MOUTH TWICE DAILY", "MAY CAUSE DROWSINESS"). Translating those phrases once, and filling in only the numbers, means the app can never invent an instruction. Anything it doesn't recognize is flagged with "ask your pharmacist" instead of being guessed.

## Run it

You need Python, used only as a simple web server.

```powershell
cd frontend
python -m http.server 8000
```

Open http://localhost:8000. To test on a phone, connect it to the same Wi-Fi and open `http://<laptop-ip>:8000` (find the IP with `ipconfig`).

The first scan downloads the OCR engine (~10 MB, cached afterwards), so it needs internet once.

## Tips for a good scan

- Use bright, even light and tilt the bottle to avoid glare.
- Fill the frame with the label and keep the text horizontal (use ↻ Rotate if needed).
- On a round bottle, photograph the directions part of the label head-on.
- If the scan is poor, fix the fields by hand or tap "Type the directions instead".

## Limitations

- Supports English-language US labels.
- Multi-step directions (for example "2 tablets day 1, then 1 daily") are flagged for the user to check instead of being fully translated.
- Translations should be reviewed by native speakers before real use.

> ⚠️ This is a hackathon prototype, not medical advice. Always confirm with a pharmacist.
