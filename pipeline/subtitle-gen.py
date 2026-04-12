#!/usr/bin/env python3
"""
Generate Thai SRT subtitle from Whisper timing + translation text

Uses SequenceMatcher to align Whisper transcription with our translation,
then splits at Thai word boundaries using pythainlp.

Usage: python3 pipeline/subtitle-gen.py <date> <mosque>
"""

import json, re, sys, subprocess
from pathlib import Path
from difflib import SequenceMatcher
from pythainlp.tokenize import word_tokenize as th_tokenize

ROOT = Path(__file__).parent.parent
AUDIO_DIR = ROOT / "output" / "audio"


def fmt_srt(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def word_boundaries(text):
    tokens = th_tokenize(text, engine="newmm")
    boundaries = set()
    p = 0
    for tok in tokens:
        boundaries.add(p)
        p += len(tok)
    boundaries.add(p)
    return sorted(boundaries)


def nearest_boundary(text, pos):
    bounds = word_boundaries(text)
    return min(bounds, key=lambda b: abs(b - pos))


def get_clean_text(date, mosque):
    # Use TTS source text if available (exact text that TTS read)
    tts_source = ROOT / "content" / date / mosque / "tts-source-text.txt"
    if tts_source.exists():
        return tts_source.read_text().strip()

    path = ROOT / "content" / date / mosque / "translation-th.md"
    text = path.read_text()

    # Remove frontmatter
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end > 0:
            text = text[end + 5:]

    # Strip markdown
    text = re.sub(r'^#{1,6}\s+.*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'^---+$', '', text, flags=re.MULTILINE)
    text = re.sub(r'.*ส่วนที่\s+\d+/\d+.*', '', text)
    text = re.sub(r'^-?\s*\*{0,2}(วันที่|เชค|แหล่งที่มา|Date|Sheikh|Source).*$', '', text, flags=re.MULTILINE | re.IGNORECASE)
    text = re.sub(r'https?://\S+', '', text)
    text = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', text)
    text = re.sub(r'## ไฮไลท์สำหรับ Reels[\s\S]*$', '', text)
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    text = re.sub(r'\*(.+?)\*', r'\1', text)
    text = re.sub(r'^>\s*', '', text, flags=re.MULTILINE)
    text = re.sub(r'^[-*]\s+', '', text, flags=re.MULTILINE)
    # Remove periods
    text = re.sub(r'\.(\n)', r'\1', text)
    text = re.sub(r'\. ', ' ', text)
    text = re.sub(r'\.$', '', text, flags=re.MULTILINE)
    # Flatten
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def run_whisper(audio_path, output_dir):
    wav_path = output_dir / "whisper_input.wav"
    json_path = output_dir / "whisper_input.json"

    if not wav_path.exists():
        subprocess.run([
            "ffmpeg", "-y", "-i", str(audio_path),
            "-ar", "16000", "-ac", "1", str(wav_path)
        ], capture_output=True, check=True)

    if not json_path.exists():
        print("     🎤 Running mlx_whisper turbo...")
        subprocess.run([
            "mlx_whisper", str(wav_path),
            "--model", "mlx-community/whisper-turbo",
            "--language", "th",
            "-f", "json",
            "-o", str(output_dir),
            "--condition-on-previous-text", "False",
            "--hallucination-silence-threshold", "2",
            "--no-speech-threshold", "0.5",
        ], check=True)

    return json.loads(json_path.read_text())


def main():
    if len(sys.argv) < 3:
        print("Usage: python3 pipeline/subtitle-gen.py <date> <mosque>")
        sys.exit(1)

    date, mosque = sys.argv[1], sys.argv[2]
    tts_audio = AUDIO_DIR / f"{date}-{mosque}-th.mp3"

    if not tts_audio.exists():
        print(f"  ❌ TTS audio not found: {tts_audio}")
        sys.exit(1)

    # 1. Whisper
    whisper_dir = AUDIO_DIR / f"{date}-{mosque}-whisper"
    whisper_dir.mkdir(parents=True, exist_ok=True)
    result = run_whisper(tts_audio, whisper_dir)
    segments = result["segments"]
    print(f"     📊 Whisper: {len(segments)} segments")

    # 2. Get script text
    script_text = get_clean_text(date, mosque)
    print(f"     📝 Script: {len(script_text)} chars")

    # 2b. Remove Whisper hallucinations (30s garbage segments)
    clean_segments = []
    for seg in segments:
        t = seg["text"].strip()
        d = seg["end"] - seg["start"]
        words = t.split()
        unique_words = len(set(words))
        if d >= 20 and unique_words <= 6 and len(words) > 8:
            print(f"     ⚠️ Hallucination removed: [{seg['start']:.0f}s-{seg['end']:.0f}s]")
            continue
        clean_segments.append(seg)
    segments = clean_segments

    # 3. Parse segments — split long ones at ~3.5s boundaries
    parsed = []
    for seg in segments:
        t = seg["text"].strip()
        d = seg["end"] - seg["start"]
        if d <= 5 or len(t) <= 40:
            parsed.append({"text": t, "start": seg["start"], "end": seg["end"]})
        else:
            # Split proportionally
            n_parts = max(2, int(d / 3.5))
            part_len = len(t) / n_parts
            part_dur = d / n_parts
            for i in range(n_parts):
                s_idx = int(i * part_len)
                e_idx = int((i + 1) * part_len) if i < n_parts - 1 else len(t)
                # Snap to Thai word boundary
                if i > 0:
                    s_idx = nearest_boundary(t, s_idx)
                if i < n_parts - 1:
                    e_idx = nearest_boundary(t, e_idx)
                chunk = t[s_idx:e_idx].strip()
                if chunk:
                    parsed.append({
                        "text": chunk,
                        "start": seg["start"] + i * part_dur,
                        "end": seg["start"] + (i + 1) * part_dur
                    })

    print(f"     📐 Parsed: {len(parsed)} segments")

    # 4. SequenceMatcher alignment
    print("     🔗 Aligning whisper ↔ script...")
    wf = "".join(s["text"] for s in parsed)
    m = SequenceMatcher(None, wf, script_text, autojunk=False)
    w2s = {}
    for tag, w1, w2, s1, s2 in m.get_opcodes():
        if tag == "equal":
            for i, j in zip(range(w1, w2), range(s1, s2)):
                w2s[i] = j
        elif tag == "replace":
            for k in range(w2 - w1):
                w2s[w1 + k] = s1 + int(k * (s2 - s1) / max(w2 - w1, 1))
        elif tag == "delete":
            for k in range(w1, w2):
                w2s[k] = s1

    # 5. Replace whisper text with script text
    corrected = []
    wp = 0
    for seg in parsed:
        sl = len(seg["text"])
        sp = [w2s[i] for i in range(wp, wp + sl) if i in w2s]
        if sp:
            start_in_script = min(sp)
            end_in_script = max(sp) + 1
            start_snapped = nearest_boundary(script_text, start_in_script)
            end_snapped = nearest_boundary(script_text, end_in_script)
            txt = script_text[start_snapped:end_snapped].strip()
            if txt:
                corrected.append({"text": txt, "start": seg["start"], "end": seg["end"]})
        wp += sl

        # Sort by time
        corrected.sort(key=lambda x: x["start"])

    print(f"     ✅ Corrected: {len(corrected)} segments")

    # 5b. Post-process: split segments that are too long (>80 chars or >6 seconds)
    final_segments = []
    for seg in corrected:
        text = seg["text"].replace(".", "").strip()
        dur = seg["end"] - seg["start"]
        if not text:
            continue
        if len(text) <= 80 and dur <= 6:
            final_segments.append({"text": text, "start": seg["start"], "end": seg["end"]})
        else:
            # Split at Thai word boundaries
            bounds = word_boundaries(text)
            n_parts = max(2, len(text) // 50)
            part_dur = dur / n_parts
            part_len = len(text) / n_parts
            for i in range(n_parts):
                s_idx = nearest_boundary(text, int(i * part_len)) if i > 0 else 0
                e_idx = nearest_boundary(text, int((i + 1) * part_len)) if i < n_parts - 1 else len(text)
                chunk = text[s_idx:e_idx].strip()
                if chunk:
                    final_segments.append({
                        "text": chunk,
                        "start": seg["start"] + i * part_dur,
                        "end": seg["start"] + (i + 1) * part_dur
                    })

    print(f"     📐 Final: {len(final_segments)} segments (after split)")

    # 6. Build SRT
    srt_blocks = []
    for i, seg in enumerate(final_segments, 1):
        text = seg["text"].strip()
        if not text:
            continue

        # Split into max 2 lines at word boundary
        if len(text) > 45:
            mid = len(text) // 2
            break_at = nearest_boundary(text, mid)
            if 10 < break_at < len(text) - 10:
                text = text[:break_at].strip() + "\n" + text[break_at:].strip()

        srt_blocks.append(f"{i}\n{fmt_srt(seg['start'])} --> {fmt_srt(seg['end'])}\n{text}")

    srt = "\n\n".join(srt_blocks) + "\n"

    # Save
    srt_path = ROOT / "content" / date / mosque / "subtitle-th.srt"
    srt_path.write_text(srt)
    print(f"  ✅ Generated {len(srt_blocks)} subtitle blocks → {srt_path}")


if __name__ == "__main__":
    main()
