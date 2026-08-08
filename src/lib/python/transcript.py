"""
Universal YouTube transcript -> structured JSON.
Tier 1: real YouTube captions (fast). Tier 2: yt-dlp audio + faster-whisper (any video).

Install:  pip install youtube-transcript-api yt-dlp curl_cffi faster-whisper
(ffmpeg recommended on PATH for widest audio-format support)

CLI Usage:
  python3 transcript.py <url> [allow_whisper=true] [whisper_model=small] [proxy_url]
"""
import os, re, json, html, sys, time, urllib.parse, urllib.request
from youtube_transcript_api import (
    YouTubeTranscriptApi, NoTranscriptFound, TranscriptsDisabled,
    VideoUnavailable, CouldNotRetrieveTranscript,
    AgeRestricted, InvalidVideoId, VideoUnplayable,
)

_HARD_CAPTION_ERRORS = (AgeRestricted, InvalidVideoId, VideoUnplayable)

BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36")

_YDL_PLAYER_CLIENTS = os.environ.get(
    "YTDLP_PLAYER_CLIENTS", "android,mweb,ios,web").split(",")


def get_proxy():
    """Get YouTube HTTP/HTTPS proxy from CLI args or environment variables."""
    if len(sys.argv) > 4 and sys.argv[4].strip():
        return sys.argv[4].strip()
    return (
        os.environ.get("YOUTUBE_PROXY")
        or os.environ.get("HTTPS_PROXY")
        or os.environ.get("HTTP_PROXY")
        or ""
    ).strip()


def _ydl_opts(extra=None, proxy=None):
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
    if proxy:
        opts["proxy"] = proxy

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
                      f"(domain column must start with '.youtube.com') — skipping cookies.", file=sys.stderr)
        except Exception as e:
            print(f"[transcript] WARNING: could not read cookies: {e}", file=sys.stderr)
    if extra:
        opts.update(extra)
    return opts


def _extract_ydl(opts, url, download=False):
    """yt-dlp extract_info with browser TLS impersonation (curl_cffi)."""
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


def get_title(vid: str, proxy=None):
    api = "https://www.youtube.com/oembed?" + urllib.parse.urlencode(
        {"url": f"https://www.youtube.com/watch?v={vid}", "format": "json"})
    try:
        if proxy:
            from curl_cffi.requests import get as curl_get
            r = curl_get(api, proxies={"http": proxy, "https": proxy}, impersonate="chrome", timeout=10)
            if r.status_code == 200:
                return r.json().get("title")
        req = urllib.request.Request(api, headers={"user-agent": BROWSER_UA})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r).get("title")
    except Exception:
        return None


def hms(seconds: float) -> str:
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:d}:{s:02d}"


# ---------- Tier 1: real captions ----------

def _yt_cookie_header():
    """Build a `Cookie` header value from the saved Netscape cookies.txt."""
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


def _transcript_api(proxy=None):
    """A YouTubeTranscriptApi that talks to YouTube like a real browser."""
    try:
        from curl_cffi.requests import Session as CurlSession
        sess = CurlSession(impersonate="chrome", timeout=30)
        sess.headers.update({
            "accept-language": "en-US,en;q=0.9",
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        })
        if proxy:
            sess.proxies = {"http": proxy, "https": proxy}
        cookie_header = _yt_cookie_header()
        if cookie_header:
            sess.headers["cookie"] = cookie_header
        try:
            return YouTubeTranscriptApi(http_client=sess, proxy=proxy) if proxy else YouTubeTranscriptApi(http_client=sess)
        except TypeError:
            return YouTubeTranscriptApi(http_client=sess)
    except Exception:
        if proxy:
            try:
                return YouTubeTranscriptApi(proxy=proxy)
            except TypeError:
                pass
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


