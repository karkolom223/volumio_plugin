'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const QUEUE = '/data/queue';
const LAST = '/data/laststates.json';
const PLAYLISTS = '/data/playlist';
const FAVOURITES = '/data/favourites/my-favourites';

function real(p) {
  const r = path.resolve(p);
  try { return fs.realpathSync(r); } catch (e) { return r; }
}

// Volumio uri ("mnt/HDD/..", "music-library/HDD/..") -> absolute real path
function uriToPath(uri) {
  let u = String(uri || '').replace(/^\/+/, '');
  if (u.indexOf('music-library/') === 0) u = 'mnt/' + u.slice('music-library/'.length);
  return real('/' + u);
}

// MPD uris are relative to /var/lib/mpd/music ("HDD/x.flac"), Volumio ones to "/"
function candidates(uri) {
  const u = String(uri || '').replace(/^\/+/, '');
  if (!u) return [];
  return [uriToPath(u), real('/mnt/' + u), real('/var/lib/mpd/music/' + u)];
}

function matches(uri, target) {
  return candidates(uri).indexOf(target) !== -1;
}

function mpd(cmd) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: '127.0.0.1', port: 6600 });
    let buf = '', greeted = false, done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      s.destroy();
      err ? reject(err) : resolve(val);
    };
    s.setTimeout(5000, () => finish(new Error('MPD timeout')));
    s.on('error', finish);
    s.on('data', d => {
      buf += d.toString('utf8');
      if (!greeted) {
        const i = buf.indexOf('\n');
        if (i < 0) return;
        greeted = true;
        buf = buf.slice(i + 1);
        s.write(cmd + '\n');
      }
      if (greeted && /(^|\n)(OK|ACK[^\n]*)\n$/.test(buf)) finish(null, buf);
    });
  });
}

async function cleanMpdQueue(target) {
  const out = await mpd('playlistinfo');
  const positions = [];
  let uri = null;
  out.split('\n').forEach(line => {
    if (line.indexOf('file: ') === 0) uri = line.slice(6);
    else if (line.indexOf('Pos: ') === 0 && uri !== null) {
      if (matches(uri, target)) positions.push(parseInt(line.slice(5), 10));
      uri = null;
    }
  });
  positions.sort((a, b) => b - a);
  for (const p of positions) await mpd('delete ' + p);
}

function cleanJsonList(file, target) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return; }
  if (!Array.isArray(data)) return;
  const kept = data.filter(x => !(x && typeof x === 'object' && x.uri && matches(x.uri, target)));
  if (kept.length === data.length) return;
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(kept, null, 2));
    const fd = fs.openSync(tmp, 'r');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}

function cleanVolumioFiles(target) {
  const files = [QUEUE, LAST, FAVOURITES];
  try {
    fs.readdirSync(PLAYLISTS).forEach(n => { if (!/\.tmp$/.test(n)) files.push(path.join(PLAYLISTS, n)); });
  } catch (e) { /* no playlists */ }
  files.forEach(f => cleanJsonList(f, target));
}

/**
 * opts: { port, roots[], hook(matcherFn) -> optional, log(msg) }
 */
function create(opts) {
  const roots = opts.roots.map(real);
  const log = opts.log || function () {};
  let chain = Promise.resolve();
  const enqueue = fn => { const r = chain.then(fn); chain = r.catch(() => {}); return r; };

  const allowed = p => roots.some(r => p === r || p.indexOf(r + '/') === 0);

  async function remove(rawPath) {
    const target = uriToPath(rawPath);
    if (!allowed(target)) return 403;
    if (opts.hook) {
      try { await opts.hook(uri => matches(uri, target)); } catch (e) { log('hook: ' + e.message); }
    }
    await cleanMpdQueue(target);
    cleanVolumioFiles(target);
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      fs.unlinkSync(target);
      await mpd('update');
    }
    log('deleted ' + target);
    return 200;
  }

  const server = http.createServer((req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end(body || '');
    };
    if (req.method === 'OPTIONS') return reply(204);
    if (req.method === 'GET') return reply(200, 'ok\n');
    if (req.method !== 'POST') return reply(405);

    let body = '';
    req.on('data', c => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      let p;
      try { p = JSON.parse(body || '{}').path; } catch (e) { return reply(400); }
      if (!p) return reply(400);
      enqueue(() => remove(p))
        .then(code => reply(code, code === 200 ? 'deleted\n' : ''))
        .catch(e => { log('error: ' + e.message); reply(500); });
    });
  });

  return {
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port, '0.0.0.0', resolve);
    }),
    stop: () => new Promise(resolve => server.close(() => resolve()))
  };
}

module.exports = { create, uriToPath, matches };
