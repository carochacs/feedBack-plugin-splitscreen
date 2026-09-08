'use strict';
// Coverage for pure helpers in screen.js: WS URL building, arrangement
// resolution/defaulting, panel-prefs snapshot/migration, range clamping.
// Runs under the org reusable CI as `node tests/screen.test.js`.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function makeLocalStorage() {
    const store = new Map();
    return {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    };
}

// screen.js only needs these DOM entry points to exist while its IIFE
// evaluates — no test asserts on rendering, so the bodies are deliberately
// inert. One shared no-op keeps that intent in a single place.
const noop = () => { /* inert DOM stub — see comment above */ };

function makeDocumentStub(onAddEventListener = noop) {
    return {
        getElementById: () => null,
        addEventListener: onAddEventListener,
        body: { appendChild: noop },
        createElement: () => ({
            style: {},
            classList: { add: noop, remove: noop },
            addEventListener: noop,
            appendChild: noop,
            setAttribute: noop,
        }),
        readyState: 'loading',
    };
}

const PLUGIN_PATH = path.join(__dirname, '..', 'screen.js');

function loadPlugin() {
    delete require.cache[require.resolve(PLUGIN_PATH)];
    return require(PLUGIN_PATH);
}

function freshPlugin({ search = '', protocol = 'http:' } = {}) {
    const location = { search, host: 'localhost:8420', protocol };
    global.window = { location, addEventListener: noop };
    global.document = makeDocumentStub();
    global.localStorage = makeLocalStorage();
    global.location = location;
    return loadPlugin();
}

test('getWsUrl decodes percent-encoded filenames and builds a ws:// URL', () => {
    const { getWsUrl } = freshPlugin();
    assert.equal(
        getWsUrl('sloppak%2Fperfouts.sloppak', 0),
        'ws://localhost:8420/ws/highway/sloppak/perfouts.sloppak?arrangement=0');
});

test('getWsUrl omits the arrangement param when undefined', () => {
    const { getWsUrl } = freshPlugin();
    assert.equal(getWsUrl('song.sloppak'), 'ws://localhost:8420/ws/highway/song.sloppak');
});

test('getWsUrl uses wss:// under https', () => {
    const { getWsUrl } = freshPlugin({ protocol: 'https:' });
    assert.match(getWsUrl('a.sloppak', 1), /^wss:\/\//);
});

test('getWsUrl translates a local dropdown position to the arrangement\'s true server index', () => {
    const mod = freshPlugin();
    // Server-sorted order (Lead, Rhythm, Bass) differs from original storage
    // order: Rhythm is stored at index 2, Bass at index 0.
    mod._setArrangementsForTest([
        { name: 'Lead', index: 1 },
        { name: 'Rhythm', index: 2 },
        { name: 'Bass', index: 0 },
    ]);
    assert.equal(
        mod.getWsUrl('song.sloppak', 1),
        'ws://localhost:8420/ws/highway/song.sloppak?arrangement=2');
    assert.equal(
        mod.getWsUrl('song.sloppak', 2),
        'ws://localhost:8420/ws/highway/song.sloppak?arrangement=0');
});

test('getWsUrl falls back to the supplied position when .index is unavailable', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }, { name: 'Rhythm' }]);
    assert.equal(
        mod.getWsUrl('song.sloppak', 1),
        'ws://localhost:8420/ws/highway/song.sloppak?arrangement=1');
});

test('resolveArrIndex is case-insensitive and finds by name', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }, { name: 'Rhythm' }, { name: 'Bass' }]);
    assert.equal(mod.resolveArrIndex('rhythm'), 1);
    assert.equal(mod.resolveArrIndex('BASS'), 2);
    assert.equal(mod.resolveArrIndex('nope'), -1);
});

test('resolveArrIndex treats special modes as non-arrangements', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }]);
    assert.equal(mod.resolveArrIndex(''), -1);
    assert.equal(mod.resolveArrIndex(null), -1);
    assert.equal(mod.resolveArrIndex('__lyrics__'), -1); // LYRICS_VALUE sentinel used at runtime; harmless if it isn't this literal
});

