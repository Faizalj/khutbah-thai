#!/usr/bin/env bun
/**
 * Generate Thai SRT subtitle from Whisper timing + translation text
 *
 * Flow:
 * 1. Convert TTS audio to 16kHz WAV
 * 2. Run mlx_whisper turbo → get segments with timestamps
 * 3. SequenceMatcher align whisper text → translation text
 * 4. Output SRT with correct timing + correct text (no periods)
 *
 * Usage: bun pipeline/subtitle-gen.ts <date> <mosque>
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { parse as parseYaml } from "yaml";
import { join } from "path";

const ROOT = import.meta.dir.replace("/pipeline", "");
const CONFIG = parseYaml(readFileSync(join(ROOT, "config.yaml"), "utf-8"));

/** Format seconds to SRT timestamp */
function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

/** Run Whisper on TTS audio to get timed segments */
function runWhisper(audioPath: string, outputDir: string): any {
  // Convert to 16kHz WAV for speed
  const wavPath = join(outputDir, "whisper_input.wav");
  if (!existsSync(wavPath)) {
    execSync(`ffmpeg -y -i "${audioPath}" -ar 16000 -ac 1 "${wavPath}" 2>/dev/null`, { timeout: 30000 });
  }

  // Run mlx_whisper (Apple Silicon optimized)
  const jsonName = "whisper_input.json";
  const jsonPath = join(outputDir, jsonName);
  if (!existsSync(jsonPath)) {
    console.log("     🎤 Running mlx_whisper turbo...");
    execSync(
      `mlx_whisper "${wavPath}" --model mlx-community/whisper-turbo --language th -f json -o "${outputDir}"`,
      { timeout: 300000 }
    );
  }

  return JSON.parse(readFileSync(jsonPath, "utf-8"));
}

