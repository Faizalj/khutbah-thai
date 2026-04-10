#!/usr/bin/env bun
/**
 * Quran Verification Utility
 * Verifies and corrects Quranic verses in transcript using alquran.cloud API
 *
 * Used by Stage 1B (Correct) to ensure 100% accuracy of Quranic text.
 * ZERO tolerance for errors in Quran text.
 *
 * API: https://alquran.cloud/api
 * - Search: GET /v1/search/{query}/all/ar
 * - Fetch by reference: GET /v1/ayah/{surah}:{ayah}/ar.uthmani
 */

const API_BASE = "https://api.alquran.cloud/v1";

export interface QuranMatch {
  surah: string;
  surahNumber: number;
  ayah: number;
  text: string;        // Verified Uthmani text from API
  reference: string;   // e.g. "سورة الأعراف: 199"
}

/** Search for a Quranic verse by partial Arabic text */
export async function searchVerse(query: string): Promise<QuranMatch[]> {
  // Clean query — take first 3-5 meaningful words
  const cleanQuery = query
    .replace(/[﴿﴾\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 5)
    .join(" ");

  if (cleanQuery.length < 5) return [];

  try {
    const url = `${API_BASE}/search/${encodeURIComponent(cleanQuery)}/all/ar`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return [];

    const data = await resp.json() as any;
    const matches = data?.data?.matches || [];

    // Filter to only Quran editions (not tafsir)
    const quranMatches = matches.filter((m: any) =>
      m.edition?.identifier === "quran-uthmani" || m.edition?.type === "quran"
    );

    // If no uthmani matches, take first match and fetch uthmani version
    const results: QuranMatch[] = [];

    for (const m of (quranMatches.length > 0 ? quranMatches : matches).slice(0, 3)) {
      const uthmaniText = await fetchUthmaniText(m.surah.number, m.numberInSurah);

      results.push({
        surah: m.surah.name,
        surahNumber: m.surah.number,
        ayah: m.numberInSurah,
        text: uthmaniText || m.text,
        reference: `${m.surah.name}: ${m.numberInSurah}`,
      });
    }

    return results;
  } catch {
    return [];
  }
}

/** Fetch the authoritative Uthmani text for a specific ayah */
export async function fetchUthmaniText(surah: number, ayah: number): Promise<string> {
  try {
    const url = `${API_BASE}/ayah/${surah}:${ayah}/ar.uthmani`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return "";

    const data = await resp.json() as any;
    return data?.data?.text || "";
  } catch {
    return "";
  }
}

/** Fetch a range of ayahs (e.g. surah 23, ayah 57-61) */
export async function fetchAyahRange(surah: number, startAyah: number, endAyah: number): Promise<string> {
  const verses: string[] = [];
  for (let i = startAyah; i <= endAyah; i++) {
    const text = await fetchUthmaniText(surah, i);
    if (text) verses.push(text);
    // Rate limit
    await Bun.sleep(200);
  }
  return verses.join(" ");
}

/**
 * Verify a Quranic verse found in a transcript.
 * Returns the CORRECT text from API, or null if not found.
 */
export async function verifyVerse(candidateText: string): Promise<QuranMatch | null> {
  const matches = await searchVerse(candidateText);
  if (matches.length === 0) return null;

  // Return the best (first) match with verified Uthmani text
  return matches[0];
}

// === CLI ===
if (import.meta.main) {
  const query = process.argv.slice(2).join(" ");
  if (!query) {
    console.log("Usage: bun quran-verify.ts <arabic text to verify>");
    console.log("Example: bun quran-verify.ts خذ العفو وأمر بالعرف");
    process.exit(0);
  }

  console.log(`🔍 Searching: "${query}"\n`);
  const matches = await searchVerse(query);

  if (matches.length === 0) {
    console.log("❌ No Quranic match found");
  } else {
    for (const m of matches) {
      console.log(`✅ ${m.reference}`);
      console.log(`   ${m.text}\n`);
    }
  }
}
