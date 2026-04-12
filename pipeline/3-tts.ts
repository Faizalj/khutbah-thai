#!/usr/bin/env bun
/**
 * Stage 3: TTS
 * Thai translation → ElevenLabs speech audio (Faizal's voice clone)
 *
 * Usage: bun pipeline/3-tts.ts [YYYY-MM-DD] [makkah|madinah]
 *
 * Reads translation-th.md, strips markdown, chunks to ~1500 chars,
 * calls ElevenLabs API per chunk, concatenates via ffmpeg.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { parse as parseYaml } from "yaml";
import { join } from "path";

const ROOT = import.meta.dir.replace("/pipeline", "");
const CONFIG = parseYaml(readFileSync(join(ROOT, "config.yaml"), "utf-8"));

// ElevenLabs config
const VOICE_ID = CONFIG.tts.voice_id;
const MODEL = "eleven_v3";
const LANG = "th";
const API_KEY = (() => {
  const envFile = readFileSync(join(process.env.HOME!, ".env"), "utf-8");
  const match = envFile.match(/ELEVENLABS_API_KEY=(.+)/);
  return match?.[1]?.trim() || "";
})();

if (!API_KEY) {
  console.error("❌ ELEVENLABS_API_KEY not found in ~/.env");
  process.exit(1);
}

/** Strip markdown formatting to get clean TTS-ready narration text */
function stripMarkdown(md: string): string {
  // Remove YAML frontmatter only if file literally starts with ---
  let text = md;
  if (text.startsWith("---\n")) {
    const endIdx = text.indexOf("\n---\n", 4);
    if (endIdx > 0) text = text.slice(endIdx + 5);
  }

  return text
    // Remove headers (## คุฏบะฮ์แรก, etc)
    .replace(/^#{1,6}\s+.*$/gm, "")
    // Remove horizontal rules
    .replace(/^---+$/gm, "")
    // Remove chunk markers (ส่วนที่ 1/3, คุฏบะฮ์แรก — ส่วนที่ 1/3, etc)
    .replace(/.*ส่วนที่\s+\d+\/\d+.*/g, "")
    // Remove metadata lines in any format
    .replace(/^-?\s*\*{0,2}(วันที่|เชค|แหล่งที่มา|Date|Sheikh|Source).*$/gim, "")
    // Remove URLs
    .replace(/https?:\/\/\S+/g, "")
    // Remove image/link markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Remove inline code
    .replace(/`[^`]*`/g, "")

    // === Fix Arabic Islamic term pronunciation (safety net) ===
    // Symbols → full Thai phonetic
    .replace(/ﷺ/g, " ศ็อลลัลลอฮุอะลัยฮิวะซัลลัม ")
    .replace(/\(ร\.ฎ\.\)/g, " เราะฎิยัลลอฮุอันฮุ ")
    .replace(/\(ร\.ฮ\.\)/g, " เราะฮิมะฮุลลอฮ์ ")
    // Arabic text that may leak through
    .replace(/صلى الله عليه وسلم/g, " ศ็อลลัลลอฮุอะลัยฮิวะซัลลัม ")
    .replace(/سبحانه وتعالى/g, " ซุบฮานะฮูวะตะอาลา ")
    .replace(/رضي الله عنه/g, " เราะฎิยัลลอฮุอันฮุ ")
    .replace(/رحمه الله/g, " เราะฮิมะฮุลลอฮ์ ")
    // Common misspellings from translation
    .replace(/สุบหานะฮู/g, "ซุบฮานะฮู")
    .replace(/ตักวา/g, "ตั๊กวา")
    .replace(/เนียวมัต|เนียมัต/g, "เนี๊ยะมัต")
    .replace(/ซาลาวาน/g, "เศาะลาวาต")

    // Remove bold/italic markers (after term replacement)
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    // Remove blockquote markers but keep text
    .replace(/^>\s*/gm, "")
    // Remove bullet list markers but keep text
    .replace(/^[-*]\s+/gm, "")

    // Collapse multiple newlines
    .replace(/\n{3,}/g, "\n\n")
    // Collapse multiple spaces
    .replace(/\s{2,}/g, " ")
    // Trim
    .trim();
}

/** Split text into chunks of ~maxChars, breaking at sentence boundaries.
 *  Handles both paragraph-separated and single-block text */
function chunkText(text: string, maxChars: number = 1500, minChars: number = 300): string[] {
  // First try paragraph split
  let segments = text.split(/\n\n+/).filter(s => s.trim().length > 0);

  // If only 1 big paragraph, split by sentences (. followed by space or newline)
  if (segments.length <= 1 && text.length > maxChars) {
    segments = text.split(/(?<=\.)\s+/).filter(s => s.trim().length > 0);
  }

  const chunks: string[] = [];
  let current = "";

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length > maxChars && current.length >= minChars) {
      chunks.push(current.trim());
      current = "";
    }
    current += trimmed + " ";
  }

  // Merge last chunk if too short
  if (current.trim()) {
    if (current.trim().length < minChars && chunks.length > 0) {
      chunks[chunks.length - 1] += " " + current.trim();
    } else {
      chunks.push(current.trim());
    }
  }

  return chunks;
}

/** Call ElevenLabs TTS API for a single chunk */
async function ttsChunk(text: string, outputPath: string): Promise<void> {
  const body = {
    text,
    model_id: MODEL,
    language_code: LANG,
    voice_settings: { stability: 0.7, similarity_boost: 0.8 },
  };

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs API error ${response.status}: ${err.slice(0, 200)}`);
  }

  const buffer = await response.arrayBuffer();
  writeFileSync(outputPath, Buffer.from(buffer));
}

