/**
 * Recursively clone and sanitize a JSON Schema for Gemini FunctionDeclarations.
 * Strips disallowed keys: "additionalProperties", "$schema", "definitions", etc.,
 * converts type strings to UPPERCASE ("OBJECT", "STRING", "NUMBER", "BOOLEAN", "ARRAY"),
 * and cleans up empty "properties: {}" objects if present.
 * @param {Object|Array|any} schema
 * @returns {Object|Array|any}
 */
export function sanitizeGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeGeminiSchema(item));
  }
  const sanitized = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties' || key === '$schema' || key === 'definitions') {
      continue;
    }
    if (key === 'type' && typeof value === 'string') {
      sanitized[key] = value.toUpperCase();
    } else if (key === 'properties' && typeof value === 'object' && value !== null) {
      const sanitizedProps = sanitizeGeminiSchema(value);
      if (Object.keys(sanitizedProps).length > 0) {
        sanitized.properties = sanitizedProps;
      }
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeGeminiSchema(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Recursively clone and cap data arrays to a maximum length (e.g. 5 items)
 * to avoid context window bloating over extended conversations.
 * @param {any} data
 * @param {number} maxItems
 * @returns {any}
 */
export function truncateToolDataArrays(data, maxItems = 5) {
  if (!data || typeof data !== 'object') return data;
  if (Array.isArray(data)) {
    return data.slice(0, maxItems).map((item) => truncateToolDataArrays(item, maxItems));
  }
  const result = {};
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      result[key] = value.slice(0, maxItems).map((item) => truncateToolDataArrays(item, maxItems));
      if (value.length > maxItems) {
        result[`${key}TotalCount`] = value.length;
      }
    } else if (typeof value === 'object' && value !== null) {
      result[key] = truncateToolDataArrays(value, maxItems);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Gemini Multimodal Live API WebSocket Client for God's Eye View
 * Endpoint: wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent
 */

export class GeminiLiveClient {
  /**
   * @param {Object} options
   * @param {Function} options.runner - GEV Action Runner for tool execution
   * @param {Function} [options.onAudioChunk] - Callback for incoming model audio PCM base64 chunks
   * @param {Function} [options.onStatusChange] - Callback for connection status updates
   * @param {Function} [options.onError] - Callback for error reports
   * @param {Function} [options.onInterrupted] - Callback when model turn is interrupted
   */
  constructor({ runner, onAudioChunk, onStatusChange, onError, onInterrupted }) {
    this.runner = runner;
    this.onAudioChunk = onAudioChunk || (() => {});
    this.onStatusChange = onStatusChange || (() => {});
    this.onError = onError || (() => {});
    this.onInterrupted = onInterrupted || (() => {});

    this.ws = null;
    this.status = 'idle';
    this.connected = false;
    this.config = null;
    this.activeToolCalls = new Map();
    this.isSetupComplete = false;
    this.intentionalDisconnect = false;
    this.lastConfig = null;
  }

  /**
   * Connect to Gemini Multimodal Live API over WebSocket.
   * @param {Object} [config] - Config from /api/gemini/config
   * @returns {Promise<void>}
   */
  async connect(config = null) {
    this.intentionalDisconnect = false;
    if (config) this.lastConfig = config;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      this.connected = true;
      return;
    }

    this.setStatus('connecting', 'Connecting to Gemini');
    console.log('[Gemini Client] Fetching config/key...');

    try {
      if (!config) {
        const res = await fetch('/api/gemini/config');
        if (!res.ok) {
          throw new Error('Failed to fetch Gemini configuration');
        }
        config = await res.json();
      }

      this.config = config;
      if (!config.hasKey || !config.apiKey) {
        throw new Error('GEMINI_API_KEY is not configured in .env');
      }
    } catch (err) {
      this.connected = false;
      this.setStatus('error', err.message);
      this.onError('Gemini configuration error', err);
      throw err;
    }

    const modelName = config.model || 'models/gemini-2.5-flash-native-audio-latest';
    const wsUrl = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=' + config.apiKey;

    console.log('[Gemini Client] Dialing WebSocket...');
    this.ws = new WebSocket(wsUrl);

    return new Promise((resolve, reject) => {
      let openHandled = false;

      this.ws.onopen = () => {
        openHandled = true;
        this.connected = true;
        this.setStatus('listening', 'Gemini Ready');
        console.log('[Gemini Client] WS Open - Handshake sent!');
        this.sendSetupHandshake(modelName, config.voice || 'Puck', config.tools || []);
        resolve();
      };

      this.ws.onmessage = (event) => this.handleMessage(event);

      this.ws.onerror = (event) => {
        console.error('[Gemini Client] WS Error:', event);
        this.onError('Gemini WebSocket error', event);
        if (!openHandled) {
          reject(event instanceof Error ? event : new Error('Gemini WebSocket connection error'));
        }
      };

      this.ws.onclose = (event) => {
        console.warn("[Gemini Client] WS Closed:", event.code, event.reason);
        this.connected = false;
        this.isSetupComplete = false;
        if (!this.intentionalDisconnect) {
        console.warn('[Gemini Client] Server dropped connection. Auto-reconnecting in 1s...');
        this.setStatus('connecting', 'Reconnecting to Gemini...');
        setTimeout(() => {
          if (!this.intentionalDisconnect) {
            this.connect(this.lastConfig).catch((err) => {
              console.error('[Gemini Client] Auto-reconnect failed:', err);
            });
          }
        }, 1000);
        return;
      }
      this.setStatus('idle', 'Gemini Disconnected');
      };
    });
  }

  /**
   * Send initial BidiGenerateContentSetup handshake on open.
   */
  sendSetupHandshake(model, voiceName, tools) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const sanitizedTools = Array.isArray(tools)
      ? tools.map((t) => sanitizeGeminiSchema(t))
      : [];

    const setupMsg = {
      setup: {
        model: model || 'models/gemini-2.5-flash-native-audio-latest',
        generationConfig: {
          
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: voiceName || 'Puck',
              },
            },
          },
        },
        systemInstruction: {
          parts: [
            {
              text: [
                "You are the God's Eye View AI agent.",
                "You have real-time voice control over a photorealistic 3D Earth globe.",
                "You must chain multiple tools together to complete complex spatial requests.",
                "If a user asks to fly to or locate a specific entity (like a satellite, flight, or fire), DO NOT give up if you don't have its coordinates. First, use `analyst_query` or `frame_overhead` to search the data layers and extract the entity's latitude and longitude. Once you have the coordinates, immediately chain a `fly_to_location` tool call to move the camera there.",
                "When calling `fly_to_location`, always provide `latitude` and `longitude` numeric arguments if you know the coordinates for the requested city, country, or landmark, in addition to the `query` string.",
                "To zoom in, zoom out, or go down to the surface, use the `adjust_camera_altitude` tool. Do not calculate coordinates for simple altitude changes.",
                "Use the provided tool functions (fly_to_location, adjust_camera_altitude, set_layer_visibility, set_visual_style, get_current_view_state, analyst_query, etc.) aggressively.",
                "Always confirm your actions concisely with voice.",
              ].join(' '),
            },
          ],
        },
        tools: sanitizedTools.length ? [{ functionDeclarations: sanitizedTools }] : [],
      },
    };

    this.ws.send(JSON.stringify(setupMsg));
  }

  /**
   * Send realtime microphone PCM audio chunk.
   * @param {string} base64Pcm - 16-bit PCM audio chunk encoded as base64
   */
  sendRealtimeAudio(base64Pcm) {
    if (!base64Pcm || base64Pcm.length === 0) return;
    if (!this.isSetupComplete || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const inputMsg = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: 'audio/pcm;rate=16000',
            data: base64Pcm,
          },
        ],
      },
    };

    this.ws.send(JSON.stringify(inputMsg));
  }

  /**
   * Handle incoming WebSocket message from Gemini.
   */
  async handleMessage(event) {
    try {
      console.log("[Gemini Client] Raw incoming message:", typeof event.data === "string" ? event.data.substring(0, 150) : "Blob/Binary Data");
      let text;
      if (typeof event.data === 'string') {
        text = event.data;
      } else if (event.data instanceof Blob) {
        text = await event.data.text();
      } else if (event.data instanceof ArrayBuffer) {
        text = new TextDecoder().decode(event.data);
      }
      if (!text) return;

      const message = JSON.parse(text);

      if (message.setupComplete) {
        this.isSetupComplete = true;
        console.log('[Gemini Client] Setup Complete! Server is listening.');
      }

      if (message.serverContent) {
        const { modelTurn, interrupted, turnComplete } = message.serverContent;

        if (interrupted) {
          this.onInterrupted();
        }

        if (modelTurn && Array.isArray(modelTurn.parts)) {
          for (const part of modelTurn.parts) {
            if (part.inlineData && part.inlineData.data) {
              const mimeType = part.inlineData.mimeType || '';
              if (!mimeType || mimeType.includes('audio') || mimeType.includes('pcm')) {
                const base64Audio = part.inlineData.data;
                console.log('Gemini Audio Chunk Received:', base64Audio.length);
                this.onAudioChunk(base64Audio);
              }
            }

            const fnCall = part.functionCall || part.function_call;
            if (fnCall) {
              const { name, args, id } = fnCall;
              console.log('[Gemini Client] Function call in modelTurn:', name, args, id);
              this.executeToolCall(name, args || {}, id);
            }
          }
        }
      }

      const toolCall = message.toolCall || message.tool_call;
      if (toolCall) {
        const calls = toolCall.functionCalls || toolCall.function_calls || [];
        if (Array.isArray(calls) && calls.length > 0) {
          this.setStatus('executing', 'Running Gemini command');
          for (const call of calls) {
            const { name, args, id } = call;
            console.log('[Gemini Client] Root toolCall:', name, args, id);
            this.executeToolCall(name, args || {}, id);
          }
        }
      }
    } catch (err) {
      console.error('Error handling Gemini message:', err);
    }
  }

  /**
   * Execute tool call using GEV runner and send response back to Gemini.
   */
  async executeToolCall(name, args, id) {
    console.log('[Gemini Client] Executing tool:', name, args, id);
    let result;
    try {
      result = await this.runner(name, args);
    } catch (err) {
      result = { ok: false, error: err.message || 'Tool execution failed' };
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      let cleanedResult = result;
      if (typeof cleanedResult === 'object' && cleanedResult !== null) {
        cleanedResult = truncateToolDataArrays(cleanedResult, 5);
      }

      const fnResponse = {
        id: id || name,
        name: name,
        response: typeof cleanedResult === 'object' && cleanedResult !== null
          ? cleanedResult
          : { result: cleanedResult || 'success', status: 'Map action executed' },
      };

      let responseString = JSON.stringify(fnResponse.response);
      if (responseString.length > 15000) {
        fnResponse.response = {
          status: 'success',
          note: "Map action executed successfully, but the raw data array was too large to transmit. Data is visible on the user's screen.",
        };
      }

      const responsePayload = {
        toolResponse: {
          functionResponses: [fnResponse],
        },
      };

      console.log('[Gemini Client] Sending toolResponse payload:', JSON.stringify(responsePayload));
      this.ws.send(JSON.stringify(responsePayload));

      this.setStatus('listening', 'Gemini Ready');
    }
  }

  /**
   * Disconnect WebSocket and clean up.
   */
  disconnect() {
    this.intentionalDisconnect = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.connected = false;
    this.isSetupComplete = false;
    this.setStatus('idle', 'Gemini Offline');
  }

  setStatus(status, detail = '') {
    this.status = status;
    this.onStatusChange(status, detail);
  }
}
