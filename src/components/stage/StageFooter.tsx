import { useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useActiveProfile, visibleStages } from "@/lib/pipeline-profiles";
import type { StageKey } from "@/pipelines/_core/types";
import type { ReactNode } from "react";

/**
 * Consistent bottom-of-stage nav bar.
 *
 * Reads the active profile's visible stages to derive prev / next per profile,
 * so switching profile automatically re-wires the flow. The primary CTA is
 * always the "→ next stage" button on the right; skip appears when a stage
 * is optional-ish (i.e. not the last one).
 *
 * A stage may inject a custom primary action via `primary` — e.g. voiceover
 * uses its own "generate voiceover" living in its Config panel, so the
 * footer's next-stage button remains the navigation primary.
 */
export function StageFooter({
  current,
  primary,
  disabled,
  nextLabel,
  onBeforeNext,
}: {
  current: StageKey;
  /** Optional extra button rendered left of the next-stage CTA (e.g. "view SEO pack"). */
  primary?: ReactNode;
  disabled?: boolean;
  /** Override the auto-derived next label. */
  nextLabel?: string;
  /** Optional guard: return false to block navigation. */
  onBeforeNext?: () => boolean | void;
}) {
  const navigate = useNavigate();
  const { active } = useActiveProfile();
  const stages = visibleStages(active);
  const idx = stages.findIndex((s) => s.id === current);
  const prev = idx > 0 ? stages[idx - 1] : null;
  const next = idx >= 0 && idx < stages.length - 1 ? stages[idx + 1] : null;

  const goNext = () => {
    if (!next) return;
    if (onBeforeNext && onBeforeNext() === false) return;
    navigate({ to: next.route });
  };

  return (
    <nav
      className="mt-8 flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between"
      aria-label="Pipeline navigation"
    >
      <div className="flex items-center gap-2">
        {prev ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate({ to: prev.route })}
            className="font-mono text-xs text-muted-foreground"
          >
            <ChevronLeft className="mr-1 h-3.5 w-3.5" />
            {prev.label.toLowerCase()}
          </Button>
        ) : (
          <span />
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {primary}
        {next && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={goNext}
              className="font-mono text-xs text-muted-foreground"
              title={`Skip to ${next.label}`}
            >
              <SkipForward className="mr-1 h-3.5 w-3.5" />
              skip
            </Button>
            <Button
              onClick={goNext}
              disabled={disabled}
              className="font-mono"
              size="sm"
            >
              {nextLabel ?? `→ ${next.label.toLowerCase()}`}
              <ChevronRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>
    </nav>
  );
}
