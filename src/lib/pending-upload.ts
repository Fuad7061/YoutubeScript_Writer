// Transient handoff for a File object between the Input page and the Analyse
// pipeline (Files cannot be serialised through URL search params).

let pending: File | null = null;

export function setPendingVideoFile(f: File | null) {
  pending = f;
}
export function takePendingVideoFile(): File | null {
  const f = pending;
  pending = null;
  return f;
}
