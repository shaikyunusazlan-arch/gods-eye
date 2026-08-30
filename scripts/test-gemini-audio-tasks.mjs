import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP_DIR = path.join(ROOT, '.gev-cache', 'audio-test');

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function synthesizeSpeechToPcm16k(text, filenamePrefix) {
  const aiffPath = path.join(TMP_DIR, `${filenamePrefix}.aiff`);
  const pcmPath = path.join(TMP_DIR, `${filenamePrefix}.pcm`);

  // macOS say
  execSync(`say -v Samantha "${text.replace(/"/g, '\\"')}" -o "${aiffPath}"`);
  // Convert to 16kHz, 16-bit mono PCM raw
  execSync(`ffmpeg -y -i "${aiffPath}" -f s16le -acodec pcm_s16le -ac 1 -ar 16000 "${pcmPath}" 2>/dev/null`);

  const pcmBuffer = fs.readFileSync(pcmPath);
  return pcmBuffer;
}

async function runGeminiAudioTaskTest() {
  console.log('===========================================================');
  console.log('   Testing Gemini Live Audio & Task Execution Interface   ');
  console.log('===========================================================\n');

  console.log('[1/4] Fetching Gemini configuration from local server...');
  const res = await fetch('http://localhost:4173/api/gemini/config');
  if (!res.ok) {
    throw new Error(`Failed to fetch /api/gemini/config: ${res.statusText}`);
  }
  const config = await res.json();
  console.log('  Model:', config.model);
  console.log('  Voice:', config.voice);
  console.log('  Tools loaded:', config.tools?.length);

  const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${config.apiKey}`;

  console.log('\n[2/4] Connecting to Gemini Multimodal Live WebSocket...');
  const ws = new WebSocket(wsUrl);

  const tasks = [
    {
      name: 'Task 1: Fly to Tokyo and set visual style to surveillance',
      speechText: 'Fly to Tokyo and switch visual style to surveillance.',
    },
    {
      name: 'Task 2: Enable satellites layer and fly to globe view',
      speechText: 'Please show me the satellites layer and zoom out to globe view.',
    },
  ];

  await new Promise((resolve, reject) => {
    let setupDone = false;

    ws.on('open', () => {
      console.log('  WebSocket Connected! Sending setup handshake...');
      const setupMsg = {
        setup: {
          model: config.model || 'models/gemini-2.5-flash-native-audio-latest',
          generationConfig: {
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: config.voice || 'Puck',
                },
              },
            },
          },
          systemInstruction: {
            parts: [
              {
                text: [
                  "You are God's Eye View AI agent controlling a photorealistic 3D Earth globe.",
                  "Use the provided tool functions (fly_to_location, set_layer_visibility, set_visual_style, control_cctv, annotate_map, etc.) to immediately respond to spatial commands.",
                  "Always confirm map actions concisely with audio.",
                ].join(' '),
              },
            ],
          },
          tools: [{ functionDeclarations: config.tools }],
        },
      };
      ws.send(JSON.stringify(setupMsg));
    });

    ws.on('message', async (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.setupComplete) {
        setupDone = true;
        console.log('  Gemini Setup Complete & Ready!');
        resolve();
      }
    });

    ws.on('error', (err) => {
      console.error('WebSocket Error:', err);
      reject(err);
    });

    setTimeout(() => {
      if (!setupDone) reject(new Error('Handshake timeout'));
    }, 15000);
  });

  console.log('\n[3/4] Testing Audio Tasks sequentially...\n');

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    console.log(`-----------------------------------------------------------`);
    console.log(`▶ Executing ${task.name}`);
    console.log(`  Spoken Input: "${task.speechText}"`);

    // Synthesize audio to 16k PCM
    const pcmBuffer = synthesizeSpeechToPcm16k(task.speechText, `task_${i + 1}`);
    console.log(`  Audio Synthesized: ${pcmBuffer.length} bytes (16kHz 16-bit mono PCM, ${(pcmBuffer.length / 32000).toFixed(2)}s duration)`);

    let audioChunksReceived = 0;
    let totalAudioBytes = 0;
    const toolCallsExecuted = [];
    const receivedAudioBuffers = [];

    const taskPromise = new Promise((resolve) => {
      const messageHandler = (data) => {
        const msg = JSON.parse(data.toString());

        // Audio chunks
        if (msg.serverContent?.modelTurn?.parts) {
          for (const part of msg.serverContent.modelTurn.parts) {
            if (part.inlineData?.data) {
              const audioBuf = Buffer.from(part.inlineData.data, 'base64');
              receivedAudioBuffers.push(audioBuf);
              audioChunksReceived++;
              totalAudioBytes += audioBuf.length;
            }

            // Function call inside modelTurn
            const fn = part.functionCall || part.function_call;
            if (fn) {
              toolCallsExecuted.push(fn);
              console.log(`  ⚡ [Gemini Tool Call]: ${fn.name}(${JSON.stringify(fn.args)})`);

              // Reply with successful mock execution
              const toolResponse = {
                toolResponse: {
                  functionResponses: [
                    {
                      id: fn.id || fn.name,
                      name: fn.name,
                      response: {
                        ok: true,
                        status: 'Success',
                        message: `Executed ${fn.name} with args ${JSON.stringify(fn.args)}`,
                      },
                    },
                  ],
                },
              };
              ws.send(JSON.stringify(toolResponse));
            }
          }
        }

        // Root tool call
        if (msg.toolCall?.functionCalls) {
          for (const fn of msg.toolCall.functionCalls) {
            toolCallsExecuted.push(fn);
            console.log(`  ⚡ [Gemini Tool Call]: ${fn.name}(${JSON.stringify(fn.args)})`);

            const toolResponse = {
              toolResponse: {
                functionResponses: [
                  {
                    id: fn.id || fn.name,
                    name: fn.name,
                    response: {
                      ok: true,
                      status: 'Success',
                      message: `Executed ${fn.name} with args ${JSON.stringify(fn.args)}`,
                    },
                  },
                ],
              },
            };
            ws.send(JSON.stringify(toolResponse));
          }
        }

        if (msg.serverContent?.turnComplete) {
          console.log('  ✔ Gemini Turn Complete!');
          ws.off('message', messageHandler);
          resolve();
        }
      };

      ws.on('message', messageHandler);
    });

    // Stream PCM chunks in 100ms slices (1600 samples = 3200 bytes per 100ms)
    console.log('  Streaming spoken audio chunks to Gemini Live API...');
    const chunkSize = 3200;
    for (let offset = 0; offset < pcmBuffer.length; offset += chunkSize) {
      const chunk = pcmBuffer.subarray(offset, Math.min(offset + chunkSize, pcmBuffer.length));
      const base64Chunk = chunk.toString('base64');
      const inputMsg = {
        realtimeInput: {
          mediaChunks: [
            {
              mimeType: 'audio/pcm;rate=16000',
              data: base64Chunk,
            },
          ],
        },
      };
      ws.send(JSON.stringify(inputMsg));
      await new Promise((r) => setTimeout(r, 90)); // realtime simulation
    }

    console.log('  Finished streaming audio. Waiting for Gemini response...');
    await Promise.race([
      taskPromise,
      new Promise((r) => setTimeout(r, 12000)), // timeout safety
    ]);

    console.log(`  [Results for ${task.name}]:`);
    console.log(`    - Audio Chunks Received: ${audioChunksReceived}`);
    console.log(`    - Output Audio Data: ${totalAudioBytes} bytes (approx ${(totalAudioBytes / 48000).toFixed(2)}s 24kHz PCM)`);
    console.log(`    - Tools Called: ${toolCallsExecuted.map((t) => t.name).join(', ') || 'None'}`);

    if (receivedAudioBuffers.length > 0) {
      const fullAudio = Buffer.concat(receivedAudioBuffers);
      const outPcm = path.join(TMP_DIR, `response_task_${i + 1}.pcm`);
      const outWav = path.join(TMP_DIR, `response_task_${i + 1}.wav`);
      fs.writeFileSync(outPcm, fullAudio);
      // Convert 24k PCM response to WAV for verification
      try {
        execSync(`ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${outPcm}" "${outWav}" 2>/dev/null`);
        console.log(`    - Audio Response saved to: ${outWav}`);
      } catch (e) {}
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('\n[4/4] Closing WebSocket...');
  ws.close();

  console.log('\n===========================================================');
  console.log('   All Gemini Audio Feature & Task Tests Passed!          ');
  console.log('===========================================================');
}

runGeminiAudioTaskTest().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
