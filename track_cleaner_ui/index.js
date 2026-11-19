'use strict';

const libQ = require('kew');
const vConf = require('v-conf');
const fs = require('fs');
const path = require('path');
const execFileSync = require('child_process').execFileSync;
const { Store } = require('./lib/store');
const checker = require('./lib/checker');
const track = require('./lib/track');
const ui = require('./ui_patch');
const PKG_VERSION = require('./package.json').version;

module.exports = TrackCleaner;

const ENDPOINT = 'miscellanea/track_cleaner_ui';
const LEGACY_FILTER = '/data/favourites/webradio-filter.json'; // written by Remove Track 1.1.0
const MAX_CHECK_PER_RUN = 1500;
const WRAP_TRIES = 8;
const WRAP_RETRY_MS = 15000;
const WRAPPED = ['handleBrowseUri', 'search', 'explodeUri'];
const SETTLE_MS = 300;          // pause before the queue is cleaned after the player moved on
const DB_UPDATE_DELAY_MS = 4000; // one library update for a series of deletions
const RECHECK_DELAY_MS = 4000;   // pause before a failed station is asked once more
const PLAYLIST_DIR = '/data/playlist';
const QUIET_TAIL_MS = 800;      // Volumio's own queue messages may arrive a moment after the call returns

// station scan: the radio root and one level below it, nothing deeper
const STATION_TYPES = ['webradio', 'mywebradio'];
const MAX_SCAN_FOLDERS = 40;
const MAX_SCAN_MS = 90000;
const SCAN_DELAY_MS = 25000;
const SCAN_TIMEOUT_MS = 20000;
const SCAN_PAUSE_MS = 150;

const UI_TEXT = {
  en: {
    SECTION: 'Interface button',
    SWITCH: 'Delete button in the Volumio interface',
    SWITCH_DOC: 'Adds a delete icon to the right of the search field on every screen. On a web radio it blocks the station, on a music file it deletes the file from disk (after a confirmation, only inside the allowed folders). Reload the page (Ctrl+F5) after changing.',
    APPLIED: 'Interface button added: {dirs}. Reload the page (Ctrl+F5).',
    REMOVED: 'Interface button removed. Reload the page (Ctrl+F5).',
    FAILED: 'Could not change the Volumio interface: {err}. See the log.',
    NONE: 'No Volumio interface found in /volumio/http.'
  },
  ru: {
    SECTION: 'Кнопка в интерфейсе',
    SWITCH: 'Кнопка «Удалить» в интерфейсе Volumio',
    SWITCH_DOC: 'Добавляет иконку удаления справа от поля поиска на всех экранах. На веб-радио блокирует станцию, на музыкальном файле удаляет файл с диска (с подтверждением и только в разрешённых папках). После изменения обновите страницу (Ctrl+F5).',
    APPLIED: 'Кнопка добавлена в интерфейс: {dirs}. Обновите страницу (Ctrl+F5).',
    REMOVED: 'Кнопка убрана из интерфейса. Обновите страницу (Ctrl+F5).',
    FAILED: 'Не удалось изменить интерфейс Volumio: {err}. Подробности в логе.',
    NONE: 'В /volumio/http не найден ни один интерфейс Volumio.'
  }
};

function TrackCleaner(context) {
  this.context = context;
  this.commandRouter = context.coreCommand;
  this.logger = context.logger;
  this.configManager = context.configManager;
  this.store = null;
  this.wrapped = null;
  this.stopped = true;
  this.checking = false;
  this.scanning = false;
  this.scanPromise = null;
  this.checkTimer = null;
  this.scanTimer = null;
  this.wrapTimer = null;
  this.dbTimer = null;
  this.strings = {};
  this.fallbackStrings = {};
}

// ---------- configuration and texts ----------

TrackCleaner.prototype.getConfigurationFiles = function () {
  return ['config.json'];
};

TrackCleaner.prototype.loadConfig = function () {
  const configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
  this.config = new vConf();
  this.config.loadFile(configFile);
  this.dataDir = path.dirname(configFile);
};

TrackCleaner.prototype.cfg = function (key, def) {
  const v = this.config.get(key);
  return v === undefined ? def : v;
};

TrackCleaner.prototype.loadStrings = function () {
  const read = file => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'i18n', file), 'utf8')).TRACK_CLEANER || {}; } catch (e) { return {}; }
  };
  const lang = this.commandRouter.sharedVars.get('language_code') || 'en';
  this.fallbackStrings = read('strings_en.json');
  this.strings = lang === 'en' ? this.fallbackStrings : read('strings_' + lang + '.json');
};

TrackCleaner.prototype.t = function (key, vars) {
  let s = this.strings[key] || this.fallbackStrings[key] || key;
  Object.keys(vars || {}).forEach(k => { s = s.replace('{' + k + '}', vars[k]); });
  return s;
};

