# คุฏบะฮ์แปลไทย (Khutbah Thai)

## Project

Automated pipeline that translates weekly Jumu'ah khutbah from Makkah and Madinah into Thai, with TTS voiceover video production.

## Source

- YouTube channel: Haramain Recordings (UC37tvO47bp_cKH1f4_VQCOA)
- Filter: only "Jumu'ah Khutbah" videos (2 per week)
- Subtitle language: ar-orig (Arabic auto-captions)

## Pipeline (5 stages)

1. `pipeline/1-fetch.ts` — Poll channel, filter, download Arabic transcript
2. `pipeline/2-translate.ts` — Arabic → Thai translation via Claude
3. `pipeline/3-tts.ts` — Thai text → ElevenLabs audio
4. `pipeline/4-produce.ts` — Mix audio + create video with subtitles
5. `pipeline/5-publish.ts` — Upload to platforms (deferred)
6. `pipeline/run.ts` — Orchestrator

## Translation Guidelines

- Use standard Thai Islamic terminology (transliteration from Arabic)
- Preserve Quranic verse references with surah name + ayah number
- Keep du'a sections in both Arabic and Thai
- Structure: คุฏบะฮ์แรก + คุฏบะฮ์ที่สอง clearly separated
- Extract 3-5 highlight quotes suitable for Reels

## Key Terms (MANDATORY spelling — TTS will mispronounce if wrong)

- คุฏบะฮ์ (خطبة) — not คุตบะห์
- มักกะฮ์ (مكة) — not เมกกะ
- มะดีนะฮ์ (المدينة) — not มาดีนา
- อัลฮะรอม (الحرام) — not อัลฮาราม
- ตั๊กวา (تقوى) — NOT ตักวา, must have ไม้ตรี
- เนี๊ยะมัต (نعمة) — NOT เนียมัต or เนียวมัต
- เศาะลาวาต (صلوات) — clear ต, NOT ซาลาวาน
- ศ็อลลัลลอฮุอะลัยฮิวะซัลลัม — full phrase, never ﷺ symbol
- เราะฎิยัลลอฮุอันฮุ — full phrase, never (ร.ฎ.)
- เราะฮิมะฮุลลอฮ์ — full phrase, never (ร.ฮ.)
- ซุบฮานะฮูวะตะอาลา — NOT สุบหานะฮู
- อิสติกอมะฮ์ (استقامة)
- ดุอาอ์ (دعاء)

## TTS Rules

- Translation must be written for LISTENING not reading
- Short sentences. One idea per sentence. End with period.
- No headers, no markers, no bullet points in translation
- Full Thai phonetic for all Islamic terms — never abbreviations
- Quranic verses: prefix with "อัลลอฮ์ ซุบฮานะฮูวะตะอาลา ตรัสว่า"

## Content Structure

```
content/YYYY-MM-DD/
├── makkah/
│   ├── transcript-ar.md   # Arabic transcript (cleaned from SRT)
│   ├── translation-th.md  # Thai translation + highlights
│   └── metadata.json      # title, sheikh, video_id, date, status
└── madinah/
    ├── transcript-ar.md
    ├── translation-th.md
    └── metadata.json
```

## Important

- This project is NON-SECTARIAN — no school of thought branding
- Content is for all Thai-speaking Muslims
- Quality over speed — religious content accuracy matters