test('getDefaultArrangements prioritizes lead/rhythm/bass then fills and wraps', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([
        { name: 'Bass Guitar' }, { name: 'Rhythm Guitar' }, { name: 'Lead Guitar' }, { name: 'Extra' },
    ]);
    // indices: 0=bass, 1=rhythm, 2=lead, 3=extra
    assert.deepEqual(mod.getDefaultArrangements(2), [2, 1]); // lead, rhythm
    assert.deepEqual(mod.getDefaultArrangements(4), [2, 1, 0, 3]); // lead, rhythm, bass, extra
    assert.deepEqual(mod.getDefaultArrangements(5), [2, 1, 0, 3, 2]); // wraps around
});

test('getDefaultArrangements falls back to arrangement order with no named matches', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Arr A' }, { name: 'Arr B' }]);
    assert.deepEqual(mod.getDefaultArrangements(2), [0, 1]);
});

test('_ctlRange fills defaults for missing/non-finite bounds', () => {
    const { _ctlRange } = freshPlugin();
    assert.deepEqual(_ctlRange({}), { lo: 0, hi: 1, st: 0.05 });
    assert.deepEqual(_ctlRange({ min: -1, max: 2, step: 0.1 }), { lo: -1, hi: 2, st: 0.1 });
    assert.deepEqual(_ctlRange({ min: NaN, max: Infinity }), { lo: 0, hi: 1, st: 0.05 });
});

test('panelToPrefs encodes a plain arrangement panel', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }]);
    const panel = {
        arrIndex: 0,
        hw: { getInverted: () => false, getLefty: () => false, getMastery: () => 0.5 },
        bar: { style: { display: '' } },
    };
    const prefs = mod.panelToPrefs(panel);
    assert.equal(prefs.arrName, 'Lead');
    assert.equal(prefs.inverted, false);
    assert.equal(prefs.mastery, 0.5);
    assert.equal(prefs.barHidden, false);
});

test('panelToPrefs encodes lyrics mode', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }]);
    const panel = {
        arrIndex: 0, lyricsMode: true, lyricsOverlayOn: true,
        hw: { getInverted: () => true, getLefty: () => true, getMastery: () => 0 },
        bar: { style: { display: 'none' } },
    };
    const prefs = mod.panelToPrefs(panel);
    assert.equal(prefs.arrName, '__lyrics__'); // LYRICS_VALUE sentinel captured verbatim
    assert.equal(prefs.lyrics, true);
    assert.equal(prefs.barHidden, true);
});

test('panelToPrefs encodes viz mode with the underlying arrangement name', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }, { name: 'Bass' }]);
    const panel = {
        arrIndex: 1, vizMode: 'highway_3d',
        hw: { getInverted: () => false, getLefty: () => false, getMastery: () => 0 },
        bar: { style: { display: '' } },
    };
    const prefs = mod.panelToPrefs(panel);
    assert.equal(prefs.arrName, '__viz__:highway_3d:Bass');
});

test('migratePanelPrefs passes through non-array input unchanged', () => {
    const { migratePanelPrefs } = freshPlugin();
    assert.equal(migratePanelPrefs(null), null);
    assert.equal(migratePanelPrefs('nope'), 'nope');
});

test('migratePanelPrefs resets lyrics on first migration (v<2) and preserves other fields', () => {
    const { migratePanelPrefs } = freshPlugin();
    const out = migratePanelPrefs([{ arrName: 'Lead', lyrics: true, inverted: true }]);
    assert.equal(out[0].lyrics, false);
    assert.equal(out[0].inverted, true);
});

test('migratePanelPrefs migrates the legacy 3D-highway sentinel prefix', () => {
    const { migratePanelPrefs } = freshPlugin();
    const out = migratePanelPrefs([{ arrName: '__3d_highway__:Lead', lyrics: false }]);
    assert.equal(out[0].arrName, '__viz__:highway_3d:Lead');
});

