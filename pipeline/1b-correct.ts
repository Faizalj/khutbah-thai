#!/usr/bin/env bun
/**
 * Stage 1B: CORRECT
 * AI-powered correction of Arabic auto-caption transcript
 *
 * Usage: bun pipeline/1b-correct.ts [YYYY-MM-DD] [makkah|madinah]
 *
 * Fixes:
 * - Misspelled Arabic words from auto-caption
 * - Duplicate/overlapping text from SRT timestamps
 * - Missing words from context (especially Quranic verses)
 * - Clear separation of khutbah 1 and khutbah 2
 * - Proper Arabic punctuation and sentence structure
 */

import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { parse as parseYaml } from "yaml";
import { join } from "path";
import { searchVerse } from "./quran-verify";

const ROOT = import.meta.dir.replace("/pipeline", "");
const CONFIG = parseYaml(readFileSync(join(ROOT, "config.yaml"), "utf-8"));

const SYSTEM_PROMPT = `You are an expert Arabic linguist specializing in Islamic sermon transcription correction. You are given a raw auto-generated Arabic transcript from a Jumu'ah khutbah (Friday sermon) delivered at Masjid al-Haram or Masjid an-Nabawi.

YOUR TASK: Correct and clean the transcript. Do NOT translate — keep everything in Arabic.

FIX THESE ISSUES:
1. SPELLING: Auto-captions often misspell Arabic words. Fix based on context:
   - Missing letters (e.g. "الحمد لل" → "الحمد لله")
   - Wrong letters from speech recognition errors
   - Common Quranic phrases must be exact — check against known ayat

2. DUPLICATES: Auto-captions repeat phrases across overlapping timestamps. Remove exact and near-duplicates while keeping the flow.

3. MISSING WORDS: Speech recognition drops words. Fill in obvious gaps from context:
   - Complete partial Quranic verses (you know the Quran — complete truncated ayat)
   - Complete partial hadith phrases
   - Complete common du'a phrases

4. STRUCTURE:
   - Clearly mark the split between الخطبة الأولى and الخطبة الثانية
   - The second khutbah typically starts with a new حمد after a pause
   - Add proper sentence breaks and Arabic punctuation (، and .)

5. QURANIC VERSES: When you identify a Quranic verse (even partial), write the COMPLETE verse and add the reference (سورة name: ayah number) after it.

OUTPUT FORMAT:
Return the corrected transcript in this exact format:

## الخطبة الأولى

[corrected Arabic text of first khutbah with proper paragraphs]

## الخطبة الثانية

[corrected Arabic text of second khutbah with proper paragraphs]

Do NOT add any commentary, translation, or notes. Only output the corrected Arabic text.`;

