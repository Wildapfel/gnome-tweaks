import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {RendererController} from './renderer.js';
import {CavaController} from './cava-controller.js';
import {GstController} from './gst-controller.js';
import {MprisController} from './mpris-controller.js';

let VisualizerButton = GObject.registerClass(
class VisualizerButton extends PanelMenu.Button {
    _init(settings, extension) {
        super._init(0.0, 'SoundBar');

        this._settings = settings;
        this._extension = extension;

        // Pill / box style
        this._bottomPadding = settings.get_int('bottom-padding');
        this._showPill = settings.get_boolean('show-pill-background');
        this._pillColor = settings.get_string('pill-color');

        this._box = new St.BoxLayout({
            style_class: 'audio-visual-container',
            style: this._buildBoxStyle(),
            reactive: false,
            y_align: Clutter.ActorAlign.END,
            y_expand: false,
        });
        this.add_child(this._box);

        // Preferences menu
        this._prefsItem = new PopupMenu.PopupMenuItem('Preferences');
        this._prefsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(this._prefsItem);

        // --- Controllers ---
        this._renderer = new RendererController(this._box, settings);

        this._audioController = this._createAudioController(settings);
        this._audioController.start();

        // Wire renderer's sink-change notification to audio controller restart
        this._renderer.onSinkChanged = (newMonitor) => {
            if (this._audioController?.notifySinkChanged)
                this._audioController.notifySinkChanged(newMonitor);
        };

        this._mpris = new MprisController(this._box, settings);

        // Pill style settings
        this._pillSettingsIds = [
            settings.connect('changed::bottom-padding', () => {
                this._bottomPadding = settings.get_int('bottom-padding');
                this._box.set_style(this._buildBoxStyle());
            }),
            settings.connect('changed::show-pill-background', () => {
                this._showPill = settings.get_boolean('show-pill-background');
                this._box.set_style(this._buildBoxStyle());
            }),
            settings.connect('changed::pill-color', () => {
                this._pillColor = settings.get_string('pill-color');
                this._box.set_style(this._buildBoxStyle());
            }),
            settings.connect('changed::audio-backend', () => {
                if (this._audioController) {
                    this._audioController.destroy();
                    this._audioController = null;
                }
                this._audioController = this._createAudioController(settings);
                this._audioController.start();
            }),
        ];
    }

    _createAudioController(settings) {
        const backend = settings.get_string('audio-backend');
        const onFrame = (frame) => {
            if (frame.isStereo)
                this._renderer.updateVU(frame.levelL, frame.levelR, frame.levelsChanged);
            else
                this._renderer.updateBars(frame.prevHeights, frame.changed);
            this._renderer.updateVisibility(frame.silentFrames);
            this._mpris.updateSilence(frame.silentFrames);
        };
        if (backend === 'cava')
            return new CavaController(settings, onFrame);
        return new GstController(settings, onFrame);
    }

    _buildBoxStyle() {
        let style = `padding-bottom: ${this._bottomPadding}px;`;
        if (this._showPill)
            style += ` background-color: ${this._pillColor}; border-radius: 100px; padding-left: 6px; padding-right: 6px;`;
        return style;
    }

    destroy() {
        if (this._pillSettingsIds) {
            this._pillSettingsIds.forEach(id => this._settings.disconnect(id));
            this._pillSettingsIds = null;
        }
        if (this._mpris) { this._mpris.destroy(); this._mpris = null; }
        if (this._audioController) { this._audioController.destroy(); this._audioController = null; }
        if (this._renderer) { this._renderer.destroy(); this._renderer = null; }
        if (this._box) { this._box.destroy(); this._box = null; }
        super.destroy();
    }
});

export default class AudioVisualExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._button = null;
        this._settings = null;
    }

    enable() {
        this._settings = this.getSettings();
        this._button = new VisualizerButton(this._settings, this);

        const panelPosition = this._settings.get_string('panel-position');
        const positionIndex = this._settings.get_int('position-index');

        Main.panel.addToStatusArea('audio-visual', this._button, positionIndex, panelPosition);

        this._positionChangedId = this._settings.connect('changed::panel-position', () => {
            this.disable(); this.enable();
        });
        this._indexChangedId = this._settings.connect('changed::position-index', () => {
            this.disable(); this.enable();
        });
    }

    disable() {
        if (this._positionChangedId) {
            this._settings.disconnect(this._positionChangedId);
            this._positionChangedId = null;
        }
        if (this._indexChangedId) {
            this._settings.disconnect(this._indexChangedId);
            this._indexChangedId = null;
        }
        if (this._button) { this._button.destroy(); this._button = null; }
        this._settings = null;
    }
}
