#!/bin/bash
# uninstall.sh запускается от root — sed и rm работают напрямую, без sudo.

# 1. Удалить UI-хук (пока sudoers ещё на месте, но здесь это неважно — мы root)
sed -i 's|<script src="/remove-track.js"></script>||' /volumio/http/www3/index.html 2>/dev/null
rm -f /volumio/http/www3/remove-track.js

# 2. Удалить sudoers-файл и @include из /etc/sudoers
SUDO_FILE=/etc/sudoers.d/remove_track
SUDOERS=/etc/sudoers
rm -f "$SUDO_FILE"
if grep -qF "@include $SUDO_FILE" "$SUDOERS"; then
    sed -i "\|@include $SUDO_FILE|d" "$SUDOERS"
fi

echo "pluginuninstallend"