test('migratePanelPrefs does not reset lyrics once already migrated to v2', () => {
    global.location = { search: '', host: 'x', protocol: 'http:' };
    const mod = freshPlugin();
    global.localStorage.setItem('splitscreenPrefsMigrationV', '2');
    const out = mod.migratePanelPrefs([{ arrName: 'Lead', lyrics: true }]);
    assert.equal(out[0].lyrics, true);
});

// ── LAN share helpers (splitscreen#21) ──

test('ROOM_KEY_ALPHABET excludes every lookalike glyph', () => {
    const { ROOM_KEY_ALPHABET } = freshPlugin();
    for (const c of '0O1IlLuU') {
        assert.equal(ROOM_KEY_ALPHABET.indexOf(c.toUpperCase()), -1, `alphabet must not contain ${c}`);
    }
});

test('generateRoomKey emits 6 chars drawn from the alphabet', () => {
    const mod = freshPlugin();
    for (let i = 0; i < 20; i++) {
        const key = mod.generateRoomKey();
        assert.equal(key.length, 6);
        for (const c of key) assert.notEqual(mod.ROOM_KEY_ALPHABET.indexOf(c), -1);
    }
});

test('normalizeRoomKey is case-insensitive, trims, and rejects junk', () => {
    const { normalizeRoomKey } = freshPlugin();
    assert.equal(normalizeRoomKey('k7tr4m'), 'K7TR4M');
    assert.equal(normalizeRoomKey('  K7TR4M  '), 'K7TR4M');
    assert.equal(normalizeRoomKey('K7TR4'), null);      // too short
    assert.equal(normalizeRoomKey('K7TR4MM'), null);    // too long
    assert.equal(normalizeRoomKey('K7TR40'), null);     // 0 not in alphabet
    assert.equal(normalizeRoomKey('K7TR4O'), null);     // O not in alphabet
    assert.equal(normalizeRoomKey(null), null);
    assert.equal(normalizeRoomKey(undefined), null);
    assert.equal(normalizeRoomKey(123456), null);
});

test('ensureRoomKey persists a key and returns the same one thereafter', () => {
    const mod = freshPlugin();
    const first = mod.ensureRoomKey();
    assert.equal(mod.normalizeRoomKey(first), first);
    assert.equal(mod.ensureRoomKey(), first);
    assert.equal(global.localStorage.getItem('splitscreenRoomKey'), first);
});

test('ensureRoomKey replaces an invalid stored key', () => {
    const mod = freshPlugin();
    global.localStorage.setItem('splitscreenRoomKey', 'not a key!!');
    const key = mod.ensureRoomKey();
    assert.notEqual(key, 'not a key!!');
    assert.equal(mod.normalizeRoomKey(key), key);
});

test('buildShareUrl joins origin and key, stripping trailing slashes', () => {
    const { buildShareUrl } = freshPlugin();
    assert.equal(buildShareUrl('http://192.168.1.20:8000', 'K7TR4M'), 'http://192.168.1.20:8000/?ss=K7TR4M');
    assert.equal(buildShareUrl('http://192.168.1.20:8000/', 'K7TR4M'), 'http://192.168.1.20:8000/?ss=K7TR4M');
});

test('getSyncUrl targets the core relay endpoint, wss under https', () => {
    assert.equal(freshPlugin().getSyncUrl('K7TR4M'), 'ws://localhost:8420/ws/sync/K7TR4M');
    assert.equal(freshPlugin({ protocol: 'https:' }).getSyncUrl('K7TR4M'), 'wss://localhost:8420/ws/sync/K7TR4M');
});

