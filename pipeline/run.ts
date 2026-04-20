#!/usr/bin/env bun
/**
 * Pipeline Orchestrator — Full automation (fault-tolerant)
 * Each mosque processed independently — one failure doesn't block the other
 *
 * Usage: bun pipeline/run.ts [YYYY-MM-DD]
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { fetch } from "./1-fetch";
import { correct } from "./1b-correct";
import { translate } from "./2-translate";
import { tts } from "./3-tts";
import { produce } from "./4-produce";
import { publish } from "./5-publish";

const ROOT = import.meta.dir.replace("/pipeline", "");
const CONFIG = parseYaml(readFileSync(join(ROOT, "config.yaml"), "utf-8"));
const date = process.argv[2] || new Date().toISOString().split("T")[0];

function log(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

/** Run a stage with retry, return results. Never throws — logs errors instead */
async function safeRun<T>(name: string, fn: () => Promise<T>, retries = 1): Promise<T | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (attempt < retries) {
        log(`⚠️ ${name} failed (attempt ${attempt + 1}/${retries + 1}), retrying in 10s...`);
        await Bun.sleep(10000);
      } else {
        log(`❌ ${name} FAILED: ${err.message?.slice(0, 200)}`);
        return null;
      }
    }
  }
  return null;
}

/** Generate thumbnail for a mosque */
function generateThumbnail(date: string, mosque: string) {
  const metaPath = join(ROOT, "content", date, mosque, "metadata.json");
  if (!existsSync(metaPath)) return;
  const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  const thumbPath = join(ROOT, CONFIG.output.video_dir, `${date}-${mosque}-thumb.png`);
  if (existsSync(thumbPath)) return;

  const THAI_MONTHS = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
    "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
  const [y, m, d] = date.split("-").map(Number);
  const thaiDate = `${d} ${THAI_MONTHS[m]} ${y + 543}`;
  const mosqueFull = mosque === "makkah" ? "มัสยิดอัลฮะรอม มักกะฮ์" : "มัสยิดอันนะบะวีย์ มะดีนะฮ์";

  // Use bun subprocess to generate thumbnail with canvas
  execSync(`bun -e "
    const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
    const { writeFileSync, existsSync } = require('fs');
    GlobalFonts.registerFromPath('/System/Library/AssetsV2/com_apple_MobileAsset_Font8/cf0dc8d3b09f9ba379660e591e82566e2b557949.asset/AssetData/Sarabun.ttc', 'Sarabun');
    (async () => {
      const canvas = createCanvas(1280, 720);
      const ctx = canvas.getContext('2d');
      const bgPath = '${join(ROOT, CONFIG.output.audio_dir, "thumb-" + meta.video_id + ".png")}';
      if (existsSync(bgPath)) { const bg = await loadImage(bgPath); ctx.drawImage(bg, 0, 0, 1280, 720); }
      else { ctx.fillStyle = '#0d2818'; ctx.fillRect(0, 0, 1280, 720); }
      ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(0, 0, 1280, 720);
      const grad = ctx.createLinearGradient(0, 500, 0, 720);
      grad.addColorStop(0, 'rgba(13,40,24,0)'); grad.addColorStop(1, 'rgba(13,40,24,0.9)');
      ctx.fillStyle = grad; ctx.fillRect(0, 500, 1280, 220);
      ctx.textAlign = 'center'; ctx.font = 'bold 72px Sarabun'; ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.fillStyle = 'white';
      const title = ${JSON.stringify(meta.title || "คุฏบะฮ์วันศุกร์")};
      const words = title.split(' '); let lines = []; let cur = '';
      for (const w of words) { if (ctx.measureText(cur+' '+w).width > 1100 && cur) { lines.push(cur); cur = w; } else { cur = cur ? cur+' '+w : w; } }
      if (cur) lines.push(cur);
      const ty = 360 - (lines.length-1)*45;
      for (let i = 0; i < lines.length; i++) { ctx.strokeText(lines[i], 640, ty+i*90); ctx.fillText(lines[i], 640, ty+i*90); }
      const my = ty + lines.length*90 + 20;
      ctx.font = 'bold 42px Sarabun'; ctx.fillStyle = '#c9a84c'; ctx.lineWidth = 4;
      ctx.strokeText(${JSON.stringify(mosqueFull)}, 640, my); ctx.fillText(${JSON.stringify(mosqueFull)}, 640, my);
      ctx.font = 'bold 32px Sarabun'; ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 3;
      const sub = ${JSON.stringify(meta.sheikh + "  ·  " + thaiDate)};
      ctx.strokeText(sub, 640, my+55); ctx.fillText(sub, 640, my+55);
      ctx.textAlign = 'left'; ctx.font = 'bold 36px Sarabun'; ctx.fillStyle = '#c9a84c'; ctx.lineWidth = 4;
      ctx.strokeText('คุฏบะฮ์แปลไทย', 40, 690); ctx.fillText('คุฏบะฮ์แปลไทย', 40, 690);
      writeFileSync('${thumbPath}', canvas.toBuffer('image/png'));
    })();
  "`, { cwd: ROOT, timeout: 30000 });
  log(`  ✅ Thumbnail: ${mosque}`);
}

