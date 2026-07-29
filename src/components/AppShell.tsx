import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";
import { History, Plus, MoreHorizontal, ChevronRight } from "lucide-react";
import { useHistory, useProject, useGlobalProcess } from "@/lib/store";
import { useHydrated } from "@/lib/use-hydrated";
import { STAGES } from "@/pipelines/_core/registry";
import { useActiveProfile, useProfiles, visibleStages } from "@/lib/pipeline-profiles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { CommandPalette, useCommandPalette } from "@/components/CommandPalette";
import { toast } from "sonner";

function relTime(ts: number) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function AppShell({ children, title }: { children: ReactNode; title?: string }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [project] = useProject();
  const { active, setActive, setActiveByMode } = useActiveProfile();
  const { history, startNewSession, loadSession, deleteSession } = useHistory(active.mode);
  const navigate = useNavigate();
  const { profiles } = useProfiles();
  const { open: cmdOpen, setOpen: setCmdOpen } = useCommandPalette();
  const hydrated = useHydrated();
  const { isProcessing, abortAllProcesses } = useGlobalProcess();

  const currentStage = STAGES.find((s) => s.route === pathname);
  const breadcrumb =
    pathname === "/"
      ? "Input"
      : pathname === "/settings"
        ? "Settings"
        : currentStage?.label ?? pathname.replace(/^\//, "");

  const { doneCount, totalCount, nextRoute } = useMemo(() => {
    const vis = visibleStages(active);
    let done = 0;
    let next: string | null = null;
    for (const s of vis) {
      if (s.hasOutput?.(project)) done++;
      else if (!next) next = s.route;
    }
    return { doneCount: done, totalCount: vis.length, nextRoute: next };
  }, [active, project]);

  const handleNewSession = () => {
    startNewSession();
    toast.success("New session started");
    navigate({ to: "/" });
  };

  const handleLoad = (id: string) => {
    loadSession(id);
    const entry = history.find((e) => e.id === id);
    if (entry?.project?.mode) {
      setActiveByMode(entry.project.mode);
    }
    toast.success("Session restored");
    navigate({ to: "/" });
  };

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background text-foreground">
        <AppSidebar onOpenCommand={() => setCmdOpen(true)} onNewSession={handleNewSession} onLoadSession={handleLoad} />

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top bar — contextual only (nav lives in sidebar) */}
          <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur">
            <SidebarTrigger />
            <div className="flex min-w-0 items-center gap-2 text-sm">
              {/* Profile switcher inline in breadcrumb */}
              <DropdownMenu>
                <DropdownMenuTrigger className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground">
                  <span>{hydrated ? active.name : ""}</span>
                  <ChevronRight className="h-3 w-3 rotate-90 opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuLabel className="text-xs uppercase tracking-wider">
                    Switch profile
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {profiles.map((p) => (
                    <DropdownMenuItem
                      key={p.id}
                      onSelect={() => setActive(p.id)}
                      className="text-xs"
                    >
                      {p.name}
                      {p.id === active.id && (
                        <span className="ml-auto font-mono text-[10px] text-primary">active</span>
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="text-muted-foreground">/</span>
              <span className="truncate font-medium">{breadcrumb}</span>
              {hydrated && project.meta?.title && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {project.meta.title.slice(0, 60)}
                  </span>
                </>
              )}
            </div>

            <div className="ml-auto flex items-center gap-2">
              {/* Global Stop Button */}
              {isProcessing && (
                <button
                  onClick={abortAllProcesses}
                  className="flex items-center gap-2 rounded-full border border-destructive bg-destructive/10 px-2.5 py-1 font-mono text-[10px] font-bold text-destructive hover:bg-destructive/20 transition animate-pulse"
                  title="Stop all running processes immediately"
                >
                  <span className="h-2 w-2 rounded-sm bg-destructive"></span>
                  STOP
                </button>
              )}

              {/* Progress pill — click to jump to next todo stage */}
              {hydrated && totalCount > 0 && (
                <button
                  onClick={() => nextRoute && navigate({ to: nextRoute })}
                  disabled={!nextRoute}
                  className="hidden items-center gap-2 rounded-full border border-border bg-panel px-2.5 py-1 font-mono text-[10px] text-muted-foreground transition hover:text-foreground disabled:opacity-60 sm:flex"
                  title={nextRoute ? "Jump to next stage" : "All stages complete"}
                >
                  <span className="tabular-nums">
                    {doneCount}<span className="text-muted-foreground/60">/{totalCount}</span>
                  </span>
                  <span className="uppercase tracking-wider">stages</span>
                  {nextRoute && <ChevronRight className="h-3 w-3" />}
                </button>
              )}

              {/* Session menu — groups New, History, Command palette */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  aria-label="Session menu"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuItem onSelect={handleNewSession}>
                    <Plus className="mr-2 h-3.5 w-3.5" />
                    <span className="text-xs">New session</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setCmdOpen(true)}>
                    <span className="text-xs">Command palette</span>
                    <kbd className="ml-auto rounded bg-muted px-1 font-mono text-[10px]">⌘K</kbd>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <History className="mr-2 h-3.5 w-3.5" />
                      <span className="text-xs">
                        History{hydrated ? ` · ${history.length}` : ""}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-80">
                      <DropdownMenuLabel className="text-xs uppercase tracking-wider">
                        Last {history.length}/3 sessions
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {history.length === 0 && (
                        <div className="px-2 py-3 text-xs text-muted-foreground">
                          No saved sessions yet.
                        </div>
                      )}
                      {history.map((h) => (
                        <DropdownMenuItem
                          key={h.id}
                          className="flex items-start justify-between gap-2"
                          onSelect={(e) => {
                            e.preventDefault();
                            handleLoad(h.id);
                          }}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-medium">{h.label}</div>
                            <div className="font-mono text-[10px] text-muted-foreground">
                              {relTime(h.savedAt)} · {h.project.mode ?? "—"}
                            </div>
                          </div>
                          <button
                            className="font-mono text-[10px] text-muted-foreground hover:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteSession(h.id);
                            }}
                          >
                            ✕
                          </button>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>

          <main className="min-w-0 flex-1">
            <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-8">
              {title && (
                <div className="mb-6 flex items-baseline justify-between border-b border-border pb-4">
                  <h1 className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
                    {title}
                  </h1>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {project.videoId ? `vid:${project.videoId}` : "no video"}
                  </span>
                </div>
              )}
              {children}
            </div>
          </main>
        </div>

        <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />
      </div>
    </SidebarProvider>
  );
}
