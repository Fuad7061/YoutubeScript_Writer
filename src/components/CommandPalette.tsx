import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { STAGES } from "@/pipelines/_core/registry";
import { useHistory } from "@/lib/store";
import { useProfiles, useActiveProfile } from "@/lib/pipeline-profiles";
import { toast } from "sonner";

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const navigate = useNavigate();
  const { active, setActive } = useActiveProfile();
  const { history, startNewSession, loadSession } = useHistory(active.mode);
  const { profiles } = useProfiles();

  const go = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Jump to stage, switch profile, load session…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>

        <CommandGroup heading="Go to">
          <CommandItem onSelect={() => go(() => navigate({ to: "/" }))}>Input</CommandItem>
          {STAGES.map((s) => (
            <CommandItem key={s.id} onSelect={() => go(() => navigate({ to: s.route }))}>
              <s.icon className="mr-2 h-4 w-4" />
              {s.label}
            </CommandItem>
          ))}
          <CommandItem onSelect={() => go(() => navigate({ to: "/settings" }))}>
            Settings
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem
            onSelect={() =>
              go(() => {
                startNewSession();
                toast.success("New session started");
                navigate({ to: "/" });
              })
            }
          >
            New session
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Switch profile">
          {profiles.map((p) => (
            <CommandItem key={p.id} onSelect={() => go(() => setActive(p.id))}>
              {p.name}
              <span className="ml-auto font-mono text-[10px] text-muted-foreground">{p.mode}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        {history.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Recent sessions">
              {history.map((h) => (
                <CommandItem
                  key={h.id}
                  onSelect={() =>
                    go(() => {
                      loadSession(h.id);
                      navigate({ to: "/" });
                    })
                  }
                >
                  <span className="truncate">{h.label}</span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {new Date(h.savedAt).toLocaleDateString()}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}

export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  return { open, setOpen };
}
