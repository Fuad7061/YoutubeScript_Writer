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
    AgeRestricted, InvalidVideoId, VideoUnplayable,
)

# Errors that definitively mean the *video* cannot be played — no point
# retrying or falling back to Whisper.
# NOTE: VideoUnavailable from youtube-transcript-api on VPS IPs is often an
# IP-block masquerading as "video unavailable" (the watch-page HTML doesn't
# load so the library can't confirm the video exists). We intentionally leave
# VideoUnavailable OUT of this tuple so it falls through to yt-dlp, which uses
# impersonation + PO tokens and can often still fetch the video.
_HARD_CAPTION_ERRORS = (AgeRestricted, InvalidVideoId, VideoUnplayable)

# Chrome 150 fingerprint so YouTube sees requests that look like a real
# browser instead of a server (matters on VPS/datacenter egress IPs).
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36")

# Player clients in priority order. android, mweb, ios, and web are the most
# reliable clients for captions and audio streams on datacenter IPs.
_YDL_PLAYER_CLIENTS = os.environ.get(
    "YTDLP_PLAYER_CLIENTS", "android,mweb,ios,web").split(",")


def _ydl_opts(extra=None):
    """yt-dlp options that survive YouTube's bot checks from datacenter IPs."""
    pot_url = os.environ.get("POT_PROVIDER_URL", "http://127.0.0.1:4416/token")
    yt_args = {
        "player_client": _YDL_PLAYER_CLIENTS,
        "po_token": [
            f"web+{pot_url}",
            f"mweb+{pot_url}",
            f"android+{pot_url}",
            f"ios+{pot_url}",
        ],
    }
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "socket_timeout": 30,
        "retries": 5,
        "extractor_args": {"youtube": yt_args},
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
    try:
        from yt_dlp.networking.impersonate import ImpersonateTarget
        opts["impersonate"] = ImpersonateTarget("chrome")
    except Exception:
        opts.pop("impersonate", None)

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(url, download=download)
    except Exception as e:
        if "impersonate" in opts:
            opts.pop("impersonate", None)
            with yt_dlp.YoutubeDL(opts) as ydl:
                return ydl.extract_info(url, download=download)
        raise e


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

def _yt_cookie_header():
    """Build a `Cookie` header value from the saved Netscape cookies.txt.

    youtube-transcript-api's cookie auth is disabled upstream, so instead of
    loading the jar we inject the same browser cookies as a Cookie header. This
    makes the watch-page fetch look like a logged-in browser, which is what
    gets past "Sign in to confirm you're not a bot" on flagged datacenter IPs.
    """
    path = os.environ.get("YOUTUBE_COOKIES_PATH", "/data/youtube-cookies.txt")
    if not os.path.exists(path):
        return None
    pairs = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split("\t")
                if len(parts) < 7:
                    continue
                domain = parts[0]
                if "youtube.com" not in domain and "google.com" not in domain:
                    continue
                name, value = parts[5], parts[6]
                if name and value is not None:
                    pairs.append(f"{name}={value}")
    except Exception:
        return None
    return "; ".join(pairs) if pairs else None


def _transcript_api():
    """A YouTubeTranscriptApi that talks to YouTube like a real browser.

    The stock client uses plain `requests`, which YouTube connection-resets on
    datacenter IPs (Errno 104) before any content is served. curl_cffi
    (already in the venv for yt-dlp) impersonates Chrome's TLS fingerprint,
    and we add the saved browser cookies on top. Falls back to the stock
    client if curl_cffi or the http_client kwarg isn't available.
    """
    try:
        from curl_cffi.requests import Session as CurlSession
        sess = CurlSession(impersonate="chrome", timeout=30)
        sess.headers.update({
            "accept-language": "en-US,en;q=0.9",
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        })
        cookie_header = _yt_cookie_header()
        if cookie_header:
            sess.headers["cookie"] = cookie_header
        return YouTubeTranscriptApi(http_client=sess)
    except Exception:
        return YouTubeTranscriptApi()


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
    # Connection resets (Errno 104) and library request errors are NOT wrapped
    # as CouldNotRetrieveTranscript, so they must be caught explicitly here or
    # they'd crash the whole script instead of falling through to yt-dlp.
    last_err = None
    tlist = None
    for attempt in range(retries):
        try:
            tlist = _transcript_api().list(vid)
            break
        except (NoTranscriptFound, TranscriptsDisabled):
            raise _NoCaptions
        except _HARD_CAPTION_ERRORS:
            raise
        except CouldNotRetrieveTranscript as e:
            # IpBlocked / RequestBlocked / PoTokenRequired / ... -> blocked IP
            # or token-required video. Retry, then fall through to yt-dlp which
            # has the PO token provider + cookies.
            last_err = e
        except Exception as e:
            # requests.exceptions.ConnectionError, urllib3 ProtocolError, etc.
            # — the "connection reset by peer" signature of a flagged IP.
            last_err = e
        if attempt < retries - 1:
            time.sleep(2 * (attempt + 1))
    if tlist is None:
        print(f"[transcript] Tier 1 (transcript API) failed after {retries} attempts: "
              f"{type(last_err).__name__}: {last_err}", file=sys.stderr)
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

    # Subtitle files are hosted on YouTube's timedtext CDN which also
    # bot-checks TLS fingerprints from datacenter IPs. Use curl_cffi Chrome
    # impersonation when available, fall back to plain urllib.
    raw = _fetch_vtt(url2)

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

