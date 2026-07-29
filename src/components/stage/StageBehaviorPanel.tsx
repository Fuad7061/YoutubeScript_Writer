import { useConfig } from "@/lib/store";
import type { StageKey } from "@/pipelines/_core/types";
import type { ChunkMode, TtsProvider } from "@/lib/types";

/**
 * Stage-scoped behavior toggles rendered inside the StageGearDrawer's
 * "Behavior" tab. Each toggle writes to the persistent Config store, so
 * changes take effect on the next run and stick across sessions.
 *
 * Design: only show toggles that meaningfully change how the stage behaves;
 * per-run knobs (e.g. angle, tone, length) stay on the stage page itself.
 */
export function StageBehaviorPanel({ stage }: { stage: StageKey }) {
  const [cfg, setCfg] = useConfig();

  const rows: React.ReactNode[] = [];

  if (stage === "transcript" || stage === "analyze") {
    rows.push(
      <ToggleRow
        key="transcribe"
        checked={cfg.transcribeAudio}
        onChange={(v) => setCfg({ transcribeAudio: v })}
        title="Whisper fallback"
        desc="When captions are unavailable, fall back to server-side Whisper (yt-dlp + faster-whisper). Off is best for Shorts / music-only clips."
      />,
    );
  }

  if (stage === "analyze-vision" || stage === "analyze" || stage === "frames") {
    rows.push(
      <SelectRow
        key="fps"
        title="Frame extraction rate"
        desc="How many frames per second to sample from the video for AI vision analysis. 'Auto' picks a smart count based on duration (cost-efficient). Higher rates capture more detail but increase processing time and AI cost."
        value={cfg.analyzeVisionFps ?? "auto"}
        onChange={(v) => setCfg({ analyzeVisionFps: v as "auto" | "0.5fps" | "1fps" | "2fps" })}
        options={[
          { value: "auto", label: "⚡ Auto (smart, based on duration)" },
          { value: "0.5fps", label: "0.5 fps — 1 frame every 2 s" },
          { value: "1fps", label: "1 fps — 1 frame per second" },
          { value: "2fps", label: "2 fps — 2 frames per second (detailed)" },
        ]}
      />,
      <SelectRow
        key="gridStitch"
        title="Frame Grid Stitching (Request Saver)"
        desc="Stitches multiple frames into a composite 2x2 or 3x3 grid tile before sending to the AI model. 3x3 Grid reduces total API requests and image payloads by up to 89%, saving rate limits and credits."
        value={cfg.analyzeGridStitch ?? "3x3"}
        onChange={(v) => setCfg({ analyzeGridStitch: v as "off" | "2x2" | "3x3" })}
        options={[
          { value: "3x3", label: "🧩 3×3 Grid — 9 frames/image (89% request savings — recommended)" },
          { value: "2x2", label: "🧩 2×2 Grid — 4 frames/image (75% request savings)" },
          { value: "off", label: "🖼️ Off — send individual frame images" },
        ]}
      />,
      <NumberInputRow
        key="maxFrames"
        title="Max frames (Auto mode)"
        desc="Upper limit on total extracted frames when FPS rate is set to 'Auto'. Type any custom number or click a preset."
        value={cfg.analyzeMaxFrames ?? 12}
        onChange={(v) => setCfg({ analyzeMaxFrames: Math.max(1, Math.min(200, v)) })}
        presets={[6, 8, 12, 16, 24, 32, 48, 64, 120]}
        unit="frames"
      />,
      <NumberInputRow
        key="batchSize"
        title="Batch size (Frames per AI call)"
        desc="Number of frames packaged in a single vision AI request. Setting a higher number (e.g. 10, 15, 20) drastically reduces total API calls to save free-tier RPM limits."
        value={cfg.analyzeBatchSize ?? 6}
        onChange={(v) => setCfg({ analyzeBatchSize: Math.max(1, Math.min(60, v)) })}
        presets={[4, 6, 10, 12, 15, 20, 30]}
        unit="frames/call"
      />,
    );
  }

  if (stage === "commentary") {
    rows.push(
      <SelectRow
        key="mode"
        title="Default mode"
        desc="Which Mode the Commentary page starts on. Mirror clones the source's beat structure; Remix picks a fresh angle; Custom lets you write a free-form brief."
        value={cfg.commentaryDefaultMode}
        onChange={(v) =>
          setCfg({ commentaryDefaultMode: v as "mirror" | "remix" | "custom" })
        }
        options={[
          { value: "mirror", label: "🪞 Mirror source (default)" },
          { value: "remix", label: "🎨 Remix — pick an angle" },
          { value: "custom", label: "✍️ Custom brief" },
        ]}
      />,
    );
  }

  if (stage === "voiceover") {
    rows.push(
      <SelectRow
        key="chunk"
        title="Chunking mode"
        desc="Sentence splits & merges (best on long scripts). Full sends the whole script in one Gemini request (fewer requests, kinder on free-tier quotas)."
        value={cfg.voiceover.chunkMode}
        onChange={(v) =>
          setCfg({ voiceover: { ...cfg.voiceover, chunkMode: v as ChunkMode } })
        }
        options={[
          { value: "full", label: "Full script (one request)" },
          { value: "sentence", label: "Sentence-by-sentence" },
        ]}
      />,
      <SelectRow
        key="provider"
        title="Default TTS provider"
        desc="Which provider the Voiceover page starts with. You can still switch per-run on the page."
        value={cfg.voiceover.provider}
        onChange={(v) =>
          setCfg({ voiceover: { ...cfg.voiceover, provider: v as TtsProvider } })
        }
        options={[
          { value: "gemini", label: "Google Gemini TTS" },
          { value: "murf", label: "Murf.ai (BYO session)" },
        ]}
      />,
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded border border-dashed border-border p-4 text-xs text-muted-foreground">
        No stage-wide behavior toggles for this stage yet — everything for this
        step is a per-run knob on the stage page.
      </div>
    );
  }

  return <div className="flex flex-col gap-3">{rows}</div>;
}

