import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MPRIS_PLAYER_IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
  </interface>
</node>`;

const LABEL_STYLE = (maxWidth) =>
    `max-width: ${maxWidth}px; font-size: 12px; font-weight: 600; color: rgba(255,255,255,1.0); ` +
    `text-shadow: ` +
    `0 0 2px rgba(0,0,0,1.0), ` +
    `0 0 6px rgba(0,0,0,0.95), ` +
    `0 0 12px rgba(0,0,0,0.85), ` +
    `-1px -1px 0 rgba(0,0,0,1.0), 1px -1px 0 rgba(0,0,0,1.0), ` +
    `-1px 1px 0 rgba(0,0,0,1.0), 1px 1px 0 rgba(0,0,0,1.0);`;

export class MprisController {
    constructor(box, settings) {
        this._box = box;
        this._settings = settings;

        this._showNowPlaying = settings.get_boolean('show-now-playing');
        this._showAlbumArt = settings.get_boolean('show-album-art');
        this._showTrackTitle = settings.get_boolean('show-track-title');
        this._npMaxWidth = settings.get_int('now-playing-max-width');
        this._npPosition = settings.get_string('now-playing-position');

        // Widget refs
        this._npWidget = null;
        this._npArtBin = null;
        this._npArtWidget = null;
        this._npLabel = null;
        this._npArtBgActive = false;

        // MPRIS state
        this._mprisProxy = null;
        this._mprisInitDone = false;
        this._mprisPropsChangedId = 0;
        this._mprisPlayerName = null;
        this._mprisCachedProps = null;
        this._nameOwnerChangedId = null;
        this._currentArtUrl = null;
        this._currentTrackTitle = '';
        this._artTmpDir = null;

        if (this._showNowPlaying) {
            this._buildNowPlaying();
            this._initMpris();
        }

        this._connectSettings();
    }

    destroy() {
        if (this._settingsIds) {
            this._settingsIds.forEach(id => this._settings.disconnect(id));
            this._settingsIds = null;
        }
        this._destroyMpris();
        this._destroyNowPlaying();
    }

    /** Hide now-playing widget during silence, show when audio resumes.
     *  Called every frame — only acts on threshold crossings to avoid
     *  redundant visibility changes. */
    updateSilence(silentFrames) {
        if (!this._npArtBin) return;
        const silent = silentFrames >= 10;
        if (silent !== this._wasSilent) {
            this._wasSilent = silent;
            this._npArtBin.visible = !silent;
        }
    }

    // --- Now Playing widget ---

    _buildNowPlaying() {
        if (this._npWidget) return;

        const panelHeight = Main.panel.height || 28;
        this._artSize = panelHeight - 6;

        this._npWidget = new St.BoxLayout({
            style_class: 'soundbar-now-playing',
            style: 'spacing: 6px;',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            visible: true,
        });
        this._npArtBgActive = false;

        this._npArtBin = new St.Bin({
            style: 'border-radius: 100px;',
            y_align: Clutter.ActorAlign.FILL,
            y_expand: true,
            child: this._npWidget,
            visible: true,
        });

        if (this._showAlbumArt) {
            const r = Math.round(this._artSize / 2);
            this._npArtWidget = new St.Widget({
                width: this._artSize, height: this._artSize,
                style: `border-radius: ${r}px; background-color: rgba(255,255,255,0.1);`,
                y_align: Clutter.ActorAlign.CENTER,
                visible: true,
            });
            this._npWidget.add_child(this._npArtWidget);
        }

        if (this._showTrackTitle) {
            this._npLabel = new St.Label({
                text: '...',
                y_align: Clutter.ActorAlign.CENTER,
                style: LABEL_STYLE(this._npMaxWidth),
                visible: true,
            });
            this._npLabel.clutter_text.set_ellipsize(3);
            this._npWidget.add_child(this._npLabel);
        }

        if (this._npPosition === 'right')
            this._box.add_child(this._npArtBin);
        else
            this._box.insert_child_at_index(this._npArtBin, 0);
    }

    _destroyNowPlaying() {
        if (this._npArtBin) {
            this._npArtBin.destroy();
            this._npArtBin = null;
        } else if (this._npWidget) {
            this._npWidget.destroy();
        }
        this._npWidget = null;
        this._npArtWidget = null;
        this._npLabel = null;
    }

    _rebuildNowPlaying() {
        if (!this._showNowPlaying) return;
        this._destroyNowPlaying();
        this._buildNowPlaying();
        if (this._mprisCachedProps) this._applyMetadata();
    }

    // --- MPRIS ---

    _initMpris() {
        if (this._mprisInitDone) return;
        this._mprisInitDone = true;
        this._discoverMprisPlayer();
        this._watchForNewPlayers();
    }

    _destroyMpris() {
        if (this._nameOwnerChangedId) {
            try { Gio.DBus.session.signal_unsubscribe(this._nameOwnerChangedId); } catch (_) {}
            this._nameOwnerChangedId = null;
        }
        this._mprisInitDone = false;
        this._disconnectPlayer();
    }

    _discoverMprisPlayer() {
        try {
            Gio.DBus.session.call(
                'org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus', 'ListNames',
                null, new GLib.VariantType('(as)'),
                Gio.DBusCallFlags.NONE, -1, null,
                (connection, res) => {
                    try {
                        const [names] = connection.call_finish(res).deep_unpack();
                        const mprisNames = names.filter(n => n.startsWith('org.mpris.MediaPlayer2.'));
                        if (mprisNames.length === 0) { this._watchForNewPlayers(); return; }
                        if (mprisNames.length === 1) {
                            this._connectToPlayer(mprisNames[0]);
                            this._watchForNewPlayers();
                            return;
                        }
                        this._pickBestPlayer(mprisNames);
                    } catch (e) {
                        console.debug(`[SoundBar] MPRIS discover error: ${e.message}`);
                        this._watchForNewPlayers();
                    }
                }
            );
        } catch (e) {
            console.debug(`[SoundBar] MPRIS init error: ${e.message}`);
        }
    }

    _pickBestPlayer(names) {
        let remaining = names.length;
        const statuses = new Map();
        const done = () => {
            let best = names[0];
            for (const n of names) {
                const s = statuses.get(n) || 'Unknown';
                const bs = statuses.get(best) || 'Unknown';
                if (s === 'Playing' && bs !== 'Playing') best = n;
                else if (s === 'Paused' && bs !== 'Playing' && bs !== 'Paused') best = n;
            }
            this._connectToPlayer(best);
            this._watchForNewPlayers();
        };
        for (const name of names) {
            Gio.DBus.session.call(
                name, '/org/mpris/MediaPlayer2',
                'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'PlaybackStatus']),
                null, Gio.DBusCallFlags.NONE, 1000, null,
                (conn, res) => {
                    try {
                        const v = conn.call_finish(res).deep_unpack()[0];
                        statuses.set(name, v instanceof GLib.Variant ? v.unpack() : (typeof v === 'string' ? v : 'Unknown'));
                    } catch (_) { statuses.set(name, 'Unknown'); }
                    if (--remaining === 0) done();
                }
            );
        }
    }

    _watchForNewPlayers() {
        if (this._nameOwnerChangedId) return;
        try {
            this._nameOwnerChangedId = Gio.DBus.session.signal_subscribe(
                'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
                '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
                (_conn, _sender, _path, _iface, _signal, params) => {
                    const [name, oldOwner, newOwner] = params.deep_unpack();
                    if (!name.startsWith('org.mpris.MediaPlayer2.')) return;
                    if (newOwner && newOwner !== '') {
                        this._connectToPlayer(name);
                    } else if (oldOwner && oldOwner !== '' && this._mprisPlayerName === name) {
                        this._disconnectPlayer();
                        this._clearNowPlaying();
                        this._discoverMprisPlayer();
                    }
                }
            );
        } catch (e) {
            console.debug(`[SoundBar] MPRIS watch error: ${e.message}`);
        }
    }

    _connectToPlayer(busName) {
        if (this._mprisProxy) this._disconnectPlayer();
        this._mprisPlayerName = busName;
        try {
            const nodeInfo = Gio.DBusNodeInfo.new_for_xml(MPRIS_PLAYER_IFACE);
            const ifaceInfo = nodeInfo.interfaces.find(i => i.name === 'org.mpris.MediaPlayer2.Player');
            Gio.DBusProxy.new(
                Gio.DBus.session, Gio.DBusProxyFlags.NONE, ifaceInfo,
                busName, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player',
                null,
                (source, res) => {
                    try {
                        this._mprisProxy = Gio.DBusProxy.new_finish(res);
                        this._mprisProxy._busName = busName;
                        this._mprisPropsChangedId = this._mprisProxy.connect(
                            'g-properties-changed', () => this._fetchAndApplyMetadata(busName));
                        this._fetchAndApplyMetadata(busName);
                        this._watchForNewPlayers();
                    } catch (e) {
                        console.debug(`[SoundBar] MPRIS connect finish error: ${e.message}`);
                    }
                }
            );
        } catch (e) {
            console.debug(`[SoundBar] MPRIS connect error: ${e.message}`);
        }
    }

    _disconnectPlayer() {
        if (this._mprisPropsChangedId && this._mprisProxy) {
            this._mprisProxy.disconnect(this._mprisPropsChangedId);
            this._mprisPropsChangedId = 0;
        }
        this._mprisProxy = null;
        this._mprisPlayerName = null;
        this._mprisCachedProps = null;
    }

    _fetchAndApplyMetadata(busName) {
        Gio.DBus.session.call(
            busName, '/org/mpris/MediaPlayer2',
            'org.freedesktop.DBus.Properties', 'GetAll',
            new GLib.Variant('(s)', ['org.mpris.MediaPlayer2.Player']),
            null, Gio.DBusCallFlags.NONE, -1, null,
            (conn, r) => {
                try {
                    const raw = conn.call_finish(r).deep_unpack();
                    let propsDict = raw[0];
                    if (propsDict instanceof GLib.Variant) propsDict = propsDict.deep_unpack();
                    const props = {};
                    for (const [k, v] of Object.entries(propsDict))
                        props[k] = (v instanceof GLib.Variant) ? v.deep_unpack() : v;
                    if (props['Metadata'] && typeof props['Metadata'] === 'object') {
                        const meta = {};
                        for (const [k, v] of Object.entries(props['Metadata']))
                            meta[k] = (v instanceof GLib.Variant) ? v.deep_unpack() : v;
                        props['Metadata'] = meta;
                    }
                    this._mprisCachedProps = props;
                    this._applyMetadata();
                } catch (_) {}
            }
        );
    }

    _applyMetadata() {
        if (!this._mprisCachedProps) return;
        try {
            const props = this._mprisCachedProps;
            const metadata = props['Metadata'];
            if (!metadata) return;

            const unpackStr = v => {
                if (v instanceof GLib.Variant) v = v.deep_unpack();
                return typeof v === 'string' ? v : '';
            };

            const title = unpackStr(metadata['xesam:title']);
            let artist = '';
            if (metadata['xesam:artist']) {
                let artists = metadata['xesam:artist'];
                if (artists instanceof GLib.Variant) artists = artists.deep_unpack();
                if (Array.isArray(artists) && artists.length > 0) {
                    let a = artists[0];
                    if (a instanceof GLib.Variant) a = a.deep_unpack();
                    artist = typeof a === 'string' ? a : '';
                } else if (typeof artists === 'string') {
                    artist = artists;
                }
            }

            const displayText = artist ? `${artist} — ${title}` : title;
            let status = props['PlaybackStatus'];
            if (status instanceof GLib.Variant) status = status.deep_unpack();
            if (typeof status !== 'string') status = 'Stopped';
            const isActive = (status === 'Playing' || status === 'Paused') && !!title;

            if (this._npLabel) {
                this._npLabel.set_text(displayText);
                this._npLabel.visible = isActive && this._showTrackTitle;
            }

            const artUrl = unpackStr(metadata['mpris:artUrl']);
            if (this._npArtWidget) {
                if (artUrl && artUrl !== this._currentArtUrl) {
                    this._currentArtUrl = artUrl;
                    this._npArtWidget.visible = true;
                    this._updateAlbumArt(artUrl);
                } else if (!artUrl) {
                    this._currentArtUrl = null;
                    this._npArtWidget.visible = false;
                }
            }
            this._currentTrackTitle = displayText;
        } catch (_) {}
    }

    // --- Album art ---

    _updateAlbumArt(artUrl) {
        if (!this._npArtWidget) return;
        const sz = this._artSize || 22;
        const r = Math.round(sz / 2);
        try {
            if (artUrl.startsWith('file://') || artUrl.startsWith('/')) {
                const uri = artUrl.startsWith('file://') ? artUrl
                    : Gio.File.new_for_path(artUrl).get_uri();
                this._setArtFromUri(uri, sz, r);
            } else if (artUrl.startsWith('http://') || artUrl.startsWith('https://')) {
                this._downloadAndLoadArt(artUrl, sz, r);
            } else {
                this._npArtWidget.set_style(
                    `border-radius: ${r}px; background-color: rgba(255,255,255,0.1); width: ${sz}px; height: ${sz}px;`
                );
            }
        } catch (e) {
            console.debug(`[SoundBar] Album art error: ${e.message}`);
        }
    }

    _downloadAndLoadArt(artUrl, sz, r) {
        if (!this._artTmpDir) {
            this._artTmpDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'soundbar-art']);
            GLib.mkdir_with_parents(this._artTmpDir, 0o755);
        }
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, artUrl, -1);
        const tmpPath = GLib.build_filenamev([this._artTmpDir, hash + '.img']);
        const tmpFile = Gio.File.new_for_path(tmpPath);
        if (tmpFile.query_exists(null)) { this._setArtFromUri(tmpFile.get_uri(), sz, r); return; }
        try {
            const session = new Soup.Session();
            let uri;
            try { uri = GLib.Uri.parse(artUrl, GLib.UriFlags.NONE); } catch (_) { return; }
            const message = new Soup.Message({ method: 'GET', uri });
            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                try {
                    const bytes = s.send_and_read_finish(res);
                    if (!bytes || bytes.get_size() === 0 || !this._npArtWidget) return;
                    const outStream = tmpFile.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                    outStream.write_bytes(bytes, null);
                    outStream.close(null);
                    this._setArtFromUri(tmpFile.get_uri(), sz, r);
                } catch (e) {
                    console.debug(`[SoundBar] Art download error: ${e.message}`);
                }
            });
        } catch (e) {
            console.debug(`[SoundBar] Soup session error: ${e.message}`);
        }
    }

    _setArtFromUri(uri, sz, r) {
        if (!this._npArtWidget) return;
        this._npArtWidget.set_style(
            `border-radius: ${r}px; width: ${sz}px; height: ${sz}px; ` +
            `background-image: url("${uri}"); background-size: cover;`
        );
        if (this._npArtBin) {
            const h = Main.panel.height || 28;
            this._npArtBin.set_style(
                `border-radius: 100px; height: ${h}px; ` +
                `background-image: url("${uri}"); background-size: cover; background-position: center; ` +
                `padding: 0 8px;`
            );
            this._npArtWidget.visible = false;
            this._npArtBgActive = true;
            if (this._npLabel)
                this._npLabel.set_style(LABEL_STYLE(this._npMaxWidth));
        }
    }

    _clearNowPlaying() {
        this._currentTrackTitle = '';
        this._currentArtUrl = null;
        if (this._npLabel) this._npLabel.set_text('');
        if (this._npArtWidget) {
            const sz = this._artSize || 22;
            const r = Math.round(sz / 2);
            this._npArtWidget.set_content(null);
            this._npArtWidget.set_style(
                `border-radius: ${r}px; background-color: rgba(255,255,255,0.1); width: ${sz}px; height: ${sz}px;`
            );
            this._npArtWidget.visible = true;
        }
        if (this._npArtBin) {
            this._npArtBin.set_style('border-radius: 100px;');
            this._npArtBgActive = false;
        }
        if (this._npLabel)
            this._npLabel.set_style(LABEL_STYLE(this._npMaxWidth));
    }

    // --- Settings ---

    _connectSettings() {
        this._settingsIds = [
            this._settings.connect('changed::show-now-playing', () => {
                this._showNowPlaying = this._settings.get_boolean('show-now-playing');
                if (this._showNowPlaying) {
                    this._buildNowPlaying();
                    this._initMpris();
                } else {
                    this._destroyMpris();
                    this._destroyNowPlaying();
                }
            }),
            this._settings.connect('changed::show-album-art', () => {
                this._showAlbumArt = this._settings.get_boolean('show-album-art');
                this._rebuildNowPlaying();
            }),
            this._settings.connect('changed::show-track-title', () => {
                this._showTrackTitle = this._settings.get_boolean('show-track-title');
                this._rebuildNowPlaying();
            }),
            this._settings.connect('changed::now-playing-max-width', () => {
                this._npMaxWidth = this._settings.get_int('now-playing-max-width');
                if (this._npLabel)
                    this._npLabel.set_style(LABEL_STYLE(this._npMaxWidth));
            }),
            this._settings.connect('changed::now-playing-position', () => {
                this._npPosition = this._settings.get_string('now-playing-position');
                this._rebuildNowPlaying();
            }),
        ];
    }
}
