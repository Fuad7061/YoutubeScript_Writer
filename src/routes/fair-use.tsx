import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Copy, Plus } from "lucide-react";
import { useProject } from "@/lib/store";
import { toast } from "sonner";
import { StageHeader } from "@/components/stage/StageHeader";
import { StageFooter } from "@/components/stage/StageFooter";

export const Route = createFileRoute("/fair-use")({
  component: FairUsePage,
});

function copy(text: string, label: string) {
  navigator.clipboard.writeText(text.trim());
  toast.success(`${label} copied`);
}

type Section = { icon: string; title: string; body: string };

/** Split markdown output on top-level `## ` headings. */
function parseSections(md: string): Section[] {
  if (!md) return [];
  const parts = md.split(/\n(?=##\s)/g);
  return parts
    .map((chunk) => {
      const m = chunk.match(/^##\s+(\S+)\s+(.+?)\n([\s\S]*)$/);
      if (!m) return null;
      return { icon: m[1], title: m[2].trim(), body: m[3].trim() };
    })
    .filter((s): s is Section => !!s);
}

function CopyBtn({ text, label }: { text: string; label: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => copy(text, label)}
      className="h-7 gap-1.5 px-2 font-mono text-[10px] text-muted-foreground hover:text-primary"
    >
      <Copy className="h-3 w-3" /> copy {label}
    </Button>
  );
}

function FairUsePage() {
  const [project, setProject] = useProject();
  const md = project.fairuse ?? "";
  const sections = useMemo(() => parseSections(md), [md]);

  // Disclosure section is the first one — used by the "append to SEO"
  // action so the description users paste to YouTube already includes
  // the FTC + fair-use block.
  const disclosure = sections.find((s) => /disclosure/i.test(s.title));

  function appendToSeo() {
    if (!disclosure || !project.seo) return;
    if (project.seo.description.includes(disclosure.body.trim().slice(0, 40))) {
      toast.info("disclosure already in SEO description");
      return;
    }
    setProject({
      seo: {
        ...project.seo,
        description: `${project.seo.description.trimEnd()}\n\n${disclosure.body.trim()}`,
      },
    });
    toast.success("appended to SEO description");
  }

  return (
    <AppShell>
      <StageHeader
        current="fairuse"
        title="Fair use & disclosure"
        purpose="FTC + Amazon Associates + §107 disclosure block, ready to paste into the video description."
      />
      {!md ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center font-mono text-sm text-muted-foreground">
          Nothing yet.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
            ⚖️ Ready to paste. The <strong className="text-foreground">disclosure</strong> block
            below covers FTC + Amazon Associates + fair-use §107 requirements. YouTube has no
            "fair use" opt-in — the disclosure is documentation, not a shield against Content ID.
            Use the checklist before publishing.
          </div>

          {sections.map((s) => {
            const isDisclosure = s === disclosure;
            return (
              <section
                key={s.title}
                className="rounded-lg border border-border bg-card overflow-hidden"
              >
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
                  <h4 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                    <span className="mr-2">{s.icon}</span>
                    {s.title}
                  </h4>
                  <div className="flex gap-1.5">
                    {isDisclosure && project.seo && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={appendToSeo}
                        className="h-7 gap-1.5 px-2 font-mono text-[10px] text-muted-foreground hover:text-primary"
                      >
                        <Plus className="h-3 w-3" /> append to SEO description
                      </Button>
                    )}
                    <CopyBtn
                      text={s.body}
                      label={s.title.split(/\s+/)[0].toLowerCase()}
                    />
                  </div>
                </header>
                {isDisclosure ? (
                  <pre className="whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed text-foreground">
                    {s.body}
                  </pre>
                ) : (
                  <article className="prose prose-sm dark:prose-invert max-w-none p-4 leading-relaxed prose-headings:font-mono prose-headings:uppercase prose-headings:tracking-wider">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{s.body}</ReactMarkdown>
                  </article>
                )}
              </section>
            );
          })}

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => copy(md, "full markdown")}
              className="h-7 gap-1.5 px-2 font-mono text-[10px] text-muted-foreground hover:text-primary"
            >
              <Copy className="h-3 w-3" /> copy full markdown
            </Button>
          </div>

          <details className="rounded-lg border border-border bg-card">
            <summary className="cursor-pointer px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground">
              view raw markdown
            </summary>
            <pre className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed text-muted-foreground">
              {md}
            </pre>
          </details>
        </div>
      )}
      <StageFooter current="fairuse" />
    </AppShell>
  );
}
