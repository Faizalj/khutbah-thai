#!/usr/bin/env bun
/**
 * Stage 5: PUBLISH
 * Upload video to YouTube via API + update metadata with video ID
 *
 * First run requires OAuth login (opens browser).
 * Subsequent runs use cached token.
 *
 * Usage: bun pipeline/5-publish.ts [YYYY-MM-DD] [makkah|madinah]
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { parse as parseYaml } from "yaml";
import { join } from "path";

const ROOT = import.meta.dir.replace("/pipeline", "");
const CONFIG = parseYaml(readFileSync(join(ROOT, "config.yaml"), "utf-8"));

const CLIENT_SECRET = "/Users/faizal/Downloads/client_secret_665960870283-lrre598gepk6m2e2gh6i6hcfhl3h96s8.apps.googleusercontent.com.json";
const TOKEN_PATH = join(ROOT, ".youtube-token.json");

const THAI_MONTHS = [
  "", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
];

function formatThaiDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  return `${day} ${THAI_MONTHS[month]} ${year + 543}`;
}

/** Upload video to YouTube using Python script */
async function uploadToYouTube(
  videoPath: string,
  title: string,
  description: string,
  tags: string[]
): Promise<string | null> {
  try {
    const result = execSync(
      `python3 "${join(ROOT, "pipeline", "youtube-upload.py")}" ` +
      `${JSON.stringify(videoPath)} ` +
      `${JSON.stringify(title)} ` +
      `${JSON.stringify(description)} ` +
      `${JSON.stringify(tags.join(","))}`,
      {
        encoding: "utf-8",
        timeout: 600000,
        maxBuffer: 1024 * 1024 * 10,
      }
    );

    const match = result.match(/VIDEO_ID=(\S+)/);
    return match ? match[1] : null;
  } catch (err: any) {
    console.error(`     ❌ Upload failed: ${err.message?.slice(0, 200)}`);
    return null;
  }
}

/** Find videos ready to publish */
function findReady(targetDate?: string, targetMosque?: string): string[] {
  const contentDir = join(ROOT, "content");
  const dirs: string[] = [];

  let dates: string[];
  try {
    dates = targetDate ? [targetDate] : require("fs").readdirSync(contentDir).filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  } catch { return []; }

  for (const date of dates) {
    const mosques = targetMosque ? [targetMosque] : ["makkah", "madinah"];
    for (const mosque of mosques) {
      const videoPath = join(ROOT, CONFIG.output.video_dir, `${date}-${mosque}-full.mp4`);
      const metaPath = join(ROOT, "content", date, mosque, "metadata.json");

      if (!existsSync(videoPath) || !existsSync(metaPath)) continue;

      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      if (!meta.our_youtube_id) {
        dirs.push(`${date}/${mosque}`);
      }
    }
  }

  return dirs;
}

/** Publish a single khutbah video */
async function publishKhutbah(dateMosque: string): Promise<boolean> {
  const [date, mosque] = dateMosque.split("/");
  const contentPath = join(ROOT, "content", date, mosque);
  const metadata = JSON.parse(readFileSync(join(contentPath, "metadata.json"), "utf-8"));
  const videoPath = join(ROOT, CONFIG.output.video_dir, `${date}-${mosque}-full.mp4`);

  const mosqueFull = mosque === "makkah"
    ? "มัสยิดอัลฮะรอม มักกะฮ์"
    : "มัสยิดอันนะบะวีย์ มะดีนะฮ์";

  const thaiDate = formatThaiDate(date);
  const title = `${metadata.title || "คุฏบะฮ์วันศุกร์"} | คุฏบะฮ์วันศุกร์ ${mosque === "makkah" ? "มักกะฮ์" : "มะดีนะฮ์"} ${thaiDate}`;

  const description = `คุฏบะฮ์วันศุกร์จาก${mosqueFull}
โดย ${metadata.sheikh} — ${thaiDate}

แปลและอ่านออกเสียงโดยระบบปัญญาประดิษฐ์
หากมีข้อผิดพลาดประการใด ได้โปรดแจ้งเราเพื่อแก้ไข

อ่านบทแปลฉบับเต็ม: https://khutbah-thai.pages.dev

#คุฏบะฮ์ #คุฏบะฮ์แปลไทย #${mosque === "makkah" ? "มักกะฮ์" : "มะดีนะฮ์"} #วันศุกร์ #อิสลาม`;

  const tags = ["คุฏบะฮ์", "คุฏบะฮ์แปลไทย", "วันศุกร์", "อิสลาม",
    mosque === "makkah" ? "มักกะฮ์" : "มะดีนะฮ์",
    metadata.sheikh, "Jumu'ah Khutbah"];

  console.log(`     📤 Uploading: ${title.slice(0, 60)}...`);
  const videoId = await uploadToYouTube(videoPath, title, description, tags);

  if (videoId) {
    console.log(`     ✅ YouTube: https://www.youtube.com/watch?v=${videoId}`);

    // Update metadata
    metadata.our_youtube_id = videoId;
    metadata.published_at = new Date().toISOString();
    metadata.status = "published";
    writeFileSync(join(contentPath, "metadata.json"), JSON.stringify(metadata, null, 2));

    return true;
  }

  return false;
}

// === MAIN ===
export async function publish(targetDate?: string, targetMosque?: string) {
  const ready = findReady(targetDate, targetMosque);

  if (ready.length === 0) {
    console.log("  ⚠️ No videos ready to publish");
    return [];
  }

  console.log(`  📋 Found ${ready.length} video(s) to publish:`);
  const results: string[] = [];

  for (const item of ready) {
    console.log(`  🔄 ${item}`);
    const success = await publishKhutbah(item);
    if (success) results.push(item);
  }

  return results;
}

if (import.meta.main) {
  const targetDate = process.argv[2];
  const targetMosque = process.argv[3] as "makkah" | "madinah" | undefined;
  publish(targetDate, targetMosque).then((results) => {
    if (results.length > 0) {
      console.log(`\n  🎉 Published ${results.length} video(s): ${results.join(", ")}`);
    }
  });
}