def _from_captions(vid, prefer, translate_to, retries=3, proxy=None):
    last_err = None
    tlist = None
    api = _transcript_api(proxy=proxy)
    for attempt in range(retries):
        try:
            tlist = api.list(vid)
            break
        except (NoTranscriptFound, TranscriptsDisabled):
            raise _NoCaptions
        except _HARD_CAPTION_ERRORS:
            raise
        except CouldNotRetrieveTranscript as e:
            last_err = e
        except Exception as e:
            last_err = e
        if attempt < retries - 1:
            time.sleep(1.5 * (attempt + 1))
    if tlist is None:
        print(f"[transcript] Tier 1 (transcript API{' via proxy' if proxy else ''}) failed: "
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
        "title": get_title(vid, proxy=proxy), "video_id": vid,
        "url": f"https://www.youtube.com/watch?v={vid}", "source": f"captions{' (proxy)' if proxy else ''}",
        "language": chosen.language, "language_code": chosen.language_code,
        "is_generated": chosen.is_generated, "translated_to": translated_to,
        "available_languages": available, "duration_seconds": total, "duration": hms(total),
        "caption_count": len(caps), "transcript": " ".join(c["text"] for c in caps),
        "captions": caps,
    }


# ---------- Tier 1b: yt-dlp subtitles ----------

def _fetch_subtitles(url, vid, prefer, proxy=None):
    langs = [l for l in prefer if isinstance(l, str)] + ["en", "en-US", "en-orig"]
    opts = _ydl_opts({
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": langs,
        "subtitlesformat": "vtt/best",
    }, proxy=proxy)
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

    raw = _fetch_vtt(url2, proxy=proxy)
    caps = _parse_vtt(raw)
    if not caps:
        raise _NoCaptions
    total = round(max((c["start"] + c["dur"] for c in caps), default=0.0), 3)
    is_generated = chosen_lang in (info.get("automatic_captions") or {})
    return {
        "title": info.get("title") or get_title(vid, proxy=proxy), "video_id": vid,
        "url": f"https://www.youtube.com/watch?v={vid}", "source": f"ytdlp-captions{' (proxy)' if proxy else ''}",
        "language": chosen_lang, "language_code": chosen_lang,
        "is_generated": is_generated, "translated_to": None,
        "available_languages": sorted(set(
            list((info.get("subtitles") or {}).keys()) +
            list((info.get("automatic_captions") or {}).keys()))),
        "duration_seconds": total, "duration": hms(total),
        "caption_count": len(caps), "transcript": " ".join(c["text"] for c in caps),
        "captions": caps,
    }


