#!/usr/bin/env bun
/**
 * Generate Thai SRT subtitle file from TTS chunks
 *
 * Creates subtitle timings based on TTS chunk durations.
 * Each chunk becomes a subtitle block, split into shorter lines for readability.
 *
 * Usage: bun pipeline/subtitle-gen.ts <date> <mosque>
 * Example: bun pipeline/subtitle-gen.ts 2026-04-10 makkah
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { parse as parseYaml } from "yaml";
import { join } from "path";

const ROOT = import.meta.dir.replace("/pipeline", "");
const CONFIG = parseYaml(readFileSync(join(ROOT, "config.yaml"), "utf-8"));

/** Get audio duration in seconds */
function getDuration(path: string): number {
  const result = execSync(
    `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${path}"`,
    { encoding: "utf-8", timeout: 10000 }
  );
  return parseFloat(result.trim()) || 0;
}

/** Format seconds to SRT timestamp: HH:MM:SS,mmm */
function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

/** Split text into subtitle lines (~40 chars per line, max 2 lines) */
function splitSubtitleText(text: string, maxCharsPerLine: number = 45): string[] {
  // Split by sentences
  const sentences = text.split(/(?<=\.)\s+/).filter(s => s.trim());
  const lines: string[] = [];

  for (const sentence of sentences) {
    if (sentence.length <= maxCharsPerLine) {
      lines.push(sentence.trim());
    } else {
      // Split long sentence at natural break points
      const words = sentence.split(/\s+/);
      let current = "";
      for (const word of words) {
        if (current.length + word.length + 1 > maxCharsPerLine && current) {
          lines.push(current.trim());
          current = "";
        }
        current += word + " ";
      }
      if (current.trim()) lines.push(current.trim());
    }
  }

  return lines;
}

/** Generate SRT from TTS chunks */
export function generateSubtitle(date: string, mosque: string): string | null {
  const audioDir = join(ROOT, CONFIG.output.audio_dir);
  const chunksDir = join(audioDir, `${date}-${mosque}-chunks`);

  if (!existsSync(chunksDir)) {
    console.log(`  ❌ No TTS chunks found: ${chunksDir}`);
    return null;
  }

  // Get all chunk files sorted
  const chunkFiles = readdirSync(chunksDir)
    .filter(f => f.endsWith(".mp3") && f.startsWith("chunk_"))
    .sort()
    .map(f => join(chunksDir, f));

  if (chunkFiles.length === 0) {
    console.log("  ❌ No chunk files found");
    return null;
  }

  // Read the TTS-stripped text to get content per chunk
  const translationPath = join(ROOT, "content", date, mosque, "translation-th.md");
  if (!existsSync(translationPath)) return null;

  const md = readFileSync(translationPath, "utf-8");

  // Strip markdown (same logic as 3-tts.ts)
  let text = md;
  if (text.startsWith("---\n")) {
    const endIdx = text.indexOf("\n---\n", 4);
    if (endIdx > 0) text = text.slice(endIdx + 5);
  }
  text = text
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/^---+$/gm, "")
    .replace(/^-?\s*\*{0,2}(วันที่|เชค|แหล่งที่มา|Date|Sheikh|Source).*$/gim, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/^>\s*/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Split text into same chunks as TTS (by sentences, ~1500 chars)
  let segments = text.split(/\n\n+/).filter(s => s.trim().length > 0);
  if (segments.length <= 1 && text.length > 1500) {
    segments = text.split(/(?<=\.)\s+/).filter(s => s.trim().length > 0);
  }

  // Rebuild chunks matching TTS chunking logic
  const textChunks: string[] = [];
  let current = "";
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    if (current.length + trimmed.length > 1500 && current.length >= 300) {
      textChunks.push(current.trim());
      current = "";
    }
    current += trimmed + " ";
  }
  if (current.trim()) {
    if (current.trim().length < 300 && textChunks.length > 0) {
      textChunks[textChunks.length - 1] += " " + current.trim();
    } else {
      textChunks.push(current.trim());
    }
  }

  // Calculate timing from chunk audio durations
  let srtIndex = 1;
  let currentTime = 0;
  const srtBlocks: string[] = [];

  const numChunks = Math.min(chunkFiles.length, textChunks.length);

  for (let i = 0; i < numChunks; i++) {
    const chunkDur = getDuration(chunkFiles[i]);
    const chunkText = textChunks[i] || "";

    // Split chunk into subtitle segments (~8 seconds each)
    const subtitleLines = splitSubtitleText(chunkText);
    const timePerLine = chunkDur / subtitleLines.length;

    for (let j = 0; j < subtitleLines.length; j++) {
      const start = currentTime + j * timePerLine;
      const end = currentTime + (j + 1) * timePerLine - 0.1;

      // Show 2 lines at a time for readability
      const line = subtitleLines[j];
      if (line.length > 90) {
        // Split into 2 lines
        const mid = Math.floor(line.length / 2);
        const breakPoint = line.indexOf(" ", mid);
        const l1 = line.slice(0, breakPoint > 0 ? breakPoint : mid);
        const l2 = line.slice(breakPoint > 0 ? breakPoint + 1 : mid);
        srtBlocks.push(`${srtIndex}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${l1}\n${l2}`);
      } else {
        srtBlocks.push(`${srtIndex}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${line}`);
      }
      srtIndex++;
    }

    currentTime += chunkDur;
  }

  const srt = srtBlocks.join("\n\n") + "\n";

  // Save SRT file
  const contentDir = join(ROOT, "content", date, mosque);
  const srtPath = join(contentDir, "subtitle-th.srt");
  writeFileSync(srtPath, srt);
  console.log(`  ✅ Generated ${srtIndex - 1} subtitle blocks → ${srtPath}`);

  return srtPath;
}

// CLI
if (import.meta.main) {
  const date = process.argv[2];
  const mosque = process.argv[3];
  if (!date || !mosque) {
    console.log("Usage: bun pipeline/subtitle-gen.ts <date> <mosque>");
    process.exit(1);
  }
  generateSubtitle(date, mosque);
}
