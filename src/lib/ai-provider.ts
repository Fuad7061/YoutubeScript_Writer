import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError } from "ai";

/**
 * Wrap an AI SDK call so cryptic provider errors (like "Invalid JSON response"
 * from a misconfigured OpenAI-compatible endpoint that returned HTML) surface
 * as a useful message instead of a raw stack trace in the UI.
 */
export async function runAi<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (APICallError.isInstance(err)) {
      const status = err.statusCode ? ` [HTTP ${err.statusCode}]` : "";
      const url = err.url ? ` at ${err.url}` : "";
      let bodyHint = "";
      const body = (err as unknown as { responseBody?: string }).responseBody;
      if (typeof body === "string" && body.trim()) {
        const trimmed = body.trim().slice(0, 400);
        bodyHint = ` — response: ${trimmed}${body.length > 400 ? "…" : ""}`;
      }
      const isInvalidJson = /invalid json/i.test(err.message);
      const hint = isInvalidJson
        ? " (the endpoint did not return an OpenAI-compatible JSON response — check the host URL, path, and that the model id is valid)"
        : "";
      throw new Error(`${label}${status}${url}: ${err.message}${hint}${bodyHint}`);
    }
    throw err;
  }
}

export type StageOverride = {
  useLovable?: boolean;
  /** UI routing mode; runtime still resolves via presetId or host/key/model. */
  mode?: "global" | "inline" | "preset";
  host?: string;
  apiKey?: string;
  model?: string;
  /** Optional reference to a custom-model preset id. */
  presetId?: string;

  /** When true, fail over to fallbackHost/fallbackApiKey/fallbackModel if primary model fails. */
  enableFallback?: boolean;
  fallbackHost?: string;
  fallbackApiKey?: string;
  fallbackModel?: string;
};

export type CustomModelPreset = {
  id: string;
  label: string;
  host: string;
  apiKey: string;
  model: string;
};

export const DEFAULT_MODEL = "";

/**
 * Resolve a user-facing model choice into a StageOverride payload.
 * Choice format:
 *   - "default"            → fall back to `stageDefault` (per-stage Settings)
 *   - "global"             → Global default host/key/model
 *   - "custom:<preset-id>" → user-defined host/key/model from Settings presets
 */
export type GlobalDefaults = { host?: string; apiKey?: string; model?: string };

export function resolveModelChoice(
  choice: string | undefined,
  presets: CustomModelPreset[],
  stageDefault: StageOverride,
  globals?: GlobalDefaults,
): StageOverride {
  const c = (choice || "default").trim();
  if (!c || c === "default") return stageDefault;
  if (c === "global" || c.startsWith("lovable:")) {
    if (globals?.host) {
      return { useLovable: false, host: globals.host, apiKey: globals.apiKey, model: globals.model };
    }
    return stageDefault;
  }
  if (c.startsWith("custom:")) {
    const id = c.slice("custom:".length);
    const p = presets.find((x) => x.id === id);
    if (!p) return stageDefault;
    return { useLovable: false, host: p.host, apiKey: p.apiKey, model: p.model };
  }
  return stageDefault;
}

export function resolveModel(override: StageOverride | undefined) {
  if (!override?.host) {
    throw new Error(
      "No AI model configured. Open Settings → Models and set a Global default host/key/model (or a custom preset).",
    );
  }

  const provider = createOpenAICompatible({
    name: "custom",
    baseURL: override.host!.replace(/\/$/, ""),
    headers: override.apiKey ? { Authorization: `Bearer ${override.apiKey}` } : {},
    fetch: sseTolerantFetch as typeof fetch,
  });
  return provider(override.model || DEFAULT_MODEL);
}

export function resolveFallbackModel(override: StageOverride | undefined) {
  if (!override?.enableFallback || !override?.fallbackHost) {
    return null;
  }
  const provider = createOpenAICompatible({
    name: "custom-fallback",
    baseURL: override.fallbackHost.replace(/\/$/, ""),
    headers: override.fallbackApiKey ? { Authorization: `Bearer ${override.fallbackApiKey}` } : {},
    fetch: sseTolerantFetch as typeof fetch,
  });
  return provider(override.fallbackModel || DEFAULT_MODEL);
}

