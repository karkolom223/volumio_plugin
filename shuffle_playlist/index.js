'use strict';

var fs = require('fs');
var path = require('path');

// Use the modules that ship with Volumio itself. A plugin folder has no node_modules
// of its own unless one is bundled, so fall back to the core's copy.
function requireCore(name) {
  try {
    return require(name);
  } catch (e) {
    return require('/volumio/node_modules/' + name);
  }
}

var libQ = requireCore('kew');
var config = new (requireCore('v-conf'))();

var PLAYLIST_DIR = '/data/playlist/';

module.exports = ControllerShufflePlaylist;

function ControllerShufflePlaylist(context) {
  var self = this;

  self.context = context;
  self.commandRouter = self.context.coreCommand;
  self.logger = self.context.logger;
  self.configManager = self.context.configManager;
}

/* ---------- lifecycle ---------- */

ControllerShufflePlaylist.prototype.onVolumioStart = function () {
  var self = this;
  var configFile = self.commandRouter.pluginManager.getConfigurationFile(self.context, 'config.json');
  config.loadFile(configFile);
  return libQ.resolve();
};

ControllerShufflePlaylist.prototype.onStart = function () {
  return libQ.resolve();
};

ControllerShufflePlaylist.prototype.onStop = function () {
  return libQ.resolve();
};

ControllerShufflePlaylist.prototype.onRestart = function () {};

ControllerShufflePlaylist.prototype.getConfigurationFiles = function () {
  return ['config.json'];
};

/* ---------- helpers ---------- */

// commandRouter.getI18nString only knows the core strings, so plugin strings are loaded here
ControllerShufflePlaylist.prototype.loadI18n = function () {
  var self = this;
  var dir = path.join(__dirname, 'i18n');
  var read = function (file) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (e) {
      return {};
    }
  };
  var lang = 'en';
  try {
    lang = self.commandRouter.sharedVars.get('language_code') || 'en';
  } catch (e) { /* keep en */ }
  self.i18nDefaults = read('strings_en.json');
  self.i18nStrings = lang === 'en' ? self.i18nDefaults : read('strings_' + lang + '.json');
};

ControllerShufflePlaylist.prototype.tr = function (key) {
  this.loadI18n(); // cheap, and always follows the current UI language
  var v = this.i18nStrings[key];
  if (v === undefined || v === '') v = this.i18nDefaults[key];
  return v !== undefined ? v : key;
};

ControllerShufflePlaylist.prototype.getSuffix = function () {
  var s = config.get('suffix');
  return (typeof s === 'string' && s.length) ? s : ' shuffle';
};

ControllerShufflePlaylist.prototype.listPlaylists = function () {
  try {
    return fs.readdirSync(PLAYLIST_DIR).filter(function (name) {
      if (name.charAt(0) === '.') return false;
      try {
        return fs.statSync(path.join(PLAYLIST_DIR, name)).isFile();
      } catch (e) {
        return false;
      }
    }).sort(function (a, b) {
      return a.toLowerCase().localeCompare(b.toLowerCase());
    });
  } catch (e) {
    this.logger.error('[shuffle_playlist] cannot read ' + PLAYLIST_DIR + ': ' + e);
    return [];
  }
};

// Fisher-Yates
ControllerShufflePlaylist.prototype.shuffleArray = function (arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
};

// the select sends {value,label}, but accept plain strings / wrapper objects too
ControllerShufflePlaylist.prototype.extractName = function (data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (data.playlist_select !== undefined) return this.extractName(data.playlist_select);
  if (data.value !== undefined) return this.extractName(data.value);
  if (data.label !== undefined) return String(data.label);
  return '';
};

/* ---------- UI ---------- */

