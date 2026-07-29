/**
 * Browser-only audio extraction. Decodes a video (or audio) File/Blob/URL,
 * downsamples to 16 kHz mono, and encodes a WAV blob suitable for uploading
 * to the Lovable AI transcription endpoint.
 *
 * WAV keeps things simple: every browser can decode a video's audio track
 * with AudioContext.decodeAudioData, and OpenAI's gpt-4o-mini-transcribe
 * happily accepts WAV. 16 kHz mono is plenty for STT and keeps the payload
 * far under the gateway's 25 MiB cap for typical short clips.
 */

const TARGET_SR = 16000;
const MAX_BYTES = 20_000_000;

export async function extractWav(source: File | Blob | string): Promise<Blob> {
  const buf =
    typeof source === "string"
      ? await (await fetch(source)).arrayBuffer()
      : await source.arrayBuffer();

  // Some browsers require an unlocked AudioContext; we're always in a user gesture
  // path (button click) by the time this runs so this is fine.
  const AC: typeof AudioContext =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window.AudioContext || (window as any).webkitAudioContext);
  const ctx = new AC();

  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(buf.slice(0));
  } finally {
    ctx.close().catch(() => {});
  }

  // Downmix to mono
  const src = decoded;
  const srcSr = src.sampleRate;
  const chans = src.numberOfChannels;
  const totalIn = src.length;
  const mono = new Float32Array(totalIn);
  for (let c = 0; c < chans; c++) {
    const ch = src.getChannelData(c);
    for (let i = 0; i < totalIn; i++) mono[i] += ch[i] / chans;
  }

  // Linear resample to TARGET_SR
  const ratio = srcSr / TARGET_SR;
  const outLen = Math.floor(totalIn / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const t = i * ratio;
    const i0 = Math.floor(t);
    const i1 = Math.min(totalIn - 1, i0 + 1);
    const frac = t - i0;
    out[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
  }

  // Trim tail if resulting WAV would exceed MAX_BYTES (16-bit mono → 2 bytes/sample)
  const maxSamples = Math.floor((MAX_BYTES - 44) / 2);
  const finalSamples = Math.min(out.length, maxSamples);
  const clipped = out.subarray(0, finalSamples);

  return encodeWav(clipped, TARGET_SR);
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const numChannels = 1;
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}