/**
 * Some OpenAI-compatible proxies (n8n, custom gateways) always stream SSE even
 * when the client asked for a non-streaming JSON response. The AI SDK then
 * fails with "Invalid JSON response". This fetch wrapper detects an SSE
 * `text/event-stream` reply to a non-stream request and reassembles the deltas
 * into a single OpenAI chat.completion JSON payload.
 */
const sseTolerantFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input as RequestInfo, init);
  const ct = res.headers.get("content-type") || "";
  let wantsStream = false;
  try {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body) wantsStream = JSON.parse(body)?.stream === true;
  } catch {
    /* ignore */
  }
  if (wantsStream || !ct.includes("text/event-stream")) return res;

  const text = await res.text();
  const merged = mergeSseToChatCompletion(text);
  if (!merged) return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify(merged), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
};

function mergeSseToChatCompletion(sse: string): Record<string, unknown> | null {
  const events: Array<Record<string, unknown>> = [];
  for (const line of sse.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.*)$/);
    if (!m) continue;
    const payload = m[1].trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      /* skip malformed */
    }
  }
  if (events.length === 0) return null;

  let id = "";
  let model = "";
  let created = 0;
  let role = "assistant";
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let usage: unknown = undefined;
  const toolCalls: Record<number, { id?: string; type?: string; function: { name?: string; arguments: string } }> = {};

  for (const ev of events) {
    if (typeof ev.id === "string") id = ev.id;
    if (typeof ev.model === "string") model = ev.model;
    if (typeof ev.created === "number") created = ev.created;
    if (ev.usage) usage = ev.usage;
    const choices = (ev.choices as Array<Record<string, unknown>>) || [];
    for (const c of choices) {
      const delta = (c.delta as Record<string, unknown>) || (c.message as Record<string, unknown>) || {};
      if (typeof delta.role === "string") role = delta.role;
      if (typeof delta.content === "string") content += delta.content;
      if (typeof (delta as { reasoning_content?: unknown }).reasoning_content === "string") {
        reasoning += (delta as { reasoning_content: string }).reasoning_content;
      }
      const tcs = (delta as { tool_calls?: Array<Record<string, unknown>> }).tool_calls;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          const slot = (toolCalls[idx] ||= { function: { arguments: "" } });
          if (typeof tc.id === "string") slot.id = tc.id;
          if (typeof tc.type === "string") slot.type = tc.type;
          const fn = tc.function as { name?: string; arguments?: string } | undefined;
          if (fn?.name) slot.function.name = fn.name;
          if (typeof fn?.arguments === "string") slot.function.arguments += fn.arguments;
        }
      }
      if (typeof c.finish_reason === "string") finishReason = c.finish_reason;
    }
  }

  // Salvage: some reasoning models (o-series / R1-style) stream the full answer
  // into `reasoning_content` and leave `content` null. If reasoning contains a
  // JSON object or fenced code block, promote it into `content` so the AI SDK's
  // `text` isn't empty. Preserve the raw reasoning for debugging.
  let finalContent = content;
  if (!finalContent && reasoning) {
    const fenced = reasoning.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced && fenced[1].trim()) {
      finalContent = fenced[1].trim();
    } else {
      const first = reasoning.indexOf("{");
      const last = reasoning.lastIndexOf("}");
      if (first !== -1 && last > first) {
        const candidate = reasoning.slice(first, last + 1).trim();
        try {
          JSON.parse(candidate);
          finalContent = candidate;
        } catch {
          /* not valid JSON — leave content empty so caller can throw a clear error */
        }
      }
    }
  }

  const message: Record<string, unknown> = { role, content: finalContent || null };
  if (reasoning) (message as { reasoning_content?: string }).reasoning_content = reasoning;

  const tcArr = Object.keys(toolCalls)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => toolCalls[Number(k)]);
  if (tcArr.length) message.tool_calls = tcArr;

  return {
    id: id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason || "stop" }],
    usage,
  };
}
