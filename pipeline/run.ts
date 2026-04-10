#!/usr/bin/env bun
/**
 * Pipeline Orchestrator
 * Runs stages sequentially for a given date
 *
 * Usage: bun pipeline/run.ts [YYYY-MM-DD]
 * If no date given, uses today's date
 */

import { fetch } from "./1-fetch";
import { correct } from "./1b-correct";
import { translate } from "./2-translate";
import { tts } from "./3-tts";
import { produce } from "./4-produce";

const date = process.argv[2] || new Date().toISOString().split("T")[0];

console.log(`\n🕌 คุฏบะฮ์แปลไทย — Pipeline`);
console.log(`📅 Date: ${date}`);
console.log(`${"═".repeat(50)}\n`);

// Stage 1: Fetch
console.log("▶ STAGE 1: FETCH");
const fetched = await fetch(date);
console.log(`✓ FETCH done — ${fetched.length} new\n`);

// Stage 1B: Correct
console.log("▶ STAGE 1B: CORRECT");
const corrected = await correct(date);
console.log(`✓ CORRECT done — ${corrected.length} corrected\n`);

// Stage 2: Translate
console.log("▶ STAGE 2: TRANSLATE");
const translated = await translate(date);
console.log(`✓ TRANSLATE done — ${translated.length} translated\n`);

// Stage 3: TTS
console.log("▶ STAGE 3: TTS");
const ttsResults = await tts(date);
console.log(`✓ TTS done — ${ttsResults.length} generated\n`);

// Stage 4: Produce
console.log("▶ STAGE 4: PRODUCE");
const produced = await produce(date);
console.log(`✓ PRODUCE done — ${produced.length} videos\n`);

// Stage 5: Publish — manual for now
console.log("▶ STAGE 5: PUBLISH — manual upload for now\n");

console.log("═".repeat(50));
console.log(`🎉 Pipeline complete for ${date}`);
console.log(`   Fetched:    ${fetched.length}`);
console.log(`   Corrected: ${corrected.length}`);
console.log(`   Translated: ${translated.length}`);
console.log(`   TTS:        ${ttsResults.length}`);
console.log(`   Produced:   ${produced.length}`);
