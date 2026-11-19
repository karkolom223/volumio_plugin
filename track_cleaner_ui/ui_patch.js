'use strict';

// Adds (and removes) one <script> tag in the index.html of the Volumio web interfaces
// and puts ui/track_cleaner_ui.js next to it. Everything the plugin adds sits between two
// marker comments, so it can be taken out again byte for byte.
//
// Volumio keeps its interfaces in /volumio/http:
//   www  = Classic, www3 = Contemporary, www4 = Manifest.

const fs = require('fs');
const os = require('os');
const path = require('path');
const execFileSync = require('child_process').execFileSync;

const UI_DIRS = ['/volumio/http/www3', '/volumio/http/www', '/volumio/http/www4'];
const JS_NAME = 'track_cleaner_ui.js';
const SETTINGS_NAME = 'track_cleaner_ui.json'; // read by the icon at run time: changes apply without a reload of index.html
const BEGIN = '<!-- track_cleaner_ui:begin -->';
const END = '<!-- track_cleaner_ui:end -->';
const BLOCK_RE = /\n?<!-- track_cleaner_ui:begin -->[\s\S]*?<!-- track_cleaner_ui:end -->\n?/g;

function needsSudo(e) {
  return e && (e.code === 'EACCES' || e.code === 'EPERM');
}

// Writes through a temporary file and a rename, so a half written index.html never exists.
// When the folder is not writable for the volumio user, the same sudo rule that Volumio
// allows for /bin/cp is tried ("sudo -n" never asks for a password).
function writeFile(target, data) {
  const tmp = target + '.tcui.tmp';
  try {
    let mode = 0o644;
    try { mode = fs.statSync(target).mode & 0o777; } catch (e) { /* new file */ }
    fs.writeFileSync(tmp, data, { mode: mode });
    fs.renameSync(tmp, target);
    return;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* nothing to clean */ }
    if (!needsSudo(e)) throw e;
  }
  const stage = path.join(os.tmpdir(), 'track_cleaner_ui_' + process.pid + '_' + Date.now());
  fs.writeFileSync(stage, data);
  try {
    execFileSync('/usr/bin/sudo', ['-n', '/bin/cp', '-f', '--', stage, target], { timeout: 10000, stdio: 'ignore' });
  } finally {
    try { fs.unlinkSync(stage); } catch (e) { /* nothing to clean */ }
  }
}

function removeFile(target) {
  try {
    fs.unlinkSync(target);
  } catch (e) {
    if (e && e.code === 'ENOENT') return;
    if (!needsSudo(e)) throw e;
    execFileSync('/usr/bin/sudo', ['-n', '/bin/rm', '-f', '--', target], { timeout: 10000, stdio: 'ignore' });
  }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}

function stripBlock(html) {
  return html.replace(BLOCK_RE, '');
}

function insertBlock(html, block) {
  let idx = -1;
  const re = /<\/body\s*>/gi;
  let m;
  while ((m = re.exec(html))) idx = m.index;
  const ins = '\n' + block + '\n';
  return idx === -1 ? html + ins : html.slice(0, idx) + ins + html.slice(idx);
}

function errText(e) {
  return e && (e.code || e.message) ? (e.code || e.message) : String(e);
}

// opts: { endpoint, version, backupDir, dirs, settings }
// returns { patched: [dir], skipped: [dir], failed: [{ dir, error }] }
function apply(opts) {
  const o = opts || {};
  const dirs = o.dirs || UI_DIRS;
  const tpl = fs.readFileSync(path.join(__dirname, 'ui', JS_NAME), 'utf8');
  const js = tpl.split('__ENDPOINT__').join(o.endpoint || '');
  const block = BEGIN + '<script src="' + JS_NAME + '?v=' + encodeURIComponent(o.version || '1') + '"></script>' + END;
  const settingsText = JSON.stringify(o.settings || { confirm: true });
  const res = { patched: [], skipped: [], failed: [] };

  dirs.forEach(dir => {
    const index = path.join(dir, 'index.html');
    const html = readText(index);
    if (html === null) { res.skipped.push(dir); return; }
    try {
      // one untouched copy of the original page, kept in the plugin's own folder
      if (o.backupDir && html.indexOf(BEGIN) === -1) {
        try {
          fs.mkdirSync(o.backupDir, { recursive: true });
          const bak = path.join(o.backupDir, 'index.' + path.basename(dir) + '.orig.html');
          if (!fs.existsSync(bak)) fs.writeFileSync(bak, html);
        } catch (e) { /* the backup is a courtesy, never a reason to stop */ }
      }
      const next = insertBlock(stripBlock(html), block);
      const jsPath = path.join(dir, JS_NAME);
      if (readText(jsPath) !== js) writeFile(jsPath, js); // the script first: no 404 window
      const setPath = path.join(dir, SETTINGS_NAME);
      if (readText(setPath) !== settingsText) writeFile(setPath, settingsText);
      if (next !== html) writeFile(index, next);
      res.patched.push(dir);
    } catch (e) {
      res.failed.push({ dir: dir, error: errText(e) });
    }
  });
  return res;
}

// returns { removed: [dir], failed: [{ dir, error }] }
function remove(opts) {
  const o = opts || {};
  const dirs = o.dirs || UI_DIRS;
  const res = { removed: [], failed: [] };
  dirs.forEach(dir => {
    const index = path.join(dir, 'index.html');
    const html = readText(index);
    if (html === null) return;
    try {
      if (html.indexOf(BEGIN) !== -1) {
        writeFile(index, stripBlock(html));
        res.removed.push(dir);
      }
      removeFile(path.join(dir, JS_NAME));
      removeFile(path.join(dir, SETTINGS_NAME));
    } catch (e) {
      res.failed.push({ dir: dir, error: errText(e) });
    }
  });
  return res;
}

module.exports = { apply: apply, remove: remove, UI_DIRS: UI_DIRS, JS_NAME: JS_NAME, SETTINGS_NAME: SETTINGS_NAME, BEGIN: BEGIN, END: END };