TrackCleaner.prototype.push = function (type, text) {
  const fn = this.quietOrig || this.commandRouter.pushToastMessage; // the real one, also while muted
  fn.call(this.commandRouter, type, this.t('TITLE'), text);
};

TrackCleaner.prototype.toast = function (type, key, vars) {
  this.push(type, this.t(key, vars));
};

// texts of the interface button: kept in the code, so the old i18n files stay untouched
TrackCleaner.prototype.tx = function (key, vars) {
  const lang = this.commandRouter.sharedVars.get('language_code') || 'en';
  let s = (UI_TEXT[lang] || UI_TEXT.en)[key] || UI_TEXT.en[key] || key;
  Object.keys(vars || {}).forEach(k => { s = s.replace('{' + k + '}', vars[k]); });
  return s;
};

TrackCleaner.prototype.uiToast = function (type, key, vars) {
  this.push(type, this.tx(key, vars));
};

// ---------- lifecycle ----------

TrackCleaner.prototype.onVolumioStart = function () {
  this.loadConfig();
  return libQ.resolve();
};

TrackCleaner.prototype.onStart = function () {
  const self = this;
  const defer = libQ.defer();
  try {
    self.stopped = false;
    self.loadStrings();
    self.store = new Store(self.dataDir);
    const imported = self.store.importLegacy(LEGACY_FILTER);
    if (imported) self.logger.info('[track_cleaner] imported ' + imported + ' blocked stations from Remove Track 1.1.0');
    self.wrapWebradio(0);
    self.applyUi(false);
    self.scheduleScan();
    self.scheduleCheck();
    defer.resolve();
  } catch (e) {
    self.logger.error('[track_cleaner] cannot start: ' + e);
    defer.reject(e);
  }
  return defer.promise;
};

TrackCleaner.prototype.onStop = function () {
  const defer = libQ.defer();
  this.stopped = true;
  clearTimeout(this.checkTimer);
  clearTimeout(this.scanTimer);
  clearTimeout(this.wrapTimer);
  clearTimeout(this.dbTimer);
  this.unmuteToasts();
  this.unwrapWebradio();
  this.removeUi();
  try { if (this.store) this.store.flush(); } catch (e) { this.logger.error('[track_cleaner] flush failed: ' + e); }
  defer.resolve();
  return defer.promise;
};

TrackCleaner.prototype.onInstall = function () {};
TrackCleaner.prototype.onUninstall = function () { this.removeUi(); };

// ---------- the delete icon in the Volumio interface ----------
// Adds one script tag to the index.html of the Volumio interfaces (/volumio/http/www*) and
// takes it out again on stop. Everything between two marker comments, nothing else is changed.

TrackCleaner.prototype.applyUi = function (notify) {
  const self = this;
  try {
    if (self.cfg('ui_button', true) !== true) {
      const off = ui.remove();
      self.logger.info('[track_cleaner_ui] interface button is off, cleaned: ' + (off.removed.join(', ') || 'nothing to clean'));
      off.failed.forEach(f => self.logger.error('[track_cleaner_ui] cannot clean ' + f.dir + ': ' + f.error));
      if (notify) self.uiToast(off.failed.length ? 'warning' : 'success', off.failed.length ? 'FAILED' : 'REMOVED', { err: off.failed.map(f => f.error).join(', ') });
      return;
    }
    const r = ui.apply({ endpoint: ENDPOINT, version: PKG_VERSION, backupDir: self.dataDir, settings: { confirm: self.cfg('confirm_delete', true) === true } });
    r.failed.forEach(f => self.logger.error('[track_cleaner_ui] cannot patch ' + f.dir + ': ' + f.error));
    if (r.patched.length) self.logger.info('[track_cleaner_ui] interface button added to: ' + r.patched.join(', '));
    if (r.failed.length) {
      if (notify) self.uiToast('warning', 'FAILED', { err: r.failed.map(f => path.basename(f.dir) + ' ' + f.error).join(', ') });
    } else if (!r.patched.length) {
      self.logger.warn('[track_cleaner_ui] no Volumio interface found');
      if (notify) self.uiToast('warning', 'NONE');
    } else if (notify) {
      self.uiToast('success', 'APPLIED', { dirs: r.patched.map(d => path.basename(d)).join(', ') });
    }
  } catch (e) {
    self.logger.error('[track_cleaner_ui] interface patch failed: ' + e);
    if (notify) self.uiToast('error', 'FAILED', { err: e && e.message ? e.message : e });
  }
};

TrackCleaner.prototype.removeUi = function () {
  try {
    const r = ui.remove();
    if (r.removed.length) this.logger.info('[track_cleaner_ui] interface button removed from: ' + r.removed.join(', '));
    r.failed.forEach(f => this.logger.error('[track_cleaner_ui] cannot clean ' + f.dir + ': ' + f.error));
  } catch (e) {
    this.logger.error('[track_cleaner_ui] cleanup failed: ' + e);
  }
};

