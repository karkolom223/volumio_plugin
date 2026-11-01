'use strict';
const libQ = require('kew');
const vConf = require('v-conf');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const removeServer = require('./server');

const WWW = '/volumio/http/www3';
const TAG = '<script src="/remove-track.js"></script>';

module.exports = RemoveTrack;

function RemoveTrack(context) {
  this.context = context;
  this.commandRouter = context.coreCommand;
  this.logger = context.logger;
  this.configManager = context.configManager;
  this.server = null;
}

RemoveTrack.prototype.log = function (msg) {
  this.logger.info('[remove_track] ' + msg);
};

RemoveTrack.prototype.getI18nFile = function (langCode) {
  const dir = path.join(__dirname, 'i18n');
  const f = 'strings_' + langCode + '.json';
  return fs.existsSync(path.join(dir, f)) ? path.join(dir, f) : path.join(dir, 'strings_en.json');
};

RemoveTrack.prototype.loadConfig = function () {
  const configFile = path.join(this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json'));
  this.config = new vConf();
  this.config.loadFile(configFile);
};

RemoveTrack.prototype.getRoots = function () {
  return String(this.config.get('roots') || '')
    .split(',').map(s => s.trim()).filter(s => s.charAt(0) === '/' && s.length > 1);
};

// ---------- lifecycle ----------

RemoveTrack.prototype.onVolumioStart = function () {
  this.loadConfig();
  return libQ.resolve();
};

RemoveTrack.prototype.onStart = function () {
  const self = this;
  const defer = libQ.defer();
  if (!self.config) self.loadConfig();
  self.startAll().then(() => defer.resolve()).catch(e => {
    self.logger.error('[remove_track] start failed: ' + e.message);
    defer.reject(e);
  });
  return defer.promise;
};

RemoveTrack.prototype.onStop = function () {
  const self = this;
  const defer = libQ.defer();
  self.stopAll().then(() => defer.resolve()).catch(() => defer.resolve());
  return defer.promise;
};

RemoveTrack.prototype.getConfigurationFiles = function () { return ['config.json']; };
RemoveTrack.prototype.onInstall = function () {};
RemoveTrack.prototype.onUninstall = function () {};

// ---------- server + UI hook ----------

RemoveTrack.prototype.startAll = async function () {
  const self = this;
  const port = parseInt(self.config.get('port'), 10) || 8088;
  const roots = self.getRoots();
  if (!roots.length) throw new Error('no allowed roots configured');

  self.server = removeServer.create({
    port: port,
    roots: roots,
    log: m => self.log(m),
    hook: matcher => self.removeFromVolumioQueue(matcher)
  });
  await self.server.start();
  self.installButton(port, !!self.config.get('confirm'));
  self.log('listening on :' + port + ', roots: ' + roots.join(', '));
};

RemoveTrack.prototype.stopAll = async function () {
  if (this.server) { await this.server.stop(); this.server = null; }
  this.uninstallButton();
};

// Remove from Volumio's in-memory queue so it can't be re-saved to /data/queue
RemoveTrack.prototype.removeFromVolumioQueue = function (matcher) {
  const q = this.commandRouter.volumioGetQueue();
  if (!Array.isArray(q)) return;
  for (let i = q.length - 1; i >= 0; i--) {
    if (q[i] && q[i].uri && matcher(q[i].uri)) {
      this.commandRouter.volumioRemoveQueueItem({ value: i });
    }
  }
};

RemoveTrack.prototype.installButton = function (port, confirm) {
  const tpl = fs.readFileSync(path.join(__dirname, 'client.js.tpl'), 'utf8');
  const js = tpl.replace('__PORT__', String(port)).replace('__CONFIRM__', confirm ? 'true' : 'false');
  const tmp = '/tmp/remove-track.js';
  fs.writeFileSync(tmp, js);
  // -n: если NOPASSWD не сработает — сразу ошибка, а не ожидание пароля на tty
  execFileSync('/usr/bin/sudo', ['-n', '/bin/cp', tmp, WWW + '/remove-track.js'], { timeout: 10000 });
  const html = fs.readFileSync(WWW + '/index.html', 'utf8');
  if (html.indexOf(TAG) === -1) {
    execFileSync('/usr/bin/sudo', ['-n', '/bin/sed', '-i', 's|</body>|' + TAG + '</body>|', WWW + '/index.html'], { timeout: 10000 });
  }
};

RemoveTrack.prototype.uninstallButton = function () {
  try {
    execFileSync('/usr/bin/sudo', ['-n', '/bin/sed', '-i', 's|' + TAG + '||', WWW + '/index.html'], { timeout: 10000 });
    execFileSync('/usr/bin/sudo', ['-n', '/bin/rm', '-f', WWW + '/remove-track.js'], { timeout: 10000 });
  } catch (e) {
    this.logger.error('[remove_track] uninstall hook: ' + e.message);
  }
};

// ---------- UI config ----------

RemoveTrack.prototype.getUIConfig = function () {
  const self = this;
  const defer = libQ.defer();
  const lang = self.commandRouter.sharedVars.get('language_code');
  self.commandRouter.i18nJson(
    path.join(__dirname, 'i18n', 'strings_' + lang + '.json'),
    path.join(__dirname, 'i18n', 'strings_en.json'),
    path.join(__dirname, 'UIConfig.json')
  ).then(function (ui) {
    const c = ui.sections[0].content;
    c[0].value = self.config.get('port');
    c[1].value = self.config.get('roots');
    c[2].value = !!self.config.get('confirm');
    defer.resolve(ui);
  }).fail(function () { defer.reject(new Error()); });
  return defer.promise;
};

RemoveTrack.prototype.saveConfig = function (data) {
  const self = this;
  const defer = libQ.defer();

  const port = parseInt(data.port, 10);
  if (!(port >= 1024 && port <= 65535)) {
    self.commandRouter.pushToastMessage('error', 'Remove Track', 'Invalid port');
    return libQ.resolve();
  }
  const roots = String(data.roots || '').split(',').map(s => s.trim()).filter(s => s.charAt(0) === '/' && s.length > 1);
  if (!roots.length) {
    self.commandRouter.pushToastMessage('error', 'Remove Track', 'At least one absolute folder is required');
    return libQ.resolve();
  }

  self.config.set('port', port);
  self.config.set('roots', roots.join(','));
  self.config.set('confirm', !!data.confirm);

  self.stopAll().then(() => self.startAll()).then(() => {
    self.commandRouter.pushToastMessage('success', 'Remove Track', 'Settings saved');
    defer.resolve();
  }).catch(e => {
    self.commandRouter.pushToastMessage('error', 'Remove Track', e.message);
    defer.resolve();
  });
  return defer.promise;
};