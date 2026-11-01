'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var exec = require('child_process').exec;
var vconf = require('v-conf');

module.exports = ControllerHddAutomount;

var MARK = '# hdd_automount';
var SYSTEM_MOUNTS = ['/', '/boot', '/boot/efi', '/imgpart', '/data', '/static'];
var SAFE_NAME = /^[A-Za-z0-9_-]{1,32}$/;
var SAFE_UUID = /^[A-Za-z0-9-]{4,64}$/;

function ControllerHddAutomount(context) {
    this.context = context;
    this.commandRouter = context.coreCommand;
    this.logger = context.logger;
}

ControllerHddAutomount.prototype.onVolumioStart = function () {
    var f = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
    this.config = new vconf();
    this.config.loadFile(f);
    return libQ.resolve();
};

ControllerHddAutomount.prototype.onStart = function () {
    var self = this;
    var defer = libQ.defer();
    if (self.config.get('mount_on_start') && self.config.get('device')) {
        self.doMount().then(function () { defer.resolve(); })
            .fail(function (e) { self.logger.error('hdd_automount: ' + e.message); defer.resolve(); });
    } else {
        defer.resolve();
    }
    return defer.promise;
};

ControllerHddAutomount.prototype.onStop = function () { return libQ.resolve(); };
ControllerHddAutomount.prototype.onRestart = function () { return libQ.resolve(); };
ControllerHddAutomount.prototype.getConfigurationFiles = function () { return ['config.json']; };

ControllerHddAutomount.prototype.tr = function (key) {
    var lang = this.commandRouter.sharedVars.get('language_code');
    var load = function (l) {
        try { return fs.readJsonSync(__dirname + '/i18n/strings_' + l + '.json'); } catch (e) { return {}; }
    };
    return load(lang)[key] || load('en')[key] || key;
};

ControllerHddAutomount.prototype.run = function (cmd) {
    var self = this;
    var defer = libQ.defer();
    exec(cmd, { maxBuffer: 1024 * 1024 * 8 }, function (err, stdout, stderr) {
        if (err) {
            var msg = (stderr || err.message || '').toString().trim();
            self.logger.error('hdd_automount: FAILED: ' + cmd + ' -> ' + msg);
            defer.reject(new Error(msg));
        } else {
            defer.resolve(stdout.toString());
        }
    });
    return defer.promise;
};

ControllerHddAutomount.prototype.mountPoint = function () {
    return '/mnt/' + this.config.get('mount_name');
};

ControllerHddAutomount.prototype.toast = function (type, key, extra) {
    this.commandRouter.pushToastMessage(type, 'HDD Automount', this.tr(key) + (extra ? ': ' + extra : ''));
};

ControllerHddAutomount.prototype.listDisks = function () {
    var self = this;
    var defer = libQ.defer();
    exec('/bin/lsblk -J -o NAME,SIZE,FSTYPE,LABEL,UUID,MOUNTPOINT,TYPE', function (err, stdout) {
        if (err) return defer.resolve([]);
        var out = [];
        function walk(nodes) {
            (nodes || []).forEach(function (n) {
                var skip = !n.fstype || !n.uuid ||
                    /^(loop|mmcblk|ram|zram)/.test(n.name) ||
                    ['swap','squashfs','LVM2_member','crypto_LUKS'].indexOf(n.fstype) !== -1 ||
                    (n.mountpoint && SYSTEM_MOUNTS.indexOf(n.mountpoint) !== -1);
                if (!skip) out.push(n);
                walk(n.children);
            });
        }
        try { walk(JSON.parse(stdout).blockdevices); } catch (e) { self.logger.error(e.message); }
        defer.resolve(out);
    });
    return defer.promise;
};

ControllerHddAutomount.prototype.findDevice = function (uuid) {
    return this.listDisks().then(function (list) {
        return list.filter(function (d) { return d.uuid === uuid; })[0];
    });
};

ControllerHddAutomount.prototype.getUIConfig = function () {
    var self = this;
    var defer = libQ.defer();
    var lang = self.commandRouter.sharedVars.get('language_code');
    var dir = __dirname + '/i18n/';
    self.commandRouter.i18nJson(dir + 'strings_' + lang + '.json', dir + 'strings_en.json', __dirname + '/UIConfig.json')
        .then(function (ui) {
            return self.listDisks().then(function (disks) {
                var current = self.config.get('device');
                var opts = disks.map(function (d) {
                    return { value: d.uuid, label: '/dev/' + d.name + ' · ' + d.size + ' · ' + d.fstype + ' · ' + (d.label || '—') };
                });
                var sel = opts.filter(function (o) { return o.value === current; })[0] || opts[0] || { value: '', label: '' };
                var disk = ui.sections[1].content;
                disk[0].options = opts;
                disk[0].value = sel;
                disk[1].value = self.config.get('mount_name');
                disk[2].value = self.config.get('persistent');
                disk[3].value = self.config.get('link_mpd');
                disk[4].value = self.config.get('set_perms');
                disk[5].value = self.config.get('mount_on_start');
                return self.run('/bin/findmnt -n -M ' + self.mountPoint()).then(
                    function (o) { return 'Mounted: ' + o.trim(); },
                    function () { return 'Not mounted: ' + self.mountPoint(); }
                ).then(function (txt) { ui.sections[0].description = txt; defer.resolve(ui); });
            });
        })
        .fail(function (e) { self.logger.error(e.message); defer.reject(new Error()); });
    return defer.promise;
};

