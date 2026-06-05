import Cairo from 'gi://cairo';
import Clutter from 'gi://Clutter';
import Gvc from 'gi://Gvc';
import St from 'gi://St';

const SILENT_FRAMES_THRESHOLD = 10;
const MIN_HEIGHT = 2;
const BAR_WIDTH = 4;
const BAR_MARGIN = 1;
const LED_DIM_ALPHA = 0.12;
const PULSE_BAR_WIDTH = 6;
const PULSE_BAR_MARGIN = 3;

export function parseColor(cssColor) {
    const m = cssColor.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/);
    if (m) {
        return {
            r: parseInt(m[1]) / 255,
            g: parseInt(m[2]) / 255,
            b: parseInt(m[3]) / 255,
            a: m[4] !== undefined ? parseFloat(m[4]) : 1.0,
        };
    }
    return { r: 1, g: 1, b: 1, a: 1 };
}

export class RendererController {
    constructor(box, settings) {
        this._box = box;
        this._settings = settings;

        this._vizMode = settings.get_string('visualization-mode');
        this._numBars = settings.get_int('bar-count');
        this._maxHeight = settings.get_int('max-height');
        this._hideWhenSilent = settings.get_boolean('hide-when-silent');

        // Bar colors
        this._barColor = settings.get_string('bar-color');
        this._parsedBarColor = parseColor(this._barColor);
        this._useGradient = settings.get_boolean('use-gradient');
        this._gradientColor = settings.get_string('gradient-color');
        this._parsedGradientColor = parseColor(this._gradientColor);
        this._useVerticalGradient = settings.get_boolean('use-vertical-gradient');
        this._verticalGradientColor = settings.get_string('vertical-gradient-color');
        this._parsedVerticalGradientColor = parseColor(this._verticalGradientColor);

        // LED settings
        this._ledSegmentCount = settings.get_int('led-segment-count');
        this._ledGap = settings.get_int('led-gap');
        this._ledColorLow = settings.get_string('led-color-low');
        this._parsedLedColorLow = parseColor(this._ledColorLow);
        this._ledColorMid = settings.get_string('led-color-mid');
        this._parsedLedColorMid = parseColor(this._ledColorMid);
        this._ledColorHigh = settings.get_string('led-color-high');
        this._parsedLedColorHigh = parseColor(this._ledColorHigh);
        this._ledMidThreshold = settings.get_double('led-mid-threshold');
        this._ledHighThreshold = settings.get_double('led-high-threshold');

        // VU meter settings
        this._meterSize = settings.get_int('meter-size');
        this._needleColor = settings.get_string('needle-color');
        this._parsedNeedleColor = parseColor(this._needleColor);
        this._meterBgColor = settings.get_string('meter-bg-color');
        this._meterWidgets = [];
        this._levelL = 0.0;
        this._levelR = 0.0;

        // Pulse settings
        this._pulseBarCount = settings.get_int('pulse-bar-count');
        this._pulseColor = settings.get_string('pulse-color');
        this._parsedPulseColor = parseColor(this._pulseColor);
        this._pulseGlow = settings.get_boolean('pulse-glow');

        // State
        this._prevHeights = new Array(this._numBars).fill(MIN_HEIGHT);
        this._barCanvas = null;
        this._isMuted = false;

        // Monitor default sink mute state via Gvc
        this._mixer = new Gvc.MixerControl({ name: 'SoundBar' });
        this._mixerStateId = this._mixer.connect('state-changed', () => {
            if (this._mixer.get_state() === Gvc.MixerControlState.READY)
                this._connectSink();
        });
        this._mixer.open();

        // Build initial widgets
        if (this._vizMode === 'vu-meter')
            this._buildMeters();
        else
            this._buildBarCanvas();

        this._connectSettings();
    }

    // --- Public API ---

    /** Called by CavaController with processed frame data */
    updateBars(prevHeights, changed) {
        this._prevHeights = prevHeights;
        if (changed) this._invalidateBarCanvas();
    }

    updateVU(levelL, levelR, changed) {
        this._levelL = levelL;
        this._levelR = levelR;
        if (changed) this._invalidateMeters();
    }