// the one method the icon calls: web radio -> block the station, anything else -> delete the file
// (removeCurrentTrack itself refuses everything that is not a library track)
TrackCleaner.prototype.removeOrBlock = function () {
  const st = this.commandRouter.volumioGetState() || {};
  if (st.service === 'webradio') this.blockCurrentStation();
  else this.removeCurrentTrack();
};

// ---------- hooks into the web radio plugin (in memory only, undone on stop) ----------

TrackCleaner.prototype.getWebradio = function () {
  try { return this.commandRouter.pluginManager.getPlugin('music_service', 'webradio'); } catch (e) { return null; }
};

TrackCleaner.prototype.wrapWebradio = function (attempt) {
  const self = this;
  if (self.stopped || self.wrapped) return;
  const wr = self.getWebradio();
  if (!wr || typeof wr.handleBrowseUri !== 'function') {
    if (attempt < WRAP_TRIES) {
      self.wrapTimer = setTimeout(() => self.wrapWebradio(attempt + 1), WRAP_RETRY_MS);
      if (self.wrapTimer.unref) self.wrapTimer.unref();
    } else {
      self.logger.warn('[track_cleaner] web radio plugin not found, the station filter is inactive');
    }
    return;
  }
  const saved = { target: wr, originals: {}, own: {}, wrappers: {} };
  WRAPPED.forEach(name => {
    if (typeof wr[name] !== 'function') return;
    saved.own[name] = Object.prototype.hasOwnProperty.call(wr, name);
    saved.originals[name] = wr[name];
  });
  const o = saved.originals;
  if (o.handleBrowseUri) {
    saved.wrappers.handleBrowseUri = function (uri) {
      return self.afterList(o.handleBrowseUri.apply(this, arguments), uri);
    };
  }
  if (o.search) {
    saved.wrappers.search = function () {
      return self.afterList(o.search.apply(this, arguments), 'search');
    };
  }
  if (o.explodeUri) {
    saved.wrappers.explodeUri = function (data) {
      return self.afterExplode(o.explodeUri.apply(this, arguments), data);
    };
  }
  Object.keys(saved.wrappers).forEach(name => { wr[name] = saved.wrappers[name]; });
  self.wrapped = saved;
  self.logger.info('[track_cleaner] station filter active');
};

TrackCleaner.prototype.unwrapWebradio = function () {
  const s = this.wrapped;
  if (!s) return;
  Object.keys(s.wrappers).forEach(name => {
    if (s.target[name] !== s.wrappers[name]) return; // somebody else wrapped it after us: leave it alone
    if (s.own[name]) s.target[name] = s.originals[name];
    else delete s.target[name];
  });
  this.wrapped = null;
};

TrackCleaner.prototype.isFiltering = function () {
  return this.cfg('filter_enabled', true) === true;
};

TrackCleaner.prototype.afterList = function (result, uri) {
  const self = this;
  if (result && typeof result.then === 'function') return result.then(x => self.filterLists(x, uri));
  return self.filterLists(result, uri);
};

// removes blocked stations from a browse or search result; user's own lists are never filtered
TrackCleaner.prototype.filterLists = function (x, uri) {
  try {
    const ownLists = typeof uri === 'string' && /^radio\/(myWebRadio|favourites)/.test(uri);
    const lists = x && x.navigation && Array.isArray(x.navigation.lists) ? x.navigation.lists : (Array.isArray(x) ? x : null);
    if (!lists) return x;
    const filtering = this.isFiltering() && !ownLists;
    lists.forEach(list => {
      if (!list || !Array.isArray(list.items)) return;
      list.items = list.items.filter(item => {
        if (!item || item.type !== 'webradio' || typeof item.uri !== 'string') return true;
        if (!ownLists) this.store.noteSeen(item.uri, item.title || item.name);
        return !(filtering && this.store.isBlocked(item.uri));
      });
    });
  } catch (e) {
    this.logger.error('[track_cleaner] filter failed: ' + e);
  }
  return x;
};

// TuneIn replaces the list address with the stream address when a station is played: remember the link
TrackCleaner.prototype.afterExplode = function (result, data) {
  const self = this;
  const listUri = data && data.uri;
  if (typeof listUri !== 'string' || listUri.indexOf('opml') < 0 || !result || typeof result.then !== 'function') return result;
  return result.then(x => {
    try { if (x && typeof x.uri === 'string') self.store.mapStream(x.uri, listUri); } catch (e) { /* never break playback */ }
    return x;
  });
};

// ---------- station scan: the radio screen and one level below it ----------
// Volumio keeps no list of all web radio stations: the plugin that serves the radio
// screen knows only what the UI has asked for. So we ask for the radio root ourselves,
// open every top level folder once and take the stations found directly inside it.
// We never go deeper: the genre and country trees are endless and lead to the whole catalog.

function browseItems(x) {
  const lists = x && x.navigation && Array.isArray(x.navigation.lists)
    ? x.navigation.lists
    : (Array.isArray(x) ? x : []);
  const out = [];
  lists.forEach(list => {
    if (!list || !Array.isArray(list.items)) return;
    list.items.forEach(it => {
      if (it && typeof it.uri === 'string' && it.uri) out.push(it);
    });
  });
  return out;
}