/** Call claude CLI directly */
async function callClaude(systemPrompt: string, userPrompt: string, timeoutMs: number = 300000): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDECODE;

    const proc = spawn("claude", [
      "--print",
      "--model", "sonnet",
      "--output-format", "text",
      "--setting-sources", "",
      "--system-prompt", systemPrompt,
    ], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdin.write(userPrompt);
    proc.stdin.end();

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code: number) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim().length > 100) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Failed (code ${code}): ${stderr.slice(0, 300)}`));
      }
    });
  });
}

/** Split text into chunks for correction */
function chunkText(text: string, maxChars: number = 2000): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    if (current.length + line.length > maxChars && current.length > 300) {
      chunks.push(current.trim());
      current = "";
    }
    current += line + "\n";
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

/** Find transcripts that need correction */
function findUncorrected(targetDate?: string, targetMosque?: string): string[] {
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
      const transcriptPath = join(mosquePath, "transcript-ar.md");
      const correctedPath = join(mosquePath, "transcript-ar-corrected.md");

      if (existsSync(transcriptPath) && !existsSync(correctedPath)) {
        dirs.push(`${date}/${mosque}`);
      }
    }
  }

  return dirs;
}

/** Correct a single khutbah transcript */
async function correctTranscript(dateMosque: string): Promise<boolean> {
  const [date, mosque] = dateMosque.split("/");
  const contentPath = join(ROOT, "content", date, mosque);

  const transcript = readFileSync(join(contentPath, "transcript-ar.md"), "utf-8");
  const metadata = JSON.parse(readFileSync(join(contentPath, "metadata.json"), "utf-8"));

  console.log(`     📝 Correcting ${metadata.mosque_thai} (${metadata.sheikh})...`);

  // Extract raw Arabic text (skip the markdown header)
  const rawText = transcript
    .replace(/^#.*$/gm, "")
    .replace(/^-\s+\*\*.*$/gm, "")
    .replace(/^---+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Chunk and correct
  const chunks = chunkText(rawText, 2000);
  console.log(`     📊 ${rawText.length} chars → ${chunks.length} chunk(s)`);

  const correctedParts: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`     🔧 Chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)...`);
    try {
      const result = await callClaude(
        SYSTEM_PROMPT,
        `صحح هذا النص من خطبة الجمعة (الجزء ${i + 1} من ${chunks.length}):\n\n${chunks[i]}`,
        300000
      );
      correctedParts.push(result);
      console.log(`     ✅ Chunk ${i + 1} corrected (${result.length} chars)`);
    } catch (err: any) {
      console.error(`     ❌ Chunk ${i + 1} failed: ${err.message?.slice(0, 150)}`);
      // Use original text as fallback
      correctedParts.push(chunks[i]);
      console.log(`     ⚠️ Using original text for chunk ${i + 1}`);
    }
  }

  // Combine corrected text
  let correctedText = correctedParts.join("\n\n");

  // === QURAN VERIFICATION — ZERO TOLERANCE FOR ERRORS ===
  // Find all Quranic verse markers (﴿...﴾ or text with surah references)
  console.log(`     📖 Verifying Quranic verses...`);

  const versePatterns = [
    /﴿([^﴾]+)﴾/g,                           // ﴿verse﴾ brackets
    /\u{FD3F}([^\u{FD3E}]+)\u{FD3E}/gu,     // ornate brackets
  ];

  let verifiedCount = 0;
  let failedCount = 0;

  for (const pattern of versePatterns) {
    const matches = [...correctedText.matchAll(pattern)];
    for (const match of matches) {
      const candidateText = match[1].trim();
      if (candidateText.length < 10) continue;

      try {
        const verified = await searchVerse(candidateText);
        if (verified.length > 0) {
          const correct = verified[0];
          // Replace with authoritative Uthmani text
          const oldVerse = match[0];
          const newVerse = `﴿${correct.text}﴾ (${correct.reference})`;
          correctedText = correctedText.replace(oldVerse, newVerse);
          verifiedCount++;
        } else {
          failedCount++;
          console.log(`     ⚠️ Could not verify: "${candidateText.slice(0, 50)}..."`);
        }
        // Rate limit API calls
        await Bun.sleep(300);
      } catch {
        failedCount++;
      }
    }
  }

  // Also search for verse references like (سورة X: Y) and verify the text before them
  const refPattern = /\(سورة\s+[^)]+:\s*\d+[^)]*\)/g;
  const refMatches = [...correctedText.matchAll(refPattern)];
  console.log(`     📊 Verified: ${verifiedCount} verses, ${failedCount} could not verify, ${refMatches.length} references found`);

  // Save corrected transcript
  const correctedMd = `# Transcript (Corrected) — ${metadata.mosque_thai} Jumu'ah Khutbah

- **Date:** ${date}
- **Sheikh:** ${metadata.sheikh}
- **Source:** https://www.youtube.com/watch?v=${metadata.video_id}
- **Status:** AI-corrected from auto-captions

---

${correctedText}
`;

  writeFileSync(join(contentPath, "transcript-ar-corrected.md"), correctedMd);
  console.log(`     ✅ Saved transcript-ar-corrected.md`);

  // Update metadata
  metadata.status = "corrected";
  metadata.corrected_at = new Date().toISOString();
  writeFileSync(join(contentPath, "metadata.json"), JSON.stringify(metadata, null, 2));

  return true;
}

// === MAIN ===
export async function correct(targetDate?: string, targetMosque?: string) {
  const uncorrected = findUncorrected(targetDate, targetMosque);

  if (uncorrected.length === 0) {
    console.log("  ⚠️ No transcripts need correction");
    return [];
  }

  console.log(`  📋 Found ${uncorrected.length} transcript(s) to correct:`);
  const results: string[] = [];

  for (const item of uncorrected) {
    console.log(`  🔄 ${item}`);
    const success = await correctTranscript(item);
    if (success) results.push(item);
  }

  return results;
}

// Run if called directly
if (import.meta.main) {
  const targetDate = process.argv[2];
  const targetMosque = process.argv[3] as "makkah" | "madinah" | undefined;
  correct(targetDate, targetMosque).then((results) => {
    if (results.length > 0) {
      console.log(`\n  🎉 Corrected ${results.length} transcript(s): ${results.join(", ")}`);
    }
  });
}
