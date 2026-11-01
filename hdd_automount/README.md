# HDD Automount for Volumio

**English** · [Русский](#русский)

An unofficial plugin for [Volumio](https://volumio.com) that automates mounting an internal or USB drive: pick a partition from a list, mount it, make the mount permanent (`/etc/fstab`), expose it to the MPD music library and refresh the library, all from the web UI instead of SSH.

> **Status: personal project, shared as is.** It is not in the official Volumio plugin store, it is not reviewed by the Volumio team, and there is no support or warranty. Issues and pull requests are welcome, but I cannot promise a reply or a fix.

## What it does

| Step (manual equivalent) | What the plugin does |
|---|---|
| `lsblk` | Lists partitions with a filesystem and UUID. System partitions (`/boot`, `/imgpart`, `mmcblk*`, `squashfs`, swap, LVM/LUKS) are hidden. |
| `mkdir /mnt/NAME` | Creates the mount folder. |
| `mount` | Mounts the partition by **UUID** (device names like `sdb1` can change). |
| `/etc/fstab` | Adds one line tagged `# hdd_automount` with the `nofail` option, then runs `mount -a` to verify. |
| `ln -s` | Creates `/var/lib/mpd/music/NAME` → `/mnt/NAME` (optional). |
| `chmod -R 777` | Optional, **off by default**. Runs in the background. |
| `mpc update` | Runs after mounting. |

For NTFS, exFAT and FAT the mount options `uid=1000,gid=1000,umask=000` are added automatically (`chmod` has no effect on those filesystems).

## Requirements

- Volumio 3 or 4 (tested on Raspberry Pi / x86 builds with Debian buster and bookworm; your mileage may vary).
- SSH access for installation (default user `volumio`).
- A drive with a filesystem Linux can mount (ext4 recommended).

## Installation

1. Download this repository (green **Code** button → *Download ZIP*, or `git clone`) and copy the folder to Volumio:

   ```bash
   scp -r volumio-hdd-automount volumio@volumio.local:~/
   ```

2. Install it on the device:

   ```bash
   ssh volumio@volumio.local
   cd ~/volumio-hdd-automount
   volumio plugin install
   ```

3. In the Volumio UI open **Plugins → Installed plugins** and enable **HDD Automount**.
4. Open the plugin settings, choose the disk, press **Save and mount**.

## Settings

| Option | Description |
|---|---|
| Disk / partition | Partition to mount (identified by UUID). Press **Rescan disks** after plugging in a drive. |
| Mount folder name | Mounted to `/mnt/<name>`, shown in the library as `<name>`. Letters, digits, `_` and `-`, up to 32 characters. Reserved names (`INTERNAL`, `NAS`, `USB`, `UPNP`, …) are rejected. |
| Mount at boot (fstab) | Writes/removes the tagged line in `/etc/fstab`. |
| Link into MPD library | Creates/removes the symlink in `/var/lib/mpd/music`. |
| Set permissions to 777 | Runs `chmod -R 777` on the mounted disk. Off by default. |
| Also mount when the plugin starts | Mounts again on Volumio start (useful if the drive appears late). |

Buttons: **Unmount and remove from fstab**, **Update music library**, **Rescan disks**.

## Security notes — please read

- To work without a password prompt the installer adds a `sudoers` rule for the `volumio` user covering `mount`, `umount`, `mkdir`, `ln`, `rm`, `sed`, `tee` and `chmod`, stored in `/etc/sudoers.d/hdd_automount`, and appends one `#include` line to `/etc/sudoers` (it must be read *after* the stock rule, because the last matching `sudoers` rule wins). The installer validates the result with `visudo -c` and restores a backup if validation fails.
- These commands are not restricted by arguments, so in practice any code running as `volumio` can already do a lot as root. On a typical home Volumio box this is the same trust level as the default setup, but you should know it.
- `chmod -R 777` makes everything on the disk writable by everyone. Leave it off unless you need it.
- The plugin only edits `/etc/fstab` lines tagged `# hdd_automount`.

## Uninstall

Disable and uninstall the plugin in the UI. The uninstaller removes the `sudoers` rule and the `#include` line, the tagged `fstab` line and its own MPD symlink. **The disk stays mounted until reboot and will not be mounted automatically afterwards.** If you want to keep auto-mounting without the plugin, add the line to `/etc/fstab` yourself:

```
UUID=<your-uuid>  /mnt/HDD  ext4  defaults,nofail  0  2
```

## Troubleshooting

| Problem | What to do |
|---|---|
| `sudo: a password is required` | The `sudoers` rule is not in effect. Reinstall the plugin, then check with `sudo -n -u volumio sudo -n mkdir -p /tmp/t && echo OK`. |
| The disk is not in the list | Press **Rescan disks**; check `lsblk -o NAME,SIZE,FSTYPE,UUID` over SSH. Partitions without UUID or filesystem are not shown. |
| Mounted but empty library | Press **Update music library** and wait; large disks take time. |
| Boot hangs / strange behaviour | Remove the line tagged `# hdd_automount` from `/etc/fstab` (needs `sudo mount -o remount,rw /`). |
| Logs | `journalctl -u volumio -f` (look for `hdd_automount`). |

## Limitations

- One disk per plugin instance.
- Encrypted (LUKS) and LVM volumes are not supported.
- No SMB/NFS network shares (Volumio has built-in support for those).

## License

[ISC](LICENSE). Provided "as is", without warranty or support.

---

<a id="русский"></a>

# HDD Automount для Volumio

[English](#hdd-automount-for-volumio) · **Русский**

Неофициальный плагин для [Volumio](https://volumio.com), который автоматизирует подключение внутреннего или USB-диска: выбрать раздел из списка, смонтировать, сделать монтирование постоянным (`/etc/fstab`), подключить диск в библиотеку MPD и обновить её. Всё в веб-интерфейсе, без SSH.

> **Статус: личный проект, публикуется «как есть».** В официальном магазине плагинов Volumio его нет, командой Volumio он не проверялся, поддержки и гарантий нет. Issues и pull request'ы приветствуются, но ответ и исправление не обещаю.

## Что делает плагин

| Шаг (вручную) | Что делает плагин |
|---|---|
| `lsblk` | Показывает разделы с файловой системой и UUID. Системные (`/boot`, `/imgpart`, `mmcblk*`, `squashfs`, swap, LVM/LUKS) скрыты. |
| `mkdir /mnt/ИМЯ` | Создаёт папку монтирования. |
| `mount` | Монтирует раздел по **UUID** (имена вроде `sdb1` могут меняться). |
| `/etc/fstab` | Добавляет одну строку с пометкой `# hdd_automount` и опцией `nofail`, затем проверяет через `mount -a`. |
| `ln -s` | Создаёт `/var/lib/mpd/music/ИМЯ` → `/mnt/ИМЯ` (по желанию). |
| `chmod -R 777` | Необязательно, **по умолчанию выключено**. Выполняется в фоне. |
| `mpc update` | Запускается после монтирования. |

Для NTFS, exFAT и FAT автоматически добавляются опции `uid=1000,gid=1000,umask=000` (на этих файловых системах `chmod` не работает).

## Требования

- Volumio 3 или 4 (проверено на сборках для Raspberry Pi и x86 на Debian buster и bookworm; на других может отличаться).
- SSH-доступ для установки (пользователь по умолчанию `volumio`).
- Диск с файловой системой, которую Linux умеет монтировать (лучше ext4).

## Установка

1. Скачайте репозиторий (кнопка **Code** → *Download ZIP* или `git clone`) и скопируйте папку на Volumio:

   ```bash
   scp -r volumio-hdd-automount volumio@volumio.local:~/
   ```

2. Установите на устройстве:

   ```bash
   ssh volumio@volumio.local
   cd ~/volumio-hdd-automount
   volumio plugin install
   ```

3. В интерфейсе Volumio откройте **Плагины → Установленные плагины** и включите **HDD Automount**.
4. Откройте настройки плагина, выберите диск и нажмите **Сохранить и смонтировать**.

## Настройки

| Параметр | Описание |
|---|---|
| Диск / раздел | Раздел для монтирования (определяется по UUID). После подключения диска нажмите **Обновить список дисков**. |
| Имя папки монтирования | Монтируется в `/mnt/<имя>`, в библиотеке отображается как `<имя>`. Буквы, цифры, `_` и `-`, до 32 символов. Зарезервированные имена (`INTERNAL`, `NAS`, `USB`, `UPNP` и др.) отклоняются. |
| Монтировать при загрузке (fstab) | Добавляет/удаляет помеченную строку в `/etc/fstab`. |
| Симлинк в библиотеку MPD | Создаёт/удаляет симлинк в `/var/lib/mpd/music`. |
| Права 777 | Выполняет `chmod -R 777` на смонтированном диске. По умолчанию выключено. |
| Монтировать также при запуске плагина | Повторно монтирует при старте Volumio (полезно, если диск появляется поздно). |

Кнопки: **Отмонтировать и убрать из fstab**, **Обновить библиотеку**, **Обновить список дисков**.

## Безопасность — прочтите

- Чтобы команды выполнялись без запроса пароля, установщик добавляет правило `sudoers` для пользователя `volumio` на `mount`, `umount`, `mkdir`, `ln`, `rm`, `sed`, `tee` и `chmod` в файл `/etc/sudoers.d/hdd_automount` и дописывает одну строку `#include` в конец `/etc/sudoers`. Это нужно, потому что в `sudoers` побеждает последнее подходящее правило, а штатное правило пользователя читается позже файла с именем `hdd_automount`. Результат проверяется через `visudo -c`, при ошибке восстанавливается резервная копия.
- Эти команды не ограничены по аргументам, поэтому код, запущенный от `volumio`, и так может многое делать от root. На обычном домашнем Volumio это тот же уровень доверия, что и по умолчанию, но знать об этом стоит.
- `chmod -R 777` делает всё на диске доступным для записи всем. Не включайте без необходимости.
- Плагин правит в `/etc/fstab` только строки с пометкой `# hdd_automount`.

## Удаление

Отключите и удалите плагин в интерфейсе. Деинсталлятор убирает правило `sudoers` и строку `#include`, помеченную строку `fstab` и собственный симлинк MPD. **Диск остаётся смонтированным до перезагрузки и после неё автоматически не подключится.** Чтобы сохранить автомонтирование без плагина, добавьте строку в `/etc/fstab` вручную:

```
UUID=<ваш-uuid>  /mnt/HDD  ext4  defaults,nofail  0  2
```

## Решение проблем

| Проблема | Что делать |
|---|---|
| `sudo: a password is required` | Правило `sudoers` не действует. Переустановите плагин и проверьте: `sudo -n -u volumio sudo -n mkdir -p /tmp/t && echo OK`. |
| Диска нет в списке | Нажмите **Обновить список дисков**; по SSH выполните `lsblk -o NAME,SIZE,FSTYPE,UUID`. Разделы без UUID и файловой системы не показываются. |
| Диск смонтирован, а библиотека пустая | Нажмите **Обновить библиотеку** и подождите: большие диски индексируются долго. |
| Зависает загрузка / странное поведение | Удалите строку с `# hdd_automount` из `/etc/fstab` (сначала `sudo mount -o remount,rw /`). |
| Логи | `journalctl -u volumio -f` (ищите `hdd_automount`). |

## Ограничения

- Один диск на плагин.
- Шифрованные (LUKS) и LVM-тома не поддерживаются.
- Сетевые папки SMB/NFS не поддерживаются (в Volumio для них есть встроенная поддержка).

## Лицензия

[ISC](LICENSE). Предоставляется «как есть», без гарантий и поддержки.
