# Foundry

AI-powered video script pipeline. Paste a YouTube URL, Amazon product links, or any video — get a full review script, voiceover, SEO pack, and fair-use checklist in minutes.

**Stack**: TanStack Start (React 19 + Vite) · TypeScript · SQLite (`better-sqlite3`) · System FFmpeg · Faster-Whisper

---

## Features

- **3 built-in pipelines**: YouTube Product Review · Amazon Listicle · Any Video Commentary  
- **Server-side frame extraction** — system FFmpeg (10–50× faster than browser WASM, full codec support)  
- **Server-side transcription** — OpenAI Whisper API + local faster-whisper fallback  
- **Persistent history** — SQLite on the server, survives container restarts and re-deploys  
- **Password protection** — optional `APP_PASSWORD` env var  
- **Data management** — clear server sessions or browser cache from Settings  
- **Extensible pipeline architecture** — add a new workflow in one folder + one import line  

---

## Quick Start (Local Dev)

```bash
bun install
bun run dev        # http://localhost:5173
```

Copy `.env.example` → `.env` and set values as needed.

---

## Docker (Production)

### Build & Run

```bash
docker build -t foundry .
docker run -p 9090:9090 -v foundry_data:/data foundry
```

### With Compose

```bash
cp .env.example .env
# Optional: set APP_PASSWORD=your-secret in .env
docker compose up -d
```

App runs at `http://localhost:9090`. Database at `/data/foundry.db` (volume: `foundry_data`).

---

## Deploy on Coolify

1. **Push to GitHub** (see GitHub Actions below — image is auto-built on push).
2. In Coolify → **New Service → Docker Image**  
   → Image: `ghcr.io/<your-username>/<repo>:main`
3. **Environment Variables** (in Coolify):
   ```
   NODE_ENV=production
   PORT=9090
   DATA_DIR=/data
   APP_PASSWORD=your-secret-password     # optional
   ```
4. **Volumes** → Add: `/data` → Persistent Volume  
   Name the volume `foundry_data` — Coolify will keep it across re-deploys.
5. **Port**: `9090 → 9090`
6. Deploy ✓

> Data in `/data/foundry.db` **survives every re-deploy** as long as the volume is attached.

---

## GitHub Actions (CI/CD)

`.github/workflows/docker.yml` automatically:
- Builds multi-platform (`linux/amd64` + `linux/arm64`) Docker image
- Pushes to `ghcr.io/<owner>/<repo>` on every push to `main`
- Tags with semver (`v1.2.3` → `:1.2.3`, `:1.2`)

```bash
# Release a new version
git tag v1.0.0
git push --tags
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `9090` | HTTP port |
| `DATA_DIR` | `./data` | Directory for `foundry.db` + whisper model cache |
| `APP_PASSWORD` | *(empty)* | Optional password. Leave empty to disable auth. |

> AI model config (API key, host, model ID) is set **inside the app** on the Settings page — never in env vars. This means your API keys never go server-side.

---

## Data Management

- **Sessions** are stored in `$DATA_DIR/foundry.db` (SQLite, WAL mode)
- **Re-deploys** never drop or alter existing data — safe always
- **Settings → Data Management** → "Clear all server sessions" → wipes all session rows
- **Settings → Data Management** → "Clear browser cache" → wipes active project + IndexedDB blobs from this browser

---

## Audio Transcription

Two strategies, tried in order:

| Strategy | Speed | Cost | Requires |
|---|---|---|---|
| OpenAI Whisper API | Very fast | ~$0.006/min | Whisper-compatible API endpoint configured in Settings |
| faster-whisper (local) | 2–5× real-time on CPU | Free | Pre-installed in Docker image via `pip install faster-whisper` |

Model weights for faster-whisper (`tiny.en`, ~75MB) are downloaded on first use and cached in `$DATA_DIR/whisper-models/`.

---

## Frame Extraction

System `ffmpeg` binary (installed in Docker via `apk add ffmpeg`). Supports all codecs — H.264, VP9, AV1, HEVC, MKV. **No browser WASM download.** Extracted frames are evenly spaced, scaled to max 720px, returned as base64 JPEG.

---

## Adding a New Pipeline Workflow

New pipeline type in ~5 minutes:

```bash
# 1. Copy the template
cp -r src/pipelines/workflows/_template src/pipelines/workflows/youtube-tutorial

# 2. Edit workflow.ts
nano src/pipelines/workflows/youtube-tutorial/workflow.ts
# Change: id, name, mode, stageOrder, description

