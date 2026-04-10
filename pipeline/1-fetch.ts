#!/usr/bin/env bun
/**
 * Stage 1: FETCH
 * Poll Haramain Recordings channel → filter Jumu'ah Khutbah → download Arabic transcript
 *
 * Usage: bun pipeline/1-fetch.ts [YYYY-MM-DD]
 * If no date given, fetches the most recent Jumu'ah Khutbah videos
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { join } from "path";

const ROOT = import.meta.dir.replace("/pipeline", "");
const CONFIG = parseYaml(readFileSync(join(ROOT, "config.yaml"), "utf-8"));

interface VideoInfo {
  id: string;
  title: string;
  date: string;
  mosque: "makkah" | "madinah";
  mosqueThai: string;
  sheikh: string;
}

/** List recent videos from channel, filter for Jumu'ah Khutbah */
function listKhutbahVideos(targetDate?: string): VideoInfo[] {
  const channelUrl = `https://www.youtube.com/channel/${CONFIG.source.channel_id}/videos`;

  console.log("  📡 Polling channel:", CONFIG.source.channel_name);

  const raw = execSync(
    `yt-dlp --flat-playlist --print "%(title)s|||%(id)s" --playlist-end 30 "${channelUrl}" 2>/dev/null`,
    { encoding: "utf-8", timeout: 30000 }
  );

  const videos: VideoInfo[] = [];

  for (const line of raw.trim().split("\n")) {
    const [title, id] = line.split("|||");
    if (!title || !id) continue;

    // Filter: must contain "Jumu'ah Khutbah"
    if (!title.includes(CONFIG.source.filter_pattern)) continue;

    // Extract date from title: "10th Apr 2026 Makkah Jumu'ah Khutbah Sheikh Humaid"
    const dateMatch = title.match(/(\d{1,2})\w*\s+(\w+)\s+(\d{4})/);
    if (!dateMatch) continue;

    const [, day, monthStr, year] = dateMatch;
    const months: Record<string, string> = {
      Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
      Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
    };
    const month = months[monthStr];
    if (!month) continue;

    const date = `${year}-${month}-${day.padStart(2, "0")}`;

    // If target date specified, skip others
    if (targetDate && date !== targetDate) continue;

    // Identify mosque
    let mosque: "makkah" | "madinah" = "makkah";
    let mosqueThai = "มักกะฮ์";
    for (const m of CONFIG.naming.mosques) {
      if (title.includes(m.title_match)) {
        mosque = m.id;
        mosqueThai = m.thai_name;
        break;
      }
    }

    // Extract sheikh name: everything after "Khutbah "
    const sheikhMatch = title.match(/Khutbah\s+(.+)$/);
    const sheikh = sheikhMatch ? sheikhMatch[1] : "Unknown";

    videos.push({ id, title, date, mosque, mosqueThai, sheikh });
  }

  return videos;
}

/** Download Arabic auto-captions for a video */
function downloadTranscript(videoId: string, outputPath: string): string {
  const tmpDir = `/tmp/khutbah-fetch-${videoId}`;
  mkdirSync(tmpDir, { recursive: true });

  const subLang = CONFIG.source.subtitle_lang;
  execSync(
    `yt-dlp --write-auto-sub --sub-lang "${subLang}" --sub-format srt --skip-download -o "${tmpDir}/sub_%(id)s" "https://www.youtube.com/watch?v=${videoId}" 2>/dev/null`,
    { timeout: 30000 }
  );

  // Find the SRT file
  const srtFile = `${tmpDir}/sub_${videoId}.${subLang}.srt`;
  if (!existsSync(srtFile)) {
    throw new Error(`SRT file not found: ${srtFile}`);
  }

  return readFileSync(srtFile, "utf-8");
}

/** Clean SRT content to plain Arabic text */
function cleanSrt(srt: string): string {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const line of srt.split("\n")) {
    // Skip sequence numbers, timestamps, empty lines, and speaker tags
    if (/^\d+$/.test(line.trim())) continue;
    if (/-->/.test(line)) continue;
    if (line.trim() === "") continue;
    if (/^>>/.test(line.trim())) {
      // Remove >> prefix but keep the text
      const cleaned = line.trim().replace(/^>>\s*/, "");
      if (cleaned && !seen.has(cleaned)) {
        seen.add(cleaned);
        lines.push(cleaned);
      }
      continue;
    }
    // Skip non-content like [تنحنح]
    if (/^\[.*\]$/.test(line.trim())) continue;

    const trimmed = line.trim();
    // Deduplicate — auto-captions repeat phrases across overlapping timestamps
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      lines.push(trimmed);
    }
  }

  return lines.join("\n");
}

