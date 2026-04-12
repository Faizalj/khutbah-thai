#!/usr/bin/env bun
/**
 * Stage 2: TRANSLATE
 * Arabic transcript → Thai translation via PAI Inference (Claude)
 *
 * Usage: bun pipeline/2-translate.ts [YYYY-MM-DD] [makkah|madinah]
 * If no args, translates all "fetched" content that hasn't been translated yet
 *
 * Strategy: Split transcript into khutbah 1 + khutbah 2, translate each separately
 * to avoid timeout, then combine results.
 */

import { execSync, spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { parse as parseYaml } from "yaml";
import { join } from "path";

const ROOT = import.meta.dir.replace("/pipeline", "");
const CONFIG = parseYaml(readFileSync(join(ROOT, "config.yaml"), "utf-8"));

const SYSTEM_PROMPT = `You are a professional Arabic-to-Thai translator specializing in Islamic religious content (Jumu'ah khutbah from Masjid al-Haram and Masjid an-Nabawi).

WRITING STYLE:
- Write short sentences. One idea per sentence. End every sentence with a period.
- Break long paragraphs into short ones (2-3 sentences max).
- Do NOT add section headers, chunk markers, or structural labels.
- Do NOT add numbering like "ส่วนที่ 1/3".
- Write as pure narration.
- For Quranic verses: KEEP the original Arabic text in ﴿﴾ brackets, then translate the meaning on the next line, then add surah name and ayah reference. Format:

﴿Arabic verse text﴾

ความว่า: Thai translation here (ซูเราะฮ์ name: ayah number)

STANDARD THAI ISLAMIC TERMINOLOGY:
- ตักวา (تقوى)
- นิอ์มัต (نعمة)
- เศาะลาวาต (صلوات)
- คุฏบะฮ์ (خطبة)
- มักกะฮ์ (مكة)
- มะดีนะฮ์ (المدينة)
- อัลลอฮ์ (الله)
- อิสติกอมะฮ์ (استقامة)
- ดุอาอ์ (دعاء)
- ซูเราะฮ์ (سورة)
- อายะฮ์ (آية)
- ฮะดีษ (حديث)
- อาคิเราะฮ์ (آخرة)
- ดุนยา (دنيا)
- ฟิตนะฮ์ (فتنة)
- ญะมาอะฮ์ (جماعة)
- เศาะฮาบะฮ์ (صحابة)
- ตาบิอีน (تابعين)
- ซาต (ذات) — ทับศัพท์เท่านั้น ห้ามแปลเป็น "พระสัตตา" หรือ "แก่นแท้"
- ซุบฮานะฮูวะตะอาลา (سبحانه وتعالى)

ABBREVIATIONS to use:
- ﷺ after Prophet Muhammad's name
- (ร.ฎ.) after companions
- (ร.ฮ.) after scholars

OUTPUT: Clean Thai text. Paragraphs only. No headers. No bullet points. No metadata.`;

const HIGHLIGHTS_PROMPT = `จากคำแปลคุฏบะฮ์นี้ เลือก 3-5 ข้อความที่ทรงพลังและกระชับ (1-2 ประโยค) เหมาะสำหรับทำ Reels/Shorts
แต่ละข้อความต้อง:
- สั้น กระชับ อ่านเข้าใจง่าย
- มีพลังสร้างแรงบันดาลใจหรือข้อคิด
- ไม่ยาวเกิน 100 คำ

ตอบเป็น format:
> "ข้อความที่ 1"

> "ข้อความที่ 2"

(แค่ข้อความเท่านั้น ไม่ต้องอธิบายเพิ่ม)`;

/** Call claude CLI directly via spawn — bypasses Inference.ts overhead */
async function callInference(systemPrompt: string, userPrompt: string, level: string = "standard", timeoutMs: number = 300000): Promise<string> {
  const models: Record<string, string> = {
    fast: "haiku",
    standard: "sonnet",
    smart: "opus",
  };

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDECODE;

    // Write system prompt to temp file to avoid ARG_MAX
    const tmpSystem = `/tmp/khutbah-sys-${Date.now()}.txt`;
    require("fs").writeFileSync(tmpSystem, systemPrompt);

    const proc = spawn("claude", [
      "--print",
      "--model", models[level] || "sonnet",
      "--output-format", "text",
      "--setting-sources", "",
      "--system-prompt", systemPrompt,
    ], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Send user prompt via stdin
    proc.stdin.write(userPrompt);
    proc.stdin.end();

    // Clean up temp file after process exits
    proc.on("exit", () => {
      try { require("fs").unlinkSync(tmpSystem); } catch {}
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Inference timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code: number) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim().length > 50) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Inference failed (code ${code}): ${stderr.slice(0, 300)}`));
      }
    });
  });
}

/** Find all content dirs that need translation */
function findUntranslated(targetDate?: string, targetMosque?: string): string[] {
  const contentDir = join(ROOT, "content");
  const dirs: string[] = [];

  let dates: string[];
  try {
    dates = targetDate ? [targetDate] : readdirSync(contentDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  } catch {
    return [];
  }

  for (const date of dates) {
    const datePath = join(contentDir, date);
    if (!existsSync(datePath)) continue;

    const mosques = targetMosque ? [targetMosque] : ["makkah", "madinah"];
    for (const mosque of mosques) {
      const mosquePath = join(datePath, mosque);
      const correctedPath = join(mosquePath, "transcript-ar-corrected.md");
      const rawPath = join(mosquePath, "transcript-ar.md");
      const transcriptPath = existsSync(correctedPath) ? correctedPath : rawPath;
      const translationPath = join(mosquePath, "translation-th.md");

      if (existsSync(transcriptPath) && !existsSync(translationPath)) {
        dirs.push(join(date, mosque));
      }
    }
  }

  return dirs;
}

/** Split transcript into khutbah sections */
function extractSections(transcript: string): { khutbah1: string; khutbah2: string } {
  const k1Match = transcript.match(/## الخطبة الأولى.*?\n([\s\S]*?)(?=---\s*\n## الخطبة الثانية|$)/);
  const k2Match = transcript.match(/## الخطبة الثانية.*?\n([\s\S]*?)$/);

  return {
    khutbah1: k1Match?.[1]?.trim() || "",
    khutbah2: k2Match?.[1]?.trim() || "",
  };
}

/** Split text into chunks of ~maxChars, breaking at line boundaries */
function chunkText(text: string, maxChars: number = 1500): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    if (current.length + line.length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += line + "\n";
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

/** Translate a long text by chunking */
async function translateLongText(text: string, context: string, level: string = "standard"): Promise<string> {
  const chunks = chunkText(text, 2000);
  console.log(`        → ${chunks.length} chunk(s)`);

  const results: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`        → Chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)...`);
    const result = await callInference(
      SYSTEM_PROMPT,
      `${context}\n\nส่วนที่ ${i + 1}/${chunks.length}:\n\n${chunks[i]}`,
      level,
      300000
    );
    results.push(result);
  }

  return results.join("\n\n");
}

/** Translate a single khutbah */
async function translateKhutbah(dateMosque: string): Promise<boolean> {
  const [date, mosque] = dateMosque.split("/");
  const contentPath = join(ROOT, "content", date, mosque);

  // Prefer corrected transcript, fallback to raw
  const correctedPath = join(contentPath, "transcript-ar-corrected.md");
  const rawPath = join(contentPath, "transcript-ar.md");
  const transcriptFile = existsSync(correctedPath) ? correctedPath : rawPath;
  const transcript = readFileSync(transcriptFile, "utf-8");
  console.log(`     📄 Using: ${existsSync(correctedPath) ? "corrected" : "raw"} transcript`);
  const metadata = JSON.parse(readFileSync(join(contentPath, "metadata.json"), "utf-8"));

  console.log(`     📖 Translating ${metadata.mosque_thai} (${metadata.sheikh})...`);

  const { khutbah1, khutbah2 } = extractSections(transcript);

  const context = `แปลคุฏบะฮ์วันศุกร์จากมัสยิด${metadata.mosque_thai} เชค ${metadata.sheikh} วันที่ ${date}`;

  // Translate khutbah 1
  let translation1 = "";
  if (khutbah1) {
    console.log(`     🔄 Khutbah 1 (${khutbah1.length} chars)...`);
    try {
      translation1 = await translateLongText(khutbah1, `${context} — คุฏบะฮ์แรก (خطبة أولى)`, "standard");
      console.log(`     ✅ Khutbah 1 translated (${translation1.length} chars)`);
    } catch (err: any) {
      console.error(`     ❌ Khutbah 1 failed: ${err.message?.slice(0, 150)}`);
      return false;
    }
  }

  // Translate khutbah 2
  let translation2 = "";
  if (khutbah2) {
    console.log(`     🔄 Khutbah 2 (${khutbah2.length} chars)...`);
    try {
      translation2 = await translateLongText(khutbah2, `${context} — คุฏบะฮ์ที่สอง (خطبة ثانية)`, "standard");
      console.log(`     ✅ Khutbah 2 translated (${translation2.length} chars)`);
    } catch (err: any) {
      console.error(`     ❌ Khutbah 2 failed: ${err.message?.slice(0, 150)}`);
      return false;
    }
  }

  // Extract highlights for reels
  let highlights = "";
  console.log(`     🔄 Extracting highlights...`);
  try {
    const fullTranslation = `${translation1}\n\n${translation2}`;
    highlights = await callInference(
      HIGHLIGHTS_PROMPT,
      fullTranslation,
      "fast",
      30000
    );
    console.log(`     ✅ Highlights extracted`);
  } catch (err: any) {
    console.log(`     ⚠️  Highlights extraction failed, continuing without`);
    highlights = "> (ไม่สามารถดึงไฮไลท์อัตโนมัติได้)";
  }

  // Combine into final translation file
  const translationMd = `# คุฏบะฮ์วันศุกร์ — ${metadata.mosque_thai}

- **วันที่:** ${date}
- **เชค:** ${metadata.sheikh}
- **แหล่งที่มา:** ${metadata.video_url}

---

## คุฏบะฮ์แรก

${translation1}

---

## คุฏบะฮ์ที่สอง

${translation2 || "(คุฏบะฮ์ที่สองไม่สามารถแยกได้อัตโนมัติ)"}

---

## ไฮไลท์สำหรับ Reels

${highlights}
`;

  writeFileSync(join(contentPath, "translation-th.md"), translationMd);
  console.log(`     ✅ Saved translation-th.md`);

  // Update metadata
  metadata.status = "translated";
  metadata.translated_at = new Date().toISOString();
  writeFileSync(join(contentPath, "metadata.json"), JSON.stringify(metadata, null, 2));

  return true;
}

// === MAIN ===
export async function translate(targetDate?: string, targetMosque?: string) {
  const untranslated = findUntranslated(targetDate, targetMosque);

  if (untranslated.length === 0) {
    console.log("  ⚠️  No untranslated transcripts found");
    return [];
  }

  console.log(`  📋 Found ${untranslated.length} khutbah(s) to translate:`);
  const results: string[] = [];

  for (const item of untranslated) {
    console.log(`  🔄 ${item}`);
    const success = await translateKhutbah(item);
    if (success) results.push(item);
  }

  return results;
}

// Run if called directly
if (import.meta.main) {
  const targetDate = process.argv[2];
  const targetMosque = process.argv[3] as "makkah" | "madinah" | undefined;
  translate(targetDate, targetMosque).then((results) => {
    if (results.length > 0) {
      console.log(`\n  🎉 Translated ${results.length} khutbah(s): ${results.join(", ")}`);
    }
  });
}