    updateVisibility(silentFrames) {
        if (this._isMuted) {
            this._box.visible = false;
            return;
        }
        this._box.visible = !this._hideWhenSilent || silentFrames < SILENT_FRAMES_THRESHOLD;
    }

    _connectSink() {
        const sink = this._mixer.get_default_sink();
        if (!sink) return;

        // Disconnect previous sink signal if any
        if (this._sinkMuteId && this._sink) {
            this._sink.disconnect(this._sinkMuteId);
            this._sinkMuteId = null;
        }
        this._sink = sink;
        this._isMuted = sink.get_is_muted();
        this._box.visible = !this._isMuted;

        this._sinkMuteId = sink.connect('notify::is-muted', () => {
            this._isMuted = sink.get_is_muted();
            this._box.visible = !this._isMuted;
        });

        // Watch for default sink changes
        if (!this._defaultSinkId) {
            this._defaultSinkId = this._mixer.connect('default-sink-changed', () => {
                this._connectSink();
                // Notify audio controller so it can restart on the new monitor source
                if (this._onSinkChanged) {
                    const name = this._mixer.get_default_sink()?.get_name();
                    if (name) this._onSinkChanged(`${name}.monitor`);
                }
            });
        }
    }

    /** Set a callback to be called when the default audio sink changes.
     *  Called with the new monitor source name (e.g. "alsa_output.xxx.monitor"). */
    set onSinkChanged(cb) {
        this._onSinkChanged = cb;
    }

    switchMode(newMode) {
        if (newMode === this._vizMode) return;
        const oldMode = this._vizMode;
        this._vizMode = newMode;

        if (oldMode === 'vu-meter') {
            this._destroyMeters();
            this._buildBarCanvas();
        } else if (newMode === 'vu-meter') {
            this._destroyBarCanvas();
            this._buildMeters();
        } else if (oldMode === 'pulse' || newMode === 'pulse') {
            this._rebuildBarCanvas();
        } else {
            this._invalidateBarCanvas();
        }
    }

    get vizMode() { return this._vizMode; }

    destroy() {
        if (this._settingsIds) {
            this._settingsIds.forEach(id => this._settings.disconnect(id));
            this._settingsIds = null;
        }
        if (this._sinkMuteId && this._sink) {
            this._sink.disconnect(this._sinkMuteId);
            this._sinkMuteId = null;
        }
        this._sink = null;
        if (this._mixer) {
            if (this._defaultSinkId) {
                this._mixer.disconnect(this._defaultSinkId);
                this._defaultSinkId = null;
            }
            if (this._mixerStateId) {
                this._mixer.disconnect(this._mixerStateId);
                this._mixerStateId = null;
            }
            this._mixer.close();
            this._mixer = null;
        }
        this._destroyBarCanvas();
        this._destroyMeters();
    }

    // --- Canvas management ---

    _buildBarCanvas() {
        const totalWidth = this._vizMode === 'pulse'
            ? this._pulseBarCount * (PULSE_BAR_WIDTH + PULSE_BAR_MARGIN * 2)
            : this._numBars * (BAR_WIDTH + BAR_MARGIN * 2);
        this._barCanvas = new St.DrawingArea({
            width: totalWidth,
            height: this._maxHeight,
            y_align: Clutter.ActorAlign.END,
        });
        this._barCanvas.connect('repaint', (widget) => {
            const cr = widget.get_context();
            const [w, h] = widget.get_surface_size();
            if (this._vizMode === 'led-bars')
                this._drawLedBars(cr, w, h);
            else if (this._vizMode === 'pulse')
                this._drawPulse(cr, w, h);
            else
                this._drawBars(cr, w, h);
            cr.$dispose();
        });
        this._box.add_child(this._barCanvas);
    }

    _destroyBarCanvas() {
        if (this._barCanvas) {
            this._barCanvas.destroy();
            this._barCanvas = null;
        }
    }

    _rebuildBarCanvas() {
        this._destroyBarCanvas();
        this._buildBarCanvas();
    }

