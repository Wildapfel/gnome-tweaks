import Gst from 'gi://Gst';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const MIN_HEIGHT = 2;
const MIN_ACTIVE_HEIGHT = 4;
const VU_RISE = 0.5;
const VU_FALL = 0.25;

// FFT size — must be power of 2. 2048 gives good frequency resolution.
const FFT_SIZE = 2048;
const SAMPLE_RATE = 44100;

// --- Minimal Cooley-Tukey radix-2 FFT (in-place) ---
function fft(re, im) {
    const n = re.length;
    let j = 0;
    for (let i = 1; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len;
        const wRe = Math.cos(ang);
        const wIm = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let curRe = 1, curIm = 0;
            for (let k = 0; k < len / 2; k++) {
                const uRe = re[i + k];
                const uIm = im[i + k];
                const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
                const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
                re[i + k] = uRe + vRe;
                im[i + k] = uIm + vIm;
                re[i + k + len / 2] = uRe - vRe;
                im[i + k + len / 2] = uIm - vIm;
                const newRe = curRe * wRe - curIm * wIm;
                curIm = curRe * wIm + curIm * wRe;
                curRe = newRe;
            }
        }
    }
}

// Hann window to reduce spectral leakage
function hannWindow(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++)
        w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
    return w;
}

// Build log-frequency map: bar index → array of FFT bin indices
// Frequency range: 20Hz–20kHz (perceptual range, like cava)
function buildLogMap(numBars, numBins) {
    const map = new Array(numBars).fill(null).map(() => []);
    const fMin = Math.log(20);
    const fMax = Math.log(20000);
    const binHz = SAMPLE_RATE / FFT_SIZE;

    for (let b = 1; b < numBins; b++) {
        const freq = b * binHz;
        if (freq < 20 || freq > 20000) continue;
        const logPos = (Math.log(freq) - fMin) / (fMax - fMin);
        const barIdx = Math.min(numBars - 1, Math.floor(logPos * numBars));
        map[barIdx].push(b);
    }
    for (let i = 0; i < numBars; i++) {
        if (map[i].length === 0) {
            const prev = i > 0 ? map[i - 1] : null;
            const next = i < numBars - 1 ? map[i + 1] : null;
            map[i] = prev && prev.length ? [prev[prev.length - 1]]
                   : next && next.length ? [next[0]] : [1];
        }
    }
    return map;
}

export class GstController {
    /**
     * @param {Gio.Settings} settings
     * @param {function} onFrame - same contract as CavaController:
     *   onFrame({ isStereo, silentFrames, prevHeights, changed,
     *             levelL, levelR, levelsChanged })
     */
    constructor(settings, onFrame) {
        this._settings = settings;
        this._onFrame = onFrame;

        this._numBars = settings.get_int('bar-count');
        this._framerate = settings.get_int('framerate');
        this._sensitivity = settings.get_int('sensitivity');
        this._noiseFloor = settings.get_int('noise-floor');
        this._silenceZeroFrames = settings.get_int('silence-zero-frames');
        this._alphaRise = settings.get_double('alpha-rise');
        this._alphaFall = settings.get_double('alpha-fall');
        this._vizMode = settings.get_string('visualization-mode');

        // Frame state
        this._prevHeights = new Array(this._numBars).fill(MIN_HEIGHT);
        this._silentFrames = 0;
        this._levelL = 0.0;
        this._levelR = 0.0;
        this._prevLevelL = 0.0;
        this._prevLevelR = 0.0;

        // Pre-allocate all DSP buffers once — eliminates ~400KB/sec GC pressure
        // from per-frame Float32Array allocations at 20fps
        this._hannWin = hannWindow(FFT_SIZE);
        this._pcmBuffer = new Float32Array(FFT_SIZE);
        this._fftRe = new Float32Array(FFT_SIZE);
        this._fftIm = new Float32Array(FFT_SIZE);
        this._mags = new Float32Array(FFT_SIZE / 2);
        this._barMags = new Float32Array(this._numBars);
        this._pcmFill = 0;
        this._logMap = buildLogMap(this._numBars, FFT_SIZE / 2);

        this._pipeline = null;
        this._appsink = null;
        this._pollId = null;
        this._currentMonitor = null;

        this._connectSettings();
    }

    start() {
        if (this._pipeline) return;
        try {
            this._buildPipeline();
        } catch (e) {
            console.debug(`[SoundBar] GstController.start error: ${e.message}`);
        }
    }

    stop() {
        if (this._pollId) {
            GLib.Source.remove(this._pollId);
            this._pollId = null;
        }
        if (this._pipeline) {
            this._pipeline.set_state(Gst.State.NULL);
            this._pipeline = null;
        }
        this._appsink = null;
        this._pcmFill = 0;
    }

    restart() {
        this.stop();
        this.start();
    }

    /** Called by RendererController when the default audio sink changes. */
    notifySinkChanged(newMonitor) {
        if (newMonitor !== this._currentMonitor) {
            this._currentMonitor = newMonitor;
            if (this._pipeline) this.restart();
        }
    }

