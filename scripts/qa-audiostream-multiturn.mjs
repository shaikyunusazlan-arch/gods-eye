import puppeteer from 'puppeteer';

async function testAudioStreamManagerMultiTurn() {
  console.log('===========================================================');
  console.log('   Verifying AudioStreamManager Multi-Turn Persistence   ');
  console.log('===========================================================\n');

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

  // Wait for the app to initialize
  await page.waitForFunction(() => Boolean(window.__gevVoiceCommands), { timeout: 15000 });

  const result = await page.evaluate(async () => {
    const controller = window.__gevVoiceCommands;
    const asm = controller.audioStreamManager;

    const turns = [];

    // Turn 1
    await asm.start();
    let turn1Chunks = 0;
    const sub1 = () => { turn1Chunks++; };
    asm.subscribe(sub1);

    await new Promise((r) => setTimeout(r, 1200));
    turns.push({
      turn: 1,
      chunks: turn1Chunks,
      recording: asm.recording,
      hasDummyGain: Boolean(asm.dummyGain),
      dummyGainMuted: asm.dummyGain?.gain?.value === 0,
    });

    // Turn 2: continuous streaming across another turn without restart
    let turn2Chunks = 0;
    const sub2 = () => { turn2Chunks++; };
    asm.subscribe(sub2);

    await new Promise((r) => setTimeout(r, 1200));
    turns.push({
      turn: 2,
      chunks: turn2Chunks,
      recording: asm.recording,
      hasDummyGain: Boolean(asm.dummyGain),
      dummyGainMuted: asm.dummyGain?.gain?.value === 0,
    });

    // Turn 3: simulate user toggling mic off
    asm.unsubscribe(sub1);
    asm.unsubscribe(sub2);
    asm.stop();

    const afterStopState = {
      recording: asm.recording,
      sourceIsNull: asm.source === null,
      scriptNodeIsNull: asm.scriptNode === null,
      dummyGainIsNull: asm.dummyGain === null,
    };

    // Turn 4: user toggles mic back on for another request
    await asm.start();
    let turn4Chunks = 0;
    const sub4 = () => { turn4Chunks++; };
    asm.subscribe(sub4);

    await new Promise((r) => setTimeout(r, 1200));
    turns.push({
      turn: 4,
      chunks: turn4Chunks,
      recording: asm.recording,
      hasDummyGain: Boolean(asm.dummyGain),
      dummyGainMuted: asm.dummyGain?.gain?.value === 0,
    });

    asm.unsubscribe(sub4);
    asm.stop();

    return {
      turns,
      afterStopState,
    };
  });

  console.log('Test Results:', JSON.stringify(result, null, 2));

  await browser.close();

  const allTurnsStreamed = result.turns.every((t) => t.chunks > 0 && t.hasDummyGain && t.dummyGainMuted);
  const cleanStop = result.afterStopState.recording === false &&
                    result.afterStopState.sourceIsNull &&
                    result.afterStopState.scriptNodeIsNull &&
                    result.afterStopState.dummyGainIsNull;

  if (allTurnsStreamed && cleanStop) {
    console.log('\n✔ Verification Passed: Multi-turn microphone streaming persisted and cleaned up perfectly!');
  } else {
    throw new Error('Verification failed');
  }
}

testAudioStreamManagerMultiTurn().catch((err) => {
  console.error(err);
  process.exit(1);
});