function isStation(it) {
  return STATION_TYPES.indexOf(it.type) !== -1;
}

// a native promise on purpose: kew promises have no .catch()
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout after ' + ms + ' ms')), ms);
    if (timer.unref) timer.unref();
    Promise.resolve(promise).then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

// browse through the original method: our own wrapper would hide the blocked stations
TrackCleaner.prototype.browseRaw = function (uri) {
  const wr = this.getWebradio();
  if (!wr || typeof wr.handleBrowseUri !== 'function') return Promise.reject(new Error('no web radio plugin'));
  const fn = (this.wrapped && this.wrapped.originals.handleBrowseUri) || wr.handleBrowseUri;
  return withTimeout(Promise.resolve(fn.call(wr, uri)), SCAN_TIMEOUT_MS);
};

TrackCleaner.prototype.noteStations = function (items) {
  let n = 0;
  items.forEach(it => {
    if (!isStation(it)) return;
    this.store.noteSeen(it.uri, it.title || it.name);
    n++;
  });
  return n;
};

// Remembers the stations shown on the radio screen and inside its top level folders.
// Resolves with the number of newly remembered stations, never rejects.
// While a scan is running, further calls get the same promise.
TrackCleaner.prototype.scanRadio = function () {
  const self = this;
  if (self.scanning && self.scanPromise) return self.scanPromise;
  if (!self.store || self.stopped) return Promise.resolve(0);
  self.scanning = true;
  const before = self.store.counts().known;
  const deadline = Date.now() + MAX_SCAN_MS;
  let folders = 0;
  let opened = 0;
  let stations = 0;

  const openFolder = top => Promise.resolve(self.browseRaw(top.uri)).then(x => {
    stations += self.noteStations(browseItems(x));
  }).catch(e => {
    self.logger.warn('[track_cleaner] scan: cannot open ' + top.uri + ': ' + (e && e.message ? e.message : e));
  }).then(() => sleep(SCAN_PAUSE_MS)).then(() => null);

  const run = Promise.resolve(self.browseRaw('radio')).then(root => {
    const tops = browseItems(root).filter(it => !isStation(it)).slice(0, MAX_SCAN_FOLDERS);
    folders = tops.length;
    let chain = libQ.resolve();
    tops.forEach(top => {
      chain = chain.then(() => {
        if (self.stopped) return null;
        if (Date.now() > deadline) return null;
        opened++;
        return openFolder(top);
      });
    });
    return chain;
  }).catch(e => {
    self.logger.warn('[track_cleaner] scan failed: ' + (e && e.message ? e.message : e));
  }).then(() => {
    self.scanning = false;
    self.scanPromise = null;
    if (self.stopped) return 0;
    self.store.flush();
    const added = Math.max(0, self.store.counts().known - before);
    self.logger.info('[track_cleaner] radio scan: opened ' + opened + ' of ' + folders +
      ' folder(s), saw ' + stations + ' station(s), ' + added + ' new, ' +
      self.store.counts().known + ' known in total');
    return added;
  });

  self.scanPromise = run;
  return run;
};

// a scan shortly after start: the lists are ready before the nightly check needs them
TrackCleaner.prototype.scheduleScan = function () {
  const self = this;
  clearTimeout(self.scanTimer);
  if (self.stopped) return;
  self.scanTimer = setTimeout(() => {
    try { self.scanRadio(); } catch (e) { self.logger.error('[track_cleaner] scan crashed: ' + e); }
  }, SCAN_DELAY_MS);
  if (self.scanTimer.unref) self.scanTimer.unref();
};

// ---------- helpers for the actions ----------

function sleep(ms) {
  const d = libQ.defer();
  setTimeout(() => d.resolve(), ms);
  return d.promise;
}

TrackCleaner.prototype.currentTarget = function () {
  const cr = this.commandRouter;
  const state = cr.volumioGetState();
  const queue = cr.volumioGetQueue() || [];
  const pos = state && typeof state.position === 'number' ? state.position : 0;
  return { state: state, queue: queue, pos: pos, current: queue[pos], hasNext: pos + 1 < queue.length };
};

// leave the current item (next if there is one, otherwise stop), then let the player settle
TrackCleaner.prototype.moveAway = function (hasNext) {
  const cr = this.commandRouter;
  return libQ.resolve(hasNext ? cr.volumioNext() : cr.volumioStop());
};

