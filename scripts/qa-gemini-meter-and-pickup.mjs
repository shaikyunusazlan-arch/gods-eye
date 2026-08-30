import puppeteer from 'puppeteer';
import { truncateToolDataArrays } from '../src/voice/geminiLiveClient.js';

async function testGeminiMeterAndAudioPickup() {
  console.log('===========================================================');
  console.log('   Verifying VAD Buffer, Gemini Activity Meter & Tool Array Truncation');
  console.log('===========================================================\n');

  // 1. Test truncateToolDataArrays in Node
  const testLargePayload = {
    query: 'satellites',
    satellites: Array.from({ length: 50 }, (_, i) => ({ id: `SAT-${i}`, name: `Satellite ${i}`, lat: i * 2, lon: i * 3 })),
    nested: {
      items: Array.from({ length: 25 }, (_, i) => ({ item: i, desc: `Item description ${i}` })),
      singleValue: 'ok',
    },
    count: 50,
  };

  const truncated = truncateToolDataArrays(testLargePayload, 5);
  if (truncated.satellites.length !== 5 || truncated.satellitesTotalCount !== 50) {
    throw new Error(`Array truncation failed on top-level array: length=${truncated.satellites.length}`);
  }
  if (truncated.nested.items.length !== 5 || truncated.nested.itemsTotalCount !== 25) {
    throw new Error(`Array truncation failed on nested array: length=${truncated.nested.items.length}`);
  }
  console.log('✔ Part 3 Verified: Large tool data arrays truncated to max 5 items with count annotations.');

  // 2. Launch browser to verify UI meter and VAD buffer in Web Audio
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
    ],
  });

  const page = await browser.newPage();
  await page.goto('http://localhost:4173', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => Boolean(window.__gevVoiceCommands), { timeout: 15000 });

  const testResults = await page.evaluate(async () => {
    const controller = window.__gevVoiceCommands;
    const asm = controller.audioStreamManager;
    const meter = controller.geminiMeter;

    // 1. Verify Mode Visibility Toggle
    controller.setAgentMode('openai');
    const openaiModeHidden = meter.root.hidden === true;

    controller.setAgentMode('gemini');
    const geminiModeVisible = meter.root.hidden === false;

    // 2. Verify Meter States via global updateGeminiMeter and class setState
    window.updateGeminiMeter('idle');
    const stateIdle = {
      state: meter.root.dataset.state,
      text: meter.statusText.textContent,
    };

    window.updateGeminiMeter('listening');
    const stateListening = {
      state: meter.root.dataset.state,
      text: meter.statusText.textContent,
    };

    window.updateGeminiMeter('processing');
    const stateProcessing = {
      state: meter.root.dataset.state,
      text: meter.statusText.textContent,
    };

    window.updateGeminiMeter('speaking');
    const stateSpeaking = {
      state: meter.root.dataset.state,
      text: meter.statusText.textContent,
    };

    // 3. Verify VAD Buffer: silenceFrames counter and 30-frame cutoff (~1s trailing silence)
    let emittedCount = 0;
    let activityLog = [];
    asm.onVoiceActivity = (active, rms) => {
      activityLog.push({ active, rms });
    };
    asm.subscribe(() => { emittedCount++; });
    await asm.start();

    // Voice syllable: RMS = 0.003 (>= 0.002) -> sets silenceFrames = 0 and emits chunk
    const voiceInputBuffer = {
      inputBuffer: {
        getChannelData: () => new Float32Array(2048).fill(0.003),
        sampleRate: 48000,
      },
    };
    const countBeforeVoice = emittedCount;
    asm.scriptNode.onaudioprocess(voiceInputBuffer);
    const voiceAudioEmitted = emittedCount > countBeforeVoice;
    const silenceFramesResetOnVoice = asm.silenceFrames === 0;

    // Trailing silence buffer: 30 consecutive silence frames (RMS = 0.0005 < 0.002)
    // All 30 must be smoothly emitted without clipping
    const silenceBuffer = {
      inputBuffer: {
        getChannelData: () => new Float32Array(2048).fill(0.0005),
        sampleRate: 48000,
      },
    };
    const countBeforeTrailingSilence = emittedCount;
    for (let i = 0; i < 30; i++) {
      asm.scriptNode.onaudioprocess(silenceBuffer);
    }
    const trailingSilenceEmittedCount = emittedCount - countBeforeTrailingSilence;
    const silenceFramesAfter30 = asm.silenceFrames;

    // 31st silence frame: silenceFrames becomes 31 (> 30) -> MUST be dropped/returned
    const countBefore31st = emittedCount;
    asm.scriptNode.onaudioprocess(silenceBuffer);
    const frame31Dropped = emittedCount === countBefore31st;

    asm.stop();
    const silenceFramesResetOnStop = asm.silenceFrames === 0;

    return {
      visibility: {
        openaiModeHidden,
        geminiModeVisible,
      },
      states: {
        stateIdle,
        stateListening,
        stateProcessing,
        stateSpeaking,
      },
      vadBuffer: {
        voiceAudioEmitted,
        silenceFramesResetOnVoice,
        trailingSilenceEmittedCount,
        silenceFramesAfter30,
        frame31Dropped,
        silenceFramesResetOnStop,
      },
    };
  });

  console.log('UI & VAD Test Results:', JSON.stringify(testResults, null, 2));
  await browser.close();

  const ok = testResults.visibility.openaiModeHidden &&
             testResults.visibility.geminiModeVisible &&
             testResults.states.stateIdle.state === 'idle' &&
             testResults.states.stateIdle.text === 'IDLE' &&
             testResults.states.stateListening.state === 'listening' &&
             testResults.states.stateListening.text === 'LISTENING' &&
             testResults.states.stateProcessing.state === 'processing' &&
             testResults.states.stateProcessing.text === 'PROCESSING' &&
             testResults.states.stateSpeaking.state === 'speaking' &&
             testResults.states.stateSpeaking.text === 'SPEAKING' &&
             testResults.vadBuffer.voiceAudioEmitted &&
             testResults.vadBuffer.silenceFramesResetOnVoice &&
             testResults.vadBuffer.trailingSilenceEmittedCount === 30 &&
             testResults.vadBuffer.silenceFramesAfter30 === 30 &&
             testResults.vadBuffer.frame31Dropped &&
             testResults.vadBuffer.silenceFramesResetOnStop;

  if (ok) {
    console.log('\n✔ All verifications passed: VAD buffer, Gemini activity meter, and tool array truncation verified!');
  } else {
    throw new Error('Verification failed');
  }
}

testGeminiMeterAndAudioPickup().catch((err) => {
  console.error(err);
  process.exit(1);
});
