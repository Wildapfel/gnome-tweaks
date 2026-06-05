import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';

const MIN_HEIGHT = 2;
const MIN_ACTIVE_HEIGHT = 4;
const VU_RISE = 0.5;
const VU_FALL = 0.25;

export class CavaController {
    /**
     * @param {Gio.Settings} settings
     * @param {function} onFrame - called each processed frame:
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

        // Process state
        this._procPid = null;
        this._stdout = null;
        this._stderr = null;
        this._stderrStream = null;
        this._stdoutCancellable = null;
        this._rawBuffer = new Uint8Array(8192);
        this._bufferUsed = 0;
        this._tmpConfigPath = null;

        // Frame state
        this._prevHeights = new Array(this._numBars).fill(MIN_HEIGHT);
        this._bins = new Array(this._numBars);
        this._silentFrames = 0;
        this._levelL = 0.0;
        this._levelR = 0.0;
        this._prevLevelL = 0.0;
        this._prevLevelR = 0.0;

        this._connectSettings();
    }

    start() {
        if (this._procPid) return;

        try {
            if (!GLib.find_program_in_path('cava')) return;

            const tmpDir = GLib.get_tmp_dir();
            const tmpConfig = `${tmpDir}/soundbar-cava-config-${GLib.get_monotonic_time()}`;
            const isStereo = this._vizMode === 'vu-meter';
            const cfg =
                `[general]\n` +
                `bars = ${this._numBars}\n` +
                `framerate = ${this._framerate}\n` +
                `sensitivity = ${this._sensitivity}\n` +
                `\n[input]\n` +
                `method = pulse\n` +
                `source = auto\n` +
                `\n[output]\n` +
                `method = raw\n` +
                `bit_format = 16bit\n` +
                `channels = ${isStereo ? 'stereo' : 'mono'}\n` +
                `raw_target = /dev/stdout\n`;

            GLib.file_set_contents(tmpConfig, cfg);
            this._tmpConfigPath = tmpConfig;

            const argv = ['cava', '-p', tmpConfig];
            const flags = GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD;
            const [ok, pid, stdinFd, stdoutFd, stderrFd] =
                GLib.spawn_async_with_pipes(null, argv, null, flags, null);
            if (!ok) return;

            if (stdinFd >= 0) {
                try { new GioUnix.InputStream({ fd: stdinFd, close_fd: true }).close(null); } catch (_) {}
            }

            this._procPid = pid;
            this._stdout = new GioUnix.InputStream({ fd: stdoutFd, close_fd: true });
            this._stderr = new GioUnix.InputStream({ fd: stderrFd, close_fd: true });
            this._stdoutCancellable = new Gio.Cancellable();
            this._bufferUsed = 0;
            this._readStdoutBytes();
            this._readStderrLine();

            this._childWatchId = GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, (p, _status) => {
                GLib.spawn_close_pid(p);
                if (this._procPid === p) this._procPid = null;
                this._childWatchId = null;
            });
        } catch (e) {
            console.debug(`[SoundBar] CavaController.start error: ${e.message}`);
        }
    }

    stop() {
        if (this._childWatchId) {
            GLib.Source.remove(this._childWatchId);
            this._childWatchId = null;
        }
        if (this._procPid) {
            try {
                GLib.kill(this._procPid, 15);
                GLib.spawn_close_pid(this._procPid);
            } catch (_) {}
            this._procPid = null;
        }
        if (this._stdout) {
            try {
                if (this._stdoutCancellable && !this._stdoutCancellable.is_cancelled())
                    this._stdoutCancellable.cancel();
                this._stdout.close(null);
            } catch (_) {}
            this._stdout = null;
        }
        this._stdoutCancellable = null;
        this._bufferUsed = 0;
        if (this._stderr) {
            try { this._stderr.close(null); } catch (_) {}
            this._stderr = null;
        }
        if (this._stderrStream) {
            try { this._stderrStream.close(null); } catch (_) {}
            this._stderrStream = null;
        }
        if (this._tmpConfigPath) {
            try {
                const f = Gio.File.new_for_path(this._tmpConfigPath);
                if (f.query_exists(null)) f.delete(null);
            } catch (_) {}
            this._tmpConfigPath = null;
        }
    }

    restart() {
        this.stop();
        this.start();
    }

    destroy() {
        if (this._settingsIds) {
            this._settingsIds.forEach(id => this._settings.disconnect(id));
            this._settingsIds = null;
        }
        this.stop();
        this._cleanupOldTempFiles();
    }

    // --- Internal ---

    _readStdoutBytes() {
        if (!this._stdout) return;

        const isStereo = this._vizMode === 'vu-meter';
        const frameSize = isStereo ? this._numBars * 4 : this._numBars * 2;
        const readSize = Math.max(4096, frameSize * 4);

        this._stdout.read_bytes_async(readSize, GLib.PRIORITY_DEFAULT, this._stdoutCancellable, (stream, res) => {
            try {
                const gbytes = stream.read_bytes_finish(res);
                if (!gbytes) return;
                const chunk = gbytes.get_data ? gbytes.get_data() : null;
                if (!chunk || chunk.length === 0) { this._readStdoutBytes(); return; }

                const needed = this._bufferUsed + chunk.length;
                if (needed > this._rawBuffer.length) {
                    if (needed > 65536) { this._bufferUsed = 0; this._readStdoutBytes(); return; }
                    const nb = new Uint8Array(Math.max(needed, this._rawBuffer.length * 2));
                    nb.set(this._rawBuffer.subarray(0, this._bufferUsed));
                    this._rawBuffer = nb;
                }
                this._rawBuffer.set(chunk, this._bufferUsed);
                this._bufferUsed += chunk.length;

                let offset = 0;
                while (this._bufferUsed - offset >= frameSize) {
                    const dv = new DataView(this._rawBuffer.buffer, this._rawBuffer.byteOffset + offset, frameSize);
                    this._processFrame(dv, isStereo, frameSize);
                    offset += frameSize;
                }

                if (offset > 0) {
                    this._rawBuffer.copyWithin(0, offset, this._bufferUsed);
                    this._bufferUsed -= offset;
                }
                this._readStdoutBytes();
            } catch (e) {
                console.debug(`[SoundBar] readStdout error: ${e.message}`);
            }
        });
    }

    _processFrame(dv, isStereo) {
        if (isStereo) {
            let maxL = 1, maxR = 1;
            for (let i = 0; i < this._numBars; i++) {
                const v = Math.abs(dv.getInt16(i * 2, true));
                if (v > maxL) maxL = v;
            }
            for (let i = 0; i < this._numBars; i++) {
                const v = Math.abs(dv.getInt16((this._numBars + i) * 2, true));
                if (v > maxR) maxR = v;
            }
            const maxVal = Math.max(maxL, maxR);
            if (maxVal < this._noiseFloor) this._silentFrames++; else this._silentFrames = 0;

            let levelsChanged = false;
            if (this._silentFrames >= this._silenceZeroFrames) {
                levelsChanged = this._levelL !== 0.0 || this._levelR !== 0.0;
                this._levelL = 0.0;
                this._levelR = 0.0;
                this._prevLevelL = 0.0;
                this._prevLevelR = 0.0;
            } else {
                const meterSensitivity = this._settings.get_double('meter-sensitivity');
                const targetL = Math.min(1.0, Math.pow(maxL / 32767.0, 1.5) * meterSensitivity);
                const targetR = Math.min(1.0, Math.pow(maxR / 32767.0, 1.5) * meterSensitivity);
                const alphaL = targetL < this._prevLevelL ? VU_FALL : VU_RISE;
                const alphaR = targetR < this._prevLevelR ? VU_FALL : VU_RISE;
                this._levelL = Math.min(1.0, Math.max(0.0, this._prevLevelL * (1 - alphaL) + targetL * alphaL));
                this._levelR = Math.min(1.0, Math.max(0.0, this._prevLevelR * (1 - alphaR) + targetR * alphaR));
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
        } else {
            let maxVal = 1;
            for (let i = 0; i < this._numBars; i++) {
                const v = Math.abs(dv.getInt16(i * 2, true));
                this._bins[i] = v;
                if (v > maxVal) maxVal = v;
            }
            if (maxVal < this._noiseFloor) this._silentFrames++; else this._silentFrames = 0;

            let changed = false;
            if (this._silentFrames >= this._silenceZeroFrames) {
                for (let i = 0; i < this._numBars; i++) {
                    if (this._prevHeights[i] !== MIN_HEIGHT) {
                        this._prevHeights[i] = MIN_HEIGHT;
                        changed = true;
                    }
                }
            } else {
                const invMaxVal = maxVal > 0 ? 1 / maxVal : 0;
                for (let i = 0; i < this._numBars; i++) {
                    const v = this._bins[i];
                    const norm = v * invMaxVal;
                    let target = Math.max(MIN_HEIGHT, Math.sqrt(norm) * this._maxHeight);
                    if (this._silentFrames === 0 && v > 0 && target < MIN_ACTIVE_HEIGHT)
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
    }

    _readStderrLine() {
        if (!this._stderr) return;
        if (!this._stderrStream)
            this._stderrStream = new Gio.DataInputStream({ base_stream: this._stderr });
        this._stderrStream.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
            try {
                const [line] = stream.read_line_finish(res);
                if (line !== null) this._readStderrLine();
            } catch (_) {}
        });
    }

    _cleanupOldTempFiles() {
        try {
            const tmpDir = Gio.File.new_for_path(GLib.get_tmp_dir());
            const enumerator = tmpDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (name.startsWith('soundbar-cava-config-')) {
                    try { tmpDir.get_child(name).delete(null); } catch (_) {}
                }
            }
        } catch (_) {}
    }

    _connectSettings() {
        this._settingsIds = [
            this._settings.connect('changed::bar-count', () => {
                this._numBars = this._settings.get_int('bar-count');
                this._prevHeights = new Array(this._numBars).fill(MIN_HEIGHT);
                this._bins = new Array(this._numBars);
                this.restart();
            }),
            this._settings.connect('changed::sensitivity', () => {
                this._sensitivity = this._settings.get_int('sensitivity');
                this.restart();
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

    get _maxHeight() { return this._settings.get_int('max-height'); }
}
