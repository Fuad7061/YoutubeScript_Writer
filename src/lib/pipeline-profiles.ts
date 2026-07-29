/**
 * Pipeline Profiles — maps WorkflowDefinitions to user-editable PipelineProfiles.
 *
 * Built-in profiles are generated automatically from the WORKFLOWS registry
 * (src/pipelines/_core/registry.ts). Adding a new workflow to the registry
 * automatically surfaces it here — no manual edits to this file needed.
 *
 * Users can duplicate, rename, and customize any profile. Custom profiles
 * are stored in localStorage (browser-only, not synced to server).
 */

import { useSyncExternalStore } from "react";
import type { InputMode, StageConfig, StageKey } from "@/pipelines/_core/types";
import { STAGES, WORKFLOWS, stageById } from "@/pipelines/_core/registry";

export type PipelineProfile = {
  id: string;
  name: string;
  mode: InputMode;
  stageOrder: StageKey[];
  stages: Partial<Record<StageKey, StageConfig>>;
  isBuiltIn?: boolean;
  description?: string;
};

const KEY = "foundry.profiles.v1";
const ACTIVE_KEY = "foundry.profiles.active.v1";

function buildStageConfig(
  stageOrder: StageKey[],
  overrides?: Partial<Record<string, Partial<StageConfig>>>,
): Partial<Record<StageKey, StageConfig>> {
  const out: Partial<Record<StageKey, StageConfig>> = {};
  for (const s of STAGES) {
    const d = { ...s.defaults };
    const wo = overrides?.[s.id] ?? {};
    out[s.id] = { ...d, ...wo, enabled: stageOrder.includes(s.id) };
  }
  return out;
}

/**
 * Auto-generated built-in profiles from the workflow registry.
 * Adding a workflow to registry.ts auto-creates a profile here.
 */
export const BUILTIN_PROFILES: PipelineProfile[] = WORKFLOWS.map((w) => ({
  id: `builtin.${w.id}`,
  name: w.name,
  mode: w.mode,
  description: w.description,
  isBuiltIn: true,
  stageOrder: w.stageOrder,
  stages: buildStageConfig(w.stageOrder, w.stageDefaults),
}));

function readAll(): PipelineProfile[] {
  if (typeof window === "undefined") return BUILTIN_PROFILES;
  try {
    const raw = localStorage.getItem(KEY);
    const user = raw ? (JSON.parse(raw) as PipelineProfile[]) : [];
    // Always merge built-ins first so new stages/workflows appear after upgrade.
    return [...BUILTIN_PROFILES, ...user.filter((p) => !p.isBuiltIn)];
  } catch {
    return BUILTIN_PROFILES;
  }
}

function writeAll(list: PipelineProfile[]) {
  if (typeof window === "undefined") return;
  const user = list.filter((p) => !p.isBuiltIn);
  localStorage.setItem(KEY, JSON.stringify(user));
  window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
}

function subscribe(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  const h = () => cb();
  window.addEventListener("storage", h);
  return () => window.removeEventListener("storage", h);
}

export function useProfiles() {
  const raw = useSyncExternalStore(
    subscribe,
    () => JSON.stringify(readAll()),
    () => JSON.stringify(BUILTIN_PROFILES),
  );
  const profiles = JSON.parse(raw) as PipelineProfile[];

  return {
    profiles,
    save: (p: PipelineProfile) => {
      const list = readAll().filter((x) => x.id !== p.id);
      writeAll([...list, p]);
    },
    remove: (id: string) => {
      const list = readAll().filter((x) => x.id !== id || x.isBuiltIn);
      writeAll(list);
    },
    duplicate: (id: string) => {
      const src = readAll().find((x) => x.id === id);
      if (!src) return;
      const copy: PipelineProfile = {
        ...src,
        id: `user.${Date.now().toString(36)}`,
        name: `${src.name} (copy)`,
        isBuiltIn: false,
        stages: JSON.parse(JSON.stringify(src.stages)) as PipelineProfile["stages"],
      };
      writeAll([...readAll(), copy]);
    },
  };
}

export function useActiveProfile(): {
  activeId: string;
  active: PipelineProfile;
  setActive: (id: string) => void;
  setActiveByMode: (mode: InputMode) => void;
} {
  const { profiles } = useProfiles();
  const raw = useSyncExternalStore(
    subscribe,
    () => (typeof window !== "undefined" ? localStorage.getItem(ACTIVE_KEY) || "" : ""),
    () => "",
  );
  const activeId = raw || profiles[0].id;
  const active = profiles.find((p) => p.id === activeId) ?? profiles[0];

  return {
    activeId: active.id,
    active,
    setActive: (id) => {
      if (typeof window === "undefined") return;
      localStorage.setItem(ACTIVE_KEY, id);
      window.dispatchEvent(new StorageEvent("storage", { key: ACTIVE_KEY }));
    },
    setActiveByMode: (mode) => {
      const match =
        profiles.find((p) => p.mode === mode && p.isBuiltIn) ??
        profiles.find((p) => p.mode === mode);
      if (!match) return;
      if (typeof window === "undefined") return;
      localStorage.setItem(ACTIVE_KEY, match.id);
      window.dispatchEvent(new StorageEvent("storage", { key: ACTIVE_KEY }));
    },
  };
}

/** Ordered visible stages for a profile — excludes disabled. */
export function visibleStages(profile: PipelineProfile) {
  return profile.stageOrder
    .filter((id) => profile.stages[id]?.enabled !== false)
    .map((id) => stageById[id])
    .filter(Boolean);
}