ControllerShufflePlaylist.prototype.getUIConfig = function () {
  var self = this;
  var defer = libQ.defer();
  var langCode = self.commandRouter.sharedVars.get('language_code');

  self.commandRouter.i18nJson(
    path.join(__dirname, 'i18n', 'strings_' + langCode + '.json'),
    path.join(__dirname, 'i18n', 'strings_en.json'),
    path.join(__dirname, 'UIConfig.json')
  ).then(function (uiconf) {
    var select = uiconf.sections[0].content[0];
    var names = self.listPlaylists();

    select.options = names.map(function (n) {
      return { value: n, label: n };
    });

    if (names.length) {
      select.value = { value: names[0], label: names[0] };
    } else {
      select.options = [{ value: '', label: self.tr('NO_PLAYLISTS') }];
      select.value = { value: '', label: self.tr('NO_PLAYLISTS') };
    }

    defer.resolve(uiconf);
  }).fail(function (err) {
    self.logger.error('[shuffle_playlist] getUIConfig failed: ' + err);
    defer.reject(new Error());
  });

  return defer.promise;
};

ControllerShufflePlaylist.prototype.setUIConfig = function () {};
ControllerShufflePlaylist.prototype.getConf = function () {};
ControllerShufflePlaylist.prototype.setConf = function () {};

/* ---------- main action ---------- */

ControllerShufflePlaylist.prototype.shufflePlaylist = function (data) {
  var self = this;
  var defer = libQ.defer();

  var sourceName = self.extractName(data);
  if (!sourceName) {
    self.commandRouter.pushToastMessage('error', self.tr('ERR_TITLE'), self.tr('ERR_NO_SELECTION'));
    defer.resolve();
    return defer.promise;
  }

  // no path tricks: the name must be a bare file name inside the playlist dir
  if (sourceName !== path.basename(sourceName)) {
    self.commandRouter.pushToastMessage('error', self.tr('ERR_TITLE'), self.tr('ERR_NO_SELECTION'));
    defer.resolve();
    return defer.promise;
  }

  var suffix = self.getSuffix();
  var targetName = sourceName;
  // already a shuffled copy -> just re-shuffle it in place
  if (sourceName.slice(-suffix.length) !== suffix) {
    targetName = sourceName + suffix;
  }

  var tracks;
  try {
    tracks = JSON.parse(fs.readFileSync(path.join(PLAYLIST_DIR, sourceName), 'utf8'));
  } catch (e) {
    self.logger.error('[shuffle_playlist] read failed for "' + sourceName + '": ' + e);
    tracks = null;
  }

  if (!Array.isArray(tracks) || tracks.length === 0) {
    self.commandRouter.pushToastMessage('error', self.tr('ERR_TITLE'), self.tr('ERR_EMPTY'));
    defer.resolve();
    return defer.promise;
  }

  var shuffled = self.shuffleArray(tracks);

  // atomic write: temp file in the same dir, then rename over the target
  var targetPath = path.join(PLAYLIST_DIR, targetName);
  var tmpPath = path.join(PLAYLIST_DIR, '.' + targetName + '.tmp');

  var fail = function (err) {
    self.logger.error('[shuffle_playlist] write failed for "' + targetName + '": ' + err);
    try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
    self.commandRouter.pushToastMessage('error', self.tr('ERR_TITLE'), self.tr('ERR_WRITE'));
    defer.resolve();
  };

  fs.writeFile(tmpPath, JSON.stringify(shuffled), 'utf8', function (err) {
    if (err) return fail(err);
    fs.rename(tmpPath, targetPath, function (err2) {
      if (err2) return fail(err2);
      onWritten();
    });
  });

  function onWritten() {

    var msg = self.tr('DONE_MSG').replace('{0}', targetName).replace('{1}', shuffled.length);
    self.commandRouter.pushToastMessage('success', self.tr('DONE'), msg);
    self.logger.info('[shuffle_playlist] ' + msg);

    // refresh the select list so the new playlist shows up without reopening the page
    try {
      self.commandRouter.getUIConfigOnPlugin('miscellanea', 'shuffle_playlist', {})
        .then(function (conf) {
          self.commandRouter.broadcastMessage('pushUiConfig', conf);
        });
    } catch (e) { /* non-critical */ }

    defer.resolve();
  }

  return defer.promise;
};