/** Get clean translation text (same strip as TTS but remove periods) */
function getCleanText(date: string, mosque: string): string {
  const translationPath = join(ROOT, "content", date, mosque, "translation-th.md");
  let text = readFileSync(translationPath, "utf-8");

  // Remove frontmatter
  if (text.startsWith("---\n")) {
    const endIdx = text.indexOf("\n---\n", 4);
    if (endIdx > 0) text = text.slice(endIdx + 5);
  }

  text = text
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/^---+$/gm, "")
    .replace(/.*ส่วนที่\s+\d+\/\d+.*/g, "")
    .replace(/^-?\s*\*{0,2}(วันที่|เชค|แหล่งที่มา|Date|Sheikh|Source).*$/gim, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/## ไฮไลท์สำหรับ Reels[\s\S]*$/m, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/^>\s*/gm, "")
    .replace(/^[-*]\s+/gm, "")
    // Remove periods (for display, not TTS)
    .replace(/\.(\n)/g, "$1")
    .replace(/\. /g, " ")
    .replace(/\.$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Flatten to single line for alignment
  return text.replace(/\n+/g, " ").trim();
}

/** Sequence alignment — map whisper character positions to script positions */
function alignTexts(whisperText: string, scriptText: string): Map<number, number> {
  const w2s = new Map<number, number>();

  // Simple LCS-based alignment (character level)
  const wLen = whisperText.length;
  const sLen = scriptText.length;

  // Use sliding window matching for efficiency
  let wi = 0;
  let si = 0;

  while (wi < wLen && si < sLen) {
    if (whisperText[wi] === scriptText[si]) {
      w2s.set(wi, si);
      wi++;
      si++;
    } else {
      // Try to find match nearby
      let foundW = -1, foundS = -1;
      const searchRange = 20;

      // Look ahead in script
      for (let j = 1; j <= searchRange && si + j < sLen; j++) {
        if (whisperText[wi] === scriptText[si + j]) {
          foundS = si + j;
          break;
        }
      }
      // Look ahead in whisper
      for (let j = 1; j <= searchRange && wi + j < wLen; j++) {
        if (whisperText[wi + j] === scriptText[si]) {
          foundW = wi + j;
          break;
        }
      }

      if (foundS >= 0 && (foundW < 0 || foundS - si <= foundW - wi)) {
        // Skip in script (insertion)
        for (let j = si; j < foundS; j++) {
          w2s.set(wi, j);
        }
        si = foundS;
      } else if (foundW >= 0) {
        // Skip in whisper (deletion)
        for (let j = wi; j < foundW; j++) {
          w2s.set(j, si);
        }
        wi = foundW;
      } else {
        // No match — map proportionally
        w2s.set(wi, si);
        wi++;
        si++;
      }
    }
  }

  return w2s;
}

/** Main subtitle generation */
export function generateSubtitle(date: string, mosque: string): string | null {
  const audioDir = join(ROOT, CONFIG.output.audio_dir);
  const ttsAudio = join(audioDir, `${date}-${mosque}-th.mp3`);

  if (!existsSync(ttsAudio)) {
    console.log("  ❌ TTS audio not found");
    return null;
  }

  // Step 1: Run Whisper
  const whisperDir = join(audioDir, `${date}-${mosque}-whisper`);
  mkdirSync(whisperDir, { recursive: true });
  const whisperResult = runWhisper(ttsAudio, whisperDir);
  const segments = whisperResult.segments;
  console.log(`     📊 Whisper: ${segments.length} segments`);

  // Step 2: Get clean translation text
  const scriptText = getCleanText(date, mosque);
  console.log(`     📝 Script: ${scriptText.length} chars`);

  // Step 3: Align whisper text → script text
  console.log("     🔗 Aligning whisper ↔ script...");
  const whisperFullText = segments.map((s: any) => s.text.trim()).join("");
  const w2s = alignTexts(whisperFullText, scriptText);

  // Step 4: Map segments to corrected text
  const corrected: { text: string; start: number; end: number }[] = [];
  let wp = 0;

  for (const seg of segments) {
    const segText = seg.text.trim();
    const segLen = segText.length;
    const mappedPositions: number[] = [];

    for (let i = wp; i < wp + segLen; i++) {
      const mapped = w2s.get(i);
      if (mapped !== undefined) mappedPositions.push(mapped);
    }

    if (mappedPositions.length > 0) {
      const start = Math.min(...mappedPositions);
      const end = Math.max(...mappedPositions) + 1;
      const txt = scriptText.slice(start, end).trim();
      if (txt.length > 0) {
        corrected.push({ text: txt, start: seg.start, end: seg.end });
      }
    }
    wp += segLen;
  }

  console.log(`     ✅ Aligned: ${corrected.length} segments`);

  // Step 5: Build SRT (split long segments into ≤2 lines)
  const srtBlocks: string[] = [];
  let srtIdx = 1;

  for (const seg of corrected) {
    let text = seg.text;
    // Remove any remaining periods
    text = text.replace(/\./g, "").trim();
    if (!text) continue;

    // Split long text into max 2 lines of ~45 chars
    if (text.length > 90) {
      const mid = Math.floor(text.length / 2);
      const breakAt = text.indexOf(" ", mid);
      if (breakAt > 0 && breakAt < text.length - 5) {
        text = text.slice(0, breakAt) + "\n" + text.slice(breakAt + 1);
      }
    } else if (text.length > 45) {
      const mid = Math.floor(text.length / 2);
      const breakAt = text.indexOf(" ", mid);
      if (breakAt > 0) {
        text = text.slice(0, breakAt) + "\n" + text.slice(breakAt + 1);
      }
    }

    srtBlocks.push(`${srtIdx}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${text}`);
    srtIdx++;
  }

  const srt = srtBlocks.join("\n\n") + "\n";

  // Save
  const contentDir = join(ROOT, "content", date, mosque);
  const srtPath = join(contentDir, "subtitle-th.srt");
  writeFileSync(srtPath, srt);
  console.log(`  ✅ Generated ${srtIdx - 1} subtitle blocks → ${srtPath}`);

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
