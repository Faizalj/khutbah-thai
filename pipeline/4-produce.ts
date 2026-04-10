#!/usr/bin/env bun
/**
 * Stage 4: PRODUCE
 * Assemble final video: intro TTS + body TTS + outro TTS + background image + subtitles
 * Also download source Arabic audio and mix at 20% under Thai TTS at 80%
 *
 * Usage: bun pipeline/4-produce.ts [YYYY-MM-DD] [makkah|madinah]
 *
 * Prerequisites: Stage 3 (TTS) must have completed — body audio must exist
 *
 * Output:
 *   output/video/YYYY-MM-DD-{mosque}-full.mp4   (full-length video)
 *   output/reels/YYYY-MM-DD-{mosque}-reel-NN.mp4 (highlight clips — future)
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { parse as parseYaml } from "yaml";
import { join } from "path";

const ROOT = import.meta.dir.replace("/pipeline", "");
const CONFIG = parseYaml(readFileSync(join(ROOT, "config.yaml"), "utf-8"));

// ElevenLabs config (for intro/outro TTS)
const VOICE_ID = CONFIG.tts.voice_id;
const API_KEY = (() => {
  const envFile = readFileSync(join(process.env.HOME!, ".env"), "utf-8");
  const match = envFile.match(/ELEVENLABS_API_KEY=(.+)/);
  return match?.[1]?.trim() || "";
})();

// Thai month names
const THAI_MONTHS = [
  "", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
];

function formatThaiDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const thaiYear = year + 543;
  return `${day} ${THAI_MONTHS[month]} ${thaiYear}`;
}

/** Generate intro/outro text from config templates */
function generateIntroText(metadata: any, date: string): string {
  const mosqueThai = metadata.mosque === "makkah"
    ? "มัสยิดอัลฮะรอม มักกะฮ์"
    : "มัสยิดอันนะบะวีย์ มะดีนะฮ์";

  return CONFIG.intro_template
    .replace("{mosque_thai}", mosqueThai)
    .replace("{sheikh}", metadata.sheikh)
    .replace("{date_thai}", formatThaiDate(date));
}

function generateOutroText(): string {
  return CONFIG.outro_template;
}

/** Call ElevenLabs TTS for short text (intro/outro) */
async function ttsShort(text: string, outputPath: string): Promise<void> {
  const body = {
    text,
    model_id: "eleven_v3",
    language_code: "th",
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

/** Download source Arabic audio from YouTube */
function downloadArabicAudio(videoId: string, outputPath: string): void {
  if (existsSync(outputPath)) return;

  execSync(
    `yt-dlp -x --audio-format mp3 --audio-quality 3 -o "${outputPath}" "https://www.youtube.com/watch?v=${videoId}" 2>/dev/null`,
    { timeout: 120000 }
  );
}

/** Get audio duration in seconds */
function getDuration(audioPath: string): number {
  const result = execSync(
    `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`,
    { encoding: "utf-8", timeout: 10000 }
  );
  return parseFloat(result.trim()) || 0;
}

/** Add silence padding (seconds) to audio */
function addSilence(inputPath: string, outputPath: string, beforeSec: number = 1, afterSec: number = 1): void {
  execSync(
    `ffmpeg -y -f lavfi -t ${beforeSec} -i anullsrc=r=44100:cl=mono ` +
    `-i "${inputPath}" ` +
    `-f lavfi -t ${afterSec} -i anullsrc=r=44100:cl=mono ` +
    `-filter_complex "[0][1][2]concat=n=3:v=0:a=1[out]" -map "[out]" "${outputPath}" 2>/dev/null`,
    { timeout: 30000 }
  );
}

/** Concat audio files: intro + body + outro */
function concatAudio(parts: string[], outputPath: string): void {
  const listFile = outputPath.replace(".mp3", "-concat.txt");
  writeFileSync(listFile, parts.map(p => `file '${p}'`).join("\n"));

  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}" 2>/dev/null`,
    { timeout: 60000 }
  );

  unlinkSync(listFile);
}

