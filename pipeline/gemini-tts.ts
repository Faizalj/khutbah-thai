/**
 * The project's only TTS path: Gemini gemini-3.8-flash-lite-tts via the Interactions API.
 * No other model or provider, no fallback.
 *
 * geminiTts(text, outPath, label) writes one MP3 take (24 kHz mono) for config.yaml tts.voice + tts.style.
 * Cache: output/tts-cache/<sha256(model, voice, style, text)>.mp3, so a re-run with the same text costs no request
 * and takes from another model/voice are never reused.
 * The model's daily quota (~100 requests per Pacific day) is shared across projects: every request is booked in
 * output/tts-ledger.jsonl, and the first HTTP 429 or 402 stops the whole run at once (exit 75, no retry).
 */
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export const MODEL = "gemini-3.8-flash-lite-tts";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const ROOT = import.meta.dir.replace("/pipeline", "");
const CONFIG = parseYaml(readFileSync(join(ROOT, "config.yaml"), "utf-8"));
const CACHE = join(ROOT, "output", "tts-cache");
const LEDGER = join(ROOT, "output", "tts-ledger.jsonl");
export const VOICE: string = CONFIG.tts.voice;
export const STYLE: string = String(CONFIG.tts.style ?? "").trim();

if (CONFIG.tts.model !== MODEL) {
  throw new Error(`config.yaml tts.model must be ${MODEL} (got ${CONFIG.tts.model})`);
}

let key: string | undefined;
function apiKey(): string {
  if (key) return key;
  const envPath = join(homedir(), ".claude/.env");
  const env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  key = process.env.GEMINI_API_KEY || env.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!key) throw new Error("no GEMINI_API_KEY in the environment or ~/.claude/.env");
  return key;
}

const book = (label: string, status: string, detail?: string) =>
  appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), model: MODEL, voice: VOICE, label, status, detail }) + "\n");

/** One take → outPath (MP3). Returns true when it came from the cache (no request). */
export async function geminiTts(text: string, outPath: string, label: string): Promise<boolean> {
  mkdirSync(CACHE, { recursive: true });
  const hit = join(CACHE, createHash("sha256").update(`${MODEL}\n${VOICE}\n${STYLE}\n${text}`).digest("hex") + ".mp3");
  if (existsSync(hit)) {
    copyFileSync(hit, outPath);
    return true;
  }

  const body = {
    model: MODEL,
    input: [{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style: STYLE }] }] }],
    response_format: { type: "audio" },
    generation_config: { speech_config: [{ voice: VOICE }] },
  };

  let json: { steps?: { content?: { type?: string; data?: string; mime_type?: string }[] }[] } | undefined;
  for (let attempt = 0; ; attempt++) {
    book(label, "request");
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    }).catch((e: unknown) => e as Error);
    if (!(res instanceof Error) && res.ok) {
      json = await res.json();
      break;
    }
    const detail = res instanceof Error ? `network: ${res.message}` : `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
    book(label, "failed", detail);
    if (!(res instanceof Error) && (res.status === 429 || res.status === 402)) {
      console.error(`tts: ${detail}\nquota hit: stopping (no retry)`);
      process.exit(75);
    }
    if (attempt >= 1) throw new Error(`tts: ${detail}`);
    console.error(`tts: ${detail.slice(0, 160)}; one retry in 20 s`);
    await Bun.sleep(20_000);
  }

  const parts = (json?.steps ?? []).flatMap((s) => s.content ?? []).filter((c) => c.type === "audio" && c.data);
  if (!parts.length) throw new Error(`tts: no audio in response: ${JSON.stringify(json).slice(0, 300)}`);
  const audio = Buffer.concat(parts.map((p) => Buffer.from(p.data!, "base64")));
  const mime = parts[0].mime_type ?? "";
  const raw = !["RIFF", "OggS", "fLaC"].includes(audio.subarray(0, 4).toString("latin1")) || /l16|pcm/i.test(mime);
  const rate = mime.match(/rate=(\d+)/)?.[1] ?? "24000";
  const ff = Bun.spawnSync(
    ["ffmpeg", "-y", "-loglevel", "error", ...(raw ? ["-f", "s16le", "-ar", rate, "-ac", "1"] : []), "-i", "pipe:0",
      "-ar", "24000", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", hit],
    { stdin: audio },
  );
  if (ff.exitCode !== 0) throw new Error(`ffmpeg: ${ff.stderr.toString().slice(0, 300)}`);
  book(label, "ok");
  copyFileSync(hit, outPath);
  return false;
}