// removes queue items for which test(item.uri) is true, from the end so indexes stay valid
// Volumio announces "removed from queue" for every item taken out of the queue. Here that message
// only repeats what the person has just been told (file deleted / station blocked), so it is muted
// while the plugin cleans the queue. Everything else is shown as usual.
TrackCleaner.prototype.muteToasts = function () {
  const self = this;
  const cr = self.commandRouter;
  if (!self.muted) {
    self.quietOrig = cr.pushToastMessage;
    self.quietOwn = Object.prototype.hasOwnProperty.call(cr, 'pushToastMessage');
    cr.pushToastMessage = function () { /* muted */ };
  }
  self.muted = (self.muted || 0) + 1;
  let done = false;
  return function release() {
    if (done) return;
    done = true;
    if (--self.muted <= 0) self.unmuteToasts();
  };
};

TrackCleaner.prototype.unmuteToasts = function () {
  const cr = this.commandRouter;
  if (this.quietOrig) {
    if (this.quietOwn) cr.pushToastMessage = this.quietOrig; else delete cr.pushToastMessage;
  }
  this.quietOrig = null;
  this.muted = 0;
};

TrackCleaner.prototype.dropFromQueue = function (test) {
  const cr = this.commandRouter;
  const queue = cr.volumioGetQueue() || [];
  let chain = libQ.resolve();
  let release = null;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i] && test(queue[i].uri)) {
      if (!release) release = this.muteToasts();
      chain = chain.then(() => cr.volumioRemoveQueueItem({ value: i }));
    }
  }
  if (!release) return chain;
  const unmute = () => { const t = setTimeout(release, QUIET_TAIL_MS); if (t.unref) t.unref(); };
  const safety = setTimeout(release, 8000); // never stay muted
  if (safety.unref) safety.unref();
  return chain.then(v => { unmute(); return v; }, e => { unmute(); throw e; });
};

// ---------- action: block the playing web radio station ----------
// Methods reached through callMethod return nothing: the core would emit a returned promise as a socket event.

TrackCleaner.prototype.blockCurrentStation = function () {
  this.blockStationAsync().fail(e => this.logger.error('[track_cleaner] block failed: ' + e));
};

TrackCleaner.prototype.blockStationAsync = function () {
  const self = this;
  const cur = self.currentTarget();
  if (!cur.state || cur.state.service !== 'webradio' || !cur.state.uri) {
    self.toast('warning', 'TOAST_NOT_RADIO');
    return libQ.resolve();
  }
  const uris = [];
  const add = u => { if (typeof u === 'string' && u && uris.indexOf(u) === -1) uris.push(u); };
  add(cur.state.uri);
  if (cur.current) add(cur.current.uri);
  add(self.store.listUriFor(cur.state.uri));
  if (cur.current) add(self.store.listUriFor(cur.current.uri));
  const title = cur.state.title || cur.state.uri;
  self.store.blockManual(uris);
  self.store.flush();
  self.toast('success', 'TOAST_BLOCKED', { title: title }); // the station is blocked: say so at once
  return self.moveAway(cur.hasNext)
    .then(() => sleep(SETTLE_MS))
    .then(() => self.dropFromQueue(u => self.store.isBlocked(u)));
};

// ---------- action: delete the playing file from disk ----------

TrackCleaner.prototype.removeCurrentTrack = function () {
  this.removeTrackAsync().fail(e => {
    this.logger.error('[track_cleaner] remove failed: ' + e);
    this.toast('error', 'TOAST_REMOVE_FAILED');
  });
};

// Deletes one file. When the file itself is not writable by the volumio user
// (files owned by root on an ext4 disk, or a mount without uid=volumio), the
// unprivileged sudo path that Volumio already allows for /bin/rm is tried.
// "sudo -n" never asks for a password: if the rule is missing, it fails at once.
TrackCleaner.prototype.deleteFile = function (target) {
  const self = this;
  try {
    fs.unlinkSync(target);
    self.logger.info('[track_cleaner] deleted ' + target);
    return libQ.resolve();
  } catch (e) {
    const code = e && e.code ? e.code : String(e);
    self.logger.error('[track_cleaner] unlink failed: ' + target + ': ' + code);
    if (e && (e.code === 'EACCES' || e.code === 'EPERM')) {
      try {
        execFileSync('/usr/bin/sudo', ['-n', '/bin/rm', '-f', '--', target], { timeout: 10000, stdio: 'ignore' });
        self.logger.info('[track_cleaner] deleted with sudo ' + target);
        return libQ.resolve();
      } catch (e2) {
        self.logger.error('[track_cleaner] sudo rm failed: ' + target + ': ' + (e2 && e2.message ? e2.message : e2));
      }
    }
    return libQ.reject(e);
  }
};

