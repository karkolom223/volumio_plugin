#!/bin/bash
# install.sh запускается от root.

SUDO_FILE=/etc/sudoers.d/hdd_automount
SUDOERS=/etc/sudoers

# 1. Создаём файл с правилом (нормальное имя)
echo "volumio ALL=(ALL) NOPASSWD: /bin/mkdir, /usr/bin/mkdir, /bin/sed, /usr/bin/sed" > "$SUDO_FILE"
chmod 0440 "$SUDO_FILE"
chown root:root "$SUDO_FILE"

# 2. Гарантируем, что этот файл читается ПОСЛЕ @includedir.
#    Добавляем @include в конец /etc/sudoers, если его там ещё нет.
if ! grep -qF "@include $SUDO_FILE" "$SUDOERS"; then
    echo "@include $SUDO_FILE" >> "$SUDOERS"
fi

echo "plugininstallend"