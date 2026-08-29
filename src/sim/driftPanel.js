/**
 * Drift-simulation scrub panel: a small self-contained fixed DOM element
 * (banner, time scrub, play/pause, close). Self-styled on purpose — no
 * ui.js edits, no stylesheet coupling; disposing removes every trace.
 * Returns a no-op stub when no DOM is available (workers, tests).
 */

/**
 * @param {Object} options
 * @param {number} options.particleCount Ensemble size.
 * @param {string} options.classLabel Leeway class shown in the header.
 * @param {number} options.frameCount Number of scrubbable frames.
 * @param {number} options.horizonH Simulation horizon, hours.
 * @param {boolean} [options.degraded] Forcing gaps were zero-filled.
 * @param {(index: number) => void} options.onScrub
 * @param {() => void} options.onPlayPause
 * @param {() => void} options.onClose
 * @returns {{setFrame: Function, setPlaying: Function, destroy: Function}}
 */
export function createDriftPanel({
  particleCount,
  classLabel,
  frameCount,
  horizonH,
  degraded = false,
  onScrub,
  onPlayPause,
  onClose,
} = {}) {
  if (typeof document === 'undefined') {
    return { setFrame() {}, setPlaying() {}, destroy() {} };
  }

  const root = document.createElement('div');
  root.id = 'gev-drift-panel';
  root.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:18px', 'transform:translateX(-50%)',
    'z-index:44', 'min-width:340px', 'max-width:480px',
    'background:rgba(8,14,18,0.92)', 'border:1px solid rgba(255,177,77,0.55)',
    'border-radius:6px', 'padding:10px 12px',
    'font:11px/1.5 "SF Mono", ui-monospace, monospace', 'color:#e8f4ff',
    'backdrop-filter:blur(6px)',
  ].join(';');

  const banner = document.createElement('div');
  banner.textContent = 'SIMULATED DRIFT ENSEMBLE — NOT A SAR PRODUCT';
  banner.style.cssText = 'color:#ffb14d;font-weight:700;letter-spacing:0.08em;margin-bottom:2px;';
  root.appendChild(banner);

  const meta = document.createElement('div');
  meta.textContent = `${classLabel} · ${Number(particleCount).toLocaleString()} particles · ${horizonH} h forecast drift`
    + (degraded ? ' · ⚠ forcing gaps' : '');
  meta.style.cssText = 'color:#9fb8c8;margin-bottom:8px;';
  root.appendChild(meta);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;';

  const playButton = document.createElement('button');
  playButton.type = 'button';
  playButton.textContent = '▶';
  playButton.setAttribute('aria-label', 'Play or pause drift playback');
  playButton.style.cssText = 'background:none;border:1px solid #4dd2ff;color:#4dd2ff;border-radius:4px;width:26px;height:22px;cursor:pointer;font:inherit;';
  playButton.addEventListener('click', () => onPlayPause?.());
  row.appendChild(playButton);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(Math.max(0, frameCount - 1));
  slider.step = '1';
  slider.value = '0';
  slider.setAttribute('aria-label', 'Drift time scrub');
  slider.style.cssText = 'flex:1;accent-color:#ffb14d;';
  slider.addEventListener('input', () => onScrub?.(Number(slider.value)));
  row.appendChild(slider);

  const clock = document.createElement('span');
  clock.textContent = 'T+00:00';
  clock.style.cssText = 'color:#ffb14d;min-width:62px;text-align:right;';
  row.appendChild(clock);

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = '✕';
  closeButton.setAttribute('aria-label', 'Close drift simulation');
  closeButton.style.cssText = 'background:none;border:none;color:#9fb8c8;cursor:pointer;font:inherit;padding:0 2px;';
  closeButton.addEventListener('click', () => onClose?.());
  row.appendChild(closeButton);

  root.appendChild(row);
  document.body.appendChild(root);

  return {
    setFrame(index, offsetMs) {
      slider.value = String(index);
      const totalMinutes = Math.max(0, Math.round((offsetMs ?? 0) / 60000));
      const hh = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
      const mm = String(totalMinutes % 60).padStart(2, '0');
      clock.textContent = `T+${hh}:${mm}`;
    },
    setPlaying(playing) {
      playButton.textContent = playing ? '⏸' : '▶';
    },
    destroy() {
      root.remove();
    },
  };
}
