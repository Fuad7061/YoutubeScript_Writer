import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Copy } from "lucide-react";
import { toast } from "sonner";

type ScriptRow = {
  visuals: string;
  voiceover: string;
  sfx: string;
  editor: string;
  /** Parsed timestamp — OUT (cumulative in the new commentary) + SRC (source clip). */
  outTs?: string;
  srcTs?: string;
  archetype?: string;
  captionMode?: string;
};
type Parsed = {
  title: string;
  description: string;
  rows: ScriptRow[];
  scriptMarkdown: string;
  musicTip: string;
  loopCheck: string;
};

function stripLabel(line: string, ...labels: string[]) {
  let s = line.trim();
  for (const l of labels) {
    const re = new RegExp(`^${l}\\s*:?\\s*`, "i");
    s = s.replace(re, "");
  }
  return s.trim();
}

function pickAfter(
  text: string,
  patterns: RegExp[],
  opts: { stopOnBlankLine?: boolean } = {},
): { value: string; end: number } {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m.index != null) {
      const after = text.slice(m.index + m[0].length);
      // stop at next emoji-labeled section, ## heading, or a markdown table row
      const stops: number[] = [];
      const sectionStop = after.search(/\n\s*(?:🔥|📝|🎬|🎵|🔄|## |\| )/);
      if (sectionStop !== -1) stops.push(sectionStop);
      if (opts.stopOnBlankLine) {
        // Terse sections (Music tip / Loop check) are 1–2 lines. Any blank
        // line after them means the model started rambling (self-checks,
        // word counts, "Wait, let me…"). Cut it off.
        const blankStop = after.search(/\n\s*\n/);
        if (blankStop !== -1) stops.push(blankStop);
      }
      const stop = stops.length ? Math.min(...stops) : -1;
      const value = (stop === -1 ? after : after.slice(0, stop)).trim();
      return { value, end: m.index + m[0].length + (stop === -1 ? after.length : stop) };
    }
  }
  return { value: "", end: -1 };
}

export function parseScript(raw: string): Parsed {
  const text = raw.trim();

  const title = stripLabel(
    pickAfter(text, [/🔥\s*Viral Title\s*:?/i, /Viral Title\s*:/i]).value.split("\n")[0] ?? "",
  );
  const description = pickAfter(text, [/📝\s*Meta Description\s*:?/i, /Meta Description\s*:/i], {
    stopOnBlankLine: true,
  }).value;
  const musicTip = pickAfter(text, [/🎵\s*Music Tip\s*:?/i, /Music Tip\s*:/i], {
    stopOnBlankLine: true,
  }).value;
  const loopCheck = pickAfter(text, [/🔄\s*Loop Check\s*:?/i, /Loop Check\s*:/i], {
    stopOnBlankLine: true,
  }).value;

  // Extract the markdown table block
  const lines = text.split("\n");
  const tableStart = lines.findIndex((l) => /^\s*\|.*\|.*\|/.test(l));
  let rows: ScriptRow[] = [];
  let scriptMarkdown = "";
  if (tableStart !== -1) {
    const collected: string[] = [];
    for (let i = tableStart; i < lines.length; i++) {
      if (/^\s*\|/.test(lines[i])) collected.push(lines[i]);
      else if (collected.length && lines[i].trim() === "") continue;
      else break;
    }
    scriptMarkdown = collected.join("\n");
    // parse rows (skip header + separator)
    const dataRows = collected.filter((l) => !/^\s*\|\s*:?-+/.test(l));
    for (let i = 1; i < dataRows.length; i++) {
      const cells = dataRows[i]
        .replace(/^\s*\|/, "")
        .replace(/\|\s*$/, "")
        .split("|")
        .map((c) => c.trim());
      if (cells.length >= 3) {
        const c0 = cells[0];
        // Parse "OUT 0.0–2.8s · SRC 0:00–0:03 — description" if present
        const outMatch = c0.match(/OUT\s+([0-9.]+\s*[–-]\s*[0-9.]+s?)/i);
        const srcMatch = c0.match(/SRC\s+([0-9:.]+\s*[–-]\s*[0-9:.]+|—|-)/i);
        const outTs = outMatch?.[1]?.trim();
        const srcTs = srcMatch?.[1]?.trim();
        const c2 = cells[2];
        const archetype = c2.match(/\[ARCHETYPE:\s*([^\]]+)\]/i)?.[1]?.trim();
        const captionMode = c2.match(/\[CAPTION\s*MODE:\s*([^\]]+)\]/i)?.[1]?.trim();
        rows.push({
          visuals: c0,
          voiceover: cells[1],
          sfx: c2,
          editor: cells[3] ?? "",
          outTs, srcTs, archetype, captionMode,
        });
      }
    }
  }

  return { title, description, rows, scriptMarkdown, musicTip, loopCheck };
}

