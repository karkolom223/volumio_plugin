#!/bin/bash
SUDO_FILE=/etc/sudoers.d/hdd_automount
SUDOERS=/etc/sudoers

# Удаляем файл правила
rm -f "$SUDO_FILE"

# Удаляем строку @include из /etc/sudoers
if grep -qF "@include $SUDO_FILE" "$SUDOERS"; then
    sed -i "\|@include $SUDO_FILE|d" "$SUDOERS"
fi

# Остальная очистка
rm -f /etc/sudoers.d/hdd_automount /etc/sudoers.d/hdd_automount_helper /etc/sudoers.d/hdd_automount_extra
rm -f /usr/local/sbin/hdd_automount_helper

[ -f /etc/fstab ] && sed -i '/hdd_automount/d' /etc/fstab

for l in /var/lib/mpd/music/*; do
    [ -L "$l" ] && [ ! -e "$l" ] && rm -f "$l"
done

echo "pluginuninstallend"