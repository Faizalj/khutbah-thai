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
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import { generateSubtitle } from "./subtitle-gen";

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

// Register Thai font
const SARABUN_PATH = "/System/Library/AssetsV2/com_apple_MobileAsset_Font8/cf0dc8d3b09f9ba379660e591e82566e2b557949.asset/AssetData/Sarabun.ttc";
try { GlobalFonts.registerFromPath(SARABUN_PATH, "Sarabun"); } catch {}

/** Download video thumbnail from YouTube */
function downloadThumbnail(videoId: string, outputPath: string): void {
  if (existsSync(outputPath)) return;
  execSync(
    `yt-dlp --write-thumbnail --skip-download --convert-thumbnails png -o "${outputPath.replace('.png', '')}" "https://www.youtube.com/watch?v=${videoId}" 2>/dev/null`,
    { timeout: 30000 }
  );
}

/** Create title card with video thumbnail background + text overlay */
async function createTitleCard(title: string, subtitle: string, thumbnailPath: string, outputPath: string): Promise<void> {
  const canvas = createCanvas(1920, 1080);
  const ctx = canvas.getContext("2d");

  // Draw thumbnail as background
  if (existsSync(thumbnailPath)) {
    const bg = await loadImage(thumbnailPath);
    ctx.drawImage(bg, 0, 0, 1920, 1080);
  } else {
    ctx.fillStyle = "#0d2818";
    ctx.fillRect(0, 0, 1920, 1080);
  }

  // Dark overlay for readability
  ctx.fillStyle = "rgba(13, 40, 24, 0.65)";
  ctx.fillRect(0, 0, 1920, 1080);

  // Title (gold)
  ctx.textAlign = "center";
  ctx.fillStyle = "#c9a84c";
  ctx.font = "bold 56px Sarabun";
  ctx.fillText(title, 960, 420);

  // Subtitle — mosque name (white)
  ctx.fillStyle = "white";
  ctx.font = "bold 44px Sarabun";
  ctx.fillText(subtitle.split(" — ")[0] || subtitle, 960, 490);

  // Sheikh + date (gold)
  ctx.fillStyle = "#c9a84c";
  ctx.font = "30px Sarabun";
  const sheikhDate = subtitle.includes(" — ") ? subtitle.split(" — ").slice(1).join(" — ") : "";
  if (sheikhDate) ctx.fillText(sheikhDate, 960, 550);

  // Brand (bottom)
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.font = "24px Sarabun";
  ctx.fillText("คุฏบะฮ์แปลไทย", 960, 980);

  writeFileSync(outputPath, canvas.toBuffer("image/png"));
}

/** Download source video from YouTube */
function downloadSourceVideo(videoId: string, outputPath: string): void {
  if (existsSync(outputPath)) return;
  execSync(
    `yt-dlp -f "bestvideo[height<=1080]+bestaudio/best[height<=1080]" --merge-output-format mp4 -o "${outputPath}" "https://www.youtube.com/watch?v=${videoId}" 2>/dev/null`,
    { timeout: 300000 }
  );
}

/** Create title card for intro/outro */
async function createTitleCardFile(title: string, subtitle: string, videoId: string, outputPath: string): Promise<void> {
  // Download thumbnail for background
  const thumbPath = outputPath.replace(".png", "-thumb.png");
  try { downloadThumbnail(videoId, thumbPath); } catch {}

  await createTitleCard(title, subtitle, thumbPath, outputPath);
  try { unlinkSync(thumbPath); } catch {}
}

