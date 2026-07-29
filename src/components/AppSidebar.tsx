import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { Check, Circle, Plus, Settings2, Command as CmdIcon, History, X, Trash2 } from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { STAGES } from "@/pipelines/_core/registry";
import type { StageDefinition } from "@/pipelines/_core/types";
import { useActiveProfile, useProfiles, visibleStages } from "@/lib/pipeline-profiles";
import { useProject, useHistory } from "@/lib/store";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";

export function AppSidebar({ onOpenCommand, onNewSession, onLoadSession }: { onOpenCommand?: () => void; onNewSession?: () => void; onLoadSession?: (id: string) => void }) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [project] = useProject();
  const { profiles } = useProfiles();
  const { active, setActive } = useActiveProfile();
  const { history, loadSession, deleteSession, clearCurrentSession } = useHistory(active.mode);
  const hydrated = useHydrated();
  const navigate = useNavigate();
  const hasCurrent = Boolean(
    project.videoId ||
      project.meta?.title ||
      project.analysis ||
      project.analysisSource?.title ||
      project.analysisSource?.filename ||
      (project.products && project.products.length) ||
      (project.transcript && project.transcript.length) ||
      project.script ||
      project.url,
  );


  const visible = visibleStages(active);
  const visibleIds = new Set(visible.map((s) => s.id));

  const stageStatus = (s: StageDefinition): "done" | "current" | "todo" | "off" => {
    if (!visibleIds.has(s.id)) return "off";
    if (pathname === s.route) return "current";
    if (s.hasOutput?.(project)) return "done";
    return "todo";
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <Link to="/" className="flex items-center gap-2 px-2 py-1.5">
          <div className="h-6 w-6 shrink-0 rounded bg-primary amber-glow" />
          {!collapsed && (
            <span className="font-mono text-sm tracking-tight">
              FOUNDRY<span className="text-muted-foreground">/</span>
              <span className="text-muted-foreground">review</span>
            </span>
          )}
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {!collapsed && (
          <SidebarGroup>
            <SidebarGroupLabel>Profile</SidebarGroupLabel>
            <SidebarGroupContent className="px-2">
              <Select value={active.id} onValueChange={setActive}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={p.id} className="text-xs">
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        <SidebarGroup>
          <SidebarGroupLabel className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/80">
            <span className="h-px flex-1 bg-sidebar-border" />
            <span>Pipeline</span>
            <span className="h-px flex-1 bg-sidebar-border" />
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname === "/"} tooltip="Input">
                  <Link to="/">
                    <Plus className="h-4 w-4" />
                    <span>Input</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {STAGES.map((s) => {
                const status = stageStatus(s);
                const Icon = s.icon;
                return (
                  <SidebarMenuItem key={s.id}>
                    <SidebarMenuButton
                      asChild
                      isActive={status === "current"}
                      tooltip={s.label}
                      className={cn(status === "off" && "opacity-40")}
                    >
                      <Link to={s.route}>
                        <Icon className="h-4 w-4" />
                        <span
                          className={cn(
                            "flex-1",
                            status === "off" && "line-through decoration-muted-foreground/50",
                          )}
                        >
                          {s.label}
                        </span>
                        {status === "done" && (
                          <Check className="h-3 w-3 shrink-0 text-primary" />
                        )}
                        {status === "todo" && (
                          <Circle className="h-2 w-2 shrink-0 text-muted-foreground/40" />
                        )}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {!collapsed && hydrated && (
          <>
            <div className="mx-3 my-2 border-t border-sidebar-border/60" />
            <SidebarGroup>
              <SidebarGroupLabel className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/80">
                <span className="h-px flex-1 bg-sidebar-border" />
                <span className="flex items-center gap-1.5">
                  <History className="h-3 w-3" />
                  Recent sessions
                </span>
                <span className="h-px flex-1 bg-sidebar-border" />
                <span className="rounded-sm bg-muted px-1.5 font-mono text-[9px] text-muted-foreground">
                  {history.length}/3
                </span>
              </SidebarGroupLabel>
              <SidebarGroupContent className="px-2 space-y-2">
                {hasCurrent && (
                  <button
                    onClick={() => {
                      if (
                        confirm(
                          "Erase the current session? This clears the active project and its cached audio/frames from this browser. History entries are kept.",
                        )
                      ) {
                        clearCurrentSession();
                        navigate({ to: "/" });
                      }
                    }}
                    className="flex w-full items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-left text-[11px] text-destructive transition hover:bg-destructive/10"
                    title="Clear the currently loaded project"
                  >
                    <Trash2 className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">Erase current session</span>
                  </button>
                )}
                {history.length === 0 ? (

                  <div className="rounded-md border border-dashed border-sidebar-border/60 px-2 py-3 text-center font-mono text-[10px] text-muted-foreground">
                    No saved sessions yet
                  </div>
                ) : (
                  <ul className="space-y-1">
                    {history.map((h) => {
                      const isCurrent = h.project.videoId && project.videoId === h.project.videoId;
                      return (
                        <li
                          key={h.id}
                          className={cn(
                            "group flex items-center gap-1 rounded-md border px-1.5 py-1.5 text-xs transition",
                            isCurrent
                              ? "border-primary/40 bg-primary/5"
                              : "border-transparent hover:border-sidebar-border hover:bg-sidebar-accent",
                          )}
                        >
                          <button
                            onClick={() => {
                              if (onLoadSession) onLoadSession(h.id);
                              else loadSession(h.id);
                            }}
                            className="min-w-0 flex-1 text-left"
                            title={h.label}
                          >
                            <div className="truncate text-[11px] font-medium">{h.label}</div>
                            <div className="truncate font-mono text-[9px] text-muted-foreground">
                              {new Date(h.savedAt).toLocaleDateString()} · {h.project.mode ?? "—"}
                            </div>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (confirm(`Delete session "${h.label}"? This clears its cached audio and frames and cannot be undone.`)) {
                                deleteSession(h.id);
                              }
                            }}
                            className="rounded p-1 text-muted-foreground/70 transition hover:bg-destructive/10 hover:text-destructive"
                            aria-label="Delete session"
                            title="Delete session"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </SidebarGroupContent>
            </SidebarGroup>
          </>
        )}

        {collapsed && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton tooltip={`History · ${history.length}`}>
                    <History className="h-4 w-4" />
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          {onNewSession && (
            <SidebarMenuItem>
              <SidebarMenuButton onClick={onNewSession} tooltip="New session">
                <Plus className="h-4 w-4" />
                <span>New session</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {onOpenCommand && (
            <SidebarMenuItem>
              <SidebarMenuButton onClick={onOpenCommand} tooltip="Command palette (⌘K)">
                <CmdIcon className="h-4 w-4" />
                <span>Command</span>
                <kbd className="ml-auto hidden font-mono text-[10px] text-muted-foreground sm:inline">⌘K</kbd>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={pathname === "/settings"} tooltip="Settings">
              <Link to="/settings">
                <Settings2 className="h-4 w-4" />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
