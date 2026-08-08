# Free YouTube Transcript & Script Maker — Beginner Guide

Everything in this project runs on **your own VPS** and costs **$0** in software
fees. This guide explains how it works, how to keep it running, and how to use
it from n8n instead of paid tools like noteai or snapscooper.

---

## 1. What you have and what it costs

| Component | What it does | Cost |
|---|---|---|
| This app (Coolify) | Takes a YouTube URL, returns transcript + script | Free (open source) |
| yt-dlp | Downloads video info/audio/captions — also handles Facebook, TikTok, Instagram, X, Vimeo, 1000+ sites | Free |
| youtube-transcript-api | Fast captions path | Free |
| faster-whisper | Transcribes audio when a video has no captions | Free (runs on your CPU) |
| PO token provider (optional) | Unlocks real video formats on a flagged IP | Free (built in, env-gated) |
| n8n | Your automation workflows | Free |
| VPS + Coolify | The machine everything runs on | Already yours |

**You do not need noteai, snapscooper, or any other paid API.** Your app does
the same job natively, with no per-request limits.

---

## 2. How the app gets a transcript (the "ladder")

For a YouTube URL the app tries, in order:

1. **Tier 1 — real captions** (fast, no download): youtube-transcript-api with
   browser TLS impersonation (curl_cffi). This works for most videos.
2. **Tier 2 — Whisper fallback** (only if no captions): yt-dlp downloads the
   audio, faster-whisper transcribes it on your VPS.
3. **PO tokens (automatic)**: a bundled provider starts inside the container and
   yt-dlp fetches fresh tokens from it. On a flagged datacenter IP this is often
   the signal that unlocks real video/audio formats (without it YouTube may serve
   only storyboard images). Disable with `ENABLE_POT=0` in Coolify if your IP is clean.
4. **YouTube cookies**: paste your browser's YouTube cookies in Settings so yt-dlp
   sends a verified, logged-in session.

Non-YouTube URLs (Facebook, TikTok, ...) go straight to yt-dlp.

---

## 3. Redeploy after a code update (Coolify)

When I push changes to the GitHub repo:

1. Open Coolify → your project → the **YoutubeVideoScript_Maker** application.
2. Click **Deploy** (or **Pull & Deploy** if the button exists).
3. Watch the build log; wait for "Production: Deployed".

That's it. Your app is rebuilt with the newest code.

---

## 4. YouTube cookies (required on a flagged VPS IP)

YouTube aggressively bot-checks datacenter/VPS IP ranges and shows *"Sign in
to confirm you're not a bot"*. The fix is to give yt-dlp cookies from a browser
where you're logged into YouTube — YouTube then sees a verified, logged-in
session instead of a bare server IP.

### One-time setup

1. In Firefox or Chrome, install the extension **"Get cookies.txt LOCALLY"**.
2. Go to [youtube.com](https://www.youtube.com) and make sure you're logged in.
3. Click the extension icon → **Export** → copies a `cookies.txt` to your clipboard.
4. In the app → **Settings** → scroll to **YouTube cookies** → paste into the
   textarea → **Save cookies**.

A status line appears showing the file size and when it was saved.

### When it breaks again

Cookies expire eventually (weeks to months). When downloads start failing,
re-export from your browser and re-paste. Settings shows a **remove** button to
clear stale cookies first if you want.

> The textarea also accepts a raw cookie header string
> (`SID=abc; HSID=def; ...`) — whatever your browser gives you works.

---

## 5. Use your app from n8n (replace noteai / snapscooper)

Your app already exposes a JSON API. In n8n, use an **HTTP Request** node:

- **Method:** POST
- **URL:** `https://<your-app-domain>/api/transcribe`
- **Headers:**
  - `Authorization: Bearer <your APP_PASSWORD>`
- **Body (JSON):**
  ```json
  {
    "url": "https://www.youtube.com/watch?v=VIDEO_ID",
    "whisperModel": "small"
  }
  ```

Response contains `segments` (text + timestamps), `meta` (title, language,
duration), and `logs`.

Notes:

- The app password is set in Coolify → app → **Environment Variables** →
  `APP_PASSWORD`. If it is not set, the default is `admin`.
- The `/api/transcribe` endpoint tries captions first and falls back to
  Whisper automatically — same result you got from noteai, for free.
- `/api/healthz` is public and needs no password — good for testing:
  `curl https://<your-app-domain>/api/healthz`

---

## 6. The truth about "IP blocking"

You tested noteai and snapscooper from your VPS and they worked — that does
**not** mean YouTube doesn't block datacenter IPs. Here's what's happening:

- **noteai/snapscooper don't block VPS IPs** — they want anyone to use them.
  That's their business, so of course they respond.
- **YouTube is the one with the aggressive bot check.** It is triggered by
  datacenter IP ranges (that's what flags VPS traffic). This is extremely well
  documented — thousands of reports, GitHub issues, and workarounds exist
  precisely because it is real.
- Proof that snapscooper itself is not "free of checks": your own cURL includes
  a `cf_clearance` cookie. That is a **Cloudflare challenge token** that you
  solved in a browser. It is tied to your IP + browser fingerprint and it
  **expires** — it cannot be a long-term solution, and it would not even work
  from a different IP.
- YouTube blocking is **intermittent**: some days, some videos, some client
  types work fine; that's why you'll sometimes see it working from the VPS.
  The app's ladder (impersonation + multiple player clients + your YouTube
  cookies) is your free, permanent defense.

**Bottom line:** your own app is more reliable than the free tier of those
third-party sites, costs nothing per request, and does not depend on their
uptime or their limits.

---

## 7. Troubleshooting

| Problem | Check |
|---|---|
| App returns 401 | Use `Authorization: Bearer <APP_PASSWORD>`; check the env var in Coolify |
| "Sign in to confirm you're not a bot" | Re-export your YouTube cookies (they expired) and re-paste in Settings |
| Whisper fallback is slow | Change `whisperModel` to `base` (faster, slightly less accurate) |
| Non-YouTube URL fails | That site may have changed; check the app logs for the yt-dlp error message |
| No captions for a YouTube video | Normal — that video has no captions; the app falls back to Whisper automatically |

### Enable debug mode (temporary)

To see yt-dlp's full diagnostics, set this env var in Coolify:

- Name: `YTDLP_VERBOSE`
- Value: `1`

Then redeploy and try one download. The `[media-proxy] yt-dlp stderr:` log line
will show yt-dlp's detailed output. (Remove the env var when done — verbose mode
is noisy.)

---

## 8. All the commands you ever need

```bash
# SSH into VPS, then:

# Check the app container logs
docker logs <your-app-container-name> --tail 50

# Restart the app container (or just click Deploy in Coolify)
docker restart <your-app-container-name>
```