    _invalidateBarCanvas() {
        if (this._barCanvas) this._barCanvas.queue_repaint();
    }

    // --- Meter management ---

    _buildMeters() {
        const w = this._meterSize;
        const h = Math.round(w * 0.6);
        for (let ch = 0; ch < 2; ch++) {
            const label = ch === 0 ? 'L' : 'R';
            const area = new St.DrawingArea({
                width: w, height: h,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'margin: 0 1px;',
            });
            area.connect('repaint', (widget) => {
                const cr = widget.get_context();
                const [aw, ah] = widget.get_surface_size();
                this._drawMeter(cr, aw, ah, ch === 0 ? this._levelL : this._levelR, label);
                cr.$dispose();
            });
            this._box.add_child(area);
            this._meterWidgets.push(area);
        }
    }

    _destroyMeters() {
        this._meterWidgets.forEach(w => w.destroy());
        this._meterWidgets = [];
        this._levelL = 0.0;
        this._levelR = 0.0;
    }

    _rebuildMeters() {
        this._destroyMeters();
        this._buildMeters();
    }

    _invalidateMeters() {
        this._meterWidgets.forEach(w => w.queue_repaint());
    }

    // --- Draw routines ---

    _drawBars(cr, width, height) {
        const barStep = BAR_WIDTH + BAR_MARGIN * 2;
        const useVGrad = this._useVerticalGradient;
        const topColor = useVGrad ? this._parsedVerticalGradientColor : null;

        for (let i = 0; i < this._numBars; i++) {
            const x = i * barStep + BAR_MARGIN;
            const barH = Math.round(this._prevHeights[i]);
            const y = height - barH;
            const baseColor = (this._useGradient && (i % 2 === 1))
                ? this._parsedGradientColor : this._parsedBarColor;

            if (useVGrad && barH > MIN_HEIGHT) {
                cr.save();
                cr.rectangle(x, y, BAR_WIDTH, barH);
                cr.clip();
                const grad = new Cairo.LinearGradient(0, height, 0, 0);
                grad.addColorStopRGBA(0, baseColor.r, baseColor.g, baseColor.b, baseColor.a);
                grad.addColorStopRGBA(1, topColor.r, topColor.g, topColor.b, topColor.a);
                cr.setSource(grad);
                cr.paint();
                cr.restore();
            } else {
                cr.setSourceRGBA(baseColor.r, baseColor.g, baseColor.b, baseColor.a);
                cr.rectangle(x, y, BAR_WIDTH, barH);
                cr.fill();
            }
        }
    }

    _drawLedBars(cr, width, height) {
        const barStep = BAR_WIDTH + BAR_MARGIN * 2;
        const segCount = this._ledSegmentCount;
        const gap = this._ledGap;
        const segH = Math.max(1, Math.floor((height - (segCount - 1) * gap) / segCount));
        const midSeg = Math.floor(this._ledMidThreshold * segCount);
        const highSeg = Math.floor(this._ledHighThreshold * segCount);
        const cLow = this._parsedLedColorLow;
        const cMid = this._parsedLedColorMid;
        const cHigh = this._parsedLedColorHigh;

        for (let i = 0; i < this._numBars; i++) {
            const x = i * barStep + BAR_MARGIN;
            const level = Math.round(this._prevHeights[i]) / this._maxHeight;
            const litSegs = Math.round(level * segCount);

            for (let s = 0; s < segCount; s++) {
                const segY = height - (s + 1) * (segH + gap) + gap;
                const lit = s < litSegs;
                const c = s >= highSeg ? cHigh : s >= midSeg ? cMid : cLow;
                cr.setSourceRGBA(c.r, c.g, c.b, lit ? c.a : LED_DIM_ALPHA);
                cr.rectangle(x, segY, BAR_WIDTH, segH);
                cr.fill();
            }
        }
    }

