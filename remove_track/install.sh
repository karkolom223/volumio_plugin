#!/bin/bash
# install.sh запускается от root.
# Добавляем в sudoers команды, которых нет в volumio-user: /bin/cp и /bin/sed.
# /bin/rm уже есть в NOPASSWD volumio-user — не трогаем.

SUDO_FILE=/etc/sudoers.d/remove_track
SUDOERS=/etc/sudoers

echo "volumio ALL=(ALL) NOPASSWD: /bin/cp, /usr/bin/cp, /bin/sed, /usr/bin/sed" > "$SUDO_FILE"
chmod 0440 "$SUDO_FILE"
chown root:root "$SUDO_FILE"

# ВАЖНО: файл должен читаться ПОСЛЕ @includedir /etc/sudoers.d,
# потому что volumio-user содержит общее "volumio ALL=(ALL) ALL" (требует пароль),
# и оно перекрывает NOPASSWD, если наш файл читается раньше.
# @include в конце /etc/sudoers гарантирует порядок независимо от имени файла.
if ! grep -qF "@include $SUDO_FILE" "$SUDOERS"; then
    echo "@include $SUDO_FILE" >> "$SUDOERS"
fi

echo "plugininstallend"