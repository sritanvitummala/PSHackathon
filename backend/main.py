"""PillPal backend: scans a prescription bottle photo with Claude vision and
returns structured dosing info plus a translation into the user's language."""

import base64
import json
from pathlib import Path

import anthropic
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles

load_dotenv()

MODEL = "claude-opus-5-5"
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # API limit per image

SYSTEM_PROMPT = """You read photos of pharmacy prescription bottle labels and extract the information a patient needs to take the medication correctly.

Accuracy rules - people will take medicine based on your output:
- Transcribe what the label actually says. Never guess a drug name, strength, or dose you cannot read. If a field is unreadable or absent, leave it as an empty string (or 0 for numbers) and list it in unreadable_fields.
- label_directions_verbatim must be the directions text exactly as printed, in the original language.
- If the image is not a prescription label, set is_prescription_label to false and leave the other fields empty.
- Set confidence to "low" if glare, blur, cropping, or curvature made any dosing field uncertain.

Scheduling rules for suggested_times (24-hour "HH:MM", local time):
- Once daily: 08:00. Twice daily: 08:00, 20:00. Three times: 08:00, 14:00, 20:00. Four times: 08:00, 12:00, 16:00, 20:00.
- "At bedtime": 21:30. "Every N hours": spread evenly across the day starting 08:00, unless the label says while awake, then keep within 08:00-22:00.
- Follow explicit label timing (e.g. "in the morning", "with breakfast") over these defaults.
- As-needed (PRN) medications: schedule_type "as_needed" and an empty suggested_times list.
- duration_days: only if the label states a duration or it is clearly computable (e.g. quantity 20, 2 per day = 10 days for an antibiotic course). Otherwise 0.

Translation: fill the translation object in the requested target language, in plain words a patient with no medical background understands. Keep the medication name in its original form. Translate the warnings faithfully - do not soften or drop any."""

LABEL_SCHEMA = {
    "type": "object",
    "properties": {
        "is_prescription_label": {"type": "boolean"},
        "medication_name": {"type": "string"},
        "strength": {"type": "string"},
        "dose_amount": {"type": "string", "description": "e.g. '1 tablet', '10 mL'"},
        "label_directions_verbatim": {"type": "string"},
        "schedule_type": {"type": "string", "enum": ["daily", "weekly", "as_needed", "other"]},
        "times_per_day": {"type": "integer"},
        "suggested_times": {"type": "array", "items": {"type": "string"}},
        "duration_days": {"type": "integer"},
        "take_with_food": {"type": "string", "enum": ["with_food", "empty_stomach", "either", "unknown"]},
        "warnings": {"type": "array", "items": {"type": "string"}},
        "patient_name": {"type": "string"},
        "prescriber": {"type": "string"},
        "pharmacy": {"type": "string"},
        "pharmacy_phone": {"type": "string"},
        "rx_number": {"type": "string"},
        "quantity": {"type": "string"},
        "refills": {"type": "string"},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        "unreadable_fields": {"type": "array", "items": {"type": "string"}},
        "translation": {
            "type": "object",
            "properties": {
                "language": {"type": "string"},
                "summary": {"type": "string", "description": "One or two sentences: what this medicine is and how to take it."},
                "how_to_take": {"type": "string"},
                "when_to_take": {"type": "string"},
                "warnings": {"type": "array", "items": {"type": "string"}},
                "reminder_title": {"type": "string", "description": "Short calendar title, e.g. 'Take 1 tablet of Amoxicillin'"},
                "disclaimer": {"type": "string", "description": "'Always confirm with your pharmacist or doctor.' in the target language"},
            },
            "required": ["language", "summary", "how_to_take", "when_to_take", "warnings", "reminder_title", "disclaimer"],
            "additionalProperties": False,
        },
    },
    "required": [
        "is_prescription_label", "medication_name", "strength", "dose_amount",
        "label_directions_verbatim", "schedule_type", "times_per_day", "suggested_times",
        "duration_days", "take_with_food", "warnings", "patient_name", "prescriber",
        "pharmacy", "pharmacy_phone", "rx_number", "quantity", "refills", "confidence",
        "unreadable_fields", "translation",
    ],
    "additionalProperties": False,
}

client = anthropic.AsyncAnthropic()
app = FastAPI(title="PillPal")


@app.post("/api/scan")
async def scan(image: UploadFile = File(...), language: str = Form("English")):
    if image.content_type not in ALLOWED_TYPES:
        raise HTTPException(400, "Please upload a JPEG, PNG, WEBP, or GIF image.")
    data = await image.read()
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "Image is too large (max 5 MB).")
    language = language.strip()[:40] or "English"

    try:
        response = await client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={
                "effort": "medium",
                "format": {"type": "json_schema", "schema": LABEL_SCHEMA},
            },
            system=SYSTEM_PROMPT,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": image.content_type,
                            "data": base64.standard_b64encode(data).decode("utf-8"),
                        },
                    },
                    {"type": "text", "text": f"Extract this prescription label. Target language for the translation: {language}."},
                ],
            }],
        )
    except anthropic.AuthenticationError:
        raise HTTPException(500, "Server is missing a valid ANTHROPIC_API_KEY.")
    except anthropic.RateLimitError:
        raise HTTPException(429, "Too many requests - try again in a moment.")
    except anthropic.APIStatusError as e:
        raise HTTPException(502, f"AI service error: {e.message}")
    except anthropic.APIConnectionError:
        raise HTTPException(502, "Could not reach the AI service.")

    if response.stop_reason == "refusal":
        raise HTTPException(422, "The label could not be processed. Please ask your pharmacist.")
    if response.stop_reason == "max_tokens":
        raise HTTPException(502, "The response was cut off - please try again.")

    text = next((b.text for b in response.content if b.type == "text"), None)
    if text is None:
        raise HTTPException(502, "No result returned - please try again.")
    return json.loads(text)


# Serve the frontend from the same origin (mounted last so /api routes win).
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