async function copy(text: string, label: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error("clipboard-unavailable");
    }
    toast.success(`${label} copied`);
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.setAttribute("readonly", "");
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (!ok) throw new Error("execCommand-failed");
      toast.success(`${label} copied`);
    } catch {
      toast.error(`Couldn't copy ${label}. Select the text and copy manually.`);
    }
  }
}

function CopyBtn({
  text,
  label,
  showLabel,
}: {
  text: string;
  label: string;
  showLabel?: boolean;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => copy(text, label)}
      className="h-7 gap-1.5 px-2 font-mono text-[10px] text-muted-foreground hover:text-primary"
      title={`Copy ${label}`}
    >
      <Copy className="h-3 w-3" />
      {showLabel ? label : "copy"}
    </Button>
  );
}

function SectionCard({
  icon,
  title,
  copyText,
  copyLabel,
  children,
}: {
  icon: string;
  title: string;
  copyText: string;
  copyLabel: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card overflow-hidden">
      <header className="flex items-center justify-between border-b border-border px-4 py-2">
        <h4 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          <span className="mr-2">{icon}</span>
          {title}
        </h4>
        {copyText && <CopyBtn text={copyText} label={copyLabel} />}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function ScriptResult({ raw }: { raw: string }) {
  const parsed = useMemo(() => parseScript(raw), [raw]);
  const voiceoverOnly = parsed.rows.map((r) => r.voiceover).filter(Boolean).join(" ");
  const visualsOnly = parsed.rows.map((r, i) => `${i + 1}. ${r.visuals}`).join("\n");
  const sfxOnly = parsed.rows.map((r, i) => `${i + 1}. ${r.sfx}`).join("\n");
  const editorOnly = parsed.rows.map((r, i) => `${i + 1}. ${r.editor}`).join("\n");
  const hasEditor = parsed.rows.some((r) => r.editor.trim().length > 0);
  const wordCount = voiceoverOnly.split(/\s+/).filter(Boolean).length;

  return (
    <div className="space-y-4">
      {/* Top: title + description side by side */}
      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard icon="🔥" title="Viral title" copyText={parsed.title} copyLabel="Title">
          <p className="text-lg font-semibold leading-snug">{parsed.title || <span className="text-muted-foreground">—</span>}</p>
          <p className="mt-2 font-mono text-[10px] text-muted-foreground">{parsed.title.length} chars</p>
        </SectionCard>

        <SectionCard icon="📝" title="Meta description" copyText={parsed.description} copyLabel="Description">
          <p className="whitespace-pre-wrap text-sm leading-relaxed">
            {parsed.description || <span className="text-muted-foreground">—</span>}
          </p>
        </SectionCard>
      </div>

      {/* Script table */}
      <section className="rounded-lg border border-border bg-card overflow-hidden">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
          <h4 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            🎬 The script · {parsed.rows.length} beats · {wordCount} VO words
          </h4>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 font-mono text-[10px] uppercase text-muted-foreground/70">copy:</span>
            <CopyBtn text={voiceoverOnly} label="voiceover" showLabel />
            <CopyBtn text={visualsOnly} label="visuals" showLabel />
            <CopyBtn text={sfxOnly} label="sfx" showLabel />
            {hasEditor && <CopyBtn text={editorOnly} label="editor" showLabel />}
            <CopyBtn text={parsed.scriptMarkdown} label="full table" showLabel />
          </div>
        </header>

        {parsed.rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-muted/40 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className={`${hasEditor ? "w-[24%]" : "w-[30%]"} px-4 py-2 border-b border-border`}>Timestamp (OUT · SRC) & Visuals</th>
                  <th className={`${hasEditor ? "w-[34%]" : "w-[45%]"} px-4 py-2 border-b border-border`}>Audio / Voiceover</th>
                  <th className={`${hasEditor ? "w-[22%]" : "w-[25%]"} px-4 py-2 border-b border-border`}>Visuals · SFX · Overlays</th>
                  {hasEditor && (
                    <th className="w-[20%] px-4 py-2 border-b border-border">📱 Editor (CapCut)</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {parsed.rows.map((r, i) => (
                  <tr key={i} className="align-top hover:bg-muted/20">
                    <td className="px-4 py-3 border-b border-border/60 text-xs text-muted-foreground leading-relaxed">
                      {(r.outTs || r.srcTs) && (
                        <div className="mb-1 flex flex-wrap gap-1 font-mono text-[10px]">
                          {r.outTs && (
                            <span className="rounded bg-primary/15 px-1.5 py-0.5 text-primary">OUT {r.outTs}</span>
                          )}
                          {r.srcTs && r.srcTs !== "—" && r.srcTs !== "-" && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">SRC {r.srcTs}</span>
                          )}
                        </div>
                      )}
                      <MD>{r.visuals}</MD>
                    </td>
                    <td className="px-4 py-3 border-b border-border/60 leading-relaxed">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 font-medium"><MD>{r.voiceover}</MD></div>
                        <button
                          onClick={() => copy(r.voiceover, `Beat ${i + 1}`)}
                          className="shrink-0 rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-primary"
                          title="copy this beat"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3 border-b border-border/60 text-xs text-muted-foreground leading-relaxed">
                      {(r.archetype || r.captionMode) && (
                        <div className="mb-1 flex flex-wrap gap-1 font-mono text-[10px]">
                          {r.archetype && (
                            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-500">🎣 {r.archetype}</span>
                          )}
                          {r.captionMode && (
                            <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-sky-500">💬 {r.captionMode}</span>
                          )}
                        </div>
                      )}
                      <MD>{r.sfx}</MD>
                    </td>
                    {hasEditor && (
                      <td className="px-4 py-3 border-b border-border/60 text-xs text-muted-foreground/90 leading-relaxed font-mono">
                        <MD>{r.editor}</MD>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-8 text-center font-mono text-xs text-muted-foreground">
            No table detected — showing raw markdown below.
          </div>
        )}
      </section>


      {/* Music + Loop */}
      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard icon="🎵" title="Music tip" copyText={parsed.musicTip} copyLabel="Music tip">
          <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed">
            <MD>{parsed.musicTip || "—"}</MD>
          </div>
        </SectionCard>
        <SectionCard icon="🔄" title="Loop check" copyText={parsed.loopCheck} copyLabel="Loop check">
          <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed">
            <MD>{parsed.loopCheck || "—"}</MD>
          </div>
        </SectionCard>
      </div>

      {/* Full markdown fallback */}
      <details className="rounded-lg border border-border bg-card">
        <summary className="cursor-pointer px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground">
          view raw markdown
        </summary>
        <div className="border-t border-border p-4">
          <div className="mb-2 flex justify-end">
            <CopyBtn text={raw} label="Full script" />
          </div>
          <pre className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground">
            {raw}
          </pre>
        </div>
      </details>
    </div>
  );
}

function MD({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <span>{children}</span>,
        strong: ({ children }) => <strong className="text-foreground">{children}</strong>,
        em: ({ children }) => <em className="text-primary">{children}</em>,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
