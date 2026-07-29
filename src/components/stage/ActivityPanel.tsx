import { useState } from "react";
import { ChevronDown, ChevronRight, Copy, Loader2, X } from "lucide-react";
import type { ActivityLog, LogEntry, LogLevel } from "@/hooks/useActivityLog";
import { toast } from "sonner";

function fmtElapsed(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const ss = (s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

const LEVEL_CLASSES: Record<LogLevel, string> = {
  info: "text-muted-foreground",
  ok: "text-primary",
  warn: "text-amber-500",
  error: "text-destructive",
};

const LEVEL_DOTS: Record<LogLevel, string> = {
  info: "bg-muted-foreground/50",
  ok: "bg-primary",
  warn: "bg-amber-500",
  error: "bg-destructive",
};

function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    toast.success("logs copied");
  } catch {
    toast.error("could not copy logs");
  }
}

export function ActivityPanel({ activity }: { activity: ActivityLog }) {
  const { logs, running, elapsedMs, reset } = activity;
  const [open, setOpen] = useState(false);

  if (!running && logs.length === 0) return null;

  const latest: LogEntry | undefined = logs[logs.length - 1];
  const latestLevel: LogLevel = latest?.level ?? "info";

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 overflow-hidden rounded-lg border border-border bg-card/50"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40"
      >
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <span
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${LEVEL_DOTS[latestLevel]}`}
          />
        )}
        <span
          className={`min-w-0 flex-1 truncate font-mono text-[11px] ${LEVEL_CLASSES[latestLevel]}`}
        >
          {latest?.message ?? (running ? "working…" : "idle")}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {fmtElapsed(elapsedMs)} · {logs.length}
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="border-t border-border">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              activity log
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  copyText(
                    logs
                      .map((l) => `[${fmtTime(l.ts)}] ${l.level.padEnd(5)} ${l.message}`)
                      .join("\n"),
                  );
                }}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Copy logs"
              >
                <Copy className="h-3 w-3" /> copy
              </button>
              {!running && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    reset();
                  }}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="Clear logs"
                >
                  <X className="h-3 w-3" /> clear
                </button>
              )}
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto px-3 pb-2">
            <ul className="space-y-0.5">
              {logs.map((l, i) => (
                <li key={i} className="flex gap-2 font-mono text-[11px] leading-relaxed">
                  <span className="shrink-0 text-muted-foreground/60 tabular-nums">
                    {fmtTime(l.ts)}
                  </span>
                  <span className={`shrink-0 w-8 ${LEVEL_CLASSES[l.level]}`}>
                    {l.level}
                  </span>
                  <span className={`min-w-0 flex-1 ${LEVEL_CLASSES[l.level]} break-words`}>
                    {l.message}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
