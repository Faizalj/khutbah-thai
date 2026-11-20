# คุฏบะฮ์แปลไทย (Khutbah Thai)

แปลคุฏบะฮ์วันศุกร์จากมัสยิดอัลฮะรอม (มักกะฮ์) และมัสยิดอันนะบะวีย์ (มะดีนะฮ์) เป็นภาษาไทย พร้อมเสียงอ่านและวิดีโอ

## Pipeline

```
1. FETCH     → ดึง transcript อาหรับจาก YouTube (Haramain Recordings)
2. TRANSLATE → แปล อาหรับ → ไทย (Claude AI)
3. TTS       → สร้างเสียงอ่านภาษาไทย (ElevenLabs)
4. PRODUCE   → ผลิตวิดีโอ: เสียงอาหรับ 20% + เสียงไทย 80% + subtitle
5. PUBLISH   → เผยแพร่ YouTube + Facebook/IG Reels
```

## Output ต่อสัปดาห์

| ชิ้นงาน | จำนวน | Platform |
|---------|--------|----------|
| บทแปลฉบับเต็ม | 2 (มักกะฮ์ + มะดีนะฮ์) | Archive |
| วิดีโอยาว | 2 | YouTube |
| Reels/Shorts | 6-10 | FB/IG/YouTube |

## โครงสร้าง

```
khutbah-thai/
├── config.yaml          # ตั้งค่า source, filter, API
├── pipeline/            # Scripts 5 ขั้นตอน
├── templates/           # Template สำหรับ transcript/translation
├── content/             # Archive บทแปล (git-tracked)
│   └── YYYY-MM-DD/
│       ├── makkah/
│       └── madinah/
└── output/              # Media files (gitignored)
    ├── audio/
    ├── video/
    └── reels/
```

## Source

- Channel: [Haramain Recordings](https://www.youtube.com/channel/UC37tvO47bp_cKH1f4_VQCOA)
- Filter: เฉพาะวิดีโอที่ title มี "Jumu'ah Khutbah"
- ความถี่: 2 คลิป/สัปดาห์ (ศุกร์)