/** Mix Thai TTS (foreground) + Arabic audio (background) */
function mixAudio(thaiPath: string, arabicPath: string, outputPath: string): void {
  const thaiDur = getDuration(thaiPath);
  const thaiVol = CONFIG.tts.thai_volume;
  const arVol = CONFIG.tts.arabic_volume;

  // Trim Arabic to match Thai duration, lower volume
  execSync(
    `ffmpeg -y -i "${thaiPath}" -i "${arabicPath}" ` +
    `-filter_complex "[0:a]volume=${thaiVol}[thai];[1:a]atrim=0:${thaiDur},volume=${arVol}[ar];[thai][ar]amix=inputs=2:duration=first[out]" ` +
    `-map "[out]" "${outputPath}" 2>/dev/null`,
    { timeout: 120000 }
  );
}

/** Create video from audio + static background image + subtitles */
function createVideo(audioPath: string, outputPath: string, title: string): void {
  const duration = getDuration(audioPath);
  const videoDir = join(ROOT, CONFIG.output.video_dir);
  mkdirSync(videoDir, { recursive: true });

  // Generate a simple dark background with title text using ffmpeg
  // 1920x1080, dark green Islamic aesthetic
  execSync(
    `ffmpeg -y ` +
    `-f lavfi -i "color=c=0x1a3c2a:s=1920x1080:d=${duration}" ` +
    `-i "${audioPath}" ` +
    `-vf "drawtext=text='${title.replace(/'/g, "\\'")}':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:fontfile=/System/Library/Fonts/Supplemental/Arial Unicode.ttf" ` +
    `-c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -shortest "${outputPath}" 2>/dev/null`,
    { timeout: 300000 }
  );
}

/** Find content dirs ready for video production */
function findReady(targetDate?: string, targetMosque?: string): string[] {
  const contentDir = join(ROOT, "content");
  const dirs: string[] = [];

  let dates: string[];
  try {
    const { readdirSync } = require("fs");
    dates = targetDate ? [targetDate] : readdirSync(contentDir).filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  } catch { return []; }

  for (const date of dates) {
    const mosques = targetMosque ? [targetMosque] : ["makkah", "madinah"];
    for (const mosque of mosques) {
      const audioPath = join(ROOT, CONFIG.output.audio_dir, `${date}-${mosque}-th.mp3`);
      const videoPath = join(ROOT, CONFIG.output.video_dir, `${date}-${mosque}-full.mp4`);

      if (existsSync(audioPath) && !existsSync(videoPath)) {
        dirs.push(`${date}/${mosque}`);
      }
    }
  }

  return dirs;
}