/** Set YouTube thumbnail */
function setYouTubeThumbnail(date: string, mosque: string) {
  const metaPath = join(ROOT, "content", date, mosque, "metadata.json");
  if (!existsSync(metaPath)) return;
  const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  const thumbPath = join(ROOT, CONFIG.output.video_dir, `${date}-${mosque}-thumb.png`);
  if (!meta.our_youtube_id || !existsSync(thumbPath)) return;

  execSync(`python3 -c "
import os, json
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from google.oauth2.credentials import Credentials
env = {}
with open(os.path.expanduser('~/.env')) as f:
    for line in f:
        if '=' in line: k, v = line.strip().split('=', 1); env[k] = v
creds = Credentials(token=None, refresh_token=env['YOUTUBE_REFRESH_TOKEN'],
    client_id=env['YOUTUBE_CLIENT_ID'], client_secret=env['YOUTUBE_CLIENT_SECRET'],
    token_uri='https://oauth2.googleapis.com/token')
yt = build('youtube', 'v3', credentials=creds)
yt.thumbnails().set(videoId='${meta.our_youtube_id}',
    media_body=MediaFileUpload('${thumbPath}', mimetype='image/png')).execute()
print('OK')
"`, { cwd: ROOT, timeout: 30000 });
  log(`  ✅ YT Thumbnail: ${mosque} → ${meta.our_youtube_id}`);
}

/** Upload to Facebook */
function uploadFacebook(date: string, mosque: string) {
  const metaPath = join(ROOT, "content", date, mosque, "metadata.json");
  const videoPath = join(ROOT, CONFIG.output.video_dir, `${date}-${mosque}-full.mp4`);
  if (!existsSync(metaPath) || !existsSync(videoPath)) return;
  const meta = JSON.parse(readFileSync(metaPath, "utf-8"));

  const THAI_MONTHS = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
    "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
  const [y, m, d] = date.split("-").map(Number);
  const thaiDate = `${d} ${THAI_MONTHS[m]} ${y + 543}`;
  const mosqueFull = mosque === "makkah" ? "มัสยิดอัลฮะรอม มักกะฮ์" : "มัสยิดอันนะบะวีย์ มะดีนะฮ์";

  const title = `${meta.title || "คุฏบะฮ์วันศุกร์"} | คุฏบะฮ์วันศุกร์ ${mosque === "makkah" ? "มักกะฮ์" : "มะดีนะฮ์"} ${thaiDate}`;
  const desc = `คุฏบะฮ์วันศุกร์จาก${mosqueFull}\nโดย ${meta.sheikh} — ${thaiDate}\n\nแปลและอ่านออกเสียงโดยระบบปัญญาประดิษฐ์\nหากมีข้อผิดพลาดประการใด ได้โปรดแจ้งเราเพื่อแก้ไข\n\nอ่านบทแปลฉบับเต็ม: https://khutbahthai.com`;

  execSync(
    `python3 "${join(ROOT, "pipeline", "facebook-upload.py")}" ${JSON.stringify(videoPath)} ${JSON.stringify(title)} ${JSON.stringify(desc)}`,
    { cwd: ROOT, timeout: 600000 }
  );
  log(`  ✅ Facebook: ${mosque}`);
}

// ============ MAIN ============

log(`\n🕌 คุฏบะฮ์แปลไทย — Full Pipeline (fault-tolerant)`);
log(`📅 Date: ${date}`);
log("═".repeat(50));

const results = { fetched: 0, corrected: 0, translated: 0, tts: 0, produced: 0, published: 0, errors: [] as string[] };

// Stage 1: Fetch (both mosques together — single channel poll)
log("▶ STAGE 1: FETCH");
const fetched = await safeRun("FETCH", () => fetch(date), 2);
results.fetched = fetched?.length || 0;
log(`✓ FETCH — ${results.fetched} new`);