    _drawPulse(cr, width, height) {
        const n = this._pulseBarCount;
        const bw = PULSE_BAR_WIDTH;
        const bm = PULSE_BAR_MARGIN;
        const step = bw + bm * 2;
        const c = this._parsedPulseColor;

        for (let i = 0; i < n; i++) {
            const startBin = Math.floor(i * this._numBars / n);
            const endBin = Math.max(startBin + 1, Math.floor((i + 1) * this._numBars / n));
            let sum = 0;
            for (let b = startBin; b < endBin; b++) sum += this._prevHeights[b];
            const barH = Math.round(sum / (endBin - startBin));
            const x = i * step + bm;
            const y = height - barH;

            if (this._pulseGlow && barH > MIN_HEIGHT) {
                cr.setSourceRGBA(c.r, c.g, c.b, c.a * 0.25);
                cr.rectangle(x - 2, y - 2, bw + 4, barH + 2);
                cr.fill();
            }
            cr.setSourceRGBA(c.r, c.g, c.b, c.a);
            cr.rectangle(x, y, bw, barH);
            cr.fill();
        }
    }

    _drawMeter(cr, width, height, level, label) {
        const arcWidth = Math.max(4, width * 0.12);
        const cx = width / 2;
        const pivotY = height - 1;
        const radius = (width / 2) - 2;
        const greenEnd = Math.PI + 0.70 * Math.PI;
        const yellowEnd = Math.PI + 0.87 * Math.PI;

        cr.setLineWidth(arcWidth);
        cr.setLineCap(Cairo.LineCap.BUTT);

        cr.setSourceRGBA(0.2, 0.8, 0.2, 0.9);
        cr.arc(cx, pivotY, radius, Math.PI, greenEnd);
        cr.stroke();

        cr.setSourceRGBA(0.95, 0.7, 0.1, 0.9);
        cr.arc(cx, pivotY, radius, greenEnd, yellowEnd);
        cr.stroke();

        cr.setSourceRGBA(0.9, 0.15, 0.15, 0.9);
        cr.arc(cx, pivotY, radius, yellowEnd, 2 * Math.PI);
        cr.stroke();

        const needleLen = radius - arcWidth / 2 - 1;
        const needleAngle = Math.PI + level * Math.PI;
        const nc = this._parsedNeedleColor;
        cr.setSourceRGBA(nc.r, nc.g, nc.b, nc.a);
        cr.setLineWidth(Math.max(2, width * 0.05));
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.moveTo(cx, pivotY);
        cr.lineTo(cx + needleLen * Math.cos(needleAngle), pivotY + needleLen * Math.sin(needleAngle));
        cr.stroke();

        cr.setSourceRGBA(0.85, 0.85, 0.85, 1.0);
        const pivotR = Math.max(1.5, width * 0.04);
        cr.arc(cx, pivotY, pivotR, 0, 2 * Math.PI);
        cr.fill();

        const fontSize = Math.max(7, Math.round(width * 0.2));
        cr.setFontSize(fontSize);
        cr.setSourceRGBA(1.0, 1.0, 1.0, 0.9);
        const extents = cr.textExtents(label);
        cr.moveTo(cx - extents.width / 2, pivotY - pivotR - 1);
        cr.showText(label);
    }

    // --- Settings change handlers ---