ControllerHddAutomount.prototype.refreshUI = function () {
    var self = this;
    return self.getUIConfig().then(function (ui) { self.commandRouter.broadcastMessage('pushUiConfig', ui); });
};

ControllerHddAutomount.prototype.saveConfig = function (data) {
    var self = this;
    var uuid = data.device && data.device.value;
    var name = (data.mount_name || '').trim();
    if (!uuid || !SAFE_UUID.test(uuid)) { self.toast('error', 'NO_DISK'); return libQ.resolve(); }
    if (!SAFE_NAME.test(name)) { self.toast('error', 'BAD_NAME'); return libQ.resolve(); }
    self.config.set('device', uuid);
    self.config.set('mount_name', name);
    ['persistent', 'link_mpd', 'set_perms', 'mount_on_start'].forEach(function (k) {
        self.config.set(k, !!data[k]);
    });
    return self.doMount().then(function () {
        self.toast('success', 'MOUNTED', self.mountPoint());
        return self.refreshUI();
    }).fail(function (e) { self.toast('error', 'ERROR', e.message); });
};

ControllerHddAutomount.prototype.doMount = function () {
    var self = this;
    var uuid = self.config.get('device');
    var name = self.config.get('mount_name');
    var mp = '/mnt/' + name;
    var link = '/var/lib/mpd/music/' + name;

    if (!SAFE_UUID.test(uuid) || !SAFE_NAME.test(name)) return libQ.reject(new Error('Invalid settings'));

    return self.findDevice(uuid).then(function (dev) {
        if (!dev) throw new Error('Disk with UUID ' + uuid + ' not found');

        var fstype = (dev.fstype || 'ext4').replace(/[^A-Za-z0-9_]/g, '');
        var opts = 'defaults,nofail';
        if (['ntfs', 'ntfs3', 'exfat', 'vfat'].indexOf(fstype) !== -1) opts += ',uid=1000,gid=1000,umask=000';

        var steps = libQ.resolve();
        var seq = function (c) { steps = steps.then(function () { return self.run(c); }); };

        seq('/usr/bin/sudo -n /bin/mkdir -p ' + mp);
        seq('/bin/findmnt -n -M ' + mp + ' >/dev/null 2>&1 || /usr/bin/sudo -n /bin/mount -o ' + opts + ' UUID=' + uuid + ' ' + mp);
        seq('/usr/bin/sudo -n /bin/mount -o remount,rw / || true');
        seq('/usr/bin/sudo -n /bin/sed -i "/' + MARK + '/d" /etc/fstab');
        if (self.config.get('persistent')) {
            seq('echo "UUID=' + uuid + '  ' + mp + '  ' + fstype + '  ' + opts + '  0  2  ' + MARK +
                '" | /usr/bin/sudo -n /usr/bin/tee -a /etc/fstab >/dev/null');
        }
        seq('/usr/bin/sudo -n /bin/mount -a');
        if (self.config.get('link_mpd')) {
            seq('/usr/bin/sudo -n /bin/ln -sfn ' + mp + ' ' + link);
        } else {
            seq('[ -L ' + link + ' ] && /usr/bin/sudo -n /bin/rm ' + link + ' || true');
        }
        return steps.then(function () {
            if (self.config.get('set_perms')) {
                self.run('/usr/bin/sudo -n /bin/chmod -R 777 ' + mp)
                    .fail(function (e) { self.logger.error('chmod: ' + e.message); });
            }
            self.run('/usr/bin/mpc update').fail(function () {});
        });
    });
};

ControllerHddAutomount.prototype.unmountNow = function () {
    var self = this;
    var name = self.config.get('mount_name');
    if (!SAFE_NAME.test(name)) return libQ.resolve();
    var mp = '/mnt/' + name;
    return self.run('/usr/bin/sudo -n /bin/mount -o remount,rw / || true')
        .then(function () { return self.run('/usr/bin/sudo -n /bin/sed -i "/' + MARK + '/d" /etc/fstab'); })
        .then(function () { return self.run('[ -L /var/lib/mpd/music/' + name + ' ] && /usr/bin/sudo -n /bin/rm /var/lib/mpd/music/' + name + ' || true'); })
        .then(function () { return self.run('/bin/findmnt -n -M ' + mp + ' >/dev/null 2>&1 && /usr/bin/sudo -n /bin/umount ' + mp + ' || true'); })
        .then(function () { return self.run('/usr/bin/mpc update'); })
        .then(function () { self.toast('success', 'UNMOUNTED', mp); return self.refreshUI(); })
        .fail(function (e) { self.toast('error', 'ERROR', e.message); });
};

ControllerHddAutomount.prototype.updateLibrary = function () {
    var self = this;
    return self.run('/usr/bin/mpc update')
        .then(function () { self.toast('success', 'LIB_UPDATING'); })
        .fail(function (e) { self.toast('error', 'ERROR', e.message); });
};