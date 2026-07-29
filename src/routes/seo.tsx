import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Copy, Sparkles, RefreshCw } from "lucide-react";
import { useConfig, useProject, getStageOverride } from "@/lib/store";
import { generateFairUse } from "@/lib/fairuse.functions";
import { generateSeo } from "@/lib/seo.functions";
import { resolvePromptTextById } from "@/lib/prompt-registry";
import { toast } from "sonner";
import { StageHeader } from "@/components/stage/StageHeader";
import { ActivityPanel } from "@/components/stage/ActivityPanel";
import { useActivityLog } from "@/hooks/useActivityLog";
import { StageFooter } from "@/components/stage/StageFooter";

export const Route = createFileRoute("/seo")({
  component: SeoPage,
});

function copy(text: string, label: string) {
  navigator.clipboard.writeText(text);
  toast.success(`${label} copied`);
}

function CopyBtn({ text, label }: { text: string; label: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => copy(text, label)}
      className="h-7 gap-1.5 px-2 font-mono text-[10px] text-muted-foreground hover:text-primary"
    >
      <Copy className="h-3 w-3" />
      {label}
    </Button>
  );
}

function SeoPage() {
  const [project, setProject] = useProject();
  const [cfg] = useConfig();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [generatingSeo, setGeneratingSeo] = useState(false);
  const seo = project.seo;
  const activity = useActivityLog();

  async function generatePack() {
    if (!project.script?.trim()) {
      toast.error("Generate a script first.");
      return;
    }
    setGeneratingSeo(true);
    activity.start("generating SEO pack…");
    try {
      const res = await generateSeo({
        data: {
          title: project.meta?.title,
          script: project.script,
          products: project.products?.map((p) => ({
            name: p.name,
            affiliate_url:
              p.affiliate_url || project.amazon?.[p.name]?.[0]?.affiliateUrl,
          })),
          amazon: project.amazon,
          sourceUrl: project.videoId ? `https://youtu.be/${project.videoId}` : project.url,
          promptTemplateCommentary: resolvePromptTextById(cfg, "seo.commentary"),
          promptTemplateReview: resolvePromptTextById(cfg, "seo.review"),
          override: getStageOverride(cfg, "seo"),
        },
      });
      setProject({ seo: res });
      activity.stop("SEO pack ready", "ok");
      toast.success("SEO pack ready");
    } catch (e) {
      const msg = (e as Error).message;
      activity.stop(msg, "error");
      toast.error(msg);
    } finally {
      setGeneratingSeo(false);
    }
  }

  async function next() {
    if (!project.script) return;
    setLoading(true);
    activity.start("generating fair-use note…");
    try {
      const res = await generateFairUse({
        data: {
          sourceTitle: project.meta?.title,
          sourceAuthor: project.meta?.author,
          sourceUrl: project.videoId ? `https://youtu.be/${project.videoId}` : project.url,
          products: project.products?.map((p) => ({
            name: p.name,
            affiliate_url:
              p.affiliate_url || project.amazon?.[p.name]?.[0]?.affiliateUrl,
          })),
          script: project.script,
          promptTemplate: resolvePromptTextById(cfg, "fairuse.compliance"),
          override: getStageOverride(cfg, "fairuse"),
        },
      });
      setProject({ fairuse: res.fairuse });
      activity.stop("fair-use note ready", "ok");
      toast.success("fair-use note ready");
      navigate({ to: "/fair-use" });
    } catch (e) {
      const msg = (e as Error).message;
      activity.stop(msg, "error");
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell>
      <StageHeader
        current="seo"
        title="SEO pack"
        purpose="Title, description, chapters and tags — ready to paste into YouTube."
      />
      <div className="mb-4"><ActivityPanel activity={activity} /></div>
      {!seo ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <p className="mb-4 font-mono text-sm text-muted-foreground">
            No SEO pack yet.
          </p>
          <Button
            onClick={generatePack}
            disabled={generatingSeo || !project.script?.trim()}
            className="font-mono"
          >
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            {generatingSeo ? "generating…" : "generate SEO pack"}
          </Button>
          {!project.script?.trim() && (
            <p className="mt-3 font-mono text-[11px] text-muted-foreground">
              Generate a script first.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={generatePack}
              disabled={generatingSeo}
              className="h-8 gap-1.5 font-mono text-[11px]"
            >
              <RefreshCw className={`h-3 w-3 ${generatingSeo ? "animate-spin" : ""}`} />
              {generatingSeo ? "regenerating…" : "regenerate"}
            </Button>
          </div>

          <Section
            icon="🎬"
            title="Video title"
            meta={`${seo.title.length} chars`}
            actions={<CopyBtn text={seo.title} label="copy title" />}
          >
            <p className="text-lg font-semibold leading-snug">{seo.title}</p>
          </Section>

          <Section
            icon="📝"
            title="Description"
            actions={<CopyBtn text={seo.description} label="copy description" />}
          >
            <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm leading-relaxed">
              {seo.description}
            </div>
          </Section>

          <Section
            icon="⏱"
            title="Chapters"
            actions={<CopyBtn text={seo.chapters} label="copy chapters" />}
          >
            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
              {seo.chapters}
            </pre>
          </Section>

          <Section
            icon="🏷"
            title={`Tags · ${seo.tags.length}`}
            actions={
              <div className="flex gap-1.5">
                <CopyBtn text={seo.tags.join(", ")} label="copy comma-separated" />
                <CopyBtn text={seo.tags.join("\n")} label="copy one per line" />
              </div>
            }
          >
            <div className="flex flex-wrap gap-1.5">
              {seo.tags.map((t, i) => (
                <span
                  key={i}
                  className="rounded-sm bg-primary/15 px-2 py-0.5 font-mono text-[11px] text-primary"
                >
                  {t}
                </span>
              ))}
            </div>
          </Section>

        </div>
      )}
      <StageFooter
        current="seo"
        disabled={loading || !project.script}
        nextLabel={loading ? "drafting…" : undefined}
        onBeforeNext={() => {
          if (!project.script) {
            toast.error("Generate a script first.");
            return false;
          }
          // Kick off fair-use generation before letting the footer navigate.
          void next();
          return false;
        }}
      />
    </AppShell>
  );
}

function Section({
  icon,
  title,
  meta,
  actions,
  children,
}: {
  icon: string;
  title: string;
  meta?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
        <h4 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          <span className="mr-2">{icon}</span>
          {title}
          {meta && <span className="ml-2 text-muted-foreground/70">· {meta}</span>}
        </h4>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}