TrackCleaner.prototype.removeTrackAsync = function () {
  const self = this;
  const rawRoots = String(self.cfg('roots', ''));
  const cur = self.currentTarget();
  const st = cur.state || {};
  self.logger.info('[track_cleaner] remove pressed: service=' + st.service +
    ' uri=' + st.uri + ' roots="' + rawRoots + '"');
  const roots = track.parseRoots(rawRoots);
  if (!roots.length) {
    self.logger.warn('[track_cleaner] no usable roots, nothing to do: "' + rawRoots + '"');
    self.toast('warning', 'TOAST_NO_ROOTS');
    return libQ.resolve();
  }
  if (!cur.state || cur.state.service !== 'mpd' || !cur.state.uri) {
    self.logger.warn('[track_cleaner] not a library track: service=' + st.service + ' uri=' + st.uri);
    self.toast('warning', 'TOAST_NOT_TRACK');
    return libQ.resolve();
  }
  const target = track.resolveFile(cur.state.uri);
  self.logger.info('[track_cleaner] delete request: uri=' + cur.state.uri +
    ' resolved=' + target + ' roots=' + roots.join(',') +
    ' exists=' + (track.isAudioFile(target) ? 'yes' : 'no'));
  if (!track.isAllowed(target, roots)) {
    self.logger.warn('[track_cleaner] outside the allowed folders: ' + target);
    self.toast('error', 'TOAST_OUTSIDE_ROOTS');
    return libQ.resolve();
  }
  if (!track.isAudioFile(target)) {
    self.logger.warn('[track_cleaner] not an existing audio file: ' + target);
    self.toast('error', 'TOAST_NO_FILE');
    return libQ.resolve();
  }

  const uris = [cur.state.uri];
  cur.queue.forEach(q => { if (q && q.uri && track.matches(q.uri, target) && uris.indexOf(q.uri) === -1) uris.push(q.uri); });
  const name = cur.state.title || path.basename(target);
  const cr = self.commandRouter;

  // The player moves on, the file goes, the message is shown at once. Queue, playlists,
  // favourites and the library update follow in the background: they must never be able to
  // stop the actual deletion, and the person does not have to wait for them.
  return self.moveAway(cur.hasNext)
    .then(() => self.deleteFile(target))
    .fail(e => {
      if (e && e.code === 'EBUSY') return sleep(400).then(() => self.deleteFile(target)); // still open for a moment
      return libQ.reject(e);
    })
    .then(() => {
      self.toast('success', 'TOAST_REMOVED', { title: name });
      self.cleanupAfterRemove(target, uris);
    })
    .fail(e => {
      self.logger.error('[track_cleaner] remove failed: ' + target + ': ' + (e && e.message ? e.message : e));
      self.toast('error', 'TOAST_REMOVE_FAILED');
    });
};

// true when the playlist file lists the track; when it cannot be read, Volumio is asked as before
TrackCleaner.prototype.playlistHasTrack = function (name, uris, target) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(PLAYLIST_DIR, String(name)), 'utf8'));
    if (!Array.isArray(list)) return true;
    return list.some(it => it && typeof it.uri === 'string' &&
      (uris.indexOf(it.uri) !== -1 || track.matches(it.uri, target)));
  } catch (e) {
    return true;
  }
};

// a series of deletions leads to one library update, a few seconds after the last one
TrackCleaner.prototype.scheduleDbUpdate = function () {
  const self = this;
  clearTimeout(self.dbTimer);
  self.dbTimer = setTimeout(() => {
    try { self.commandRouter.executeOnPlugin('music_service', 'mpd', 'updateDb'); } catch (e) { /* best effort */ }
  }, DB_UPDATE_DELAY_MS);
  if (self.dbTimer.unref) self.dbTimer.unref();
};

TrackCleaner.prototype.cleanupAfterRemove = function (target, uris) {
  const self = this;
  const cr = self.commandRouter;
  sleep(SETTLE_MS)
    .then(() => { try { return self.dropFromQueue(u => track.matches(u, target)).fail(() => null); } catch (e) { return null; } })
    .then(() => { try { return libQ.resolve(cr.playListManager.listPlaylist()).fail(() => []); } catch (e) { return []; } })
    .then(names => {
      // only the playlists that really contain the file, each one handled on its own
      const jobs = (names || []).filter(n => self.playlistHasTrack(n, uris, target)).map(n => {
        let chain = libQ.resolve();
        uris.forEach(u => {
          chain = chain.then(() => libQ.resolve(cr.playListManager.removeFromPlaylist(n, 'mpd', u)).fail(() => null));
        });
        return chain;
      });
      return libQ.all(jobs).fail(() => null);
    })
    .then(() => {
      let chain = libQ.resolve();
      uris.forEach(u => {
        chain = chain.then(() => libQ.resolve(cr.playListManager.removeFromFavourites('', 'mpd', u)).fail(() => null));
      });
      return chain.fail(() => null);
    })
    .then(() => self.scheduleDbUpdate())
    .fail(e => self.logger.error('[track_cleaner] cleanup after delete failed: ' + (e && e.message ? e.message : e)));
};

// ---------- action: unblock ----------

TrackCleaner.prototype.unblockManual = function () {
  const n = this.store.unblockManual();
  this.store.flush();
  this.toast('success', 'TOAST_UNBLOCKED', { n: n });
};

TrackCleaner.prototype.unblockDead = function () {
  const n = this.store.unblockDead();
  this.store.flush();
  this.toast('success', 'TOAST_UNBLOCKED', { n: n });
};