test('makeRemoteFollowerCfg builds a remote FOLLOWER with detect stripped', () => {
    const { makeRemoteFollowerCfg } = freshPlugin();
    const cfg = makeRemoteFollowerCfg({
        type: 'config',
        filename: 'song.sloppak',
        cfg: {
            // `mode` uses the _captureMode() encoding (`viz:<pluginId>`), the
            // shape a real relay config carries — NOT the saved-prefs
            // `__viz__:` sentinel form.
            arrangement: 2, mode: 'viz:highway_3d', inverted: 1, lefty: true,
            mastery: 0.7, lyrics: true, barHidden: true, name: 'Lead',
            detectChannel: 'left', detectDeviceName: 'Scarlett', detectVerifierOffsetMs: 40,
        },
    }, 'lan-abc');
    assert.equal(cfg.remote, true);
    assert.equal(cfg.popupId, 'lan-abc');
    assert.equal(cfg.filename, 'song.sloppak');
    assert.equal(cfg.arrangement, 2);
    assert.equal(cfg.mode, 'viz:highway_3d');
    assert.equal(cfg.inverted, true);
    assert.equal(cfg.lefty, true);
    assert.equal(cfg.mastery, 0.7);
    assert.equal(cfg.lyrics, true);
    assert.equal(cfg.barHidden, true);
    assert.equal(cfg.name, 'Lead');
    // Viewers are passive mirrors — never inherit the host's mic bindings.
    assert.equal(cfg.detectChannel, 'mono');
    assert.equal(cfg.detectDeviceName, '');
    assert.equal(cfg.detectVerifierOffsetMs, 0);
});

test('makeRemoteFollowerCfg defaults sanely on a minimal config message', () => {
    const { makeRemoteFollowerCfg } = freshPlugin();
    const cfg = makeRemoteFollowerCfg({ type: 'config', filename: 'x.sloppak' }, '');
    assert.equal(cfg.remote, true);
    assert.equal(cfg.arrangement, 0);
    assert.equal(cfg.mode, '2d');
    assert.equal(cfg.inverted, false);
    assert.equal(Number.isNaN(cfg.mastery), true);
});

test('loading with ?ss=<key> under the node test harness does not boot or throw', () => {
    // Modern node DOES ship a global WebSocket, so the runtime gates the
    // remote-join boot (and share auto-resume) behind _nodeTestEnv — this
    // pins that the module loads inertly under the harness and still
    // exports its helpers, rather than opening real sockets / building DOM.
    const mod = freshPlugin({ search: '?ss=k7tr4m' });
    assert.equal(typeof mod.getSyncUrl, 'function');
});

// ── LAYOUTS / applyLayoutStyle (splitscreen#1: CSS grid fix for the
// non-interactive-panel bug) ──────────────────────────────────────────────
test('multi-panel layouts (tri/quad/five/six) are CSS grid, not flex-wrap', () => {
    const { LAYOUTS } = freshPlugin();
    for (const key of ['tri-top', 'tri-bottom', 'quad', 'five', 'six']) {
        assert.equal(LAYOUTS[key].style, 'grid', `${key} should use grid`);
        assert.ok(Number.isInteger(LAYOUTS[key].cols) && LAYOUTS[key].cols > 0, `${key}.cols`);
        assert.ok(Number.isInteger(LAYOUTS[key].rows) && LAYOUTS[key].rows > 0, `${key}.rows`);
        assert.ok(LAYOUTS[key].cols * LAYOUTS[key].rows >= LAYOUTS[key].panels,
            `${key} grid (${LAYOUTS[key].cols}x${LAYOUTS[key].rows}) must fit its ${LAYOUTS[key].panels} panels`);
    }
    // top-bottom/left-right stay flex (2-panel layouts never hit the
    // %-height-in-flex-wrap ambiguity since they don't wrap onto a 2nd row).
    assert.equal(LAYOUTS['top-bottom'].style, 'flex-col');
    assert.equal(LAYOUTS['left-right'].style, 'flex-row');
});

test('applyLayoutStyle sets a grid template sized from cols/rows for quad', () => {
    const { applyLayoutStyle } = freshPlugin();
    const container = { style: {} };
    applyLayoutStyle(container, 'quad');
    assert.match(container.style.cssText, /display:grid/);
    assert.match(container.style.cssText, /grid-template-columns:repeat\(2,1fr\)/);
    assert.match(container.style.cssText, /grid-template-rows:repeat\(2,1fr\)/);
});

