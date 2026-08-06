/**
 * Browser-side speech-to-text using @xenova/transformers (Whisper Tiny English).
 * Runs 100% in the browser via WASM — no server, no API keys, no credits.
 *
 * First run downloads ~40MB of model weights (cached by the browser afterwards).
 * Only suitable for short clips; long audio should be chunked by the caller.
 */

// Module-level so the ~40MB model is downloaded/loaded exactly once per tab.
let pipelinePromise: Promise<unknown> | undefined;

async function getPipeline(
  model: string,
  onProgress?: (p: { status: string; progress?: number }) => void,
) {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const mod = (await import("@huggingface/transformers")) as unknown as {
        pipeline: (task: string, model: string, opts?: unknown) => Promise<unknown>;
        env: { allowLocalModels: boolean; useBrowserCache: boolean };
      };
      mod.env.allowLocalModels = false;
      mod.env.useBrowserCache = true;

      // Throttle repetitive per-file progress spam so the Activity Panel
      // stays readable (the raw stream emits dozens of identical lines/sec).
      const lastEmit = new Map<string, number>();
      const emit = (p: { status?: string; progress?: number; file?: string }) => {
        const key = `${p.status ?? ""}·${p.file ?? ""}`;
        const now = Date.now();
        const last = lastEmit.get(key) ?? 0;
        // Always let "done" / "ready" through; throttle "progress" to 1 line / 500ms per file.
        if (p.status !== "progress" || now - last > 500) {
          lastEmit.set(key, now);
          const label = p.file ? `${p.status ?? "loading"} ${p.file}` : (p.status ?? "loading");
          onProgress?.({ status: label, progress: p.progress });
        }
      };

      // Prefer per-file dtype: fp32 encoder + q4 decoder is small (~40MB) and
      // avoids the broken q8 quantized decoder that ships with the legacy
      // Xenova repo (missing MatMulNBits scales → session-create crash).
      const tryLoad = async (opts: Record<string, unknown>) => {
        return mod.pipeline("automatic-speech-recognition", model, {
          device: "wasm",
          progress_callback: emit,
          ...opts,
        } as unknown);
      };

      try {
        return await tryLoad({
          dtype: { encoder_model: "fp32", decoder_model_merged: "q4" },
        });
      } catch (e1) {
        console.warn("[whisper] q4 decoder failed, retrying fp32:", e1);
        try {
          return await tryLoad({ dtype: "fp32" });
        } catch (e2) {
          const msg = e2 instanceof Error ? e2.message : String(e2);
          throw new Error(`whisper model load failed: ${msg}`);
        }
      }
    })().catch((e) => {
      pipelinePromise = undefined;
      throw e;
    });
  }
  return pipelinePromise;
}



async function blobToFloat32(blob: Blob): Promise<{ audio: Float32Array; sampleRate: number }> {
  const AudioCtx =
    (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as
      | typeof AudioContext
      | undefined;
  if (!AudioCtx) throw new Error("Web Audio API unavailable in this browser.");
  const ctx = new AudioCtx();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
    // Downmix to mono
    const channels = decoded.numberOfChannels;
    const length = decoded.length;
    const out = new Float32Array(length);
    for (let ch = 0; ch < channels; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < length; i++) out[i] += data[i] / channels;
    }
    return { audio: out, sampleRate: decoded.sampleRate };
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

function resample(audio: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return audio;
  const ratio = from / to;
  const outLen = Math.floor(audio.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, audio.length - 1);
    const frac = src - i0;
    out[i] = audio[i0] * (1 - frac) + audio[i1] * frac;
  }
  return out;
}

export async function transcribeWithBrowserWhisper(
  audio: Blob,
  opts: {
    model?: string;
    onProgress?: (p: { status: string; progress?: number }) => void;
  } = {},
): Promise<string> {
  const model = opts.model ?? "onnx-community/whisper-base.en";
  opts.onProgress?.({ status: "loading model" });

  // Race model load against a timeout so a stuck HF/CDN fetch surfaces
  // instead of hanging the pipeline forever.
  const loadTimeoutMs = 90_000;
  const pipe = (await Promise.race([
    getPipeline(model, opts.onProgress),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`whisper model load timed out after ${loadTimeoutMs / 1000}s`)), loadTimeoutMs),
    ),
  ])) as (
    input: Float32Array,
    opts?: { chunk_length_s?: number; stride_length_s?: number },
  ) => Promise<{ text?: string } | Array<{ text?: string }>>;

  opts.onProgress?.({ status: "decoding audio" });
  const { audio: pcm, sampleRate } = await blobToFloat32(audio);
  const resampled = resample(pcm, sampleRate, 16000);

  opts.onProgress?.({ status: "transcribing" });
  const transcribeTimeoutMs = 180_000;
  const result = await Promise.race([
    pipe(resampled, { chunk_length_s: 30, stride_length_s: 5 }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`whisper transcribe timed out after ${transcribeTimeoutMs / 1000}s`)), transcribeTimeoutMs),
    ),
  ]) as { text?: string } | Array<{ text?: string }>;
  const text = Array.isArray(result)
    ? result.map((r) => r.text ?? "").join(" ")
    : (result.text ?? "");
  return text.trim();
}