    destroy() {
        if (this._settingsIds) {
            this._settingsIds.forEach(id => this._settings.disconnect(id));
            this._settingsIds = null;
        }
        this.stop();
    }

    // --- Pipeline ---

    _getMonitorSource() {
        // Get the default sink monitor via pactl so we capture audio output,
        // not microphone input. Called at pipeline build time.
        try {
            const proc = Gio.Subprocess.new(
                ['pactl', 'get-default-sink'],
                Gio.SubprocessFlags.STDOUT_PIPE
            );
            const [, stdout] = proc.communicate_utf8(null, null);
            const sink = stdout.trim();
            if (sink) return `${sink}.monitor`;
        } catch (_) {}
        return null;
    }

    _buildPipeline() {
        // Init GStreamer here (not at module scope) to avoid running
        // inside the compositor before enable() is called
        Gst.init(null);

        const isStereo = this._vizMode === 'vu-meter';
        const channels = isStereo ? 2 : 1;

        this._currentMonitor = this._getMonitorSource();
        const src = this._currentMonitor
            ? `pulsesrc device="${this._currentMonitor}"`
            : `pulsesrc`;

        const pipelineStr =
            `${src} ! audioconvert ! audioresample ! ` +
            `audio/x-raw,format=S16LE,rate=${SAMPLE_RATE},channels=${channels} ! ` +
            `appsink name=sink max-buffers=4 drop=true sync=false`;

        this._pipeline = Gst.parse_launch(pipelineStr);
        if (!this._pipeline) {
            console.debug('[SoundBar] GstController: failed to create pipeline');
            return;
        }

        this._appsink = this._pipeline.get_by_name('sink');
        this._pipeline.set_state(Gst.State.PLAYING);

        // Poll appsink for new samples at framerate interval.
        // GJS requires appsink methods via emit() — direct method calls don't work.
        // GstBuffer.map().data is null in GJS — use extract_dup() instead.
        const pollMs = Math.round(1000 / this._framerate);
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, pollMs, () => {
            this._pollSamples(isStereo);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _pollSamples(isStereo) {
        if (!this._appsink) return;

        let sample;
        try {
            sample = this._appsink.emit('try-pull-sample', 0);
        } catch (_) {
            return;
        }
        if (!sample) return;

        const buf = sample.get_buffer();
        if (!buf) return;

        const size = buf.get_size();
        if (size === 0) return;

        const data = buf.extract_dup(0, size);
        if (!data || data.length === 0) return;

        const numSamples = Math.floor(data.length / (2 * (isStereo ? 2 : 1)));
        if (isStereo)
            this._processVU(data, numSamples);
        else
            this._processFFT(data, numSamples);
    }

    // --- FFT processing (bars / led-bars / pulse) ---

    _processFFT(data, numSamples) {
        // Accumulate S16LE samples into ring buffer
        for (let i = 0; i < numSamples; i++) {
            const lo = data[i * 2];
            const hi = data[i * 2 + 1];
            let s = (hi << 8) | lo;
            if (s >= 32768) s -= 65536;
            this._pcmBuffer[this._pcmFill % FFT_SIZE] = s / 32768.0;
            this._pcmFill++;
        }

        if (this._pcmFill < FFT_SIZE) return;

        const gain = this._sensitivity / 100.0;
        const maxHeight = this._settings.get_int('max-height');

        // Build windowed FFT input from ring buffer into pre-allocated arrays
        const offset = this._pcmFill % FFT_SIZE;
        for (let i = 0; i < FFT_SIZE; i++) {
            this._fftRe[i] = this._pcmBuffer[(offset + i) % FFT_SIZE] * this._hannWin[i];
            this._fftIm[i] = 0;
        }

        fft(this._fftRe, this._fftIm);

        // Compute magnitude in dB for positive frequencies only
        const numBins = FFT_SIZE / 2;
        for (let i = 0; i < numBins; i++) {
            const mag = Math.sqrt(
                this._fftRe[i] * this._fftRe[i] + this._fftIm[i] * this._fftIm[i]
            ) / FFT_SIZE;
            this._mags[i] = mag > 0 ? 20 * Math.log10(mag) : -80;
        }

        // Map FFT bins → bars via log-frequency map
        let maxMag = -80;
        for (let i = 0; i < this._numBars; i++) {
            let best = -80;
            for (const b of this._logMap[i]) {
                if (this._mags[b] > best) best = this._mags[b];
            }
            this._barMags[i] = best;
            if (best > maxMag) maxMag = best;
        }

        // Silence detection
        const isSilent = maxMag < (-80 + this._noiseFloor / 10);
        if (isSilent) this._silentFrames++; else this._silentFrames = 0;

        let changed = false;
        if (this._silentFrames >= this._silenceZeroFrames) {
            for (let i = 0; i < this._numBars; i++) {
                if (this._prevHeights[i] !== MIN_HEIGHT) {
                    this._prevHeights[i] = MIN_HEIGHT;
                    changed = true;
                }
            }
        } else {
            for (let i = 0; i < this._numBars; i++) {
                // Normalise dB [-80, 0] → [0, 1], sqrt for perceptual scaling
                const norm = Math.max(0, (this._barMags[i] + 80) / 80) * gain;
                const clamped = Math.min(1, norm);
                let target = Math.max(MIN_HEIGHT, Math.sqrt(clamped) * maxHeight);
                if (this._silentFrames === 0 && clamped > 0 && target < MIN_ACTIVE_HEIGHT)
                    target = MIN_ACTIVE_HEIGHT;
                const prev = this._prevHeights[i];
                const alpha = target < prev ? this._alphaFall : this._alphaRise;
                const h = prev * (1 - alpha) + target * alpha;
                if (Math.abs(h - prev) > 0.3) {
                    this._prevHeights[i] = h;
                    changed = true;
                }
            }
        }

        this._onFrame({
            isStereo: false,
            silentFrames: this._silentFrames,
            prevHeights: this._prevHeights,
            changed,
        });
    }

    // --- VU meter processing ---

    _processVU(data, numSamples) {
        // Read S16LE stereo interleaved from Uint8Array
        let maxL = 1, maxR = 1;
        for (let i = 0; i < numSamples; i++) {
            let l = ((data[i * 4 + 1] << 8) | data[i * 4]);
            if (l >= 32768) l -= 65536;
            if (l < 0) l = -l;

            let r = ((data[i * 4 + 3] << 8) | data[i * 4 + 2]);
            if (r >= 32768) r -= 65536;
            if (r < 0) r = -r;

            if (l > maxL) maxL = l;
            if (r > maxR) maxR = r;
        }

        const maxVal = Math.max(maxL, maxR);
        if (maxVal < this._noiseFloor) this._silentFrames++; else this._silentFrames = 0;

        const meterSensitivity = this._settings.get_double('meter-sensitivity');
        let levelsChanged = false;

        if (this._silentFrames >= this._silenceZeroFrames) {
            levelsChanged = this._levelL !== 0.0 || this._levelR !== 0.0;
            this._levelL = 0.0;
            this._levelR = 0.0;
            this._prevLevelL = 0.0;
            this._prevLevelR = 0.0;
        } else {
            const targetL = Math.min(1.0, Math.pow(maxL / 32767.0, 1.5) * meterSensitivity);
            const targetR = Math.min(1.0, Math.pow(maxR / 32767.0, 1.5) * meterSensitivity);
            const alphaL = targetL < this._prevLevelL ? VU_FALL : VU_RISE;
            const alphaR = targetR < this._prevLevelR ? VU_FALL : VU_RISE;
            this._levelL = Math.min(1, Math.max(0, this._prevLevelL * (1 - alphaL) + targetL * alphaL));
            this._levelR = Math.min(1, Math.max(0, this._prevLevelR * (1 - alphaR) + targetR * alphaR));
            levelsChanged = Math.abs(this._levelL - this._prevLevelL) > 0.005
                         || Math.abs(this._levelR - this._prevLevelR) > 0.005;
            this._prevLevelL = this._levelL;
            this._prevLevelR = this._levelR;
        }

        this._onFrame({
            isStereo: true,
            silentFrames: this._silentFrames,
            levelL: this._levelL,
            levelR: this._levelR,
            levelsChanged,
        });
    }

    // --- Settings ---

    _connectSettings() {
        this._settingsIds = [
            this._settings.connect('changed::bar-count', () => {
                this._numBars = this._settings.get_int('bar-count');
                this._prevHeights = new Array(this._numBars).fill(MIN_HEIGHT);
                this._barMags = new Float32Array(this._numBars);
                this._logMap = buildLogMap(this._numBars, FFT_SIZE / 2);
            }),
            this._settings.connect('changed::sensitivity', () => {
                this._sensitivity = this._settings.get_int('sensitivity');
            }),
            this._settings.connect('changed::framerate', () => {
                this._framerate = this._settings.get_int('framerate');
                this.restart();
            }),
            this._settings.connect('changed::noise-floor', () => {
                this._noiseFloor = this._settings.get_int('noise-floor');
            }),
            this._settings.connect('changed::silence-zero-frames', () => {
                this._silenceZeroFrames = this._settings.get_int('silence-zero-frames');
            }),
            this._settings.connect('changed::alpha-rise', () => {
                this._alphaRise = this._settings.get_double('alpha-rise');
            }),
            this._settings.connect('changed::alpha-fall', () => {
                this._alphaFall = this._settings.get_double('alpha-fall');
            }),
            this._settings.connect('changed::visualization-mode', () => {
                const newMode = this._settings.get_string('visualization-mode');
                const wasVU = this._vizMode === 'vu-meter';
                const isVU = newMode === 'vu-meter';
                this._vizMode = newMode;
                if (wasVU !== isVU) this.restart();
            }),
        ];
    }
}
