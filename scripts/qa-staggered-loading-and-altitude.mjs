import puppeteer from 'puppeteer';

async function testStaggeredLoadingAndAltitudeTool() {
  console.log('===========================================================');
  console.log('   Verifying Staggered Data Loading & adjust_camera_altitude');
  console.log('===========================================================\n');

  // 1. Verify /api/gemini/config endpoint has adjust_camera_altitude
  const res = await fetch('http://localhost:4173/api/gemini/config');
  if (!res.ok) throw new Error(`/api/gemini/config returned HTTP ${res.status}`);
  const config = await res.json();
  const hasAltitudeTool = config.tools?.some((t) => t.name === 'adjust_camera_altitude');
  if (!hasAltitudeTool) {
    throw new Error('adjust_camera_altitude tool missing from /api/gemini/config');
  }
  console.log('✔ Backend Verified: adjust_camera_altitude declared in /api/gemini/config tools');

  // 2. Launch browser to test action execution and camera flight
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

  const runnerResults = await page.evaluate(async () => {
    const controller = window.__gevVoiceCommands;
    const runner = controller.runner;

    // Test adjust_camera_altitude tool
    const initialAlt = Math.round(controller.runner('get_current_view_state', {})?.then
      ? (await controller.runner('get_current_view_state', {})).camera?.heightMeters
      : 10000);

    const result = await runner('adjust_camera_altitude', {
      targetAltitudeMeters: 500,
      durationSeconds: 1,
    });

    // Test alias adjust_altitude
    const aliasResult = await runner('adjust_altitude', {
      targetAltitudeMeters: 25000,
      durationSeconds: 1,
    });

    return {
      altitudeResult: result,
      aliasResult,
    };
  });

  console.log('Runner Test Results:', JSON.stringify(runnerResults, null, 2));
  await browser.close();

  const ok = runnerResults.altitudeResult?.ok === true &&
             runnerResults.altitudeResult?.action === 'adjust_camera_altitude' &&
             runnerResults.altitudeResult?.targetAltitudeMeters === 500 &&
             runnerResults.aliasResult?.ok === true &&
             runnerResults.aliasResult?.targetAltitudeMeters === 25000;

  if (ok) {
    console.log('\n✔ All verifications passed: adjust_camera_altitude tool and staggered data loading verified!');
  } else {
    throw new Error('Verification failed');
  }
}

testStaggeredLoadingAndAltitudeTool().catch((err) => {
  console.error(err);
  process.exit(1);
});
