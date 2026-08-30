/**
 * Audio Stream Manager and Playback Manager for God's Eye View Multi-Agent Voice System.
 * Handles microphone capture (16-bit PCM streaming) and Web Audio API playback queueing.
 */

/**
 * Base64 string to Int16Array converter
 * @param {string} base64
 * @returns {Int16Array}
 */
export function base64ToInt16Array(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

/**
 * Int16Array to Base64 string converter
 * @param {Int16Array} int16Array
 * @returns {string}
 */
export function int16ArrayToBase64(int16Array) {
  const bytes = new Uint8Array(int16Array.buffer, int16Array.byteOffset, int16Array.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Int16Array to Float32Array converter (-1.0 to 1.0)
 * @param {Int16Array} int16Array
 * @returns {Float32Array}
 */
/**
 * Downsample Float32Array audio buffer from inputSampleRate to outputSampleRate (e.g. 48000 -> 16000).
 * Uses linear interpolation for crisp speech downsampling and zero latency.
 * @param {Float32Array} buffer
 * @param {number} inputSampleRate
 * @param {number} outputSampleRate
 * @returns {Float32Array}
 */
export function downsampleBuffer(buffer, inputSampleRate, outputSampleRate = 16000) {
  if (!buffer || buffer.length === 0) return new Float32Array(0);
  if (inputSampleRate === outputSampleRate || !inputSampleRate) {
    return buffer;
  }
  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const originPos = i * sampleRateRatio;
    const index = Math.floor(originPos);
    const decimal = originPos - index;
    const currentSample = buffer[index] || 0;
    const nextSample = buffer[index + 1] !== undefined ? buffer[index + 1] : currentSample;
    result[i] = currentSample + decimal * (nextSample - currentSample);
  }
  return result;
}

export function int16ToFloat32(int16Array) {
  const float32 = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32[i] = int16Array[i] < 0 ? int16Array[i] / 32768 : int16Array[i] / 32767;
  }
  return float32;
}

/**
 * Unified Audio Stream Manager for Microphone Capture
 */
export class AudioStreamManager {
  constructor({ rmsThreshold = 0.002 } = {}) {
    this.stream = null;
    this.audioContext = null;
    this.source = null;
    this.sourceNode = null;
    this.scriptNode = null;
    this.dummyGain = null;
    this.subscribers = new Set();
    this.recording = false;
    this.rmsThreshold = rmsThreshold;
    this.silenceFrames = 0;
    this.isSpeaking = false;
    this.onVoiceActivity = null;
  }

  /**
   * Subscribe to incoming microphone audio chunks.
   * @param {function(string, Int16Array): void} callback
   */
  subscribe(callback) {
    if (typeof callback === 'function') {
      this.subscribers.add(callback);
    }
  }

  /**
   * Unsubscribe from microphone audio chunks.
   * @param {function(string, Int16Array): void} callback
   */
  unsubscribe(callback) {
    this.subscribers.delete(callback);
  }

  /**
   * Start capturing microphone audio and broadcasting 16-bit PCM chunks to subscribers.
   */
  async start() {
    if (this.recording) return;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Web Audio API or getUserMedia is not supported in this browser');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    this.audioContext = new AudioContextClass({ sampleRate: 16000 });
    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.source = this.sourceNode;

    const bufferSize = 2048;
    this.scriptNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

    this.scriptNode.onaudioprocess = (event) => {
      if (!this.recording || this.subscribers.size === 0) return;
      const rawInput = event.inputBuffer.getChannelData(0);

      // Noise gate with trailing silence buffer (0.002 RMS threshold)
      let sum = 0;
      for (let i = 0; i < rawInput.length; i++) sum += rawInput[i] * rawInput[i];
      const rms = Math.sqrt(sum / rawInput.length);

      const isActive = rms >= this.rmsThreshold;
      if (isActive) {
        this.silenceFrames = 0;
      } else {
        this.silenceFrames++;
      }

      if (this.isSpeaking !== isActive) {
        this.isSpeaking = isActive;
        if (typeof this.onVoiceActivity === 'function') {
          try {
            this.onVoiceActivity(isActive, rms);
          } catch (err) {
            console.error('Error in onVoiceActivity callback:', err);
          }
        }
      }

      // ONLY drop the chunk if trailing silence exceeds 30 frames (~1s trailing silence buffer)
      if (this.silenceFrames > 30) return;

      const actualSampleRate = event.inputBuffer.sampleRate || this.audioContext?.sampleRate || 48000;
      const resampledBuffer = downsampleBuffer(rawInput, actualSampleRate, 16000);

      const int16Array = new Int16Array(resampledBuffer.length);
      for (let i = 0; i < resampledBuffer.length; i++) {
        const s = Math.max(-1, Math.min(1, resampledBuffer[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      const base64Chunk = int16ArrayToBase64(int16Array);

      for (const subscriber of this.subscribers) {
        try {
          subscriber(base64Chunk, int16Array);
        } catch (err) {
          console.error('Error in audio subscriber callback:', err);
        }
      }
    };

    this.dummyGain = this.audioContext.createGain();
    this.dummyGain.gain.value = 0; // Mute the mic feedback
    this.source.connect(this.scriptNode);
    this.scriptNode.connect(this.dummyGain);
    this.dummyGain.connect(this.audioContext.destination);
    this.recording = true;
  }

  /**
   * Stop microphone capture and release resources.
   */
  stop() {
    this.recording = false;
    this.silenceFrames = 0;
    if (this.isSpeaking) {
      this.isSpeaking = false;
      if (typeof this.onVoiceActivity === 'function') {
        try { this.onVoiceActivity(false, 0); } catch {}
      }
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {}
      this.source = null;
      this.sourceNode = null;
    }
    if (this.scriptNode) {
      try {
        this.scriptNode.disconnect();
      } catch {}
      this.scriptNode = null;
    }
    if (this.dummyGain) {
      try {
        this.dummyGain.disconnect();
      } catch {}
      this.dummyGain = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
  }
}

/**
 * Unified Audio Playback Manager for AI Audio Output
 */
export class AudioPlaybackManager {
  constructor({ sampleRate = 24000 } = {}) {
    this.sampleRate = sampleRate;
    this.audioContext = null;
    this.nextStartTime = 0;
    this.scheduledSources = [];
    this.isPlaying = false;
    this.onPlaybackStateChange = null;
  }

  initContext() {
    if (!this.audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        this.audioContext = new AudioContextClass({ sampleRate: this.sampleRate });
      }
    }
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(() => {});
    }
  }

  /**
   * Enqueue a PCM audio chunk for playback.
   * @param {string | Int16Array | Float32Array} data
   */
  enqueueAudioChunk(data) {
    this.initContext();
    if (!this.audioContext) return;

    let float32Array;
    if (typeof data === 'string') {
      const int16 = base64ToInt16Array(data);
      float32Array = int16ToFloat32(int16);
    } else if (data instanceof Int16Array) {
      float32Array = int16ToFloat32(data);
    } else if (data instanceof Float32Array) {
      float32Array = data;
    } else {
      return;
    }

    const audioBuffer = this.audioContext.createBuffer(1, float32Array.length, this.sampleRate);
    audioBuffer.getChannelData(0).set(float32Array);

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);

    const now = this.audioContext.currentTime;
    const startTime = Math.max(now, this.nextStartTime);
    source.start(startTime);
    this.nextStartTime = startTime + audioBuffer.duration;

    this.scheduledSources.push(source);
    const wasPlaying = this.isPlaying;
    this.isPlaying = true;
    if (!wasPlaying && typeof this.onPlaybackStateChange === 'function') {
      try { this.onPlaybackStateChange(true); } catch {}
    }

    source.onended = () => {
      const idx = this.scheduledSources.indexOf(source);
      if (idx !== -1) {
        this.scheduledSources.splice(idx, 1);
      }
      if (this.scheduledSources.length === 0) {
        this.isPlaying = false;
        if (typeof this.onPlaybackStateChange === 'function') {
          try { this.onPlaybackStateChange(false); } catch {}
        }
      }
    };
  }

  /**
   * Stop all playback immediately and clear queue (e.g. on user interruption).
   */
  stop() {
    this.scheduledSources.forEach((source) => {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // ignore
      }
    });
    this.scheduledSources = [];
    this.nextStartTime = 0;
    const wasPlaying = this.isPlaying;
    this.isPlaying = false;
    if (wasPlaying && typeof this.onPlaybackStateChange === 'function') {
      try { this.onPlaybackStateChange(false); } catch {}
    }
  }
}