function ToggleRow({
  checked,
  onChange,
  title,
  desc,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  desc: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-panel/40 p-3 hover:border-primary/40">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-primary"
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-0.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
          {desc}
        </div>
      </div>
      <span
        className={
          "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] " +
          (checked ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground")
        }
      >
        {checked ? "ON" : "OFF"}
      </span>
    </label>
  );
}

function SelectRow({
  title,
  desc,
  value,
  onChange,
  options,
}: {
  title: string;
  desc: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="rounded-md border border-border bg-panel/40 p-3">
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-0.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
        {desc}
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-2 w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function NumberInputRow({
  title,
  desc,
  value,
  onChange,
  presets,
  unit,
}: {
  title: string;
  desc: string;
  value: number;
  onChange: (v: number) => void;
  presets?: number[];
  unit?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-panel/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">{title}</div>
        <div className="flex items-center gap-1.5 font-mono text-xs">
          <input
            type="number"
            min={1}
            max={200}
            value={value}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (!isNaN(n)) onChange(n);
            }}
            className="w-16 rounded border border-border bg-background px-2 py-1 text-right font-mono text-xs font-semibold focus:border-primary focus:outline-none"
          />
          {unit && <span className="text-[10px] text-muted-foreground">{unit}</span>}
        </div>
      </div>
      <div className="mt-0.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
        {desc}
      </div>
      {presets && presets.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60 mr-1">Presets:</span>
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onChange(p)}
              className={
                "rounded px-1.5 py-0.5 font-mono text-[10px] transition hover:bg-primary/20 hover:text-primary " +
                (value === p
                  ? "bg-primary/20 font-semibold text-primary"
                  : "bg-muted/60 text-muted-foreground")
              }
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
