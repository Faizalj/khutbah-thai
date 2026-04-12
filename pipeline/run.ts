#!/usr/bin/env bun
/**
 * Pipeline Orchestrator — Full automation
 * Runs all stages sequentially for a given date
 *
 * Usage: bun pipeline/run.ts [YYYY-MM-DD]
 * If no date given, uses today's date
 */

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
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
const logFile = join(ROOT, "output", `pipeline-${date}.log`);

function log(msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
}

log(`\n🕌 คุฏบะฮ์แปลไทย — Full Pipeline`);
log(`📅 Date: ${date}`);
log(`${"═".repeat(50)}`);

try {
  // Stage 1: Fetch
  log("▶ STAGE 1: FETCH");
  const fetched = await fetch(date);
  log(`✓ FETCH — ${fetched.length} new`);

  // Stage 1B: Correct
  log("▶ STAGE 1B: CORRECT");
  const corrected = await correct(date);
  log(`✓ CORRECT — ${corrected.length} corrected`);

  // Stage 2: Translate
  log("▶ STAGE 2: TRANSLATE");
  const translated = await translate(date);
  log(`✓ TRANSLATE — ${translated.length} translated`);

  // Stage 3: TTS
  log("▶ STAGE 3: TTS");
  const ttsResults = await tts(date);
  log(`✓ TTS — ${ttsResults.length} generated`);

  // Stage 4: Produce
  log("▶ STAGE 4: PRODUCE");
  const produced = await produce(date);
  log(`✓ PRODUCE — ${produced.length} videos`);

  // Stage 5: Publish (YouTube upload + thumbnail)
  log("▶ STAGE 5: PUBLISH");
  const published = await publish(date);
  log(`✓ PUBLISH — ${published.length} uploaded`);

  // Stage 6: Set YouTube thumbnails
  if (published.length > 0) {
    log("▶ STAGE 6: THUMBNAILS");
    try {
      execSync(`python3 -c "
import os, json
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from google.oauth2.credentials import Credentials
from pathlib import Path

env = {}
with open(os.path.expanduser('~/.env')) as f:
    for line in f:
        if '=' in line: k, v = line.strip().split('=', 1); env[k] = v

creds = Credentials(token=None, refresh_token=env['YOUTUBE_REFRESH_TOKEN'],
    client_id=env['YOUTUBE_CLIENT_ID'], client_secret=env['YOUTUBE_CLIENT_SECRET'],
    token_uri='https://oauth2.googleapis.com/token')
yt = build('youtube', 'v3', credentials=creds)

for mosque in ['makkah', 'madinah']:
    meta_path = Path('content/${date}') / mosque / 'metadata.json'
    thumb_path = Path('output/video/${date}') / f'${date}-{mosque}-thumb.png'
    if not meta_path.exists() or not thumb_path.exists(): continue
    m = json.loads(meta_path.read_text())
    if not m.get('our_youtube_id'): continue
    yt.thumbnails().set(
        videoId=m['our_youtube_id'],
        media_body=MediaFileUpload(str(thumb_path), mimetype='image/png')
    ).execute()
    print(f'  ✅ Thumbnail: {mosque} → {m[\"our_youtube_id\"]}')
"`, { cwd: ROOT, timeout: 30000 });
      log("✓ THUMBNAILS set");
    } catch {
      log("⚠️ THUMBNAILS failed (non-critical)");
    }
  }

  // Stage 7: Website rebuild + deploy
  log("▶ STAGE 7: WEBSITE DEPLOY");
  try {
    execSync("bun run astro build", { cwd: join(ROOT, "website"), timeout: 30000 });
    execSync("wrangler pages deploy dist --project-name khutbah-thai --commit-dirty=true", {
      cwd: join(ROOT, "website"), timeout: 60000
    });
    log("✓ WEBSITE deployed");
  } catch {
    log("⚠️ WEBSITE deploy failed (non-critical)");
  }

  // Stage 8: Git commit + push
  log("▶ STAGE 8: GIT COMMIT");
  try {
    execSync(`git add -A && git commit -m "Auto: Pipeline ${date} — Makkah + Madinah" && git push`, {
      cwd: ROOT, timeout: 30000
    });
    log("✓ GIT committed + pushed");
  } catch {
    log("⚠️ GIT commit failed (non-critical)");
  }

  log("═".repeat(50));
  log(`🎉 Pipeline complete for ${date}`);
  log(`   Fetched:    ${fetched.length}`);
  log(`   Corrected:  ${corrected.length}`);
  log(`   Translated: ${translated.length}`);
  log(`   TTS:        ${ttsResults.length}`);
  log(`   Produced:   ${produced.length}`);
  log(`   Published:  ${published.length}`);

} catch (err: any) {
  log(`❌ Pipeline FAILED: ${err.message}`);
  process.exit(1);
}