// ---------- liveness check ----------

TrackCleaner.prototype.checkNow = function () {
  const self = this;
  if (self.checking) { self.toast('warning', 'TOAST_CHECK_RUNNING'); return; }
  self.toast('info', 'TOAST_SCAN_STARTED');
  Promise.resolve(self.scanRadio()).then(() => self.runCheck(true))
    .catch(e => self.logger.error('[track_cleaner] check crashed: ' + e));
};

TrackCleaner.prototype.resolveTuneIn = function (uri) {
  const wr = this.getWebradio();
  if (!wr) return Promise.reject(new Error('no web radio plugin'));
  const explode = (this.wrapped && this.wrapped.originals.explodeUri) || wr.explodeUri;
  return Promise.resolve(explode.call(wr, { uri: uri })).then(x => x && x.uri);
};

TrackCleaner.prototype.runCheck = function (manual) {
  const self = this;
  if (self.checking) { if (manual) self.toast('warning', 'TOAST_CHECK_RUNNING'); return Promise.resolve(null); }
  const list = self.store.checkList(MAX_CHECK_PER_RUN);
  if (!list.length) { if (manual) self.toast('warning', 'TOAST_CHECK_EMPTY'); return Promise.resolve(null); }
  self.checking = true;
  if (manual) self.toast('info', 'TOAST_CHECK_STARTED', { n: list.length });
  // A manual check blocks a station that failed twice within the run; the daily check follows
  // the setting (several days in a row).
  const threshold = manual ? 1 : Number(self.cfg('fail_threshold', 2));
  const opts = {
    timeoutMs: Number(self.cfg('timeout_s', 8)) * 1000,
    concurrency: Number(self.cfg('concurrency', 3)),
    resolveTuneIn: u => self.resolveTuneIn(u),
    shouldStop: () => self.stopped
  };
  return Promise.resolve(checker.checkMany(list, opts)).then(first => {
    if (self.stopped || checker.looksLikeNetworkProblem(first)) return first;
    const failed = first.filter(r => r.alive === false).map(r => r.uri);
    if (!failed.length) return first;
    // one bad moment must not hide a good station: everything that failed is asked once more
    return sleep(RECHECK_DELAY_MS).then(() => checker.checkMany(failed, opts)).then(second => {
      const again = {};
      second.forEach(r => { again[r.uri] = r; });
      return first.map(r => (r.alive === false && again[r.uri] ? again[r.uri] : r));
    });
  }).then(results => {
    self.checking = false;
    if (self.stopped) return null;
    if (checker.looksLikeNetworkProblem(results)) {
      self.logger.warn('[track_cleaner] almost every station failed, assuming a network problem: nothing changed');
      if (manual) self.toast('warning', 'TOAST_CHECK_NETWORK');
      return { aborted: true };
    }
    const sum = { checked: results.length, dead: 0, revived: 0, unknown: 0 };
    const reasons = {};
    results.forEach(r => {
      if (r.alive === null) sum.unknown++;
      if (r.alive === false) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
      const out = self.store.recordCheck(r.uri, r.alive, r.reason, threshold);
      if (out === 'dead') { sum.dead++; self.logger.info('[track_cleaner] dead station hidden: ' + r.uri + ' (' + r.reason + ')'); }
      if (out === 'revived') { sum.revived++; self.logger.info('[track_cleaner] station is alive again: ' + r.uri); }
    });
    self.store.flush();
    self.logger.info('[track_cleaner] check done: ' + JSON.stringify(sum) + ', failures by reason: ' + JSON.stringify(reasons));
    if (manual || sum.dead || sum.revived) self.toast('success', 'TOAST_CHECK_DONE', sum);
    return sum;
  }).catch(e => {
    self.checking = false;
    self.logger.error('[track_cleaner] check failed: ' + e);
    return null;
  });
};

