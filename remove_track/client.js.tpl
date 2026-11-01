(function () {
    'use strict';
    var ID = 'remove-track-btn';
    var PORT = __PORT__;
    var CONFIRM = __CONFIRM__;
    var busy = false;

    function onClick(btn) {
        if (busy) return;
        fetch('/api/v1/getstate')
            .then(function (r) { return r.json(); })
            .then(function (s) {
                if (!s || !s.uri || s.service !== 'mpd') return;
                if (CONFIRM && !window.confirm('Delete from disk?\n\n' + (s.title || s.uri))) return;
                busy = true; btn.disabled = true;
                var uri = s.uri;
                return fetch('/api/v1/commands/?cmd=next')
                    .then(function () { return new Promise(function (r) { setTimeout(r, 500); }); })
                    .then(function () {
                        return fetch('http://' + location.hostname + ':' + PORT + '/add_delete', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ path: uri })
                        });
                    })
                    .then(function (r) { if (!r.ok) console.error('RemoveTrack: HTTP ' + r.status); });
            })
            .catch(function (e) { console.error('RemoveTrack:', e); })
            .then(function () { busy = false; btn.disabled = false; });
    }

    function makeBtn() {
        var b = document.createElement('button');
        b.id = ID;
        b.textContent = 'Remove Track';
        b.style.cssText =
            'position:fixed;top:12px;right:12px;z-index:99999;' +
            'padding:8px 12px;background:#d33;color:#fff;border:0;' +
            'border-radius:4px;cursor:pointer;font-size:14px';
        b.onclick = function () { onClick(b); };
        return b;
    }

    function ensure() {
        if (!document.getElementById(ID)) document.body.appendChild(makeBtn());
    }

    new MutationObserver(ensure).observe(document.body, { childList: true, subtree: true });
    ensure();
})();