def _fetch_vtt(url2: str, proxy=None) -> str:
    headers = {
        "user-agent": BROWSER_UA,
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "referer": "https://www.youtube.com/",
    }
    try:
        from curl_cffi.requests import get as curl_get
        proxies = {"http": proxy, "https": proxy} if proxy else None
        resp = curl_get(url2, headers=headers, proxies=proxies, impersonate="chrome", timeout=30)
        resp.raise_for_status()
        return resp.text
    except Exception as e:
        print(f"[transcript] VTT fetch failed: {type(e).__name__}: {e}", file=sys.stderr)

    if proxy:
        handler = urllib.request.ProxyHandler({"http": proxy, "https": proxy})
        opener = urllib.request.build_opener(handler)
        req = urllib.request.Request(url2, headers=headers)
        try:
            with opener.open(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except Exception:
            raise _NoCaptions

    req = urllib.request.Request(url2, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read().decode("utf-8", "replace")
    except Exception:
        raise _NoCaptions


def _parse_vtt(raw):
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
                device, compute = "cuda", "float16"
            else:
                device, compute = "cpu", "int8"
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


def _from_whisper(url, vid, translate_to, size, proxy=None):
    import tempfile, os
    model = _load_whisper(size)
    with tempfile.TemporaryDirectory() as tmp:
        opts = _ydl_opts({
            "format": "bestaudio/best",
            "outtmpl": os.path.join(tmp, "%(id)s.%(ext)s"),
        }, proxy=proxy)
        info = _extract_ydl(opts, url, download=True)
        dls = info.get("requested_downloads") or []
        audio_path = dls[0].get("filepath") if dls else None
        if not audio_path:
            audio_path = os.path.join(tmp, f"{vid}.{info.get('ext') or 'webm'}")
        task = "translate" if translate_to == "en" else "transcribe"
        segments, tinfo = model.transcribe(audio_path, beam_size=5, vad_filter=True, task=task)
        segments = list(segments)
    return _whisper_result(vid, info.get("title"),
                           getattr(tinfo, "duration", None) or info.get("duration"),
                           tinfo.language, task, segments)


# ---------- Public entry point ----------

def transcript_json(url, prefer=("en",), translate_to=None,
                    whisper_model="small", allow_whisper=True, proxy_url=None) -> dict:
    vid = video_id(url)
    proxy = proxy_url or get_proxy()
    ip_blocked = False

    # ── 1. Direct Attempt (without proxy) ──────────────────────────────────
    try:
        result = _from_captions(vid, prefer, translate_to, proxy=None)
        print("[transcript] Tier 1 (direct captions): success", file=sys.stderr)
        return result
    except _NoCaptions:
        print("[transcript] Tier 1 (direct): no captions found, trying yt-dlp subtitles…", file=sys.stderr)
    except _HARD_CAPTION_ERRORS as e:
        return {"title": get_title(vid), "video_id": vid,
                "url": f"https://www.youtube.com/watch?v={vid}",
                "error": type(e).__name__, "captions": []}
    except VideoUnavailable as e:
        print(f"[transcript] Tier 1 VideoUnavailable (direct): {e} — trying yt-dlp…", file=sys.stderr)
        ip_blocked = True
    except Exception as e:
        err_str = str(e).lower()
        if any(k in err_str for k in ("ip", "block", "429", "sign in", "bot")):
            ip_blocked = True
        print(f"[transcript] Tier 1 error (direct): {type(e).__name__}: {e}", file=sys.stderr)

    try:
        result = _fetch_subtitles(url, vid, prefer, proxy=None)
        print("[transcript] Tier 1b (yt-dlp direct subtitles): success", file=sys.stderr)
        return result
    except _NoCaptions:
        print("[transcript] Tier 1b (direct): no subtitles available…", file=sys.stderr)
    except Exception as e:
        err_str = str(e).lower()
        if any(k in err_str for k in ("ip", "block", "429", "sign in", "bot")):
            ip_blocked = True
        print(f"[transcript] Tier 1b error (direct): {type(e).__name__}: {e}", file=sys.stderr)

    # ── 2. Proxy Fallback (if IP blocked / direct failed AND proxy is set) ──────
    if proxy:
        safe_proxy = proxy.split("@")[-1]
        print(f"[transcript] Direct attempt encountered IP blocks / missing captions. Retrying via Proxy ({safe_proxy})…", file=sys.stderr)

        # Retry Tier 1 via Proxy
        try:
            result = _from_captions(vid, prefer, translate_to, proxy=proxy)
            print("[transcript] Tier 1 (via proxy): success", file=sys.stderr)
            return result
        except Exception as e:
            print(f"[transcript] Tier 1 (via proxy) error: {type(e).__name__}: {e}", file=sys.stderr)

        # Retry Tier 1b via Proxy
        try:
            result = _fetch_subtitles(url, vid, prefer, proxy=proxy)
            print("[transcript] Tier 1b (via proxy): success", file=sys.stderr)
            return result
        except Exception as e:
            print(f"[transcript] Tier 1b (via proxy) error: {type(e).__name__}: {e}", file=sys.stderr)

    # ── 3. Tier 2: Whisper Audio Transcription Fallback ───────────────────
    if not allow_whisper:
        return {"title": get_title(vid), "video_id": vid,
                "url": f"https://www.youtube.com/watch?v={vid}",
                "error": "NoCaptionsAvailable", "captions": []}

    print("[transcript] Tier 2: falling back to Whisper audio transcription…", file=sys.stderr)
    try:
        return _from_whisper(url, vid, translate_to, whisper_model, proxy=proxy if (proxy and ip_blocked) else None)
    except Exception as e:
        return {"title": get_title(vid), "video_id": vid,
                "url": f"https://www.youtube.com/watch?v={vid}",
                "error": f"WhisperFailed: {type(e).__name__}: {e}", "captions": []}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: transcript.py <url> [allow_whisper=true] [whisper_model=small] [proxy_url]"}))
        sys.exit(1)

    url_arg = sys.argv[1]
    allow_whisper_arg = sys.argv[2].lower() != "false" if len(sys.argv) > 2 else True
    whisper_model_arg = sys.argv[3] if len(sys.argv) > 3 else "small"
    proxy_arg = sys.argv[4] if len(sys.argv) > 4 else None

    result = transcript_json(url_arg, allow_whisper=allow_whisper_arg, whisper_model=whisper_model_arg, proxy_url=proxy_arg)
    print(json.dumps(result, ensure_ascii=False))