def _fetch_vtt(url2: str) -> str:
    """Fetch a VTT/subtitle URL using Chrome TLS impersonation when available.

    YouTube's timedtext CDN endpoints perform TLS fingerprint checks on VPS
    datacenter IP ranges (same bot-check as the main site). curl_cffi's Chrome
    impersonation bypasses this. Falls back to plain urllib when curl_cffi is
    not installed.
    """
    headers = {
        "user-agent": BROWSER_UA,
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "referer": "https://www.youtube.com/",
    }
    try:
        from curl_cffi.requests import get as curl_get
        resp = curl_get(url2, headers=headers, impersonate="chrome", timeout=30)
        resp.raise_for_status()
        return resp.text
    except ImportError:
        pass  # curl_cffi not installed — fall back to urllib
    except Exception as e:
        print(f"[transcript] curl_cffi VTT fetch failed: {type(e).__name__}: {e}", file=sys.stderr)
        # Fall through to urllib for one more attempt

    req = urllib.request.Request(url2, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read().decode("utf-8", "replace")
    except Exception as e:
        print(f"[transcript] urllib VTT fetch also failed: {type(e).__name__}: {e}", file=sys.stderr)
        raise _NoCaptions


def _parse_vtt(raw):
    """Parse WebVTT, SRT, or JSON3 caption payloads into [{start, dur, text}]."""
    raw_str = raw.strip()
    if raw_str.startswith("{") or raw_str.startswith("["):
        try:
            data = json.loads(raw_str)
            events = data.get("events") if isinstance(data, dict) else data
            caps = []
            for ev in (events if isinstance(events, list) else []):
                start = (ev.get("tStartMs") or 0) / 1000.0
                dur = (ev.get("dDurationMs") or 0) / 1000.0
                segs = ev.get("segs") or []
                text = "".join(s.get("utf8", "") for s in segs)
                text = re.sub(r"<[^>]+>", "", text)
                text = html.unescape(text).replace("\n", " ").strip()
                if text:
                    caps.append({"start": round(start, 3), "dur": round(max(dur, 0.1), 3), "text": text})
            if caps:
                return caps
        except Exception:
            pass

    caps = []
    blocks = re.split(r"\n\s*\n", raw_str)
    time_re = re.compile(
        r"(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})?\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})?"
    )
    def _ts(h, m, s, ms):
        return int(h) * 3600 + int(m) * 60 + int(s) + (int(ms or 0) / (10 ** len(ms or "0")))

    for block in blocks:
        lines = [l.strip() for l in block.splitlines() if l.strip()]
        if not lines:
            continue
        time_idx = -1
        m = None
        for idx, line in enumerate(lines):
            m = time_re.search(line)
            if m:
                time_idx = idx
                break
        if not m or time_idx == -1:
            continue

        start = _ts(*m.groups()[:4])
        end = _ts(*m.groups()[4:])
        text_lines = lines[time_idx + 1:]
        text = " ".join(text_lines)
        text = re.sub(r"<[^>]+>", "", text)
        text = html.unescape(text).replace("\n", " ").strip()
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


def _fetch_external_api_subtitles(url, vid, prefer):
    """Fetch captions via 3rd party APIs (Snapany / Snapscooper) when YouTube bot-checks the server IP."""
    print(f"[transcript] Tier 1c: attempting 3rd-party API fallback for {vid}…", file=sys.stderr)

    # 1. Snapany API
    headers_snapany = {
        "accept": "*/*",
        "accept-language": "en",
        "content-type": "application/json",
        "g-footer": os.environ.get("SNAPANY_G_FOOTER", "2f709202d3c3805991cc8714f6887fd263a70f6584519f07f2559bc0a42d1ddf"),
        "g-timestamp": os.environ.get("SNAPANY_G_TIMESTAMP", "1786207681596"),
        "g-timezone": "Asia/Dhaka",
        "origin": "https://snapany.com",
        "referer": "https://snapany.com/",
        "user-agent": BROWSER_UA,
    }
    try:
        from curl_cffi.requests import post as curl_post
        res = curl_post(
            "https://api.snapany.com/v1/extract/subtitles",
            json={"url": f"https://www.youtube.com/watch?v={vid}"},
            headers=headers_snapany,
            impersonate="chrome",
            timeout=15,
        )
        if res.status_code == 200:
            data = res.json()
            sub_tracks = data.get("subtitles") or []
            if sub_tracks:
                track = sub_tracks[0]
                for t in sub_tracks:
                    lang = (t.get("language_tag") or "").lower()
                    if lang == "en" or lang.startswith("en"):
                        track = t
                        break
                urls = track.get("urls") or []
                item = next((u for u in urls if u.get("format") in ("srt", "vtt", "json3")), None) or (urls[0] if urls else None)
                sub_url = item.get("url") if isinstance(item, dict) else item
                if sub_url:
                    raw_sub = _fetch_vtt(sub_url)
                    caps = _parse_vtt(raw_sub)
                    if caps:
                        total = round(max((c["start"] + c["dur"] for c in caps), default=0.0), 3)
                        chosen_name = track.get("language_name") or "English"
                        chosen_tag = track.get("language_tag") or "en"
                        print("[transcript] Tier 1c (Snapany API): success", file=sys.stderr)
                        return {
                            "title": data.get("title") or get_title(vid),
                            "video_id": vid,
                            "url": f"https://www.youtube.com/watch?v={vid}",
                            "source": "snapany-captions",
                            "language": chosen_name,
                            "language_code": chosen_tag,
                            "is_generated": "auto-generated" in chosen_name.lower(),
                            "translated_to": None,
                            "available_languages": [
                                {"code": t.get("language_tag"), "name": t.get("language_name"), "generated": "auto-generated" in t.get("language_name", "").lower()}
                                for t in sub_tracks if t.get("language_tag")
                            ],
                            "duration_seconds": total,
                            "duration": hms(total),
                            "caption_count": len(caps),
                            "transcript": " ".join(c["text"] for c in caps),
                            "captions": caps,
                        }
        else:
            print(f"[transcript] Tier 1c Snapany returned status {res.status_code}", file=sys.stderr)
    except Exception as e:
        print(f"[transcript] Tier 1c Snapany exception: {e}", file=sys.stderr)

    # 2. Snapscooper API fallback
    headers_scooper = {
        "accept": "application/json",
        "accept-language": "en-US,en;q=0.9",
        "content-type": "application/json",
        "origin": "https://snapscooper.com",
        "referer": "https://snapscooper.com/tools/yt1",
        "user-agent": BROWSER_UA,
    }
    try:
        from curl_cffi.requests import post as curl_post
        res = curl_post(
            "https://snapscooper.com/api/tool/post-info",
            json={"toolId": "youtube", "url": f"https://www.youtube.com/watch?v={vid}", "highres": False},
            headers=headers_scooper,
            impersonate="chrome",
            timeout=15,
        )
        if res.status_code == 200:
            data = res.json()
            sub_tracks = data.get("subtitles") or data.get("captions") or []
            if sub_tracks:
                track = sub_tracks[0]
                for t in sub_tracks:
                    lang = (t.get("language_tag") or t.get("lang") or "").lower()
                    if lang == "en" or lang.startswith("en"):
                        track = t
                        break
                urls = track.get("urls") or []
                item = next((u for u in urls if u.get("format") in ("srt", "vtt", "json3")), None) or (urls[0] if urls else None)
                sub_url = item.get("url") if isinstance(item, dict) else item
                if sub_url:
                    raw_sub = _fetch_vtt(sub_url)
                    caps = _parse_vtt(raw_sub)
                    if caps:
                        total = round(max((c["start"] + c["dur"] for c in caps), default=0.0), 3)
                        print("[transcript] Tier 1c (Snapscooper API): success", file=sys.stderr)
                        return {
                            "title": data.get("title") or get_title(vid),
                            "video_id": vid,
                            "url": f"https://www.youtube.com/watch?v={vid}",
                            "source": "snapscooper-captions",
                            "language": track.get("language_name", "English"),
                            "language_code": track.get("language_tag", "en"),
                            "is_generated": True,
                            "translated_to": None,
                            "available_languages": [],
                            "duration_seconds": total,
                            "duration": hms(total),
                            "caption_count": len(caps),
                            "transcript": " ".join(c["text"] for c in caps),
                            "captions": caps,
                        }
        else:
            print(f"[transcript] Tier 1c Snapscooper returned status {res.status_code}", file=sys.stderr)
    except Exception as e:
        print(f"[transcript] Tier 1c Snapscooper exception: {e}", file=sys.stderr)

    raise _NoCaptions


# ---------- Public entry point ----------

def transcript_json(url, prefer=("en",), translate_to=None,
                    whisper_model="small", allow_whisper=True) -> dict:
    vid = video_id(url)

    # ── Tier 1: youtube-transcript-api (fast, real captions) ────────────────────
    try:
        return _from_captions(vid, prefer, translate_to)
    except _NoCaptions:
        print("[transcript] Tier 1: no captions found, trying yt-dlp subtitles…",
              file=sys.stderr)
    except _HARD_CAPTION_ERRORS as e:
        # AgeRestricted / InvalidVideoId / VideoUnplayable — genuine hard stops.
        return {"title": get_title(vid), "video_id": vid,
                "url": f"https://www.youtube.com/watch?v={vid}",
                "error": type(e).__name__, "captions": []}
    except VideoUnavailable as e:
        # On VPS IPs, youtube-transcript-api raises VideoUnavailable when the
        # watch-page HTML fetch is blocked (TLS fingerprint check fails, so it
        # looks like the video doesn't exist). Fall through to yt-dlp which
        # uses curl_cffi impersonation + PO tokens to bypass this.
        print(f"[transcript] Tier 1 VideoUnavailable (likely IP-blocked, not real): {e}"
              f" — trying yt-dlp…", file=sys.stderr)
    except Exception as e:
        # Unexpected — never crash the workflow; fall through to yt-dlp.
        print(f"[transcript] Tier 1 unexpected error: {type(e).__name__}: {e}",
              file=sys.stderr)

    # ── Tier 1b: yt-dlp subtitle endpoints ───────────────────────────────
    # Uses TV/embedded player clients + curl_cffi Chrome impersonation.
    # Much more robust on flagged VPS IPs than the transcript API.
    try:
        result = _fetch_subtitles(url, vid, prefer)
        print("[transcript] Tier 1b (yt-dlp subtitles): success", file=sys.stderr)
        return result
    except _NoCaptions:
        print("[transcript] Tier 1b: no subtitles available…",
              file=sys.stderr)
    except Exception as e:
        print(f"[transcript] Tier 1b error: {type(e).__name__}: {e}",
              file=sys.stderr)

    # ── Tier 1c: 3rd-party API Fallback (Snapany / Snapscooper) ───────────
    # Uses external pre-signed timedtext URLs signed with ip=0.0.0.0.
    try:
        return _fetch_external_api_subtitles(url, vid, prefer)
    except _NoCaptions:
        print("[transcript] Tier 1c (3rd-party API fallback): no subtitles returned.", file=sys.stderr)
    except Exception as e:
        print(f"[transcript] Tier 1c error: {type(e).__name__}: {e}", file=sys.stderr)

    # ── Tier 2: Whisper (audio transcription) ────────────────────────────
    # Works for any video regardless of caption availability or IP blocking.
    if not allow_whisper:
        return {"title": get_title(vid), "video_id": vid,
                "url": f"https://www.youtube.com/watch?v={vid}",
                "error": "NoCaptionsAvailable", "captions": []}

    print("[transcript] Tier 2: falling back to Whisper transcription…", file=sys.stderr)
    try:
        return _from_whisper(url, vid, translate_to, whisper_model)
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
