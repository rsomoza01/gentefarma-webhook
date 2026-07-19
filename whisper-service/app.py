"""Whisper local transcription microservice."""
import os
import tempfile
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse
import faster_whisper

app = FastAPI(title="Whisper Local Transcription")

# Model configuration — use SMALL for good quality + reasonable speed
MODEL_SIZE = os.getenv("WHISPER_MODEL", "small")
# Download model on startup
print(f"⬇️  Loading Whisper model: {MODEL_SIZE}")
model = None

def get_model():
    global model
    if model is None:
        model = faster_whisper.WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
    return model

@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL_SIZE}

@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    """Transcribe an audio file and return the text."""
    if not file:
        raise HTTPException(status_code=400, detail="No file provided")

    # Read file
    audio_bytes = await file.read()

    # Write to temp file (faster-whisper needs a path)
    suffix = Path(file.filename).suffix if file.filename else ".ogg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        model_instance = get_model()
        segments, info = model_instance.transcribe(
            tmp_path,
            language="es",
            task="transcribe",
            beam_size=5,
            vad_filter=True,
        )

        # Collect all segments
        text_parts = []
        for segment in segments:
            text_parts.append(segment.text.strip())

        full_text = " ".join(text_parts).strip()

        return JSONResponse({
            "text": full_text,
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration,
        })
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")
    finally:
        # Clean up temp file
        Path(tmp_path).unlink(missing_ok=True)


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
