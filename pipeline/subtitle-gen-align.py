#!/usr/bin/env python3
"""
Generate subtitle using stable-ts forced alignment
Text = our translation (100% correct), timing = aligned to TTS audio

Usage: KMP_DUPLICATE_LIB_OK=TRUE python3 pipeline/subtitle-gen-align.py <date> <mosque>
"""

import os
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

import re, sys, time, subprocess
from pathlib import Path

ROOT = Path(__file__).parent.parent
AUDIO_DIR = ROOT / "output" / "audio"


def get_clean_text(date, mosque):
    path = ROOT / "content" / date / mosque / "translation-th.md"
    text = path.read_text()
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end > 0: text = text[end+5:]
    text = re.sub(r'^#{1,6}\s+.*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'^---+$', '', text, flags=re.MULTILINE)
    text = re.sub(r'^-?\s*\*{0,2}(วันที่|เชค|แหล่งที่มา|Date|Sheikh|Source).*$', '', text, flags=re.MULTILINE|re.IGNORECASE)
    text = re.sub(r'https?://\S+', '', text)
    text = re.sub(r'## ไฮไลท์สำหรับ Reels[\s\S]*$', '', text)
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    text = re.sub(r'\*(.+?)\*', r'\1', text)
    text = re.sub(r'^>\s*', '', text, flags=re.MULTILINE)
    text = re.sub(r'\.(\n)', r'\1', text)
    text = re.sub(r'\. ', ' ', text)
    text = re.sub(r'\.$', '', text, flags=re.MULTILINE)
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def main():
    if len(sys.argv) < 3:
        print("Usage: python3 pipeline/subtitle-gen-align.py <date> <mosque>")
        sys.exit(1)

    date, mosque = sys.argv[1], sys.argv[2]
    tts_audio = AUDIO_DIR / f"{date}-{mosque}-th.mp3"
    whisper_dir = AUDIO_DIR / f"{date}-{mosque}-whisper"
    whisper_dir.mkdir(parents=True, exist_ok=True)

    # Convert to WAV if needed
    wav_path = whisper_dir / "whisper_input.wav"
    if not wav_path.exists():
        subprocess.run(["ffmpeg", "-y", "-i", str(tts_audio), "-ar", "16000", "-ac", "1", str(wav_path)],
                       capture_output=True, check=True)

    # Get our text
    text = get_clean_text(date, mosque)
    print(f"  📝 Text: {len(text)} chars")

    # Forced alignment with stable-ts
    import stable_whisper
    print("  🔧 Loading model...")
    model = stable_whisper.load_model("turbo", device="cpu")

    print("  🔗 Running forced alignment...")
    start = time.time()
    result = model.align(str(wav_path), text, language="th")
    elapsed = time.time() - start
    print(f"  ✅ Aligned in {elapsed:.0f}s — {len(result.segments)} segments")

    # Save SRT
    srt_path = ROOT / "content" / date / mosque / "subtitle-th.srt"
    result.to_srt_vtt(str(srt_path), word_level=False)
    print(f"  ✅ Saved: {srt_path}")

    # Preview
    print("\n  Last 5 segments:")
    for s in result.segments[-5:]:
        print(f"    [{s.start:.1f}s - {s.end:.1f}s] {s.text[:60]}")


if __name__ == "__main__":
    main()
