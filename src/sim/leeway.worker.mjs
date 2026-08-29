/**
 * Leeway Monte Carlo worker: runs the ensemble off the main thread and
 * transfers the frame buffer back. Pure compute — imports only the model.
 */
import { runEnsemble } from './leeway.js';

self.onmessage = (event) => {
  const { cmd, payload } = event.data ?? {};
  if (cmd !== 'run') return;
  try {
    const result = runEnsemble(payload);
    self.postMessage({
      type: 'result',
      timesMs: result.timesMs,
      frames: result.frames,
      n: result.n,
      degraded: result.degraded,
    }, [result.timesMs.buffer, result.frames.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.message ?? error) });
  }
};
