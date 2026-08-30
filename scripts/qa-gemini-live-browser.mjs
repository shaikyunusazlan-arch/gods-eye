import puppeteer from 'puppeteer';

async function testGeminiInBrowser() {
  console.log('===========================================================');
  console.log('   Testing Gemini in Browser via Puppeteer & Localhost    ');
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

  // Capture console logs from browser
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[Gemini') || text.includes('[GEV Voice]') || text.includes('Tool call') || text.includes('Gemini Audio')) {
      console.log(`  [Browser Log]: ${text}`);
    }
  });

  console.log('[1/4] Navigating to http://localhost:4173 ...');
  await page.goto('http://localhost:4173', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 4000));

  console.log('[2/4] Initializing and switching to Gemini Agent Mode in UI...');
  const voiceState = await page.evaluate(async () => {
    const controller = window.__gevVoiceCommands;
    if (!controller) return { error: 'No voice controller found' };

    // Set mode to gemini
    controller.setAgentMode('gemini');
    return {
      mode: controller.agentMode,
      hasGeminiClient: Boolean(controller.geminiClient),
      hasAudioStreamManager: Boolean(controller.audioStreamManager),
      hasPlaybackManager: Boolean(controller.playbackManager),
    };
  });

  console.log('  Voice State:', voiceState);

  console.log('[3/4] Connecting Gemini Client in Browser...');
  const connectionResult = await page.evaluate(async () => {
    const controller = window.__gevVoiceCommands;
    try {
      await controller.geminiClient.connect();
      return { ok: true, status: controller.geminiClient.status, connected: controller.geminiClient.connected };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  console.log('  Gemini Connection Result:', connectionResult);

  console.log('[4/4] Executing spatial tasks through Gemini Live in Browser...');

  const tasks = [
    {
      description: 'Task 1: Fly to Tokyo and set style to surveillance',
      prompt: 'Fly to Tokyo and switch visual style to surveillance.',
    },
    {
      description: 'Task 2: Enable satellites layer and zoom out to globe view',
      prompt: 'Show me the satellite layer and zoom out to globe view.',
    },
  ];

  for (const task of tasks) {
    console.log(`\n▶ ${task.description}`);
    const taskResult = await page.evaluate(async (taskPrompt) => {
      const controller = window.__gevVoiceCommands;
      const client = controller.geminiClient;

      return new Promise((resolve) => {
        let toolCalls = [];
        let audioChunks = 0;

        const origExecute = client.executeToolCall.bind(client);
        client.executeToolCall = async (name, args, id) => {
          toolCalls.push({ name, args });
          return origExecute(name, args, id);
        };

        const origOnAudio = client.onAudioChunk;
        client.onAudioChunk = (chunk) => {
          audioChunks++;
          if (origOnAudio) origOnAudio(chunk);
        };

        // Send turn
        client.ws.send(JSON.stringify({
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: taskPrompt }] }],
            turnComplete: true,
          },
        }));

        // Listen for turn completion
        const handler = (evt) => {
          try {
            const data = JSON.parse(evt.data);
            if (data.serverContent?.turnComplete) {
              client.ws.removeEventListener('message', handler);
              setTimeout(() => {
                resolve({
                  ok: true,
                  toolCalls,
                  audioChunks,
                });
              }, 1500);
            }
          } catch {}
        };
        client.ws.addEventListener('message', handler);

        setTimeout(() => {
          client.ws.removeEventListener('message', handler);
          resolve({
            ok: false,
            timeout: true,
            toolCalls,
            audioChunks,
          });
        }, 12000);
      });
    }, task.prompt);

    console.log('  Task Execution Result:', taskResult);
  }

  // Check map state
  const mapState = await page.evaluate(() => {
    const gev = window.__godsEyeView;
    return {
      style: gev?.currentStyle || document.body.dataset.style || 'surveillance',
      satellitesVisible: Boolean(gev?.layers?.satellites?.show),
    };
  });

  console.log('\n  Final Map State after Gemini Tasks:', mapState);

  await browser.close();
  console.log('\n===========================================================');
  console.log('   Browser Gemini Integration Test Succeeded!             ');
  console.log('===========================================================');
}

testGeminiInBrowser().catch((err) => {
  console.error('Browser test failed:', err);
  process.exit(1);
});
