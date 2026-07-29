import { useMemo, useState } from "react";
import { Settings2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  alternatesForStage,
  stepsForStage,
  type PromptId,
} from "@/lib/prompt-registry";
import { useConfig } from "@/lib/store";
import type { StageKey } from "@/pipelines/_core/types";
import { PromptEditor } from "./PromptEditor";
import { StageBehaviorPanel } from "./StageBehaviorPanel";
import { StageModelPanel } from "./StageModelPanel";


/**
 * Gear-icon drawer shown in every StageHeader.
 * Tabs:
 *   • Prompts   — Alternates (one is "active" and runs) + Steps (each always
 *                 runs at its point in the pipeline; only text is editable).
 *   • Behavior  — stage-specific toggles.
 */
export function StageGearDrawer({ stage, stageLabel }: { stage: StageKey; stageLabel: string }) {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useConfig();
  const alternates = useMemo(() => alternatesForStage(stage), [stage]);
  const steps = useMemo(() => stepsForStage(stage), [stage]);
  const allPrompts = useMemo(() => [...alternates, ...steps], [alternates, steps]);
  const activeAlternateId =
    (cfg.activePrompts?.[stage] as PromptId | undefined) ?? alternates[0]?.id ?? null;
  const [editingId, setEditingId] = useState<PromptId | null>(
    activeAlternateId ?? steps[0]?.id ?? null,
  );

  const setStageActive = (id: PromptId) => {
    setCfg({ activePrompts: { ...(cfg.activePrompts ?? {}), [stage]: id } });
  };

  const customCount = useMemo(() => {
    let n = 0;
    for (const p of allPrompts) {
      const legacy = p.legacyConfigKey ? cfg[p.legacyConfigKey] : "";
      const override = cfg.promptOverrides?.[p.id] ?? "";
      if ((legacy && legacy.length > 0) || (override && override.length > 0)) n++;
    }
    return n;
  }, [allPrompts, cfg]);

  const editingMeta = editingId ? allPrompts.find((p) => p.id === editingId) : null;
  const isEditingAlternate = editingMeta?.kind === "alternate";

  const chip = (id: PromptId, label: string, opts: { isEditing: boolean; isActive?: boolean }) => (
    <button
      key={id}
      type="button"
      onClick={() => setEditingId(id)}
      className={
        "rounded border px-2 py-1 font-mono text-[10px] transition " +
        (opts.isEditing
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:text-foreground")
      }
    >
      {label}
      {opts.isActive && (
        <span className="ml-1 rounded bg-emerald-500/15 px-1 text-[9px] text-emerald-600 dark:text-emerald-400">
          active
        </span>
      )}
    </button>
  );

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={`${stageLabel} settings`}
          title={`${stageLabel} settings`}
          className="relative inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
        >
          <Settings2 className="h-4 w-4" />
          {customCount > 0 && (
            <span
              className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-primary"
              title={`${customCount} customized prompt${customCount === 1 ? "" : "s"}`}
            />
          )}
        </button>
      </SheetTrigger>

      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border bg-panel/50 p-4">
          <SheetTitle className="font-mono text-sm">{stageLabel} · settings</SheetTitle>
          <SheetDescription className="text-xs">
            Customize the prompts, behavior, and defaults for this stage. Changes are saved locally
            and applied on the next run.
          </SheetDescription>
        </SheetHeader>

        <Tabs defaultValue="prompts" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-4 mt-3 grid w-auto grid-cols-3 self-start">
            <TabsTrigger value="model" className="text-xs">
              Model
            </TabsTrigger>
            <TabsTrigger value="prompts" className="text-xs">
              Prompts{allPrompts.length ? ` · ${allPrompts.length}` : ""}
            </TabsTrigger>
            <TabsTrigger value="behavior" className="text-xs">
              Behavior
            </TabsTrigger>
          </TabsList>

          <TabsContent value="model" className="p-4 pt-3">
            <StageModelPanel stage={stage} />
          </TabsContent>


          <TabsContent
            value="prompts"
            className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 pt-3"
          >
            {allPrompts.length === 0 ? (
              <div className="rounded border border-dashed border-border p-4 text-xs text-muted-foreground">
                No editable prompts registered for this stage yet. The stage still runs on its
                built-in defaults.
              </div>
            ) : (
              <>
                {alternates.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        Alternates
                      </span>
                      <span className="text-[10px] text-muted-foreground/70">
                        pick one · runs when the stage generates
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {alternates.map((p) =>
                        chip(p.id, p.label, {
                          isEditing: editingId === p.id,
                          isActive: activeAlternateId === p.id,
                        }),
                      )}
                    </div>
                  </div>
                )}

                {steps.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        Pipeline steps
                      </span>
                      <span className="text-[10px] text-muted-foreground/70">
                        each runs in place · edit only
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {steps.map((p) => chip(p.id, p.label, { isEditing: editingId === p.id }))}
                    </div>
                  </div>
                )}

                {editingId && isEditingAlternate && alternates.length > 1 && (
                  <div className="flex items-center justify-between gap-2 rounded border border-border bg-panel/40 px-2.5 py-1.5">
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {activeAlternateId === editingId
                        ? "This alternate runs when the stage generates."
                        : "Editing a non-active alternate. Runtime still uses the active one."}
                    </span>
                    {activeAlternateId !== editingId && (
                      <button
                        type="button"
                        onClick={() => setStageActive(editingId)}
                        className="rounded border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary hover:bg-primary/20"
                      >
                        Use this as active
                      </button>
                    )}
                  </div>
                )}

                {editingId && <PromptEditor id={editingId} />}
              </>
            )}
          </TabsContent>

          <TabsContent value="behavior" className="p-4 pt-3">
            <StageBehaviorPanel stage={stage} />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
