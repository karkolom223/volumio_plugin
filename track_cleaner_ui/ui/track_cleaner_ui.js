/* Track Cleaner UI: a delete icon to the right of the Volumio search field.
   Added to the Volumio interface by the track_cleaner_ui plugin, removed when the plugin stops. */
(function () {
  'use strict';
  if (window.__trackCleanerUi) return;
  window.__trackCleanerUi = true;

  var ENDPOINT = '__ENDPOINT__';
  var SELF_SRC = (document.currentScript && document.currentScript.src) || '';
  var SETTINGS_URL = SELF_SRC ? SELF_SRC.replace(/track_cleaner_ui\.js.*$/, 'track_cleaner_ui.json') : 'track_cleaner_ui.json';
  var settings = { confirm: true }; // until the plugin's settings file has been read: ask, to be safe
  var SIZE = 40;
  var GAP = 8;
  var SHIFT = SIZE + GAP;

  var TEXT = {
    en: {
      file: 'Delete the playing file from disk',
      station: 'Block the playing station',
      none: 'Nothing to delete: play a music file or a web radio station',
      confirm: 'Delete this file from disk?\n\n{title}',
      offline: 'No connection to Volumio yet, try again in a moment.'
    },
    ru: {
      file: 'Удалить играющий файл с диска',
      station: 'Заблокировать играющую станцию',
      none: 'Нечего удалять: включите музыкальный файл или станцию веб-радио',
      confirm: 'Удалить этот файл с диска?\n\n{title}',
      offline: 'Нет связи с Volumio, попробуйте ещё раз через пару секунд.'
    },
    uk: {
      file: 'Видалити файл, що грає, з диска',
      station: 'Заблокувати станцію, що грає',
      none: 'Нічого видаляти: увімкніть музичний файл або станцію веб-радіо',
      confirm: 'Видалити цей файл з диска?\n\n{title}',
      offline: 'Немає зв’язку з Volumio, спробуйте ще раз за кілька секунд.'
    }
  };
  var lang = String(navigator.language || 'en').slice(0, 2).toLowerCase();
  var T = TEXT[lang] || TEXT.en;

  var state = {};
  var socket = null;
  var btn = null;
  var busy = false;
  var shifted = null;

  // ---------- settings written by the plugin (confirmation on / off) ----------

  function loadSettings() {
    try {
      fetch(SETTINGS_URL + '?t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j) return;
          if (typeof j.confirm === 'boolean') settings.confirm = j.confirm;
          // the language of the Volumio interface, not of the browser: the plugin writes it
          if (j.lang && TEXT[j.lang] && j.lang !== lang) { lang = j.lang; T = TEXT[lang]; refresh(); }
        })
        .catch(function () { /* keep the last known value */ });
    } catch (e) { /* old browser: keep asking */ }
  }

  // ---------- playback state: own socket, the interface's own one is not touched ----------

  function mode() {
    if (state.service === 'webradio') return 'station';
    if (state.service === 'mpd') return 'file';
    return 'none';
  }

  function refresh() {
    if (!btn) return;
    var m = mode();
    var tip = m === 'file' ? T.file : (m === 'station' ? T.station : T.none);
    btn.title = tip;
    btn.setAttribute('aria-label', tip);
    btn.style.opacity = m === 'none' ? '0.55' : '1';
  }

  function connect() {
    var make = function () {
      try {
        socket = window.io(window.location.origin, { forceNew: true });
        socket.on('connect', function () { socket.emit('getState'); });
        socket.on('pushState', function (s) { state = s || {}; refresh(); });
      } catch (e) {
        if (window.console) console.warn('[track_cleaner_ui] socket failed', e);
      }
    };
    if (window.io) { make(); return; }
    var s = document.createElement('script');
    s.src = '/socket.io/socket.io.js';
    s.onload = make;
    s.onerror = function () { if (window.console) console.warn('[track_cleaner_ui] socket.io client not found'); };
    document.head.appendChild(s);
  }

  // ---------- the button ----------

  function onClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    if (busy) return;
    if (!socket || !socket.connected) { window.alert(T.offline); return; }
    var m = mode();
    if (m === 'file' && settings.confirm) {
      var name = state.title || state.uri || '';
      if (!window.confirm(T.confirm.replace('{title}', name))) return;
    }
    busy = true;
    btn.disabled = true;
    flash(); // instant feedback: the answer from Volumio follows as a message
    // the plugin decides: web radio -> block the station, music file -> delete the file;
    // the answer comes as a normal Volumio toast message
    socket.emit('callMethod', { endpoint: ENDPOINT, method: 'removeOrBlock', data: '' });
    // a file is deleted for good: the next click must not hit the next track by accident
    setTimeout(function () { busy = false; btn.disabled = false; }, m === 'file' ? 1500 : 700);
  }

  function flash() {
    btn.classList.remove('tcui-flash');
    void btn.offsetWidth; // restart the animation
    btn.classList.add('tcui-flash');
  }

  function ensureButton() {
    if (btn && document.body.contains(btn)) return;
    var css = document.createElement('style');
    css.textContent =
      '#track-cleaner-ui-btn{position:fixed;z-index:1000;width:' + SIZE + 'px;height:' + SIZE + 'px;' +
      'padding:0;margin:0;border:0;border-radius:6px;background:#db3737;color:#fff;' +
      'cursor:pointer;display:flex;align-items:center;justify-content:center;outline:none;' +
      'box-shadow:0 1px 4px rgba(0,0,0,.5);transition:background .15s,opacity .15s,transform .1s}' +
      '#track-cleaner-ui-btn i{display:block;font-size:20px;line-height:1;color:#fff}' +
      '#track-cleaner-ui-btn:hover{background:#ea4b4b}' +
      '#track-cleaner-ui-btn:active{background:#c42d2d;transform:scale(.94)}' +
      '#track-cleaner-ui-btn:disabled{cursor:default}' +
      '#track-cleaner-ui-btn.tcui-flash{animation:tcui-flash .6s ease-out}' +
      '@keyframes tcui-flash{0%{transform:scale(.85);background:#ff6b6b}60%{transform:scale(1.06)}100%{transform:scale(1)}}';
    document.head.appendChild(css);
    btn = document.createElement('button');
    btn.id = 'track-cleaner-ui-btn';
    btn.type = 'button';
    // Volumio's own bin glyph (FontAwesome fa-trash, the one in its "Remove from playlist" menu)
    // in white on a solid red tile
    btn.innerHTML = '<i class="fa fa-trash" aria-hidden="true"></i>';
    btn.addEventListener('click', onClick);
    document.body.appendChild(btn);
    refresh();
  }

  // ---------- placement: right of the search field ----------

  function findSearch() {
    var inputs = document.querySelectorAll('input');
    var best = null;
    var bestRight = -1;
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var hint = (el.getAttribute('placeholder') || '') + ' ' + (el.id || '') + ' ' + (el.className || '') + ' ' + (el.name || '');
      if (el.type !== 'search' && !/search|поиск|пошук|recherche|suche|busca|ricerca/i.test(hint)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 10 || r.top > 160) continue; // hidden, or not in the top bar
      if (r.right > bestRight) { best = el; bestRight = r.right; }
    }
    return best;
  }

  // the outermost element that is still just the search field (input plus its wrapper)
  function blockOf(input) {
    var el = input;
    var ir = input.getBoundingClientRect();
    while (el.parentElement && el.parentElement !== document.body && el.parentElement !== document.documentElement) {
      var pr = el.parentElement.getBoundingClientRect();
      if (pr.width > ir.width + 80 || pr.height > ir.height + 40) break;
      el = el.parentElement;
    }
    return el;
  }

  // moves the search field to the left to make room, without touching the page layout
  function shift(el) {
    if ('translate' in document.documentElement.style) {
      el.style.translate = '-' + SHIFT + 'px 0';
    } else {
      el.style.transform = (el.style.transform ? el.style.transform + ' ' : '') + 'translateX(-' + SHIFT + 'px)';
    }
  }

  function unshift(el) {
    if (!el) return;
    if ('translate' in document.documentElement.style) el.style.translate = '';
    else el.style.transform = String(el.style.transform || '').replace(/\s*translateX\(-\d+px\)/, '');
  }

  function place() {
    if (document.hidden && btn) return; // nothing to lay out in a background tab
    ensureButton();
    var input = findSearch();
    if (!input) {
      unshift(shifted);
      shifted = null;
      btn.style.left = 'auto';
      btn.style.right = '12px';
      btn.style.top = '14px';
      return;
    }
    var block = blockOf(input);
    if (shifted !== block) {
      unshift(shifted);
      shift(block);
      shifted = block;
    }
    var r = input.getBoundingClientRect(); // measured after the shift
    var left = Math.min(r.right + GAP, window.innerWidth - SIZE - 2);
    btn.style.right = 'auto';
    btn.style.left = Math.round(left) + 'px';
    btn.style.top = Math.round(r.top + (r.height - SIZE) / 2) + 'px';
  }

  function start() {
    place();
    setInterval(place, 1000);
    window.addEventListener('resize', place);
    loadSettings();
    setInterval(loadSettings, 20000);
    window.addEventListener('focus', loadSettings);
    setTimeout(connect, 150);
  }

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', function () { setTimeout(start, 100); });
})();
