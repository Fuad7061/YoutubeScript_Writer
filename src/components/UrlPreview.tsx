import { useEffect, useState } from "react";
import { fetchLinkMeta, type LinkMeta } from "@/lib/link-meta.functions";

export function UrlPreview({ url }: { url: string }) {
  const [meta, setMeta] = useState<LinkMeta | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!url || !/^https?:\/\//.test(url.trim())) {
      setMeta(null);
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const m = await fetchLinkMeta({ data: { url: url.trim() } });
        setMeta(m);
      } catch {
        setMeta(null);
      } finally {
        setLoading(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [url]);

  if (!url || (!meta && !loading)) return null;
  return (
    <div className="mt-3 flex items-start gap-3 rounded-md border border-border bg-panel p-3">
      {meta?.thumbnail ? (
        <img
          src={meta.thumbnail}
          alt=""
          className="h-14 w-24 shrink-0 rounded object-cover"
          loading="lazy"
        />
      ) : (
        <div className="h-14 w-24 shrink-0 animate-pulse rounded bg-muted" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {loading ? "Loading preview…" : meta?.title ?? "No preview available"}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
          {meta?.author ? `${meta.author} · ` : ""}
          {meta?.platform ?? new URL(url).hostname}
        </div>
      </div>
    </div>
  );
}
