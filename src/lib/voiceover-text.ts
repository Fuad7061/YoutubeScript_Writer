// Shared voiceover text extraction — used by both the Voiceover route
// (runtime) and the live prompt preview so the ORIGINAL_TEXT shown in
// the enhancer preview matches EXACTLY what the enhancer receives.

import { parseScript } from "@/components/ScriptResult";

export function cleanSpokenText(input: string): string {
  return input
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/\((?:whisper|pause|beat|smile|laugh|sfx|music|note)[^)]*\)/gi, " ")
    .replace(/\[(?:pause|beat|sfx|music|note|source clip[^\]]*)\]/gi, " ")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractVoiceoverText(script?: string): string {
  if (!script) return "";
  const parsed = parseScript(script);
  const vo = parsed.rows.map((r) => r.voiceover).filter(Boolean).join(" ");
  if (!vo.trim()) {
    const tableRows = script
      .split("\n")
      .filter((line) => /^\s*\|/.test(line) && !/^\s*\|\s*:?-+/.test(line));
    const raw = tableRows
      .slice(1)
      .map((line) => {
        const cells = line
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((cell) => cell.trim());
        return cells[1] ?? "";
      })
      .filter(Boolean)
      .join(" ");
    return cleanSpokenText(raw);
  }
  return cleanSpokenText(vo);
}