/** Concatenate MP3 chunks using ffmpeg */
function concatChunks(chunkPaths: string[], outputPath: string): number {
  const listFile = outputPath.replace(".mp3", "-concat.txt");
  writeFileSync(listFile, chunkPaths.map(p => `file '${p}'`).join("\n"));

  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}" 2>/dev/null`,
    { timeout: 30000 }
  );

  // Get duration
  const dur = execSync(
    `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${outputPath}"`,
    { encoding: "utf-8", timeout: 10000 }
  );

  // Clean up list file
  unlinkSync(listFile);

  return parseFloat(dur.trim()) || 0;
}

/** Find content dirs that have translation but no audio */
function findUnprocessed(targetDate?: string, targetMosque?: string): string[] {
  const contentDir = join(ROOT, "content");
  const dirs: string[] = [];

  let dates: string[];
  try {
    dates = targetDate ? [targetDate] : readdirSync(contentDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  } catch { return []; }

  for (const date of dates) {
    const datePath = join(contentDir, date);
    if (!existsSync(datePath)) continue;

    const mosques = targetMosque ? [targetMosque] : ["makkah", "madinah"];
    for (const mosque of mosques) {
      const mosquePath = join(datePath, mosque);
      const translationPath = join(mosquePath, "translation-th.md");
      const audioPath = join(ROOT, CONFIG.output.audio_dir, `${date}-${mosque}-th.mp3`);

      if (existsSync(translationPath) && !existsSync(audioPath)) {
        dirs.push(`${date}/${mosque}`);
      }
    }
  }

  return dirs;
}

/** Generate TTS for a single khutbah */
async function generateTts(dateMosque: string): Promise<boolean> {
  const [date, mosque] = dateMosque.split("/");
  const contentPath = join(ROOT, "content", date, mosque);
  const audioDir = join(ROOT, CONFIG.output.audio_dir);
  mkdirSync(audioDir, { recursive: true });

  const metadata = JSON.parse(readFileSync(join(contentPath, "metadata.json"), "utf-8"));
  const translation = readFileSync(join(contentPath, "translation-th.md"), "utf-8");

  console.log(`     🎙️ Generating TTS for ${metadata.mosque_thai} (${metadata.sheikh})...`);

  // Strip markdown and chunk
  const cleanText = stripMarkdown(translation);
  const chunks = chunkText(cleanText, 1500);
  console.log(`     📝 Text: ${cleanText.length} chars → ${chunks.length} chunks`);

  // Save TTS source text — subtitle must use this exact text
  writeFileSync(join(contentPath, "tts-source-text.txt"), cleanText);
  console.log(`     💾 Saved tts-source-text.txt`);

  // TTS each chunk
  const chunksDir = join(audioDir, `${date}-${mosque}-chunks`);
  mkdirSync(chunksDir, { recursive: true });

  const chunkPaths: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkPath = join(chunksDir, `chunk_${String(i + 1).padStart(3, "0")}.mp3`);

    // Skip if already generated
    if (existsSync(chunkPath) && statSync(chunkPath).size > 1000) {
      console.log(`     ⏭️  Chunk ${i + 1}/${chunks.length} — cached`);
      chunkPaths.push(chunkPath);
      continue;
    }

    console.log(`     🔊 Chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)...`);
    try {
      await ttsChunk(chunks[i], chunkPath);
      const size = statSync(chunkPath).size;
      console.log(`        ✅ ${(size / 1024).toFixed(0)}KB`);
      chunkPaths.push(chunkPath);

      // Rate limit — slight delay between calls
      if (i < chunks.length - 1) await Bun.sleep(500);
    } catch (err: any) {
      console.error(`        ❌ ${err.message?.slice(0, 150)}`);
      return false;
    }
  }

  // Concatenate
  const outputPath = join(audioDir, `${date}-${mosque}-th.mp3`);
  console.log(`     🔗 Concatenating ${chunkPaths.length} chunks...`);

  try {
    const duration = concatChunks(chunkPaths, outputPath);
    console.log(`     ✅ Audio: ${outputPath}`);
    console.log(`     ⏱️  Duration: ${duration.toFixed(0)}s (${(duration / 60).toFixed(1)} min)`);

    // Update metadata
    metadata.status = "tts_done";
    metadata.tts_at = new Date().toISOString();
    metadata.audio_duration_seconds = Math.round(duration);
    writeFileSync(join(contentPath, "metadata.json"), JSON.stringify(metadata, null, 2));

    return true;
  } catch (err: any) {
    console.error(`     ❌ Concat failed: ${err.message?.slice(0, 150)}`);
    return false;
  }
}

// === MAIN ===
export async function tts(targetDate?: string, targetMosque?: string) {
  const unprocessed = findUnprocessed(targetDate, targetMosque);

  if (unprocessed.length === 0) {
    console.log("  ⚠️  No translations ready for TTS");
    return [];
  }

  console.log(`  📋 Found ${unprocessed.length} khutbah(s) for TTS:`);
  const results: string[] = [];

  for (const item of unprocessed) {
    console.log(`  🔄 ${item}`);
    const success = await generateTts(item);
    if (success) results.push(item);
  }

  return results;
}

// Run if called directly
if (import.meta.main) {
  const targetDate = process.argv[2];
  const targetMosque = process.argv[3] as "makkah" | "madinah" | undefined;
  tts(targetDate, targetMosque).then((results) => {
    if (results.length > 0) {
      console.log(`\n  🎉 TTS generated for ${results.length} khutbah(s): ${results.join(", ")}`);
    }
  });
}
