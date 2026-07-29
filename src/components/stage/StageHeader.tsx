import { useMemo } from "react";
import { useActiveProfile, visibleStages } from "@/lib/pipeline-profiles";
import type { StageKey } from "@/pipelines/_core/types";
import { useProject } from "@/lib/store";
import { useHydrated } from "@/lib/use-hydrated";
import { StageGearDrawer } from "./StageGearDrawer";

/**
 * Per-stage header shown at the top of every pipeline page.
 * Communicates:
 *  - what this stage does (one line)
 *  - where it sits in the active profile (x of y, with the dots showing done)
 */
export function StageHeader({
  current,
  title,
  purpose,
}: {
  current: StageKey;
  title: string;
  purpose: string;
}) {
  const [project] = useProject();
  const { active } = useActiveProfile();
  const hydrated = useHydrated();

  const { position, total, dots } = useMemo(() => {
    const vis = visibleStages(active);
    const i = vis.findIndex((s) => s.id === current);
    return {
      position: i + 1,
      total: vis.length,
      dots: vis.map((s) => ({ id: s.id, done: !!s.hasOutput?.(project) })),
    };
  }, [active, current, project]);

  return (
    <header className="mb-6 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 border-b border-border pb-4 sm:flex sm:flex-row sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          <span>stage {hydrated && position > 0 ? position : "—"}/{total}</span>
          <span className="text-muted-foreground/40">·</span>
          <span className="truncate">{active.name}</span>
        </div>
        <h1 className="mt-1 truncate font-mono text-lg font-semibold sm:text-xl">{title}</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">{purpose}</p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-2 sm:flex-row sm:items-end">
        {hydrated && total > 0 && (
          <ol className="hidden flex-wrap items-center gap-1.5 sm:flex" aria-label="Stage progress">
            {dots.map((d) => {
              const isCurrent = d.id === current;
              return (
                <li
                  key={d.id}
                  className={
                    "h-1.5 w-6 rounded-full transition " +
                    (isCurrent
                      ? "bg-primary"
                      : d.done
                        ? "bg-primary/50"
                        : "bg-border")
                  }
                  title={d.id}
                />
              );
            })}
          </ol>
        )}
        <StageGearDrawer stage={current} stageLabel={title} />
      </div>
    </header>
  );
}
