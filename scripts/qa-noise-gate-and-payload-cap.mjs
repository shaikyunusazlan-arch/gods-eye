import puppeteer from 'puppeteer';

async function testNoiseGateAndPayloadCap() {
  console.log('===========================================================');
  console.log('   Verifying RMS Noise Gate and Tool Payload Truncation   ');
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
  await page.waitForFunction(() => Boolean(window.__gevVoiceCommands), { timeout: 15000 });

  const testResults = await page.evaluate(async () => {
    const controller = window.__gevVoiceCommands;
    const asm = controller.audioStreamManager;
    const client = controller.geminiClient;

    // 1. Test Noise Gate directly
    let emittedChunks = 0;
    const testSub = () => { emittedChunks++; };
    asm.subscribe(testSub);
    await asm.start();

    // Directly invoke onaudioprocess with silence (low RMS)
    const silenceBuffer = {
      inputBuffer: {
        getChannelData: () => new Float32Array(2048).fill(0.001), // RMS = 0.001 < 0.005
        sampleRate: 48000,
      },
    };
    const emittedBeforeSilence = emittedChunks;
    asm.scriptNode.onaudioprocess(silenceBuffer);
    const silenceDropped = emittedChunks === emittedBeforeSilence;

    // Directly invoke onaudioprocess with audible signal (high RMS)
    const soundBuffer = {
      inputBuffer: {
        getChannelData: () => new Float32Array(2048).fill(0.1), // RMS = 0.1 > 0.005
        sampleRate: 48000,
      },
    };
    asm.scriptNode.onaudioprocess(soundBuffer);
    const soundEmitted = emittedChunks > emittedBeforeSilence;

    asm.unsubscribe(testSub);
    asm.stop();

    // 2. Test Tool Payload Size Truncation
    let sentPayload = null;
    const mockWs = {
      readyState: 1, // OPEN
      send: (data) => { sentPayload = JSON.parse(data); },
    };
    const originalWs = client.ws;
    const originalRunner = client.runner;
    client.ws = mockWs;

    // Test a bloated tool result (> 15,000 chars)
    client.runner = async () => ({
      records: new Array(500).fill({ id: 'massive-record-item-test', lat: 35.68, lng: 139.76, desc: 'Large dataset entry exceeding buffer limits' }),
    });

    await client.executeToolCall('analyst_query', { query: 'test' }, 'call-large-payload-123');

    const fnResp = sentPayload?.toolResponse?.functionResponses?.[0]?.response;
    const wasTruncated = fnResp?.note && fnResp.note.includes('too large to transmit');

    // Restore original state
    client.ws = originalWs;
    client.runner = originalRunner;

    return {
      noiseGate: {
        silenceDropped,
        soundEmitted,
      },
      payloadTruncation: {
        wasTruncated,
        summaryStatus: fnResp?.status,
      },
    };
  });

  console.log('Test Results:', JSON.stringify(testResults, null, 2));
  await browser.close();

  if (testResults.noiseGate.silenceDropped &&
      testResults.noiseGate.soundEmitted &&
      testResults.payloadTruncation.wasTruncated) {
    console.log('\n✔ Verification Passed: Noise gate drops silence and payload guard caps oversized tool data!');
  } else {
    throw new Error('Verification failed');
  }
}

testNoiseGateAndPayloadCap().catch((err) => {
  console.error(err);
  process.exit(1);
});
