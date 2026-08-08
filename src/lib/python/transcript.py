"""
Universal YouTube transcript -> structured JSON.
Tier 1: real YouTube captions (fast). Tier 2: yt-dlp audio + faster-whisper (any video).

Install:  pip install youtube-transcript-api yt-dlp curl_cffi faster-whisper
(ffmpeg recommended on PATH for widest audio-format support)
curl_cffi enables browser TLS impersonation, which keeps YouTube from
bot-blocking datacenter/VPS egress IPs.

CLI Usage:
  python3 transcript.py <url> [allow_whisper=true] [whisper_model=small]
"""
import os, re, json, html, sys, time, urllib.parse, urllib.request
from youtube_transcript_api import (
    YouTubeTranscriptApi, NoTranscriptFound, TranscriptsDisabled,
    VideoUnavailable, CouldNotRetrieveTranscript,
)

# Chrome 150 fingerprint so YouTube sees requests that look like a real
# browser instead of a server (matters on VPS/datacenter egress IPs).
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36")

# Player clients in priority order. `web` is listed first: when YouTube
# cookies are configured this client tends to be the most reliable. The others
# are tried as fallbacks. Override via YTDLP_PLAYER_CLIENTS env var.
_YDL_PLAYER_CLIENTS = os.environ.get(
    "YTDLP_PLAYER_CLIENTS", "web,web_embedded,tv_embedded,tv,android_vr").split(",")


def _ydl_opts(extra=None):
    """yt-dlp options that survive YouTube's bot checks from datacenter IPs."""
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "socket_timeout": 30,
        "retries": 5,
        "extractor_args": {"youtube": {"player_client": _YDL_PLAYER_CLIENTS}},
    }
    # YouTube cookies (Netscape cookies.txt) — when present, yt-dlp sends them so
    # YouTube sees a logged-in, verified session. The most reliable way to pass
    # the "Sign in to confirm you're not a bot" check on a flagged datacenter IP.
    # Python's http.cookiejar is strict: every domain column must start with ".".
    cookies_path = os.environ.get("YOUTUBE_COOKIES_PATH", "/data/youtube-cookies.txt")
    if os.path.exists(cookies_path):
        try:
            with open(cookies_path, "r", encoding="utf-8", errors="replace") as fh:
                body = fh.read()
            data_lines = [l for l in body.split("\n") if l.strip() and not l.startswith("#")]
            well_formed = data_lines and all("\t" in l and l.split("\t")[0].startswith(".") for l in data_lines)
            if well_formed:
                opts["cookiefile"] = cookies_path
            else:
                print(f"[transcript] WARNING: {cookies_path} is not in valid Netscape format "
                      f"(domain column must start with '.youtube.com') — skipping cookies. "
                      f"Re-export from your browser and re-paste in Settings.", file=sys.stderr)
        except Exception as e:
            print(f"[transcript] WARNING: could not read cookies: {e}", file=sys.stderr)
    if extra:
        opts.update(extra)
    return opts


def _extract_ydl(opts, url, download=False):
    """yt-dlp extract_info with browser TLS impersonation (curl_cffi).

    Falls back to plain HTTPS when curl_cffi isn't installed in the venv.
    """
    import yt_dlp
    opts = dict(opts)
    opts["impersonate"] = "chrome"
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(url, download=download)
    except Exception:
        opts.pop("impersonate", None)
        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(url, download=download)


class _NoCaptions(Exception):
    """Internal: captions truly unavailable -> trigger Whisper fallback."""


def video_id(url: str) -> str:
    try:
        parsed = urllib.parse.urlparse(url)
        v = urllib.parse.parse_qs(parsed.query).get("v")
        if v:
            m = re.fullmatch(r"[A-Za-z0-9_-]{11}", v[0])
            if m:
                return m.group(0)
    except ValueError:
        pass
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


def _from_captions(vid, prefer, translate_to, retries=3):
    # youtube-transcript-api can get transiently throttled (429 / IP-based
    # rate limits on datacenter IPs). Retry with backoff before giving up.
    last_err = None
    tlist = None
    for attempt in range(retries):
        try:
            tlist = YouTubeTranscriptApi().list(vid)
            break
        except (NoTranscriptFound, TranscriptsDisabled):
            raise _NoCaptions
        except CouldNotRetrieveTranscript as e:
            last_err = e
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
    if tlist is None:
        # VPS/datacenter egress IPs are usually hard-blocked on this endpoint
        # while the same call succeeds with a browser TLS fingerprint
        # (curl_cffi impersonation). Try that once before falling through.
        try:
            tlist = YouTubeTranscriptApi(impersonate=True).list(vid)
        except TypeError:
            raise last_err          # installed version lacks impersonate support
        except (NoTranscriptFound, TranscriptsDisabled):
            raise _NoCaptions
        except CouldNotRetrieveTranscript as e:
            raise e
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


# ---------- Tier 1b: yt-dlp subtitles (works when the transcript API is blocked) ----------