// Stage 1B-5: Process each mosque independently
for (const mosque of ["makkah", "madinah"]) {
  const contentDir = join(ROOT, "content", date, mosque);
  if (!existsSync(join(contentDir, "transcript-ar.md"))) {
    log(`⏭️ ${mosque} — no transcript, skipping`);
    continue;
  }

  log(`\n━━━ ${mosque.toUpperCase()} ━━━`);

  // 1B: Correct
  const corrected = await safeRun(`CORRECT ${mosque}`, () => correct(date, mosque), 1);
  if (corrected) results.corrected++;

  // 2: Translate (retry 2 times — most likely to timeout)
  if (!existsSync(join(contentDir, "translation-th.md"))) {
    const translated = await safeRun(`TRANSLATE ${mosque}`, () => translate(date, mosque), 2);
    if (translated) results.translated++;
  } else {
    log(`  ⏭️ Translation exists`);
    results.translated++;
  }

  // 2b: Auto-generate title if missing
  if (existsSync(join(contentDir, "translation-th.md"))) {
    const meta = JSON.parse(readFileSync(join(contentDir, "metadata.json"), "utf-8"));
    if (!meta.title) {
      try {
        const translation = readFileSync(join(contentDir, "translation-th.md"), "utf-8").slice(0, 2000);
        const titleResult = execSync(
          `echo ${JSON.stringify(translation)} | claude --print --model haiku --output-format text --setting-sources '' --system-prompt "สร้างหัวข้อสั้นภาษาไทย 1 บรรทัด ไม่เกิน 60 ตัวอักษร สำหรับคุฏบะฮ์นี้ ตอบแค่หัวข้ออย่างเดียว"`,
          { encoding: "utf-8", timeout: 30000 }
        ).trim();
        if (titleResult && titleResult.length < 80) {
          meta.title = titleResult;
          writeFileSync(join(contentDir, "metadata.json"), JSON.stringify(meta, null, 2));
          log(`  ✅ Title: ${titleResult}`);
        }
      } catch { log(`  ⚠️ Title generation failed`); }
    }
  }

  // 3: TTS
  if (existsSync(join(contentDir, "translation-th.md"))) {
    const ttsResult = await safeRun(`TTS ${mosque}`, () => tts(date, mosque), 1);
    if (ttsResult) results.tts++;
  }

  // 4: Produce
  const videoPath = join(ROOT, CONFIG.output.video_dir, `${date}-${mosque}-full.mp4`);
  if (!existsSync(videoPath) && existsSync(join(ROOT, CONFIG.output.audio_dir, `${date}-${mosque}-th.mp3`))) {
    const produced = await safeRun(`PRODUCE ${mosque}`, () => produce(date, mosque), 1);
    if (produced) results.produced++;
  }

  // 4b: Thumbnail
  if (existsSync(videoPath)) {
    try { generateThumbnail(date, mosque); } catch (e: any) { log(`  ⚠️ Thumbnail failed: ${e.message?.slice(0, 100)}`); }
  }

  // 5: Publish YouTube
  if (existsSync(videoPath)) {
    const meta = JSON.parse(readFileSync(join(contentDir, "metadata.json"), "utf-8"));
    if (!meta.our_youtube_id) {
      const published = await safeRun(`PUBLISH ${mosque}`, () => publish(date, mosque), 1);
      if (published) {
        results.published++;
        // Set thumbnail after upload
        try { setYouTubeThumbnail(date, mosque); } catch (e: any) { log(`  ⚠️ YT Thumbnail failed: ${e.message?.slice(0, 100)}`); }
      }
    } else {
      log(`  ⏭️ Already published: ${meta.our_youtube_id}`);
      results.published++;
    }
  }

  // 6: Facebook
  if (existsSync(videoPath)) {
    try { uploadFacebook(date, mosque); } catch (e: any) { log(`  ⚠️ Facebook failed: ${e.message?.slice(0, 100)}`); }
  }
}

// Stage 7: Website
log("\n▶ WEBSITE DEPLOY");
try {
  execSync("bun run astro build", { cwd: join(ROOT, "website"), timeout: 30000 });
  execSync("wrangler pages deploy dist --project-name khutbah-thai --commit-dirty=true", {
    cwd: join(ROOT, "website"), timeout: 60000
  });
  log("✓ WEBSITE deployed");
} catch { log("⚠️ WEBSITE deploy failed"); }

// Copy thumbnails to website public
try {
  execSync(`cp output/video/${date}-*-thumb.png website/public/thumbnails/ 2>/dev/null`, { cwd: ROOT });
} catch {}

// Stage 8: Git
log("▶ GIT COMMIT");
try {
  execSync(`git add -A && git commit -m "Auto: Pipeline ${date}" && git push`, { cwd: ROOT, timeout: 30000 });
  log("✓ GIT committed + pushed");
} catch { log("⚠️ GIT commit/push failed"); }

log("\n" + "═".repeat(50));
log(`🎉 Pipeline complete for ${date}`);
log(`   Fetched:    ${results.fetched}`);
log(`   Corrected:  ${results.corrected}`);
log(`   Translated: ${results.translated}`);
log(`   TTS:        ${results.tts}`);
log(`   Produced:   ${results.produced}`);
log(`   Published:  ${results.published}`);