TrackCleaner.prototype.scheduleCheck = function () {
  const self = this;
  clearTimeout(self.checkTimer);
  if (self.stopped || self.cfg('auto_check', true) !== true) return;
  const hour = Math.min(23, Math.max(0, parseInt(self.cfg('check_hour', 4), 10) || 0));
  const now = new Date();
  const next = new Date(now.getTime());
  next.setHours(hour, Math.floor(Math.random() * 20), 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  self.checkTimer = setTimeout(() => {
    let p;
    try { p = Promise.resolve(self.scanRadio()); } catch (e) { self.logger.error('[track_cleaner] scan crashed: ' + e); p = Promise.resolve(); }
    p.then(() => self.runCheck(false)).catch(e => self.logger.error('[track_cleaner] daily check crashed: ' + e)).then(() => self.scheduleCheck());
  }, next - now);
  if (self.checkTimer.unref) self.checkTimer.unref();
};

// ---------- settings page ----------

function findContent(uiconf, id) {
  for (const s of uiconf.sections) {
    for (const c of (s.content || [])) if (c.id === id) return c;
  }
  return null;
}

function setSelect(uiconf, id, value) {
  const el = findContent(uiconf, id);
  if (!el || !Array.isArray(el.options)) return;
  const opt = el.options.find(o => String(o.value) === String(value));
  if (opt) el.value = { value: opt.value, label: opt.label };
}

// Mounted folders that can be used as deletion roots. This is only a hint for
// the settings page; the user still types the roots manually.
TrackCleaner.prototype.detectRoots = function () {
  const out = [];
  const add = p => {
    if (!p || p === '/mnt' || p === '/media' || out.indexOf(p) !== -1) return;
    try { if (!fs.statSync(p).isDirectory()) return; } catch (e) { return; }
    out.push(p);
  };
  const unescape = s => s.replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\134/g, '\\');
  try {
    fs.readFileSync('/proc/mounts', 'utf8').split('\n').forEach(line => {
      const parts = line.split(' ');
      if (parts.length < 2) return;
      const mp = unescape(parts[1]);
      if (/^\/(mnt|media)\//.test(mp)) add(mp);
    });
  } catch (e) { /* /proc/mounts is not readable: fall back to the usual names */ }
  ['/mnt/HDD', '/mnt/USB'].forEach(add);
  out.sort();
  return out.slice(0, 8);
};

TrackCleaner.prototype.getUIConfig = function () {
  const self = this;
  const defer = libQ.defer();
  const lang = self.commandRouter.sharedVars.get('language_code') || 'en';
  self.commandRouter.i18nJson(
    path.join(__dirname, 'i18n', 'strings_' + lang + '.json'),
    path.join(__dirname, 'i18n', 'strings_en.json'),
    path.join(__dirname, 'UIConfig.json')
  ).then(uiconf => {
    const sw = (id, v) => { const el = findContent(uiconf, id); if (el) el.value = v; };
    sw('filter_enabled', self.cfg('filter_enabled', true) === true);
    sw('auto_check', self.cfg('auto_check', true) === true);
    sw('roots', String(self.cfg('roots', '')));
    sw('ui_button', self.cfg('ui_button', true) === true);
    sw('confirm_delete', self.cfg('confirm_delete', true) === true);
    if (self.cfg('confirm_delete', true) !== true) {
      const rm = findContent(uiconf, 'remove_track');
      if (rm && rm.onClick) delete rm.onClick.askForConfirm; // no question on the settings button either
    }
    const uiSec = uiconf.sections.find(x => x.id === 'ui');
    if (uiSec) {
      uiSec.label = self.tx('SECTION');
      const uiSw = findContent(uiconf, 'ui_button');
      if (uiSw) { uiSw.label = self.tx('SWITCH'); uiSw.doc = self.tx('SWITCH_DOC'); }
    }
    setSelect(uiconf, 'check_hour', self.cfg('check_hour', 4));
    setSelect(uiconf, 'fail_threshold', self.cfg('fail_threshold', 2));
    setSelect(uiconf, 'concurrency', self.cfg('concurrency', 3));
    setSelect(uiconf, 'timeout_s', self.cfg('timeout_s', 8));
    const roots = findContent(uiconf, 'roots');
    if (roots) {
      const found = self.detectRoots();
      const hint = found.length
        ? self.t('ROOTS_FOUND') + ' ' + found.join(', ')
        : self.t('ROOTS_EXAMPLES');
      roots.doc = self.t('ROOTS_DOC') + ' ' + hint;
    }
    const c = self.store ? self.store.counts() : { manual: 0, dead: 0, known: 0 };
    const radio = uiconf.sections.find(s => s.id === 'radio');
    if (radio) radio.description = self.t('STATS', c);
    defer.resolve(uiconf);
  }).fail(e => {
    self.logger.error('[track_cleaner] cannot build the settings page: ' + e);
    defer.reject(new Error());
  });
  return defer.promise;
};

TrackCleaner.prototype.saveSettings = function (data) {
  const self = this;
  const d = data || {};
  const val = v => (v && typeof v === 'object' && 'value' in v ? v.value : v);
  const num = (key, lo, hi) => {
    if (!(key in d)) return;
    const n = parseInt(val(d[key]), 10);
    if (!isNaN(n)) self.config.set(key, Math.min(hi, Math.max(lo, n)));
  };
  ['filter_enabled', 'auto_check', 'ui_button', 'confirm_delete'].forEach(key => {
    if (key in d) self.config.set(key, val(d[key]) === true || val(d[key]) === 'true');
  });
  num('check_hour', 0, 23);
  num('fail_threshold', 1, 10);
  num('concurrency', 1, 8);
  num('timeout_s', 3, 30);
  if ('roots' in d) self.config.set('roots', String(val(d.roots) || '').trim());
  self.scheduleCheck();
  if ('ui_button' in d) self.applyUi(true);
  else {
    if ('confirm_delete' in d) self.applyUi(false); // the icon in the interface reads the new value
    self.toast('success', 'TOAST_SAVED');
  }
  return libQ.resolve();
};
