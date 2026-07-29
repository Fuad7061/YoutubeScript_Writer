import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useConfig, useProject, getStageOverride, CLEAR_DOWNSTREAM } from "@/lib/store";
import { extractProducts } from "@/lib/products.functions";
import { resolvePromptTextById } from "@/lib/prompt-registry";
import { searchAmazon, type AmazonMatch } from "@/lib/amazon.functions";
import { fetchAmazonByAsins, parseAsin } from "@/lib/amazon-input.functions";
import { toast } from "sonner";
import { StageHeader } from "@/components/stage/StageHeader";
import { StageFooter } from "@/components/stage/StageFooter";
import { ActivityPanel } from "@/components/stage/ActivityPanel";
import { useActivityLog } from "@/hooks/useActivityLog";
import {
  Sparkles,
  DollarSign,
  Link2,
  ExternalLink,
  Edit2,
  Check,
  X,
  Plus,
  Trash2,
  Tag,
  RefreshCw,
  Star,
} from "lucide-react";
import type { Product } from "@/lib/types";

export const Route = createFileRoute("/products")({
  component: ProductsPage,
});

const emptyProduct: Product = {
  name: "",
  category: "",
  brand: "",
  description: "",
  key_feature: "",
  estimated_price: "",
  affiliate_url: "",
};

