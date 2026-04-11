/**
 * Load khutbah content from the pipeline's content/ directory
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const CONTENT_DIR = join(process.cwd(), "..", "content");

export interface KhutbahEntry {
  date: string;
  mosque: "makkah" | "madinah";
  mosqueThai: string;
  sheikh: string;
  videoId: string;
  videoUrl: string;
  slug: string;          // e.g. "2026-04-10-makkah"
  title: string;         // AI-generated topic title
  translationHtml: string;
  topics?: string[];
  ourYoutubeId?: string; // Our Thai translation YouTube video ID
}

const THAI_MONTHS = [
  "", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
];

export function formatThaiDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const thaiYear = year + 543;
  return `${day} ${THAI_MONTHS[month]} ${thaiYear}`;
}

import { marked } from "marked";

/** Convert markdown to HTML using proper parser */
function mdToHtml(md: string): string {
  let clean = md;

  // Remove YAML frontmatter ONLY if file literally starts with ---
  if (clean.startsWith("---\n")) {
    const endIdx = clean.indexOf("\n---\n", 4);
    if (endIdx > 0) {
      clean = clean.slice(endIdx + 5);
    }
  }

  // Remove top-level title (# คุฏบะฮ์วันศุกร์ — we render our own header)
  clean = clean.replace(/^# .+$/m, "");
  // Remove metadata bullet lines (- **วันที่:** etc)
  clean = clean.replace(/^- \*\*[^*]+\*\*:.*$/gm, "");
  // Remove "ไฮไลท์สำหรับ Reels" section and everything after it
  clean = clean.replace(/## ไฮไลท์สำหรับ Reels[\s\S]*$/m, "");
  // Remove periods — used for TTS pacing only, not for display
  // Only remove periods that are NOT part of numbers (e.g. 3.14) or abbreviations
  // Preserve newlines to keep paragraph structure
  clean = clean.replace(/\.(\n)/g, "$1");  // period before newline → just newline
  clean = clean.replace(/\. /g, " ");       // period + space → just space
  clean = clean.replace(/\.$/gm, "");       // period at end of line

  return marked.parse(clean, { async: false }) as string;
}

/** Load a single khutbah entry */
function loadEntry(date: string, mosque: string): KhutbahEntry | null {
  const dir = join(CONTENT_DIR, date, mosque);
  const metaPath = join(dir, "metadata.json");
  const translationPath = join(dir, "translation-th.md");

  if (!existsSync(metaPath) || !existsSync(translationPath)) return null;

  const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  const translation = readFileSync(translationPath, "utf-8");

  return {
    date: meta.date,
    mosque: meta.mosque,
    mosqueThai: meta.mosque === "makkah" ? "มัสยิดอัลฮะรอม มักกะฮ์" : "มัสยิดอันนะบะวีย์ มะดีนะฮ์",
    sheikh: meta.sheikh,
    videoId: meta.video_id,
    videoUrl: meta.video_url,
    slug: `${meta.date}-${meta.mosque}`,
    title: meta.title || `คุฏบะฮ์วันศุกร์`,
    translationHtml: mdToHtml(translation),
    topics: meta.topics,
    ourYoutubeId: meta.our_youtube_id,
  };
}

/** Load all khutbah entries, sorted by date descending */
export function loadAllEntries(): KhutbahEntry[] {
  if (!existsSync(CONTENT_DIR)) return [];

  const entries: KhutbahEntry[] = [];
  const dates = readdirSync(CONTENT_DIR)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse();

  for (const date of dates) {
    for (const mosque of ["makkah", "madinah"]) {
      const entry = loadEntry(date, mosque);
      if (entry) entries.push(entry);
    }
  }

  return entries;
}

/** Load a single entry by slug */
export function loadEntryBySlug(slug: string): KhutbahEntry | null {
  const match = slug.match(/^(\d{4}-\d{2}-\d{2})-(makkah|madinah)$/);
  if (!match) return null;
  return loadEntry(match[1], match[2]);
}