def _fetch_subtitles(url, vid, prefer):
    """Fetch captions via yt-dlp's subtitle endpoints (no audio download).

    YouTube often throttles the youtube-transcript-api endpoints from
    datacenter IPs while the yt-dlp player/subtitle endpoints still work,
    so this is a cheap second shot at real captions before Whisper. Uses
    TV/embedded player clients + browser TLS impersonation (curl_cffi),
    which look like a real browser to YouTube.
    """
    langs = [l for l in prefer if isinstance(l, str)] + ["en", "en-US", "en-orig"]
    opts = _ydl_opts({
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": langs,
        "subtitlesformat": "vtt/best",
    })
    info = _extract_ydl(opts, url)
    if not info:
        raise _NoCaptions

    subs = info.get("requested_subtitles") or {}
    if not subs:
        all_subs = {**(info.get("subtitles") or {}), **(info.get("automatic_captions") or {})}
        if not all_subs:
            raise _NoCaptions
        langs_in_order = [l for l in langs if l in all_subs] + \
                         [l for l in all_subs if l not in langs]
        subs = {l: all_subs[l] for l in langs_in_order[:1]}

    chosen_lang = next(iter(subs))
    fmt = subs[chosen_lang]
    url2 = None
    if isinstance(fmt, dict):
        # single format: {"ext": "vtt", "url": "..."}
        url2 = fmt.get("url")
        if not url2:
            for f in fmt.values():
                if isinstance(f, dict) and f.get("url"):
                    url2 = f["url"]
                    break
                if isinstance(f, str):
                    url2 = f
                    break
    else:
        # list of formats (older yt-dlp shape)
        for f in fmt:
            if isinstance(f, str):
                url2 = f
                break
            if f.get("ext") == "vtt" or f.get("url", "").endswith(".vtt"):
                url2 = f.get("url")
                break
            if f.get("url"):
                url2 = f["url"]
                break
    if not url2:
        raise _NoCaptions

    # Subtitle files are hosted on YouTube's own endpoints (timedtext),
    # which also bot-check server fingerprints — fetch like a browser.
    req = urllib.request.Request(url2, headers={
        "user-agent": BROWSER_UA,
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "referer": "https://www.youtube.com/",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read().decode("utf-8", "replace")

    caps = _parse_vtt(raw)
    if not caps:
        raise _NoCaptions
    total = round(max((c["start"] + c["dur"] for c in caps), default=0.0), 3)
    is_generated = chosen_lang in (info.get("automatic_captions") or {})
    return {
        "title": info.get("title") or get_title(vid), "video_id": vid,
        "url": f"https://www.youtube.com/watch?v={vid}", "source": "ytdlp-captions",
        "language": chosen_lang, "language_code": chosen_lang,
        "is_generated": is_generated, "translated_to": None,
        "available_languages": sorted(set(
            list((info.get("subtitles") or {}).keys()) +
            list((info.get("automatic_captions") or {}).keys()))),
        "duration_seconds": total, "duration": hms(total),
        "caption_count": len(caps), "transcript": " ".join(c["text"] for c in caps),
        "captions": caps,
    }


def _parse_vtt(raw):
    """Parse a WebVTT/SRT payload into [{start, dur, text}]."""
    caps = []
    blocks = re.split(r"\n\s*\n", raw)
    time_re = re.compile(
        r"(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})?\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})?")
    def _ts(h, m, s, ms):
        return int(h) * 3600 + int(m) * 60 + int(s) + (int(ms or 0) / (10 ** len(ms or "0")))
    for block in blocks:
        lines = [l for l in block.splitlines() if l.strip()]
        if len(lines) < 2:
            continue
        m = time_re.search(lines[0])
        if not m:
            continue
        start = _ts(*m.groups()[:4])
        end = _ts(*m.groups()[4:])
        text = " ".join(lines[1:])
        text = re.sub(r"<[^>]+>", "", text)
        text = html.unescape(text).replace("\n", " ").strip()
        text = re.sub(r"\[[^\]]*\]", "", text).strip()  # yt auto-subs tags like [Music]
        if text:
            caps.append({"start": round(start, 3), "dur": round(max(end - start, 0.1), 3), "text": text})
    return caps


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
    import tempfile, os
    model = _load_whisper(size)
    with tempfile.TemporaryDirectory() as tmp:
        opts = _ydl_opts({
            "format": "bestaudio/best",
            "outtmpl": os.path.join(tmp, "%(id)s.%(ext)s"),
        })
        info = _extract_ydl(opts, url, download=True)
        dls = info.get("requested_downloads") or []
        audio_path = dls[0].get("filepath") if dls else None
        if not audio_path:
            audio_path = os.path.join(tmp, f"{vid}.{info.get('ext') or 'webm'}")
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
        pass  # IP block etc. -> try yt-dlp subtitles, then Whisper as alternative

    try:
        return _fetch_subtitles(url, vid, prefer)             # Tier 1b: yt-dlp
    except _NoCaptions:
        pass
    except Exception as e:
        # yt-dlp failure (no subs, endpoint blocked, etc.) -> Whisper fallback
        pass

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
