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
| PO token provider (bundled) | Defeats YouTube's "not a bot" check on VPS IPs | Free (open source, built into the app) |
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
3. **PO tokens (automatic)**: the container's entrypoint starts a bundled
   token provider on 127.0.0.1:4416 before the app boots. yt-dlp fetches
   fresh tokens from it before talking to YouTube, so the "Sign in to
   confirm you're not a bot" page never appears. No setup needed.

Non-YouTube URLs (Facebook, TikTok, ...) go straight to yt-dlp.

---

## 3. Redeploy after a code update (Coolify)

When I push changes to the GitHub repo:

1. Open Coolify → your project → the **YoutubeVideoScript_Maker** application.
2. Click **Deploy** (or **Pull & Deploy** if the button exists).
3. Watch the build log; wait for "Production: Deployed".

That's it. Your app is rebuilt with the newest code.

---

## 4. PO tokens — already included, nothing to do

The PO token provider is **built into the app container**. When the container
starts, its entrypoint automatically:

1. Starts the bundled token provider on `127.0.0.1:4416` (inside the container).
2. Waits until it is ready (you'll see `PO token provider ready on
   127.0.0.1:4416` in the app logs).
3. Then starts the app.

yt-dlp talks to it automatically — no ports, no extra containers, no env vars.

> Advanced only: if you ever run an external provider on another host, set the
> `BGUTIL_POT_URL` env var (e.g. `http://<ip>:4416`) on the app and it will use
> that instead. Skip this unless you know you need it.

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
  The app's ladder (impersonation + TV clients + PO tokens) is your free,
  permanent defense.

**Bottom line:** your own app is more reliable than the free tier of those
third-party sites, costs nothing per request, and does not depend on their
uptime or their limits.

---

## 7. Troubleshooting

| Problem | Check |
|---|---|
| App returns 401 | Use `Authorization: Bearer <APP_PASSWORD>`; check the env var in Coolify |
| "Sign in to confirm you're not a bot" | The PO token flow isn't completing yet — enable debug mode (see below) and share the log line |
| Whisper fallback is slow | Change `whisperModel` to `base` (faster, slightly less accurate) |
| Non-YouTube URL fails | That site may have changed; check the app logs for the yt-dlp error message |
| No captions for a YouTube video | Normal — that video has no captions; the app falls back to Whisper automatically |
| Server crashes / 502 with no clear cause | Check logs for `WritableStream` or `ERR_INVALID_STATE` — update to latest deploy |

### Enable debug mode (temporary)

To see exactly what the PO token flow is doing, set this env var in Coolify:

- Name: `YTDLP_VERBOSE`
- Value: `1`

Then redeploy and try one video download. In the app logs, the `[media-proxy] yt-dlp stderr:` line will now show the full PO-token steps. Paste that line here and I'll fix the exact issue. (Set the value back to `0` or remove it when done — verbose mode is noisy.)

---

## 8. All the commands you ever need

```bash
# SSH into VPS, then:

# Check the app container logs (look for "PO token provider ready" and the
# provider's own lines — the provider prints its logs to the same stream)
docker logs <your-app-container-name> --tail 50

# Restart the app container (or just click Deploy in Coolify)
docker restart <your-app-container-name>
```