/** Produce video for a single khutbah */
async function produceKhutbah(dateMosque: string): Promise<boolean> {
  const [date, mosque] = dateMosque.split("/");
  const contentPath = join(ROOT, "content", date, mosque);
  const audioDir = join(ROOT, CONFIG.output.audio_dir);
  const videoDir = join(ROOT, CONFIG.output.video_dir);
  mkdirSync(videoDir, { recursive: true });

  const metadata = JSON.parse(readFileSync(join(contentPath, "metadata.json"), "utf-8"));
  const bodyAudio = join(audioDir, `${date}-${mosque}-th.mp3`);

  console.log(`     🎬 Producing video for ${metadata.mosque_thai}...`);

  // Step 1: Generate intro/outro TTS
  const introFile = join(audioDir, `${date}-${mosque}-intro.mp3`);
  const outroFile = join(audioDir, `${date}-${mosque}-outro.mp3`);

  if (!existsSync(introFile)) {
    console.log(`     🎙️ Generating intro TTS...`);
    try {
      await ttsShort(generateIntroText(metadata, date), introFile);
      console.log(`     ✅ Intro generated`);
    } catch (err: any) {
      console.error(`     ❌ Intro TTS failed: ${err.message?.slice(0, 150)}`);
      return false;
    }
  }

  if (!existsSync(outroFile)) {
    console.log(`     🎙️ Generating outro TTS...`);
    try {
      await ttsShort(generateOutroText(), outroFile);
      console.log(`     ✅ Outro generated`);
    } catch (err: any) {
      console.error(`     ❌ Outro TTS failed: ${err.message?.slice(0, 150)}`);
      return false;
    }
  }

  // Step 2: Add silence padding to intro/outro
  const introPadded = join(audioDir, `${date}-${mosque}-intro-padded.mp3`);
  const outroPadded = join(audioDir, `${date}-${mosque}-outro-padded.mp3`);

  if (!existsSync(introPadded)) {
    console.log(`     🔇 Adding silence padding...`);
    addSilence(introFile, introPadded, 1, 2);  // 1s before, 2s after intro
    addSilence(outroFile, outroPadded, 2, 1);  // 2s before, 1s after outro
  }

  // Step 3: Concat intro + body + outro
  const fullAudio = join(audioDir, `${date}-${mosque}-full.mp3`);
  if (!existsSync(fullAudio)) {
    console.log(`     🔗 Assembling: intro + body + outro...`);
    concatAudio([introPadded, bodyAudio, outroPadded], fullAudio);
    const dur = getDuration(fullAudio);
    console.log(`     ✅ Full audio: ${dur.toFixed(0)}s (${(dur / 60).toFixed(1)} min)`);
  }

  // Step 4: Download Arabic source audio
  const arabicAudio = join(audioDir, `${date}-${mosque}-ar.mp3`);
  if (!existsSync(arabicAudio)) {
    console.log(`     📥 Downloading Arabic source audio...`);
    try {
      downloadArabicAudio(metadata.video_id, arabicAudio);
      console.log(`     ✅ Arabic audio downloaded`);
    } catch (err: any) {
      console.log(`     ⚠️ Arabic audio download failed — producing without mix`);
    }
  }

  // Step 5: Mix Thai + Arabic audio (if Arabic available)
  let videoAudio = fullAudio;
  if (existsSync(arabicAudio)) {
    const mixedAudio = join(audioDir, `${date}-${mosque}-mixed.mp3`);
    if (!existsSync(mixedAudio)) {
      console.log(`     🎚️ Mixing Thai (${(CONFIG.tts.thai_volume * 100).toFixed(0)}%) + Arabic (${(CONFIG.tts.arabic_volume * 100).toFixed(0)}%)...`);
      try {
        mixAudio(fullAudio, arabicAudio, mixedAudio);
        videoAudio = mixedAudio;
        console.log(`     ✅ Audio mixed`);
      } catch (err: any) {
        console.log(`     ⚠️ Mix failed — using Thai-only audio`);
      }
    } else {
      videoAudio = mixedAudio;
    }
  }

  // Step 6: Create video with background + audio
  const videoPath = join(videoDir, `${date}-${mosque}-full.mp4`);
  const mosqueFull = metadata.mosque === "makkah"
    ? "มัสยิดอัลฮะรอม มักกะฮ์"
    : "มัสยิดอันนะบะวีย์ มะดีนะฮ์";
  const title = `คุฏบะฮ์วันศุกร์ — ${mosqueFull}`;

  console.log(`     🎥 Creating video...`);
  try {
    createVideo(videoAudio, videoPath, title);
    const dur = getDuration(videoAudio);
    console.log(`     ✅ Video: ${videoPath}`);
    console.log(`     ⏱️ Duration: ${(dur / 60).toFixed(1)} min`);

    // Update metadata
    metadata.status = "produced";
    metadata.produced_at = new Date().toISOString();
    writeFileSync(join(contentPath, "metadata.json"), JSON.stringify(metadata, null, 2));

    return true;
  } catch (err: any) {
    console.error(`     ❌ Video creation failed: ${err.message?.slice(0, 200)}`);
    return false;
  }
}

// === MAIN ===
export async function produce(targetDate?: string, targetMosque?: string) {
  const ready = findReady(targetDate, targetMosque);

  if (ready.length === 0) {
    console.log("  ⚠️ No audio ready for video production (need Stage 3 TTS first)");
    return [];
  }

  console.log(`  📋 Found ${ready.length} khutbah(s) for production:`);
  const results: string[] = [];

  for (const item of ready) {
    console.log(`  🔄 ${item}`);
    const success = await produceKhutbah(item);
    if (success) results.push(item);
  }

  return results;
}

// Run if called directly
if (import.meta.main) {
  const targetDate = process.argv[2];
  const targetMosque = process.argv[3] as "makkah" | "madinah" | undefined;
  produce(targetDate, targetMosque).then((results) => {
    if (results.length > 0) {
      console.log(`\n  🎉 Produced ${results.length} video(s): ${results.join(", ")}`);
    }
  });
}