/** Create final video: title card intro + source video with Thai TTS + title card outro */
async function createVideo(audioPath: string, outputPath: string, title: string, subtitle: string, videoId: string, metadata: any, date: string, mosque: string): Promise<void> {
  const videoDir = join(ROOT, CONFIG.output.video_dir);
  const audioDir = join(ROOT, CONFIG.output.audio_dir);
  mkdirSync(videoDir, { recursive: true });

  const thaiDur = getDuration(audioPath);
  const thaiVol = CONFIG.tts.thai_volume;
  const arVol = CONFIG.tts.arabic_volume;

  // Step 1: Download source video
  const sourceVideo = join(audioDir, `source-${videoId}.mp4`);
  if (!existsSync(sourceVideo)) {
    console.log(`     📥 Downloading source video...`);
    downloadSourceVideo(videoId, sourceVideo);
    console.log(`     ✅ Source video downloaded`);
  }

  // Step 2: Create title card image (for intro/outro segments)
  const titleImg = join(audioDir, `titlecard-${videoId}.png`);
  if (!existsSync(titleImg)) {
    await createTitleCardFile(title, subtitle, videoId, titleImg);
    console.log(`     ✅ Title card created`);
  }

  // Step 3: Create intro video (title card 5s)
  const introVideo = join(audioDir, `intro-${videoId}.mp4`);
  if (!existsSync(introVideo)) {
    // Get intro audio
    const introAudio = join(audioDir, `${date}-${mosque}-intro-padded.mp3`);
    if (existsSync(introAudio)) {
      const introDur = getDuration(introAudio);
      execSync(
        `ffmpeg -y -loop 1 -i "${titleImg}" -i "${introAudio}" ` +
        `-c:v libx264 -tune stillimage -preset fast -crf 23 ` +
        `-c:a aac -b:a 192k -t ${introDur} -pix_fmt yuv420p "${introVideo}" 2>/dev/null`,
        { timeout: 30000 }
      );
    }
  }

  // Step 4: Create main segment — source video + Thai TTS mixed audio
  const mainVideo = join(audioDir, `main-${videoId}.mp4`);
  if (!existsSync(mainVideo)) {
    console.log(`     🎚️ Mixing source video + Thai TTS...`);
    // Get body TTS audio path
    const bodyAudio = join(audioDir, `${date}-${mosque}-th.mp3`);
    const bodyDur = getDuration(bodyAudio);

    // Trim source video from khutbah start + replace audio with Thai TTS + lowered Arabic
    const startSec = metadata.khutbah_start_seconds || 25;
    console.log(`     ✂️ Trimming video from ${startSec}s (skipping pre-khutbah)...`);
    // Trim source video from khutbah start, match duration to TTS audio
    // If source video is shorter than TTS, use source video duration instead
    const sourceVideoDur = getDuration(sourceVideo) - startSec;
    const mainDur = Math.min(bodyDur, sourceVideoDur);
    console.log(`     📐 Source: ${(sourceVideoDur / 60).toFixed(1)}min, TTS: ${(bodyDur / 60).toFixed(1)}min → using ${(mainDur / 60).toFixed(1)}min`);

    execSync(
      `ffmpeg -y -ss ${startSec} -t ${mainDur} -i "${sourceVideo}" -i "${bodyAudio}" ` +
      `-filter_complex "[0:a]volume=${arVol}[ar];[1:a]atrim=0:${mainDur},volume=${thaiVol}[thai];[thai][ar]amix=inputs=2:duration=first[aout]" ` +
      `-map 0:v -map "[aout]" ` +
      `-c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -pix_fmt yuv420p "${mainVideo}" 2>/dev/null`,
      { timeout: 600000 }
    );
    console.log(`     ✅ Main segment created (${(mainDur / 60).toFixed(1)} min)`);
  }

  // Step 4b: Burn Thai subtitles onto main segment
  const mainWithSubs = join(audioDir, `main-subs-${videoId}.mp4`);
  if (!existsSync(mainWithSubs) && existsSync(mainVideo)) {
    console.log(`     📝 Generating subtitles...`);
    const srtPath = generateSubtitle(date, mosque);
    if (srtPath && existsSync(srtPath)) {
      console.log(`     🔥 Burning subtitles...`);
      try {
        execSync(
          `ffmpeg -y -i "${mainVideo}" ` +
          `-vf "subtitles=${srtPath}:force_style='FontName=Sarabun,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Shadow=1,MarginV=40'" ` +
          `-c:v libx264 -preset fast -crf 23 -c:a copy "${mainWithSubs}" 2>/dev/null`,
          { timeout: 600000 }
        );
        console.log(`     ✅ Subtitles burned`);
      } catch (err: any) {
        console.log(`     ⚠️ Subtitle burn failed, using video without subs`);
      }
    }
  }

  // Use subtitled version if available
  const mainForConcat = existsSync(mainWithSubs) ? mainWithSubs : mainVideo;

  // Step 5: Create overflow segment if TTS is longer than source video
  // Shows title card while remaining TTS audio plays
  const overflowVideo = join(audioDir, `overflow-${videoId}.mp4`);
  const bodyAudioForOverflow = join(audioDir, `${date}-${mosque}-th.mp3`);
  const bodyDurTotal = getDuration(bodyAudioForOverflow);
  const sourceVideoDurCheck = getDuration(sourceVideo) - (metadata.khutbah_start_seconds || 25);
  const overflowDur = bodyDurTotal - sourceVideoDurCheck;

  if (overflowDur > 5 && !existsSync(overflowVideo)) {
    console.log(`     📎 TTS overflow: ${(overflowDur / 60).toFixed(1)}min remaining → title card`);
    // Extract remaining TTS audio (from where video ended)
    const overflowAudio = join(audioDir, `overflow-audio-${videoId}.mp3`);
    execSync(
      `ffmpeg -y -ss ${sourceVideoDurCheck} -i "${bodyAudioForOverflow}" -c copy "${overflowAudio}" 2>/dev/null`,
      { timeout: 30000 }
    );
    const actualOverflowDur = getDuration(overflowAudio);
    execSync(
      `ffmpeg -y -loop 1 -i "${titleImg}" -i "${overflowAudio}" ` +
      `-c:v libx264 -tune stillimage -preset fast -crf 23 ` +
      `-c:a aac -b:a 192k -t ${actualOverflowDur} -pix_fmt yuv420p "${overflowVideo}" 2>/dev/null`,
      { timeout: 120000 }
    );
    try { unlinkSync(overflowAudio); } catch {}
    console.log(`     ✅ Overflow segment: ${(actualOverflowDur / 60).toFixed(1)}min`);
  }

  // Step 6: Create outro video (title card)
  const outroVideo = join(audioDir, `outro-${videoId}.mp4`);
  if (!existsSync(outroVideo)) {
    const outroAudio = join(audioDir, `${date}-${mosque}-outro-padded.mp3`);
    if (existsSync(outroAudio)) {
      const outroDur = getDuration(outroAudio);
      execSync(
        `ffmpeg -y -loop 1 -i "${titleImg}" -i "${outroAudio}" ` +
        `-c:v libx264 -tune stillimage -preset fast -crf 23 ` +
        `-c:a aac -b:a 192k -t ${outroDur} -pix_fmt yuv420p "${outroVideo}" 2>/dev/null`,
        { timeout: 30000 }
      );
    }
  }

  // Step 7: Concat intro + main + overflow (if any) + outro
  console.log(`     🔗 Assembling final video...`);
  const parts = [introVideo, mainForConcat, overflowVideo, outroVideo].filter(p => existsSync(p));
  const n = parts.length;
  const inputs = parts.map((p, i) => `-i "${p}"`).join(" ");
  const filterParts = parts.map((_, i) => `[${i}:v:0][${i}:a:0]`).join("");

  execSync(
    `ffmpeg -y ${inputs} ` +
    `-filter_complex "${filterParts}concat=n=${n}:v=1:a=1[outv][outa]" ` +
    `-map "[outv]" -map "[outa]" ` +
    `-c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -pix_fmt yuv420p "${outputPath}" 2>/dev/null`,
    { timeout: 600000 }
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
  const subtitle = `โดย ${metadata.sheikh} — ${formatThaiDate(date)}`;

  console.log(`     🎥 Creating video...`);
  try {
    await createVideo(videoAudio, videoPath, title, subtitle, metadata.video_id, metadata, date, mosque);
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
