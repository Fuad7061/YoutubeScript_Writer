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
| PO token provider (optional) | Defeats YouTube's "not a bot" check on VPS IPs | Free (open source container) |
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
3. **PO tokens** (if the provider is enabled): yt-dlp fetches a fresh token
   from your provider before talking to YouTube, so the "Sign in to confirm
   you're not a bot" page never appears.

Non-YouTube URLs (Facebook, TikTok, ...) go straight to yt-dlp.

---

## 3. Redeploy after a code update (Coolify)

When I push changes to the GitHub repo:

1. Open Coolify → your project → the **YoutubeVideoScript_Maker** application.
2. Click **Deploy** (or **Pull & Deploy** if the button exists).
3. Watch the build log; wait for "Production: Deployed".

That's it. Your app is rebuilt with the newest code.

---

## 4. Enable PO tokens (free, recommended)

This is the piece that makes YouTube stop showing the bot check on your VPS
IP. You run one extra free container and give the app its address.

### Option A — through Coolify (easiest)

1. Coolify → **New Resource** → **Docker Image**.
2. Image: `brainicism/bgutil-ytdlp-pot-provider` (tag `latest`).
3. Port: expose **4416**.
4. Name it e.g. `bgutil-pot-provider` and create it.
5. Now open your **YoutubeVideoScript_Maker** app → **Environment Variables**:
   - Name: `BGUTIL_POT_URL`
   - Value: `http://<your-vps-ip>:4416` (the public IP of the VPS)
6. **Deploy** the app again.

### Option B — direct on the VPS (if you prefer SSH)

SSH into your VPS and run:

```bash
docker run -d --name bgutil-pot-provider --restart unless-stopped \
  -p 4416:4416 brainicism/bgutil-ytdlp-pot-provider:latest
```

Then add the same `BGUTIL_POT_URL` env var to the app and redeploy.

### Verify the provider is alive

```bash
curl http://<your-vps-ip>:4416/health
```

It should answer quickly (it prints a status line).

> Without `BGUTIL_POT_URL`, the app behaves exactly as before — nothing breaks.
> The provider just makes YouTube requests more reliable from the VPS IP.

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
| "Sign in to confirm you're not a bot" | PO provider not running → run step 4; check `curl http://<vps-ip>:4416/health` |
| Whisper fallback is slow | Change `whisperModel` to `base` (faster, slightly less accurate) |
| Non-YouTube URL fails | That site may have changed; check the app logs for the yt-dlp error message |
| No captions for a YouTube video | Normal — that video has no captions; the app falls back to Whisper automatically |

---

## 8. All the commands you ever need

```bash
# SSH into VPS, then:

# See provider status
docker logs bgutil-pot-provider --tail 20

# Test provider health
curl http://127.0.0.1:4416/health

# Restart the app container (or just click Deploy in Coolify)
docker restart <your-app-container-name>
```
