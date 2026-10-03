# PillPal — PSHackathon

Take a photo of a prescription bottle and PillPal will:

1. **Read the label** with Claude vision: drug, strength, dose, how often, warnings and pharmacy info.
2. **Explain it in your language** in plain words, with a read-aloud button. Arabic and Urdu display right-to-left.
3. **Create reminders** by downloading a `.ics` calendar file with a repeating event and alert for each dose time. It works with Google Calendar, Apple Calendar and Outlook.

The original label text is always shown next to the translation so it can be checked.

## Structure

```
backend/   FastAPI app: POST /api/scan → Claude (claude-opus-5-5) → structured JSON
frontend/  Plain HTML/CSS/JS (no build step), served by the backend at /
```

## Run it

You need Python 3.10 or newer and an Anthropic API key.

```powershell
cd backend
python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env          # then put your key in .env
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Open http://localhost:8000.

**Testing on a phone:** connect the phone to the same Wi-Fi as the laptop and open `http://<laptop-ip>:8000`. Find the laptop IP with `ipconfig`. On the phone, the photo button opens the camera directly.

## How it works

- The frontend shrinks the photo to 1600px before uploading it.
- The backend sends the image to Claude with a JSON schema (structured outputs), so the response always parses. The schema includes a `confidence` field and an `unreadable_fields` list. When confidence is low, the UI shows a warning instead of guessing.
- Suggested dose times follow standard defaults (for example, twice a day = 08:00 and 20:00). Users can edit or add times before exporting.
- The `.ics` file is generated in the browser, with one `RRULE` event per dose time and a `VALARM` alert.

> ⚠️ This is a hackathon prototype, not medical advice. Always confirm with a pharmacist.