/** Detect khutbah 1 vs 2 split point */
function splitKhutbahs(text: string): { khutbah1: string; khutbah2: string } {
  // The second khutbah typically starts with a new "الحمد لله" after a gap
  // In the transcript, look for the second occurrence of الحمد لله after significant text
  const lines = text.split("\n");
  const totalLines = lines.length;

  // Find الحمد لله occurrences
  const hamdIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("الحمد لله") && i > 5) {
      hamdIndices.push(i);
    }
  }

  // The split is typically at a الحمد لله that appears after 40%+ of the text
  let splitIndex = -1;
  for (const idx of hamdIndices) {
    if (idx > totalLines * 0.35) {
      splitIndex = idx;
      break;
    }
  }

  if (splitIndex > 0) {
    return {
      khutbah1: lines.slice(0, splitIndex).join("\n").trim(),
      khutbah2: lines.slice(splitIndex).join("\n").trim(),
    };
  }

  return { khutbah1: text, khutbah2: "" };
}

// === MAIN ===
export async function fetch(targetDate?: string) {
  console.log("  🔍 Searching for Jumu'ah Khutbah videos...");
  const videos = listKhutbahVideos(targetDate);

  if (videos.length === 0) {
    console.log("  ⚠️  No Jumu'ah Khutbah videos found" + (targetDate ? ` for ${targetDate}` : ""));
    return [];
  }

  console.log(`  📋 Found ${videos.length} khutbah(s):`);
  const processed: string[] = [];

  for (const video of videos) {
    const contentDir = join(ROOT, "content", video.date, video.mosque);

    // Skip if already processed
    if (existsSync(join(contentDir, "transcript-ar.md"))) {
      console.log(`  ⏭️  ${video.mosque} ${video.date} — already processed`);
      continue;
    }

    console.log(`  📥 ${video.title}`);

    // Download transcript
    console.log(`     Downloading Arabic transcript...`);
    const srt = downloadTranscript(video.id, contentDir);

    // Clean SRT
    const cleanText = cleanSrt(srt);
    const { khutbah1, khutbah2 } = splitKhutbahs(cleanText);

    console.log(`     Cleaned: ${cleanText.split("\n").length} unique lines`);

    // Create content directory
    mkdirSync(contentDir, { recursive: true });

    // Save transcript
    const transcriptMd = `# Transcript — ${video.mosqueThai} Jumu'ah Khutbah

- **Date:** ${video.date}
- **Sheikh:** ${video.sheikh}
- **Source:** https://www.youtube.com/watch?v=${video.id}

---

## الخطبة الأولى (คุฏบะฮ์แรก)

${khutbah1}

---

## الخطبة الثانية (คุฏบะฮ์ที่สอง)

${khutbah2 || "(ไม่สามารถแยกคุฏบะฮ์ที่สองได้อัตโนมัติ)"}
`;

    writeFileSync(join(contentDir, "transcript-ar.md"), transcriptMd);
    console.log(`     ✅ Saved transcript-ar.md`);

    // Save metadata
    const metadata = {
      date: video.date,
      mosque: video.mosque,
      mosque_thai: video.mosqueThai,
      sheikh: video.sheikh,
      video_id: video.id,
      video_url: `https://www.youtube.com/watch?v=${video.id}`,
      source_channel: CONFIG.source.channel_name,
      status: "fetched",
      fetched_at: new Date().toISOString(),
    };

    writeFileSync(join(contentDir, "metadata.json"), JSON.stringify(metadata, null, 2));
    console.log(`     ✅ Saved metadata.json`);

    processed.push(`${video.date}/${video.mosque}`);
  }

  return processed;
}

// Run if called directly
if (import.meta.main) {
  const targetDate = process.argv[2];
  fetch(targetDate).then((results) => {
    if (results.length > 0) {
      console.log(`\n  🎉 Fetched ${results.length} khutbah(s): ${results.join(", ")}`);
    }
  });
}