    _connectSettings() {
        this._settingsIds = [
            this._settings.connect('changed::bar-count', () => {
                this._numBars = this._settings.get_int('bar-count');
                if (this._vizMode !== 'vu-meter') this._rebuildBarCanvas();
                this._prevHeights = new Array(this._numBars).fill(MIN_HEIGHT);
            }),
            this._settings.connect('changed::max-height', () => {
                this._maxHeight = this._settings.get_int('max-height');
                if (this._vizMode !== 'vu-meter') this._rebuildBarCanvas();
            }),
            this._settings.connect('changed::bar-color', () => {
                this._barColor = this._settings.get_string('bar-color');
                this._parsedBarColor = parseColor(this._barColor);
                if (this._vizMode !== 'vu-meter') this._invalidateBarCanvas();
            }),
            this._settings.connect('changed::use-gradient', () => {
                this._useGradient = this._settings.get_boolean('use-gradient');
                if (this._vizMode === 'bars') this._invalidateBarCanvas();
            }),
            this._settings.connect('changed::gradient-color', () => {
                this._gradientColor = this._settings.get_string('gradient-color');
                this._parsedGradientColor = parseColor(this._gradientColor);
                if (this._vizMode === 'bars') this._invalidateBarCanvas();
            }),
            this._settings.connect('changed::use-vertical-gradient', () => {
                this._useVerticalGradient = this._settings.get_boolean('use-vertical-gradient');
                if (this._vizMode === 'bars') this._invalidateBarCanvas();
            }),
            this._settings.connect('changed::vertical-gradient-color', () => {
                this._verticalGradientColor = this._settings.get_string('vertical-gradient-color');
                this._parsedVerticalGradientColor = parseColor(this._verticalGradientColor);
                if (this._vizMode === 'bars') this._invalidateBarCanvas();
            }),
            this._settings.connect('changed::hide-when-silent', () => {
                this._hideWhenSilent = this._settings.get_boolean('hide-when-silent');
            }),
            this._settings.connect('changed::visualization-mode', () => {
                this.switchMode(this._settings.get_string('visualization-mode'));
            }),
            this._settings.connect('changed::meter-size', () => {
                this._meterSize = this._settings.get_int('meter-size');
                if (this._vizMode === 'vu-meter') this._rebuildMeters();
            }),
            this._settings.connect('changed::needle-color', () => {
                this._needleColor = this._settings.get_string('needle-color');
                this._parsedNeedleColor = parseColor(this._needleColor);
                if (this._vizMode === 'vu-meter') this._invalidateMeters();
            }),
            this._settings.connect('changed::meter-bg-color', () => {
                this._meterBgColor = this._settings.get_string('meter-bg-color');
                if (this._vizMode === 'vu-meter') this._invalidateMeters();
            }),
            this._settings.connect('changed::led-segment-count', () => {
                this._ledSegmentCount = this._settings.get_int('led-segment-count');
                if (this._vizMode === 'led-bars') this._invalidateBarCanvas();
            }),
            this._settings.connect('changed::led-gap', () => {
                this._ledGap = this._settings.get_int('led-gap');
                if (this._vizMode === 'led-bars') this._invalidateBarCanvas();
            }),
            this._settings.connect('changed::led-color-low', () => {
                this._ledColorLow = this._settings.get_string('led-color-low');
                this._parsedLedColorLow = parseColor(this._ledColorLow);
                if (this._vizMode === 'led-bars') this._invalidateBarCanvas();
            }),
            this._settings.connect('changed::led-color-mid', () => {
                this._ledColorMid = this._settings.get_string('led-color-mid');
                this._parsedLedColorMid = parseColor(this._ledColorMid);
                if (this._vizMode === 'led-bars') this._invalidateBarCanvas();
            }),
            this._settings.connect('changed::led-color-high', () => {
                this._ledColorHigh = this._settings.get_string('led-color-high');
                this._parsedLedColorHigh = parseColor(this._ledColorHigh);
                if (this._vizMode === 'led-bars') this._invalidateBarCanvas();
            }),
            this._settings.connect('changed::led-mid-threshold', () => {
                this._ledMidThreshold = this._settings.get_double('led-mid-threshold');
                if (this._vizMode === 'led-bars') this._invalidateBarCanvas();
            }),
            this._settings.connect('changed::led-high-threshold', () => {
                this._ledHighThreshold = this._settings.get_double('led-high-threshold');
                if (this._vizMode === 'led-bars') this._invalidateBarCanvas();
            }),
            this._settings.connect('changed::pulse-bar-count', () => {
                this._pulseBarCount = this._settings.get_int('pulse-bar-count');
                if (this._vizMode === 'pulse') this._rebuildBarCanvas();
            }),
            this._settings.connect('changed::pulse-color', () => {
                this._pulseColor = this._settings.get_string('pulse-color');
                this._parsedPulseColor = parseColor(this._pulseColor);
                if (this._vizMode === 'pulse') this._invalidateBarCanvas();
            }),
            this._settings.connect('changed::pulse-glow', () => {
                this._pulseGlow = this._settings.get_boolean('pulse-glow');
                if (this._vizMode === 'pulse') this._invalidateBarCanvas();
            }),
        ];
    }
}
