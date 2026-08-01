import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { useConfig, applyOverrideToAllStages } from "@/lib/store";
import { searchAmazon } from "@/lib/amazon.functions";
import { toast } from "sonner";
import { Plus, Trash2, Zap, Database, HardDriveDownload } from "lucide-react";
import { useState, useEffect } from "react";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const [cfg, setCfg] = useConfig();
  const [stats, setStats] = useState<{ count: number; dbPath: string } | null>(null);
  const [clearing, setClearing] = useState(false);
  const [testingAmazon, setTestingAmazon] = useState(false);

  async function handleTestAmazon() {
    setTestingAmazon(true);
    try {
      const res = await searchAmazon({
        data: {
          query: "laptop",
          limit: 1,
          config: {
            mode: cfg.amazonApiMode,
            clientId: cfg.amazonClientId,
            clientSecret: cfg.amazonClientSecret,
            partnerTag: cfg.amazonPartnerTag,
            region: cfg.amazonRegion,
            marketplace: cfg.amazonMarketplace,
          }
        }
      });
      if (res.results.length > 0) {
        toast.success(`Success! Found ${res.results.length} item(s).`);
      } else {
        toast.warning("API call succeeded but returned 0 results.");
      }
    } catch (e: any) {
      toast.error(`Amazon API Error: ${e.message}`);
    } finally {
      setTestingAmazon(false);
    }
  }

  useEffect(() => {
    fetch("/api/sessions?stats=1")
      .then((r) => r.json())
      .then((d) => setStats(d as { count: number; dbPath: string }))
      .catch(() => {});
  }, []);

  async function clearServerData() {
    if (!confirm("Delete ALL saved sessions from the server? This cannot be undone.")) return;
    setClearing(true);
    try {
      const r = await fetch("/api/sessions", { method: "DELETE" });
      if (!r.ok) throw new Error(`${r.status}`);
      setStats((s) => (s ? { ...s, count: 0 } : null));
      toast.success("All server sessions cleared.");
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`);
    } finally {
      setClearing(false);
    }
  }

  function clearBrowserCache() {
    if (!confirm("Clear browser-stored project and blob cache? Your settings and API keys are NOT affected.")) return;
    try {
      localStorage.removeItem("foundry.project.v1");
      localStorage.removeItem("foundry.history.v1");
      // Clear IndexedDB blob store
      const req = indexedDB.deleteDatabase("foundry");
      req.onsuccess = () => toast.success("Browser cache cleared — refresh to start fresh.");
      req.onerror = () => toast.success("Browser cache cleared.");
    } catch {
      toast.error("Could not clear browser cache.");
    }
  }

  return (
    <AppShell title="settings">
      <div className="space-y-8">
        <section className="rounded-lg border border-border bg-card p-6">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-lg font-semibold">Global AI defaults</h3>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (!cfg.defaultHost || !cfg.defaultModel) {
                  toast.error("Fill host + model first.");
                  return;
                }
                applyOverrideToAllStages(cfg, setCfg, {});
                toast.success("All pipelines routed through Global default. Zero Lovable AI credits.");
              }}
              className="h-8 gap-1.5 font-mono text-[11px]"
            >
              <Zap className="h-3 w-3" /> Route ALL pipelines through Global
            </Button>
          </div>
          <p className="mb-4 text-xs text-muted-foreground">
            OpenAI-compatible endpoint used when a stage overrides Lovable AI. Values saved in your browser only.
            Click <em>Route ALL pipelines through Global</em> to send every stage (Analyze, Script, SEO, …) through this endpoint and stop using Lovable AI credits entirely.
          </p>
          <div className="grid gap-4 md:grid-cols-3">
            <Row label="host">
              <Input value={cfg.defaultHost} onChange={(e) => setCfg({ defaultHost: e.target.value })} placeholder="https://api.openai.com/v1" className="font-mono" />
            </Row>
            <Row label="api key">
              <Input value={cfg.defaultApiKey} onChange={(e) => setCfg({ defaultApiKey: e.target.value })} placeholder="sk-…" type="password" className="font-mono" />
            </Row>
            <Row label="model">
              <Input value={cfg.defaultModel} onChange={(e) => setCfg({ defaultModel: e.target.value })} className="font-mono" />
            </Row>
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card p-6">
          <h3 className="mb-1 text-lg font-semibold">Transcription</h3>
          <p className="mb-4 text-xs text-muted-foreground">
            YouTube captions always run when available (free, instant). This toggle only controls the in-browser Whisper fallback used when captions are missing.
          </p>
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-panel/40 p-3 hover:border-primary/40">
            <input
              type="checkbox"
              checked={cfg.transcribeAudio}
              onChange={(e) => setCfg({ transcribeAudio: e.target.checked })}
              className="mt-0.5 h-4 w-4 accent-primary"
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Transcribe audio (Whisper fallback)</div>
              <div className="mt-0.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
                off (default) = skip when no captions · best for Shorts / music-only videos ·
                on = server downloads audio via yt-dlp and transcribes with faster-whisper locally (1–3 min per clip). No cloud API needed.
              </div>
            </div>
            <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${cfg.transcribeAudio ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"}`}>
              {cfg.transcribeAudio ? "ON" : "OFF"}
            </span>
          </label>
        </section>


        <section className="rounded-lg border border-border bg-card p-6">
          <h3 className="mb-1 text-lg font-semibold">Gemini TTS · API keys</h3>
          <p className="mb-4 text-xs text-muted-foreground">
            Add one or more Google AI Studio keys. During voiceover generation they are tried in order — if the first is rate-limited or invalid, the next is used automatically.{" "}
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary hover:underline"
            >
              Get free keys ↗
            </a>{" "}
            (free tier: 15 req/min per key).
          </p>
          <div className="space-y-2">
            {cfg.voiceover.geminiApiKeys.length === 0 && (
              <div className="rounded-md border border-dashed border-border py-4 text-center font-mono text-xs text-muted-foreground">
                No keys yet — add one below.
              </div>
            )}
            {cfg.voiceover.geminiApiKeys.map((key, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-6 text-center font-mono text-[11px] text-muted-foreground">#{i + 1}</span>
                <Input
                  value={key}
                  onChange={(e) => {
                    const next = [...cfg.voiceover.geminiApiKeys];
                    next[i] = e.target.value;
                    setCfg({ voiceover: { ...cfg.voiceover, geminiApiKeys: next } });
                  }}
                  type="password"
                  placeholder="AIza…"
                  className="font-mono text-xs"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    const next = cfg.voiceover.geminiApiKeys.filter((_, idx) => idx !== i);
                    setCfg({ voiceover: { ...cfg.voiceover, geminiApiKeys: next } });
                  }}
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label="remove key"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setCfg({
                  voiceover: {
                    ...cfg.voiceover,
                    geminiApiKeys: [...cfg.voiceover.geminiApiKeys, ""],
                  },
                });
              }}
              className="h-8 gap-1.5 font-mono text-[11px]"
            >
              <Plus className="h-3 w-3" /> add key
            </Button>
          </div>
          <p className="mt-3 font-mono text-[10px] text-muted-foreground">
            Stored locally in your browser only. Voice, speed, model, and instructions live on the Voiceover page.
          </p>
        </section>




        <section className="rounded-lg border border-border bg-card p-6">
          <h3 className="mb-1 text-lg font-semibold">Amazon API Settings</h3>
          <p className="mb-4 text-xs text-muted-foreground">
            Configure the official Amazon Creators API (OAuth 2.0). If you want to use the legacy Lambda API, you can toggle it below.
            For USA setup, use Region NA and Marketplace www.amazon.com.
          </p>
          <div className="mb-4 space-y-3 rounded-md border border-border bg-panel p-4">
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="amazonApiMode"
                  checked={cfg.amazonApiMode === "creator"}
                  onChange={() => setCfg({ amazonApiMode: "creator" })}
                  className="accent-primary"
                />
                Official Creators API
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="amazonApiMode"
                  checked={cfg.amazonApiMode === "lambda"}
                  onChange={() => setCfg({ amazonApiMode: "lambda" })}
                  className="accent-primary"
                />
                Legacy Lambda API
              </label>
            </div>
            
            {cfg.amazonApiMode === "creator" && (
              <div className="grid gap-4 md:grid-cols-2">
                <Row label="Client ID">
                  <Input value={cfg.amazonClientId || ""} onChange={(e) => setCfg({ amazonClientId: e.target.value })} placeholder="amzn1.application-oa2-client..." className="font-mono text-xs" />
                </Row>
                <Row label="Client Secret">
                  <Input value={cfg.amazonClientSecret || ""} onChange={(e) => setCfg({ amazonClientSecret: e.target.value })} type="password" placeholder="secret..." className="font-mono text-xs" />
                </Row>
                <Row label="Partner Tag">
                  <Input value={cfg.amazonPartnerTag || "consecho-20"} onChange={(e) => setCfg({ amazonPartnerTag: e.target.value })} placeholder="store-20" className="font-mono text-xs" />
                </Row>
                <Row label="Region">
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    value={cfg.amazonRegion || "NA"}
                    onChange={(e) => setCfg({ amazonRegion: e.target.value as any })}
                  >
                    <option value="NA">NA (api.amazon.com)</option>
                    <option value="EU">EU (api.amazon.co.uk)</option>
                    <option value="FE">FE (api.amazon.co.jp)</option>
                  </select>
                </Row>
                <Row label="Marketplace">
                  <Input value={cfg.amazonMarketplace || "www.amazon.com"} onChange={(e) => setCfg({ amazonMarketplace: e.target.value })} placeholder="www.amazon.com" className="font-mono text-xs" />
                </Row>
              </div>
            )}

            {cfg.amazonApiMode === "creator" && (
              <div className="mt-4 flex flex-col gap-4 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={cfg.amazonUseLambdaFallback}
                    onChange={(e) => setCfg({ amazonUseLambdaFallback: e.target.checked })}
                    className="accent-primary"
                  />
                  Use Legacy Lambda API as fallback if Creators API fails
                </label>
                <Button 
                  onClick={handleTestAmazon} 
                  disabled={testingAmazon || !cfg.amazonClientId || !cfg.amazonClientSecret}
                  size="sm" 
                  variant="outline"
                >
                  {testingAmazon ? "Testing..." : "Test Creators API"}
                </Button>
              </div>
            )}

          </div>
        </section>

        <section className="rounded-lg border border-border bg-card p-6">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div>
              <h3 className="text-lg font-semibold">Custom model presets</h3>
              <p className="text-xs text-muted-foreground">
                Add any OpenAI-compatible host (OpenAI, OpenRouter, Groq, Together, local Ollama, etc.). Each preset appears in the model picker on the Commentary page.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const next = [
                  ...cfg.customModels,
                  {
                    id: `mp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                    label: "",
                    host: "",
                    apiKey: "",
                    model: "",
                  },
                ];
                setCfg({ customModels: next });
              }}
              className="h-8 gap-1.5 font-mono text-[11px]"
            >
              <Plus className="h-3 w-3" /> add preset
            </Button>
          </div>
          <div className="mt-4 space-y-3">
            {cfg.customModels.length === 0 && (
              <div className="rounded-md border border-dashed border-border py-6 text-center font-mono text-xs text-muted-foreground">
                No presets yet — click <em>add preset</em> to define a host, key, and model id.
              </div>
            )}
            {cfg.customModels.map((p, i) => (
              <div key={p.id} className="rounded-md border border-border bg-panel p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="font-mono text-[10px] uppercase text-muted-foreground">
                    preset #{i + 1}
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => {
                      setCfg({ customModels: cfg.customModels.filter((x) => x.id !== p.id) });
                    }}
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    aria-label="delete preset"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <Row label="label">
                    <Input
                      value={p.label}
                      onChange={(e) => {
                        const next = cfg.customModels.map((x) =>
                          x.id === p.id ? { ...x, label: e.target.value } : x,
                        );
                        setCfg({ customModels: next });
                      }}
                      placeholder="My OpenAI GPT-5"
                      className="font-mono text-xs"
                    />
                  </Row>
                  <Row label="model id">
                    <Input
                      value={p.model}
                      onChange={(e) => {
                        const next = cfg.customModels.map((x) =>
                          x.id === p.id ? { ...x, model: e.target.value } : x,
                        );
                        setCfg({ customModels: next });
                      }}
                      placeholder="openai/gpt-5 or gpt-4o-mini"
                      className="font-mono text-xs"
                    />
                  </Row>
                  <Row label="host">
                    <Input
                      value={p.host}
                      onChange={(e) => {
                        const next = cfg.customModels.map((x) =>
                          x.id === p.id ? { ...x, host: e.target.value } : x,
                        );
                        setCfg({ customModels: next });
                      }}
                      placeholder="https://api.openai.com/v1"
                      className="font-mono text-xs"
                    />
                  </Row>
                  <Row label="api key">
                    <Input
                      value={p.apiKey}
                      onChange={(e) => {
                        const next = cfg.customModels.map((x) =>
                          x.id === p.id ? { ...x, apiKey: e.target.value } : x,
                        );
                        setCfg({ customModels: next });
                      }}
                      type="password"
                      placeholder="sk-…"
                      className="font-mono text-xs"
                    />
                  </Row>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 font-mono text-[10px] text-muted-foreground">
            Stored locally in your browser only. Requests are sent OpenAI-compatible (POST /chat/completions with Authorization: Bearer &lt;key&gt;).
          </p>
        </section>

        {/* ── Data Management ─────────────────────────────────── */}
        <section className="rounded-lg border border-border bg-card p-6">
          <div className="mb-1 flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold">Data management</h3>
          </div>
          <p className="mb-5 text-xs text-muted-foreground">
            Sessions are stored in SQLite on the server (<code className="font-mono">/data/foundry.db</code>) and survive
            container restarts and re-deploys. Use these controls to free storage or start fresh.
          </p>

          {stats && (
            <div className="mb-5 flex items-center gap-4 rounded-md border border-border bg-panel px-4 py-3 font-mono text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <HardDriveDownload className="h-3.5 w-3.5" />
                <span>{stats.count} session{stats.count !== 1 ? "s" : ""} stored</span>
              </span>
              <span className="h-3 w-px bg-border" />
              <span className="truncate opacity-60">{stats.dbPath}</span>
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            <Button
              variant="destructive"
              size="sm"
              onClick={clearServerData}
              disabled={clearing || stats?.count === 0}
              className="gap-1.5 font-mono text-[11px]"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {clearing ? "Clearing…" : `Clear all server sessions${stats ? ` (${stats.count})` : ""}`}
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={clearBrowserCache}
              className="gap-1.5 font-mono text-[11px]"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear browser cache
            </Button>
          </div>

          <p className="mt-3 font-mono text-[10px] text-muted-foreground">
            "Clear server sessions" removes pipeline outputs and session history from the database.
            "Clear browser cache" removes the active project + audio/frame blobs from this browser only.
            API keys, model presets, and prompt templates are never affected by either action.
          </p>
        </section>
      </div>
    </AppShell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