# 3. Register it (one line)
nano src/pipelines/_core/registry.ts
# Add:  import youtubeTutorial from "../workflows/youtube-tutorial/workflow";
# Add:  youtubeTutorial,   ← to WORKFLOW_DEFINITIONS array
```

**Done.** The profile picker, sidebar, and home page auto-update.

### Built-in Stages

| Stage | ID | Description |
|---|---|---|
| Analyze | `analyze` | Vision + audio analysis report |
| Transcript | `transcript` | YouTube/video captions |
| Frames | `frames` | Key frame extraction |
| Products | `products` | Amazon product matching |
| Commentary | `commentary` | Viral commentary script |
| Script | `script` | Full review script |
| Voiceover | `voiceover` | TTS audio generation |
| SEO | `seo` | Title, description, tags |
| Fair-use | `fairuse` | Fair-use checklist |

### Adding a New Stage

1. Create `src/pipelines/stages/<slug>/meta.ts` — export a `StageDefinition`
2. Add one import + one entry to `STAGE_DEFINITIONS` in `src/pipelines/_core/registry.ts`
3. Add the matching route at `src/routes/<slug>.tsx`

---

## Project Structure

```
src/
├── pipelines/
│   ├── _core/
│   │   ├── types.ts          ← Open StageKey + WorkflowDefinition types
│   │   └── registry.ts       ← Register stages + workflows here (one line each)
│   ├── stages/               ← One folder per pipeline stage
│   │   ├── transcript/
│   │   ├── frames/
│   │   ├── products/
│   │   ├── analyze/
│   │   ├── commentary/
│   │   ├── script/
│   │   ├── voiceover/
│   │   ├── seo/
│   │   └── fairuse/
│   └── workflows/            ← One folder per pipeline workflow type
│       ├── youtube-product-review/
│       ├── amazon-listicle/
│       ├── any-video-commentary/
│       └── _template/        ← Copy this to add a new workflow
├── lib/
│   ├── db.server.ts          ← SQLite persistence (server-only)
│   ├── ffmpeg.server.ts      ← System FFmpeg frame extraction (server-only)
│   ├── whisper.server.ts     ← Server-side transcription (server-only)
│   ├── auth.server.ts        ← Password middleware (server-only)
│   └── store.ts              ← Client state + API key storage (browser)
└── routes/
    └── api/
        ├── sessions.ts       ← Session CRUD
        ├── extract-frames.ts ← FFmpeg frame extraction
        ├── transcribe.ts     ← Whisper transcription
        ├── healthz.ts        ← Health check
        └── media-proxy.ts    ← External media proxy
```

---

## 🚀 Coolify Deployment Guide (Hetzner VPS)

This repository is optimized to be deployed instantly on [Coolify](https://coolify.io) (e.g. running on a Hetzner VPS). The provided `Dockerfile` leverages a robust multi-stage build that uses Bun for blazing fast installs/builds, and sets up Python 3 + `yt-dlp` / `ffmpeg` dependencies perfectly for the YouTube analysis backend!

### Prerequisites
1. **VPS with Coolify**: Follow [Coolify's installation instructions](https://coolify.io/docs/installation) on a fresh Hetzner Ubuntu server (e.g., CPX21 or CPX31 instance).
2. **GitHub Token/App configured**: Make sure Coolify has access to your private GitHub repository `https://github.com/Fuad7061/YoutubeScript_Writer`.

### Steps to Deploy

1. Open your **Coolify Dashboard**.
2. Click **Add New Resource** $\to$ **Project** $\to$ Create a new environment.
3. Select **Application** $\to$ **GitHub/GitLab/Bitbucket** (choose your connected source).
4. Select your repository `Fuad7061/YoutubeScript_Writer`.
5. Coolify will automatically detect the **Dockerfile** at the root of the repository.
6. In the **Configuration** tab for the application:
   - **Build Pack**: `Docker`
   - **Port**: `9090`
   - **Persistent Storage / Volumes**: The app stores SQLite sessions inside the `/data` folder. Add a volume mapping:
     - Volume mapping: `foundry_data:/data`
7. Click **Deploy**!

Coolify will:
1. Pull the code.
2. Build the TanStack Start app using Bun.
3. Set up a secure Python environment containing `faster-whisper` and `yt-dlp`.
4. Run the production server via `bun run preview` exposing port `9090` and map your custom domain securely.

### Database Backup
Because we mapped `foundry_data:/data`, your session data (`/data/foundry.db`) is safely stored in the Coolify Docker volumes and **will survive redeployments** seamlessly.
