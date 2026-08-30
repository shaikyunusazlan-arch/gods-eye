import puppeteer from 'puppeteer';

async function testGeocodingFallbackAndFlyTo() {
  console.log('===========================================================');
  console.log('   Verifying Nominatim Fallback & fly_to_location Tool');
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

  const results = await page.evaluate(async () => {
    const controller = window.__gevVoiceCommands;
    const runner = controller.runner;

    // Force Google API key to be undefined so Google Geocode & Places 403 / fail
    window.__GOOGLE_MAPS_API_KEY__ = undefined;

    // Test 1: fly_to_location with query "Downtown San Antonio" (should resolve via Nominatim fallback)
    const sanAntonioResult = await runner('fly_to_location', {
      query: 'Downtown San Antonio',
    });

    // Test 2: fly_to_location with direct coordinates
    const directCoordsResult = await runner('fly_to_location', {
      latitude: 29.4241,
      longitude: -98.4936,
      query: 'San Antonio',
    });

    return {
      sanAntonioResult,
      directCoordsResult,
    };
  });

  console.log('Geocoding Fallback Test Results:', JSON.stringify(results, null, 2));
  await browser.close();

  const passed = results.sanAntonioResult?.ok === true &&
                 results.directCoordsResult?.ok === true;

  if (passed) {
    console.log('\n✔ All verifications passed: OpenStreetMap (Nominatim) fallback successfully resolved location and flew camera!');
  } else {
    throw new Error('Verification failed: ' + JSON.stringify(results));
  }
}

testGeocodingFallbackAndFlyTo().catch((err) => {
  console.error(err);
  process.exit(1);
});