test('applyLayoutStyle uses a 6-column grid for five, 3-column for six', () => {
    const { applyLayoutStyle } = freshPlugin();
    const five = { style: {} };
    applyLayoutStyle(five, 'five');
    assert.match(five.style.cssText, /grid-template-columns:repeat\(6,1fr\)/);
    assert.match(five.style.cssText, /grid-template-rows:repeat\(2,1fr\)/);

    const six = { style: {} };
    applyLayoutStyle(six, 'six');
    assert.match(six.style.cssText, /grid-template-columns:repeat\(3,1fr\)/);
    assert.match(six.style.cssText, /grid-template-rows:repeat\(2,1fr\)/);
});

test('applyLayoutStyle still uses flex for the 2-panel layouts', () => {
    const { applyLayoutStyle } = freshPlugin();
    const topBottom = { style: {} };
    applyLayoutStyle(topBottom, 'top-bottom');
    assert.match(topBottom.style.cssText, /display:flex/);
    assert.equal(topBottom.style.flexDirection, 'column');

    const leftRight = { style: {} };
    applyLayoutStyle(leftRight, 'left-right');
    assert.match(leftRight.style.cssText, /display:flex/);
    assert.equal(leftRight.style.flexDirection, 'row');
});

test('_bestFitLayout picks the smallest layout with room, and caps at six', () => {
    const { _bestFitLayout } = freshPlugin();
    assert.equal(_bestFitLayout(1), 'top-bottom');
    assert.equal(_bestFitLayout(2), 'top-bottom');
    assert.equal(_bestFitLayout(3), 'tri-top');
    assert.equal(_bestFitLayout(4), 'quad');
    assert.equal(_bestFitLayout(5), 'five');
    assert.equal(_bestFitLayout(6), 'six');
    assert.equal(_bestFitLayout(7), 'six'); // nothing bigger — caller must truncate
});

// ── Reload idempotency (plugin-runtime-idempotent.v1) ─────────────────────
// The Host may re-execute screen.js on plugin reload. A second evaluation
// must not run ANY top-level statement with observable side effects: not
// just the shared-global hooks (before the guard, playSong got wrapped
// around the already-wrapped version and every listener was added twice),
// but also the settings-sync wiring, the LAN-share resume, and the
// follower boot — all of which would build state no live hook reads.
test('re-evaluating screen.js installs its global hooks exactly once', () => {
    const counts = { resize: 0, beforeunload: 0, pointerdown: 0 };
    const tally = (ev) => { if (ev in counts) counts[ev] += 1; };
    const location = { search: '', host: 'localhost:8420', protocol: 'http:' };

    // Deliberately NOT freshPlugin(): it builds a new window per call, and a
    // reload is precisely the case where one window survives two evaluations.
    global.window = { location, addEventListener: tally };
    global.document = makeDocumentStub(tally);
    global.localStorage = makeLocalStorage();
    global.location = location;

    // The settings-sync block wires a change handler onto this control. A
    // second evaluation re-wiring it is the subtler half of the bug: the new
    // handler mutates state that run #1's live playSong wrapper never reads,
    // so "Always Split" would silently stop working after a reload.
    let settingsWirings = 0;
    global.document.getElementById = (id) => (
        id === 'splitscreen-default-layout'
            ? { value: '', addEventListener: () => { settingsWirings += 1; } }
            : null
    );

    // Sentinels — only their identity matters, so the bodies stay empty.
    const originalPlaySong = async function originalPlaySong() { /* sentinel */ };
    window.playSong = originalPlaySong;
    window.showScreen = function originalShowScreen() { /* sentinel */ };

    loadPlugin();
    assert.notEqual(window.playSong, originalPlaySong, 'first load should wrap playSong');
    assert.equal(settingsWirings, 1, 'first load should wire the settings control once');
    const afterFirst = { ...counts };
    const wrappedOnce = window.playSong;

    loadPlugin();

    assert.deepEqual(counts, afterFirst, 'second evaluation must not re-add listeners');
    assert.equal(window.playSong, wrappedOnce, 'second evaluation must not re-wrap playSong');
    assert.equal(settingsWirings, 1, 'second evaluation must not re-wire settings handlers');
});

