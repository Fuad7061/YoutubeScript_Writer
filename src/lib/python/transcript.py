"""
Universal YouTube transcript -> structured JSON.
Tier 1: real YouTube captions (fast). Tier 2: yt-dlp audio + faster-whisper (any video).

Install:  pip install youtube-transcript-api yt-dlp faster-whisper
(ffmpeg recommended on PATH for widest audio-format support)

CLI Usage:
  python3 transcript.py <url> [allow_whisper=true] [whisper_model=small]
"""
import re, json, html, sys, urllib.parse, urllib.request
from youtube_transcript_api import (
    YouTubeTranscriptApi, NoTranscriptFound, TranscriptsDisabled,
    VideoUnavailable, CouldNotRetrieveTranscript,
)


class _NoCaptions(Exception):
    """Internal: captions truly unavailable -> trigger Whisper fallback."""


def video_id(url: str) -> str:
    m = re.search(r"(?:shorts/|watch\?v=|youtu\.be/|embed/|live/)([A-Za-z0-9_-]{11})", url)
    if not m:
        raise ValueError(f"Couldn't find a video ID in: {url}")
    return m.group(1)


def get_title(vid: str):
    api = "https://www.youtube.com/oembed?" + urllib.parse.urlencode(
        {"url": f"https://www.youtube.com/watch?v={vid}", "format": "json"})
    try:
        with urllib.request.urlopen(api, timeout=10) as r:
            return json.load(r).get("title")
    except Exception:
        return None


def hms(seconds: float) -> str:
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:d}:{s:02d}"


# ---------- Tier 1: real captions ----------

def _pick(tlist, prefer):
    if prefer:
        try:
            return tlist.find_transcript(list(prefer))
        except NoTranscriptFound:
            pass
    manual = [t for t in tlist if not t.is_generated]
    if manual:
        return manual[0]
    for t in tlist:
        return t
    raise NoTranscriptFound.__new__(NoTranscriptFound)


def _from_captions(vid, prefer, translate_to):
    try:
        tlist = YouTubeTranscriptApi().list(vid)
    except (NoTranscriptFound, TranscriptsDisabled):
        raise _NoCaptions
    available = [{"code": t.language_code, "name": t.language, "generated": t.is_generated}
                 for t in tlist]
    try:
        chosen = _pick(tlist, prefer)
    except NoTranscriptFound:
        raise _NoCaptions

    translated_to = None
    if translate_to and translate_to != chosen.language_code and chosen.is_translatable:
        try:
            chosen = chosen.translate(translate_to)
            translated_to = translate_to
        except Exception:
            pass

    caps = [{"start": round(s.start, 3), "dur": round(s.duration, 3),
             "text": html.unescape(s.text).replace("\n", " ").strip()} for s in chosen.fetch()]
    total = round(max((c["start"] + c["dur"] for c in caps), default=0.0), 3)
    return {
        "title": get_title(vid), "video_id": vid,
        "url": f"https://www.youtube.com/watch?v={vid}", "source": "captions",
        "language": chosen.language, "language_code": chosen.language_code,
        "is_generated": chosen.is_generated, "translated_to": translated_to,
        "available_languages": available, "duration_seconds": total, "duration": hms(total),
        "caption_count": len(caps), "transcript": " ".join(c["text"] for c in caps),
        "captions": caps,
    }


# ---------- Tier 2: Whisper fallback ----------

_WHISPER = {}


def _load_whisper(size):
    if size not in _WHISPER:
        from faster_whisper import WhisperModel
        try:
            import ctranslate2
            if ctranslate2.get_cuda_device_count() > 0:
                device, compute = "cuda", "float16"     # GPU
            else:
                device, compute = "cpu", "int8"         # optimized CPU
        except Exception:
            device, compute = "cpu", "int8"
        _WHISPER[size] = WhisperModel(size, device=device, compute_type=compute)
    return _WHISPER[size]


def _whisper_result(vid, title, duration_hint, src_lang, task, segments):
    caps = [{"start": round(s.start, 3), "dur": round(s.end - s.start, 3),
             "text": s.text.strip()} for s in segments]
    total = round(duration_hint or max((c["start"] + c["dur"] for c in caps), default=0.0), 3)
    if task == "translate":
        language, language_code, translated_to = f"{src_lang}->en (speech-to-text)", "en", "en"
    else:
        language, language_code, translated_to = f"{src_lang} (speech-to-text)", src_lang, None
    return {
        "title": title, "video_id": vid,
        "url": f"https://www.youtube.com/watch?v={vid}", "source": "whisper",
        "language": language, "language_code": language_code, "is_generated": True,
        "translated_to": translated_to, "available_languages": [],
        "duration_seconds": total, "duration": hms(total), "caption_count": len(caps),
        "transcript": " ".join(c["text"] for c in caps), "captions": caps,
    }


def _from_whisper(url, vid, translate_to, size):
    import yt_dlp, tempfile, os
    model = _load_whisper(size)
    with tempfile.TemporaryDirectory() as tmp:
        opts = {
            "format": "bestaudio/best",
            "outtmpl": os.path.join(tmp, "%(id)s.%(ext)s"),
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            audio_path = ydl.prepare_filename(info)
        task = "translate" if translate_to == "en" else "transcribe"
        segments, tinfo = model.transcribe(audio_path, beam_size=5, vad_filter=True, task=task)
        segments = list(segments)   # generator -> materialize
    return _whisper_result(vid, info.get("title"),
                           getattr(tinfo, "duration", None) or info.get("duration"),
                           tinfo.language, task, segments)


# ---------- Public entry point ----------

def transcript_json(url, prefer=("en",), translate_to=None,
                    whisper_model="small", allow_whisper=True) -> dict:
    vid = video_id(url)
    try:
        return _from_captions(vid, prefer, translate_to)      # Tier 1
    except _NoCaptions:
        pass
    except VideoUnavailable:
        return {"title": get_title(vid), "video_id": vid,
                "url": f"https://www.youtube.com/watch?v={vid}",
                "error": "VideoUnavailable", "captions": []}
    except CouldNotRetrieveTranscript:
        pass  # IP block etc. -> try Whisper as alternative

    if not allow_whisper:
        return {"title": get_title(vid), "video_id": vid,
                "url": f"https://www.youtube.com/watch?v={vid}",
                "error": "NoCaptionsAvailable", "captions": []}

    try:
        return _from_whisper(url, vid, translate_to, whisper_model)  # Tier 2
    except Exception as e:
        return {"title": get_title(vid), "video_id": vid,
                "url": f"https://www.youtube.com/watch?v={vid}",
                "error": f"WhisperFailed: {type(e).__name__}: {e}", "captions": []}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: transcript.py <url> [allow_whisper=true] [whisper_model=small]"}))
        sys.exit(1)

    url_arg = sys.argv[1]
    allow_whisper_arg = sys.argv[2].lower() != "false" if len(sys.argv) > 2 else True
    whisper_model_arg = sys.argv[3] if len(sys.argv) > 3 else "small"

    result = transcript_json(url_arg, allow_whisper=allow_whisper_arg, whisper_model=whisper_model_arg)
    # Write result to stdout as JSON
    print(json.dumps(result, ensure_ascii=False))
