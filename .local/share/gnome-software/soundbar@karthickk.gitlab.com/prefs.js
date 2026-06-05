import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class AudioVisualPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();

        // Audio backend group
        const backendGroup = new Adw.PreferencesGroup({
            title: 'Audio Backend',
            description: 'GStreamer is built-in and requires no extra software. Cava requires the cava package to be installed.'
        });
        page.add(backendGroup);

        const backendRow = new Adw.ComboRow({
            title: 'Backend',
            subtitle: 'Audio capture and analysis engine'
        });
        const backendModel = new Gtk.StringList();
        backendModel.append('GStreamer (built-in)');
        backendModel.append('Cava (external)');
        backendRow.set_model(backendModel);

        const currentBackend = settings.get_string('audio-backend');
        backendRow.set_selected(currentBackend === 'cava' ? 1 : 0);
        backendRow.connect('notify::selected', () => {
            settings.set_string('audio-backend', backendRow.get_selected() === 1 ? 'cava' : 'gstreamer');
        });
        backendGroup.add(backendRow);

        // Visualization Mode group
        const modeGroup = new Adw.PreferencesGroup({
            title: 'Visualization Mode',
            description: 'Choose between bar visualizer, LED bars, and VU meter'
        });
        page.add(modeGroup);

        const modeRow = new Adw.ComboRow({
            title: 'Display Mode',
            subtitle: 'Bars show frequency spectrum, LED Bars show segmented levels, VU Meter shows stereo levels'
        });
        const modeModel = new Gtk.StringList();
        modeModel.append('Bars');
        modeModel.append('LED Bars');
        modeModel.append('VU Meter');
        modeModel.append('Pulse');
        modeRow.set_model(modeModel);

        const currentMode = settings.get_string('visualization-mode');
        const modeMap = {'bars': 0, 'led-bars': 1, 'vu-meter': 2, 'pulse': 3};
        modeRow.set_selected(modeMap[currentMode] || 0);

        modeRow.connect('notify::selected', () => {
            const selected = modeRow.get_selected();
            const modes = ['bars', 'led-bars', 'vu-meter', 'pulse'];
            settings.set_string('visualization-mode', modes[selected]);
        });
        modeGroup.add(modeRow);

        // Bar visualizer settings
        const group = new Adw.PreferencesGroup({
            title: 'Bar Visualizer Settings',
            description: 'Configure the bar visualizer appearance'
        });
        page.add(group);

        const barCountRow = new Adw.SpinRow({
            title: 'Bar Count',
            subtitle: 'Number of visualizer bars to display',
            adjustment: new Gtk.Adjustment({
                lower: 8,
                upper: 64,
                step_increment: 1
            })
        });
        settings.bind('bar-count', barCountRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(barCountRow);

        const maxHeightRow = new Adw.SpinRow({
            title: 'Maximum Height',
            subtitle: 'Maximum height of bars in pixels',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 50,
                step_increment: 1
            })
        });
        settings.bind('max-height', maxHeightRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(maxHeightRow);

        const colorButton = new Gtk.ColorButton();
        const rgba = new Gdk.RGBA();
        rgba.parse(settings.get_string('bar-color'));
        colorButton.set_rgba(rgba);
        
        colorButton.connect('color-set', () => {
            const color = colorButton.get_rgba();
            const colorString = `rgba(${Math.round(color.red * 255)}, ${Math.round(color.green * 255)}, ${Math.round(color.blue * 255)}, ${color.alpha.toFixed(2)})`;
            settings.set_string('bar-color', colorString);
        });

        const colorRow = new Adw.ActionRow({
            title: 'Bar Color',
            subtitle: 'Choose the color of visualizer bars'
        });
        colorRow.add_suffix(colorButton);
        colorRow.set_activatable_widget(colorButton);
        group.add(colorRow);

        const gradientRow = new Adw.SwitchRow({
            title: 'Use Gradient',
            subtitle: 'Alternate between two colors for gradient effect'
        });
        settings.bind('use-gradient', gradientRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(gradientRow);

        const gradientColorButton = new Gtk.ColorButton();
        const gradientRgba = new Gdk.RGBA();
        gradientRgba.parse(settings.get_string('gradient-color'));
        gradientColorButton.set_rgba(gradientRgba);
        
        gradientColorButton.connect('color-set', () => {
            const color = gradientColorButton.get_rgba();
            const colorString = `rgba(${Math.round(color.red * 255)}, ${Math.round(color.green * 255)}, ${Math.round(color.blue * 255)}, ${color.alpha.toFixed(2)})`;
            settings.set_string('gradient-color', colorString);
        });

        const gradientColorRow = new Adw.ActionRow({
            title: 'Gradient Color',
            subtitle: 'Second color for gradient effect'
        });
        gradientColorRow.add_suffix(gradientColorButton);
        gradientColorRow.set_activatable_widget(gradientColorButton);
        group.add(gradientColorRow);

        const verticalGradientRow = new Adw.SwitchRow({
            title: 'Vertical Gradient',
            subtitle: 'Blend from bar color at bottom to a second color at top'
        });
        settings.bind('use-vertical-gradient', verticalGradientRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(verticalGradientRow);

        const verticalGradientColorButton = new Gtk.ColorButton();
        const verticalGradientRgba = new Gdk.RGBA();
        verticalGradientRgba.parse(settings.get_string('vertical-gradient-color'));
        verticalGradientColorButton.set_rgba(verticalGradientRgba);

        verticalGradientColorButton.connect('color-set', () => {
            const color = verticalGradientColorButton.get_rgba();
            const colorString = `rgba(${Math.round(color.red * 255)}, ${Math.round(color.green * 255)}, ${Math.round(color.blue * 255)}, ${color.alpha.toFixed(2)})`;
            settings.set_string('vertical-gradient-color', colorString);
        });

        const verticalGradientColorRow = new Adw.ActionRow({
            title: 'Vertical Gradient Color',
            subtitle: 'Top color for vertical gradient within each bar'
        });
        verticalGradientColorRow.add_suffix(verticalGradientColorButton);
        verticalGradientColorRow.set_activatable_widget(verticalGradientColorButton);
        group.add(verticalGradientColorRow);

        const hideSilentRow = new Adw.SwitchRow({
            title: 'Hide When Silent',
            subtitle: 'Hide the visualizer when there is no audio playback'
        });
        settings.bind('hide-when-silent', hideSilentRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(hideSilentRow);

        const pillRow = new Adw.SwitchRow({
            title: 'Background Pill',
            subtitle: 'Show a rounded pill background behind the visualizer'
        });
        settings.bind('show-pill-background', pillRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(pillRow);

        const pillColorButton = new Gtk.ColorButton({ use_alpha: true });
        const pillRgba = new Gdk.RGBA();
        pillRgba.parse(settings.get_string('pill-color'));
        pillColorButton.set_rgba(pillRgba);

        pillColorButton.connect('color-set', () => {
            const color = pillColorButton.get_rgba();
            const colorString = `rgba(${Math.round(color.red * 255)}, ${Math.round(color.green * 255)}, ${Math.round(color.blue * 255)}, ${color.alpha.toFixed(2)})`;
            settings.set_string('pill-color', colorString);
        });

        const pillColorRow = new Adw.ActionRow({
            title: 'Pill Color',
            subtitle: 'Background color of the pill'
        });
        pillColorRow.add_suffix(pillColorButton);
        pillColorRow.set_activatable_widget(pillColorButton);
        group.add(pillColorRow);

        const sensitivityRow = new Adw.SpinRow({
            title: 'Sensitivity',
            subtitle: 'Audio sensitivity/gain level (50-200%)',
            adjustment: new Gtk.Adjustment({
                lower: 50,
                upper: 200,
                step_increment: 5
            })
        });
        settings.bind('sensitivity', sensitivityRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(sensitivityRow);

        const framerateRow = new Adw.SpinRow({
            title: 'Framerate (FPS)',
            subtitle: 'How often the visualizer updates (10–60)',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 60,
                step_increment: 1
            })
        });
        settings.bind('framerate', framerateRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(framerateRow);

        const riseRow = new Adw.SpinRow({
            title: 'Rise Smoothing',
            subtitle: '0.05–1.0 (lower = slower rise)',
            digits: 2,
            adjustment: new Gtk.Adjustment({
                lower: 0.05,
                upper: 1.0,
                step_increment: 0.05
            })
        });
        settings.bind('alpha-rise', riseRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(riseRow);

        const fallRow = new Adw.SpinRow({
            title: 'Fall Smoothing',
            subtitle: '0.5–1.0 (higher = faster fall)',
            digits: 2,
            adjustment: new Gtk.Adjustment({
                lower: 0.5,
                upper: 1.0,
                step_increment: 0.05
            })
        });
        settings.bind('alpha-fall', fallRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(fallRow);

        const noiseRow = new Adw.SpinRow({
            title: 'Noise Floor',
            subtitle: 'Treat levels below this as silence (20–1000)',
            adjustment: new Gtk.Adjustment({
                lower: 20,
                upper: 1000,
                step_increment: 10
            })
        });
        settings.bind('noise-floor', noiseRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(noiseRow);

        const silenceFramesRow = new Adw.SpinRow({
            title: 'Silence Snap Frames',
            subtitle: 'Consecutive silent frames before snapping to baseline (1–12)',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 12,
                step_increment: 1
            })
        });
        settings.bind('silence-zero-frames', silenceFramesRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(silenceFramesRow);

        // Panel Position Settings
        const positionGroup = new Adw.PreferencesGroup({
            title: 'Panel Position',
            description: 'Configure where the visualizer appears in the top panel'
        });
        page.add(positionGroup);

        const panelPositionRow = new Adw.ComboRow({
            title: 'Position in Top Panel',
            subtitle: 'Left, Center, or Right section of the panel'
        });
        const positionModel = new Gtk.StringList();
        positionModel.append('Left');
        positionModel.append('Center');
        positionModel.append('Right');
        panelPositionRow.set_model(positionModel);

        const currentPosition = settings.get_string('panel-position');
        const positionMap = {'left': 0, 'center': 1, 'right': 2};
        panelPositionRow.set_selected(positionMap[currentPosition] || 0);

        panelPositionRow.connect('notify::selected', () => {
            const selected = panelPositionRow.get_selected();
            const positions = ['left', 'center', 'right'];
            settings.set_string('panel-position', positions[selected]);
        });
        positionGroup.add(panelPositionRow);

        const positionIndexRow = new Adw.SpinRow({
            title: 'Position Index',
            subtitle: 'Order relative to other elements',
            adjustment: new Gtk.Adjustment({
                lower: -10,
                upper: 10,
                step_increment: 1
            })
        });
        settings.bind('position-index', positionIndexRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        positionGroup.add(positionIndexRow);

        const bottomPaddingRow = new Adw.SpinRow({
            title: 'Bottom Padding',
            subtitle: 'Padding from the bottom of the panel in pixels',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 15,
                step_increment: 1
            })
        });
        settings.bind('bottom-padding', bottomPaddingRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        positionGroup.add(bottomPaddingRow);

        // LED Bar Settings group
        const ledGroup = new Adw.PreferencesGroup({
            title: 'LED Bar Settings',
            description: 'Configure the segmented LED bar appearance'
        });
        page.add(ledGroup);

        const ledSegmentCountRow = new Adw.SpinRow({
            title: 'Segment Count',
            subtitle: 'Number of LED segments per bar (6–24)',
            adjustment: new Gtk.Adjustment({
                lower: 6,
                upper: 24,
                step_increment: 1
            })
        });
        settings.bind('led-segment-count', ledSegmentCountRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        ledGroup.add(ledSegmentCountRow);

        const ledGapRow = new Adw.SpinRow({
            title: 'Segment Gap',
            subtitle: 'Gap between segments in pixels (1–3)',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 3,
                step_increment: 1
            })
        });
        settings.bind('led-gap', ledGapRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        ledGroup.add(ledGapRow);

        const ledColorLowButton = new Gtk.ColorButton();
        const ledColorLowRgba = new Gdk.RGBA();
        ledColorLowRgba.parse(settings.get_string('led-color-low'));
        ledColorLowButton.set_rgba(ledColorLowRgba);

        ledColorLowButton.connect('color-set', () => {
            const color = ledColorLowButton.get_rgba();
            const colorString = `rgba(${Math.round(color.red * 255)}, ${Math.round(color.green * 255)}, ${Math.round(color.blue * 255)}, ${color.alpha.toFixed(2)})`;
            settings.set_string('led-color-low', colorString);
        });

        const ledColorLowRow = new Adw.ActionRow({
            title: 'Low Zone Color',
            subtitle: 'Color for the lower segments (green by default)'
        });
        ledColorLowRow.add_suffix(ledColorLowButton);
        ledColorLowRow.set_activatable_widget(ledColorLowButton);
        ledGroup.add(ledColorLowRow);

        const ledColorMidButton = new Gtk.ColorButton();
        const ledColorMidRgba = new Gdk.RGBA();
        ledColorMidRgba.parse(settings.get_string('led-color-mid'));
        ledColorMidButton.set_rgba(ledColorMidRgba);

        ledColorMidButton.connect('color-set', () => {
            const color = ledColorMidButton.get_rgba();
            const colorString = `rgba(${Math.round(color.red * 255)}, ${Math.round(color.green * 255)}, ${Math.round(color.blue * 255)}, ${color.alpha.toFixed(2)})`;
            settings.set_string('led-color-mid', colorString);
        });

        const ledColorMidRow = new Adw.ActionRow({
            title: 'Mid Zone Color',
            subtitle: 'Color for the middle segments. Set same as Low for a two-tone look'
        });
        ledColorMidRow.add_suffix(ledColorMidButton);
        ledColorMidRow.set_activatable_widget(ledColorMidButton);
        ledGroup.add(ledColorMidRow);

        const ledColorHighButton = new Gtk.ColorButton();
        const ledColorHighRgba = new Gdk.RGBA();
        ledColorHighRgba.parse(settings.get_string('led-color-high'));
        ledColorHighButton.set_rgba(ledColorHighRgba);

        ledColorHighButton.connect('color-set', () => {
            const color = ledColorHighButton.get_rgba();
            const colorString = `rgba(${Math.round(color.red * 255)}, ${Math.round(color.green * 255)}, ${Math.round(color.blue * 255)}, ${color.alpha.toFixed(2)})`;
            settings.set_string('led-color-high', colorString);
        });

        const ledColorHighRow = new Adw.ActionRow({
            title: 'High Zone Color',
            subtitle: 'Color for the peak segments (red by default)'
        });
        ledColorHighRow.add_suffix(ledColorHighButton);
        ledColorHighRow.set_activatable_widget(ledColorHighButton);
        ledGroup.add(ledColorHighRow);

        const ledMidThresholdRow = new Adw.SpinRow({
            title: 'Mid Zone Start',
            subtitle: 'Fraction of bar where mid zone begins (0.10–0.90)',
            digits: 2,
            adjustment: new Gtk.Adjustment({
                lower: 0.10,
                upper: 0.90,
                step_increment: 0.05
            })
        });
        settings.bind('led-mid-threshold', ledMidThresholdRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        ledGroup.add(ledMidThresholdRow);

        const ledHighThresholdRow = new Adw.SpinRow({
            title: 'High Zone Start',
            subtitle: 'Fraction of bar where peak zone begins (0.10–0.95)',
            digits: 2,
            adjustment: new Gtk.Adjustment({
                lower: 0.10,
                upper: 0.95,
                step_increment: 0.05
            })
        });
        settings.bind('led-high-threshold', ledHighThresholdRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        ledGroup.add(ledHighThresholdRow);

        // VU Meter Settings group
        const meterGroup = new Adw.PreferencesGroup({
            title: 'VU Meter Settings',
            description: 'Configure the VU meter appearance'
        });
        page.add(meterGroup);

        const meterSizeRow = new Adw.SpinRow({
            title: 'Meter Size',
            subtitle: 'Width of each VU meter gauge in pixels (24–64)',
            adjustment: new Gtk.Adjustment({
                lower: 24,
                upper: 64,
                step_increment: 2
            })
        });
        settings.bind('meter-size', meterSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        meterGroup.add(meterSizeRow);

        const meterSensitivityRow = new Adw.SpinRow({
            title: 'Meter Sensitivity',
            subtitle: 'Gain multiplier for needle level (0.5–5.0)',
            digits: 1,
            adjustment: new Gtk.Adjustment({
                lower: 0.5,
                upper: 5.0,
                step_increment: 0.1
            })
        });
        settings.bind('meter-sensitivity', meterSensitivityRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        meterGroup.add(meterSensitivityRow);

        const needleColorButton = new Gtk.ColorButton();
        const needleRgba = new Gdk.RGBA();
        needleRgba.parse(settings.get_string('needle-color'));
        needleColorButton.set_rgba(needleRgba);

        needleColorButton.connect('color-set', () => {
            const color = needleColorButton.get_rgba();
            const colorString = `rgba(${Math.round(color.red * 255)}, ${Math.round(color.green * 255)}, ${Math.round(color.blue * 255)}, ${color.alpha.toFixed(2)})`;
            settings.set_string('needle-color', colorString);
        });

        const needleColorRow = new Adw.ActionRow({
            title: 'Needle Color',
            subtitle: 'Color of the VU meter needle'
        });
        needleColorRow.add_suffix(needleColorButton);
        needleColorRow.set_activatable_widget(needleColorButton);
        meterGroup.add(needleColorRow);

        const meterBgColorButton = new Gtk.ColorButton();
        const meterBgRgba = new Gdk.RGBA();
        meterBgRgba.parse(settings.get_string('meter-bg-color'));
        meterBgColorButton.set_rgba(meterBgRgba);

        meterBgColorButton.connect('color-set', () => {
            const color = meterBgColorButton.get_rgba();
            const colorString = `rgba(${Math.round(color.red * 255)}, ${Math.round(color.green * 255)}, ${Math.round(color.blue * 255)}, ${color.alpha.toFixed(2)})`;
            settings.set_string('meter-bg-color', colorString);
        });

        const meterBgColorRow = new Adw.ActionRow({
            title: 'Meter Background',
            subtitle: 'Background color of the VU meter face'
        });
        meterBgColorRow.add_suffix(meterBgColorButton);
        meterBgColorRow.set_activatable_widget(meterBgColorButton);
        meterGroup.add(meterBgColorRow);

        // Pulse Mode Settings group
        const pulseGroup = new Adw.PreferencesGroup({
            title: 'Pulse Mode Settings',
            description: 'Configure the pulse animation appearance'
        });
        page.add(pulseGroup);

        const pulseBarCountRow = new Adw.SpinRow({
            title: 'Bar Count',
            subtitle: 'Number of pulse bars (2–16)',
            adjustment: new Gtk.Adjustment({
                lower: 2,
                upper: 16,
                step_increment: 1
            })
        });
        settings.bind('pulse-bar-count', pulseBarCountRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        pulseGroup.add(pulseBarCountRow);

        const pulseColorButton = new Gtk.ColorButton({ use_alpha: true });
        const pulseRgba = new Gdk.RGBA();
        pulseRgba.parse(settings.get_string('pulse-color'));
        pulseColorButton.set_rgba(pulseRgba);

        pulseColorButton.connect('color-set', () => {
            const color = pulseColorButton.get_rgba();
            const colorString = `rgba(${Math.round(color.red * 255)}, ${Math.round(color.green * 255)}, ${Math.round(color.blue * 255)}, ${color.alpha.toFixed(2)})`;
            settings.set_string('pulse-color', colorString);
        });

        const pulseColorRow = new Adw.ActionRow({
            title: 'Bar Color',
            subtitle: 'Color of the pulse bars'
        });
        pulseColorRow.add_suffix(pulseColorButton);
        pulseColorRow.set_activatable_widget(pulseColorButton);
        pulseGroup.add(pulseColorRow);

        const pulseGlowRow = new Adw.SwitchRow({
            title: 'Glow Effect',
            subtitle: 'Draw a soft halo behind each pulse bar'
        });
        settings.bind('pulse-glow', pulseGlowRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        pulseGroup.add(pulseGlowRow);

        // Now Playing Settings group
        const npGroup = new Adw.PreferencesGroup({
            title: 'Now Playing',
            description: 'Show track info and album art from the active media player'
        });
        page.add(npGroup);

        const showNowPlayingRow = new Adw.SwitchRow({
            title: 'Enable Now Playing',
            subtitle: 'Display track info next to the visualizer'
        });
        settings.bind('show-now-playing', showNowPlayingRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        npGroup.add(showNowPlayingRow);

        const showAlbumArtRow = new Adw.SwitchRow({
            title: 'Show Album Art',
            subtitle: 'Display a circular album art thumbnail'
        });
        settings.bind('show-album-art', showAlbumArtRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        npGroup.add(showAlbumArtRow);

        const showTrackTitleRow = new Adw.SwitchRow({
            title: 'Show Track Title',
            subtitle: 'Display the track title text'
        });
        settings.bind('show-track-title', showTrackTitleRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        npGroup.add(showTrackTitleRow);

        const npMaxWidthRow = new Adw.SpinRow({
            title: 'Title Max Width',
            subtitle: 'Maximum width for track title in pixels (80–300)',
            adjustment: new Gtk.Adjustment({
                lower: 80,
                upper: 300,
                step_increment: 10
            })
        });
        settings.bind('now-playing-max-width', npMaxWidthRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        npGroup.add(npMaxWidthRow);

        const npPositionRow = new Adw.ComboRow({
            title: 'Position',
            subtitle: 'Where to show now-playing relative to the visualizer'
        });
        const npPosModel = new Gtk.StringList();
        npPosModel.append('Left');
        npPosModel.append('Right');
        npPositionRow.set_model(npPosModel);

        const currentNpPos = settings.get_string('now-playing-position');
        npPositionRow.set_selected(currentNpPos === 'right' ? 1 : 0);

        npPositionRow.connect('notify::selected', () => {
            const selected = npPositionRow.get_selected();
            settings.set_string('now-playing-position', selected === 1 ? 'right' : 'left');
        });
        npGroup.add(npPositionRow);

        window.add(page);
    }
}