// ── LAN share teardown (stopLanShare) ──────────────────────────────────────
// stopLanShare() sends a terminal 'share-ended' message directly against the
// captured WebSocket rather than via _lanSend() (which silently drops any
// message whenever the socket isn't OPEN) — every viewer's only terminal
// signal is share-ended, so dropping it on a Stop click that lands mid-
// reconnect used to leave every viewer hello-polling forever.

class FakeWebSocket {
    constructor(readyState) {
        this.readyState = readyState;
        this.sent = [];
        this.closed = false;
        this._listeners = {};
    }
    send(data) { this.sent.push(data); }
    close() { this.closed = true; }
    addEventListener(type, cb, opts) {
        this._listeners[type] = { cb, opts };
    }
    fireOpen() {
        const l = this._listeners.open;
        if (l) l.cb();
    }
}

test('stopLanShare sends share-ended and closes immediately when the socket is OPEN', () => {
    const mod = freshPlugin();
    const ws = new FakeWebSocket(1); // OPEN
    mod._setLanShareForTest({ key: 'ABC123', cfg: null, ws, retryTimer: null, backoffMs: 1000 });

    mod.stopLanShare();

    assert.equal(mod._getLanShareForTest(), null, '_lanShare must be nulled synchronously');
    assert.deepEqual(ws.sent.map((s) => JSON.parse(s)), [{ type: 'share-ended' }]);
    assert.equal(ws.closed, true);
});

test('stopLanShare waits for a CONNECTING socket to open before sending share-ended', () => {
    const mod = freshPlugin();
    const ws = new FakeWebSocket(0); // CONNECTING
    mod._setLanShareForTest({ key: 'ABC123', cfg: null, ws, retryTimer: null, backoffMs: 1000 });

    const originalSetTimeout = global.setTimeout;
    global.setTimeout = () => 0; // never fire the 1500ms fallback in this test
    try {
        mod.stopLanShare();
        assert.equal(mod._getLanShareForTest(), null, '_lanShare must be nulled synchronously');
        assert.equal(ws.sent.length, 0, 'must not send before the socket actually opens');
        assert.equal(ws.closed, false, 'must not close before the goodbye is sent');

        ws.fireOpen();

        assert.deepEqual(ws.sent.map((s) => JSON.parse(s)), [{ type: 'share-ended' }]);
        assert.equal(ws.closed, true);
    } finally {
        global.setTimeout = originalSetTimeout;
    }
});

test('stopLanShare falls back to sending on the timeout if a CONNECTING socket never opens', () => {
    const mod = freshPlugin();
    const ws = new FakeWebSocket(0); // CONNECTING, never opens
    mod._setLanShareForTest({ key: 'ABC123', cfg: null, ws, retryTimer: null, backoffMs: 1000 });

    const originalSetTimeout = global.setTimeout;
    let timeoutCb = null;
    global.setTimeout = (cb) => { timeoutCb = cb; return 0; };
    try {
        mod.stopLanShare();
        assert.equal(ws.sent.length, 0);

        timeoutCb();

        assert.deepEqual(ws.sent.map((s) => JSON.parse(s)), [{ type: 'share-ended' }]);
        assert.equal(ws.closed, true);
    } finally {
        global.setTimeout = originalSetTimeout;
    }
});

test('stopLanShare is a no-op send when there is no live socket (already closed/never connected)', () => {
    const mod = freshPlugin();
    mod._setLanShareForTest({ key: 'ABC123', cfg: null, ws: null, retryTimer: null, backoffMs: 1000 });

    assert.doesNotThrow(() => mod.stopLanShare());
    assert.equal(mod._getLanShareForTest(), null);
});

test('stopLanShare clears a pending reconnect timer so it cannot fire after teardown', () => {
    const mod = freshPlugin();
    let cleared = null;
    const originalClearTimeout = global.clearTimeout;
    global.clearTimeout = (id) => { cleared = id; };
    try {
        mod._setLanShareForTest({ key: 'ABC123', cfg: null, ws: null, retryTimer: 'sentinel-timer-id', backoffMs: 1000 });
        mod.stopLanShare();
        assert.equal(cleared, 'sentinel-timer-id');
    } finally {
        global.clearTimeout = originalClearTimeout;
    }
});