function ProductsPage() {
  const [project, setProject] = useProject();
  const [cfg] = useConfig();
  const navigate = useNavigate();

  const [editingId, setEditingId] = useState<number | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [form, setForm] = useState<Product>(emptyProduct);
  const [rerunning, setRerunning] = useState(false);
  const [fetchingAmazon, setFetchingAmazon] = useState<string | null>(null);
  const [replacingId, setReplacingId] = useState<number | null>(null);
  const [replaceInput, setReplaceInput] = useState("");
  const [replaceBusy, setReplaceBusy] = useState(false);
  const autoFetchedRef = useRef(false);
  const activity = useActivityLog();

  const products = project.products ?? [];
  const amazon = project.amazon ?? {};

  // Auto-fetch Amazon references for any product that doesn't have one yet.
  useEffect(() => {
    if (autoFetchedRef.current) return;
    if (!products.length) return;
    const missing = products.filter(
      (p) => !amazon[p.name]?.length && !/lookup failed/i.test(p.mentioned_context ?? ""),
    );
    if (!missing.length) return;
    autoFetchedRef.current = true;
    (async () => {
      const next: Record<string, AmazonMatch[]> = { ...amazon };
      activity.start(`looking up Amazon matches for ${missing.length} product${missing.length === 1 ? "" : "s"}…`);
      for (const p of missing.slice(0, 15)) {
        try {
          const query = p.amazon_search_query?.trim() || [p.brand, p.name].filter(Boolean).join(" ").trim() || p.name;
          activity.log(`searching · ${query}`);
          const r = await searchAmazon({ data: { query, limit: 3 } });
          if (r.results.length) {
            next[p.name] = r.results;
            activity.log(`${p.name} · ${r.results.length} match${r.results.length === 1 ? "" : "es"}`, "ok");
          } else {
            activity.log(`${p.name} · no match`, "warn");
          }
        } catch (e) {
          activity.log(`${p.name} · ${(e as Error).message}`, "warn");
          console.warn("amazon lookup failed for", p.name, e);
        }
      }
      setProject({ amazon: next });
      activity.stop("Amazon lookups complete", "ok");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products.length]);

  function startEdit(idx: number) {
    setEditingId(idx);
    setForm({ ...emptyProduct, ...products[idx] });
  }

  function saveEdit(idx: number) {
    const updated = [...products];
    updated[idx] = { ...updated[idx], ...form };
    setProject({ products: updated, ...CLEAR_DOWNSTREAM });
    setEditingId(null);
  }

  function removeProduct(idx: number) {
    const updated = products.filter((_, i) => i !== idx);
    setProject({ products: updated, ...CLEAR_DOWNSTREAM });
  }

  function addProduct() {
    if (!form.name.trim()) return;
    setProject({ products: [...products, { ...form }], ...CLEAR_DOWNSTREAM });
    setIsAdding(false);
    setForm(emptyProduct);
  }

  async function refetchAmazon(p: Product) {
    setFetchingAmazon(p.name);
    try {
      const query = p.amazon_search_query?.trim() || [p.brand, p.name].filter(Boolean).join(" ").trim() || p.name;
      const r = await searchAmazon({ data: { query, limit: 3 } });
      setProject({ amazon: { ...amazon, [p.name]: r.results } });
      toast.success("Amazon reference updated");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setFetchingAmazon(null);
    }
  }

  async function replaceWithAsin(idx: number) {
    const asin = parseAsin(replaceInput);
    if (!asin) {
      toast.error("Enter a valid ASIN or amazon.com URL");
      return;
    }
    setReplaceBusy(true);
    try {
      const r = await fetchAmazonByAsins({ data: { urls: [replaceInput] } });
      if (!r.products.length || r.failed.length) {
        throw new Error(`Lookup failed for ${asin}`);
      }
      const oldName = products[idx].name;
      const newProduct = r.products[0];
      const updated = [...products];
      updated[idx] = newProduct;
      const nextAmazon = { ...amazon };
      delete nextAmazon[oldName];
      if (r.amazon[newProduct.name]) nextAmazon[newProduct.name] = r.amazon[newProduct.name];
      setProject({ products: updated, amazon: nextAmazon, ...CLEAR_DOWNSTREAM });
      setReplacingId(null);
      setReplaceInput("");
      toast.success(`Replaced with ${asin}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setReplaceBusy(false);
    }
  }

  async function rerun() {
    const fullText = (project.transcript ?? []).map((s) => s.text).join(" ");
    if (!fullText) {
      toast.error("no transcript loaded");
      return;
    }
    setRerunning(true);
    activity.start("re-extracting products from transcript…");
    try {
      const r = await extractProducts({
        data: {
          transcript: fullText,
          title: project.meta?.title,
          frames: project.frames,
          promptTemplate: resolvePromptTextById(cfg, "products.extract"),
          override: getStageOverride(cfg, "products"),
        },
      });
      setProject({ products: r.products, amazon: {}, ...CLEAR_DOWNSTREAM });
      autoFetchedRef.current = false;
      activity.stop(`extracted ${r.products.length} products`, "ok");
      toast.success(`extracted ${r.products.length} products`);
    } catch (e) {
      const msg = (e as Error).message;
      activity.stop(msg, "error");
      toast.error(msg);
    } finally {
      setRerunning(false);
    }
  }

  return (
    <AppShell>
      <StageHeader
        current="products"
        title="Identified products"
        purpose="Products extracted from the transcript, enriched with Amazon matches when available."
      />
      <ActivityPanel activity={activity} />
      <div className="mb-6 flex flex-wrap items-center justify-end gap-2">
        <Button
          onClick={() => {
            setIsAdding(true);
            setForm(emptyProduct);
          }}
          variant="outline"
          size="sm"
          className="font-mono text-xs"
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> Add product
        </Button>
        <Button
          onClick={rerun}
          disabled={rerunning || !project.transcript}
          variant="outline"
          size="sm"
          className="font-mono text-xs"
        >
          {rerunning ? "re-extracting…" : "↻ re-extract"}
        </Button>
      </div>

      {isAdding && (
        <ProductForm
          form={form}
          setForm={setForm}
          onCancel={() => setIsAdding(false)}
          onSave={addProduct}
          heading="New product"
        />
      )}

      {!products.length && !isAdding ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center font-mono text-sm text-muted-foreground">
          No products yet — run stage 01 first, or add one manually.
        </div>
      ) : (
        <div className="space-y-4">
          {products.map((p, i) => {
            if (editingId === i) {
              return (
                <ProductForm
                  key={i}
                  form={form}
                  setForm={setForm}
                  onCancel={() => setEditingId(null)}
                  onSave={() => saveEdit(i)}
                  heading={`Editing #${String(i + 1).padStart(2, "0")}`}
                />
              );
            }
            const match = amazon[p.name]?.[0];
            const failed = /lookup failed/i.test(p.mentioned_context ?? "");
            return (
              <div key={i} className={`rounded-lg border ${failed ? "border-destructive/50" : "border-border"} bg-card p-6`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[10px] text-muted-foreground">
                        #{String(i + 1).padStart(2, "0")}
                      </span>
                      <h3 className="text-lg font-semibold text-primary">{p.name}</h3>
                      {failed && (
                        <span className="rounded-sm bg-destructive/20 px-1.5 py-0.5 font-mono text-[10px] text-destructive">
                          lookup failed
                        </span>
                      )}
                      {p.brand && (
                        <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {p.brand}
                        </span>
                      )}
                      {p.category && (
                        <span className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-primary">
                          <Tag className="h-3 w-3" />
                          {p.category}
                        </span>
                      )}
                      {p.confidence != null && (
                        <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {Math.round(p.confidence * 100)}%
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      onClick={() => {
                        setReplacingId(replacingId === i ? null : i);
                        setReplaceInput("");
                      }}
                      className={`rounded-md border p-1.5 ${failed ? "border-destructive/50 text-destructive hover:bg-destructive/10" : "border-border text-muted-foreground hover:text-primary"}`}
                      aria-label="replace ASIN"
                      title="Replace with another ASIN / Amazon URL"
                    >
                      <Link2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => startEdit(i)}
                      className="rounded-md border border-border p-1.5 text-muted-foreground hover:text-primary"
                      aria-label="edit"
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => removeProduct(i)}
                      className="rounded-md border border-border p-1.5 text-muted-foreground hover:text-destructive"
                      aria-label="delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {(replacingId === i || failed) && (
                  <div className="mt-3 rounded-md border border-primary/40 bg-primary/5 p-3">
                    {failed && (
                      <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-destructive">
                        Amazon lookup failed — paste a replacement ASIN or URL below to auto-fill this product.
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        autoFocus={replacingId === i}
                        placeholder="Paste new ASIN (e.g. B0113UZJE2) or amazon.com URL"
                        value={replacingId === i ? replaceInput : ""}
                        onFocus={() => {
                          if (replacingId !== i) setReplacingId(i);
                        }}
                        onChange={(e) => {
                          if (replacingId !== i) setReplacingId(i);
                          setReplaceInput(e.target.value);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !replaceBusy) replaceWithAsin(i);
                        }}
                        className="min-w-64 flex-1 font-mono text-xs"
                      />
                      <Button
                        onClick={() => replaceWithAsin(i)}
                        disabled={replaceBusy || replacingId !== i || !replaceInput.trim()}
                        size="sm"
                        className="font-mono"
                      >
                        <RefreshCw className={`mr-1 h-3.5 w-3.5 ${replaceBusy ? "animate-spin" : ""}`} />
                        {replaceBusy ? "fetching…" : "fetch & replace"}
                      </Button>
                      {replacingId === i && !failed && (
                        <Button
                          onClick={() => {
                            setReplacingId(null);
                            setReplaceInput("");
                          }}
                          variant="ghost"
                          size="sm"
                          className="font-mono"
                        >
                          cancel
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                {p.description && (
                  <p className="mt-3 text-sm text-muted-foreground">{p.description}</p>
                )}



                <div className="mt-4 grid gap-4 rounded-md border border-border bg-panel p-4 sm:grid-cols-3">
                  <Cell
                    icon={<Sparkles className="h-3 w-3 text-primary" />}
                    label="Key feature / USP"
                    value={p.key_feature}
                  />
                  <Cell
                    icon={<DollarSign className="h-3 w-3 text-primary" />}
                    label="Estimated price"
                    value={p.estimated_price}
                    mono
                  />
                  <div>
                    <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      <Link2 className="h-3 w-3 text-primary" /> Product link
                    </div>
                    {(p.affiliate_url || match?.affiliateUrl) ? (
                      <a
                        href={p.affiliate_url || match?.affiliateUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-flex items-center gap-1 truncate text-sm text-primary hover:underline"
                      >
                        View affiliate link <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <div className="mt-1 text-sm text-muted-foreground">—</div>
                    )}
                  </div>
                </div>

                {p.mentioned_context && (
                  <div className="mt-3 border-l-2 border-primary/40 pl-3 text-xs italic text-muted-foreground">
                    "{p.mentioned_context}"
                  </div>
                )}

                {p.amazon_search_query && (
                  <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-panel px-3 py-2">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">
                      Amazon query:
                    </span>
                    <code className="truncate font-mono text-xs text-primary">{p.amazon_search_query}</code>
                  </div>
                )}

                {/* Amazon reference block */}
                <div className="mt-4 rounded-md border border-border bg-panel p-4">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        Amazon reference
                      </span>
                      {match?.brand && (
                        <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                          {match.brand}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => refetchAmazon(p)}
                      disabled={fetchingAmazon === p.name}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground hover:text-primary"
                    >
                      <RefreshCw
                        className={`h-3 w-3 ${fetchingAmazon === p.name ? "animate-spin" : ""}`}
                      />
                      {match ? "Re-fetch" : fetchingAmazon === p.name ? "Fetching…" : "Fetch"}
                    </button>
                  </div>

                  {match ? (
                    <div className="flex gap-4">
                      {match.image ? (
                        <img
                          src={match.image}
                          alt=""
                          className="h-24 w-24 shrink-0 rounded border border-border bg-white/5 object-contain p-1"
                        />
                      ) : (
                        <div className="h-24 w-24 shrink-0 rounded bg-muted" />
                      )}
                      <div className="min-w-0 flex-1 space-y-1.5 text-sm">
                        <div className="grid grid-cols-[60px_1fr] gap-2">
                          <span className="font-mono text-[10px] uppercase text-muted-foreground">
                            Title:
                          </span>
                          <span className="line-clamp-2 font-medium">{match.title}</span>
                        </div>
                        {match.affiliateUrl && (
                          <div className="grid grid-cols-[60px_1fr] gap-2">
                            <span className="font-mono text-[10px] uppercase text-muted-foreground">
                              Link:
                            </span>
                            <a
                              href={match.affiliateUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="truncate text-primary hover:underline"
                            >
                              {match.affiliateUrl}
                            </a>
                          </div>
                        )}
                        <div className="flex items-center gap-3 pt-1">
                          {match.price && (
                            <span className="font-mono text-base font-semibold text-primary">
                              {match.price}
                            </span>
                          )}
                          {match.rating && (
                            <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
                              <Star className="h-3 w-3 fill-primary text-primary" /> {match.rating}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">
                      {fetchingAmazon === p.name
                        ? "Searching Amazon…"
                        : "No Amazon match yet — click Fetch."}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <StageFooter current="products" disabled={!products.length} />
    </AppShell>
  );
}

function Cell({
  icon,
  label,
  value,
  mono,
}: {
  icon: React.ReactNode;
  label: string;
  value?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {icon} {label}
      </div>
      <div className={`mt-1 text-sm ${mono ? "font-mono font-medium" : ""}`}>
        {value || <span className="text-muted-foreground">—</span>}
      </div>
    </div>
  );
}

function ProductForm({
  form,
  setForm,
  onCancel,
  onSave,
  heading,
}: {
  form: Product;
  setForm: (p: Product) => void;
  onCancel: () => void;
  onSave: () => void;
  heading: string;
}) {
  return (
    <div className="mb-4 rounded-lg border border-primary/40 bg-card p-6">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-mono text-xs uppercase tracking-wider text-primary">{heading}</h3>
        <div className="flex gap-1">
          <button
            onClick={onSave}
            className="rounded-md border border-primary bg-primary/10 p-1.5 text-primary hover:bg-primary/20"
            aria-label="save"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onCancel}
            className="rounded-md border border-border p-1.5 text-muted-foreground hover:text-foreground"
            aria-label="cancel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="grid gap-3">
        <Input
          placeholder="Product name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="font-medium"
        />
        <Textarea
          placeholder="Description"
          value={form.description ?? ""}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          className="min-h-16 text-sm"
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <Input
            placeholder="Brand (optional)"
            value={form.brand ?? ""}
            onChange={(e) => setForm({ ...form, brand: e.target.value })}
            className="text-xs"
          />
          <Input
            placeholder="Category"
            value={form.category ?? ""}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            className="text-xs"
          />
          <Input
            placeholder="Est. price (e.g. $50-120)"
            value={form.estimated_price ?? ""}
            onChange={(e) => setForm({ ...form, estimated_price: e.target.value })}
            className="text-xs"
          />
        </div>
        <Input
          placeholder="Key feature / USP"
          value={form.key_feature ?? ""}
          onChange={(e) => setForm({ ...form, key_feature: e.target.value })}
          className="text-sm"
        />
        <Input
          placeholder="Affiliate URL (optional)"
          value={form.affiliate_url ?? ""}
          onChange={(e) => setForm({ ...form, affiliate_url: e.target.value })}
          className="text-xs font-mono"
        />
      </div>
    </div>
  );
}
