# Volumio Remove Track

**English** · [Русский](#русский)

A Volumio plugin that adds a **Remove Track** button to the Contemporary UI. One click skips the current track and permanently deletes its file from disk, the MPD queue and database, the Volumio queue, play history, favourites and playlists.

> ⚠️ **Unofficial community plugin. Not in the Volumio plugin store, no support, no warranty. Deletion is permanent — there is no recycle bin. Use at your own risk.**

- Version: 1.0.1
- Tested target: Volumio 4.x, Contemporary UI (`/volumio/http/www3`)
- License: ISC

## What it does

On click the button:

1. Reads the URI of the currently playing track (`/api/v1/getstate`).
2. Switches to the next track, so Volumio releases the file.
3. Sends a `POST` to a small HTTP server run by the plugin.
4. The server, one request at a time:
   - removes the track from the live MPD queue;
   - removes it from Volumio's in-memory queue and from `/data/queue`, `/data/laststates.json`, `/data/playlist/*` and `/data/favourites/my-favourites`;
   - deletes the file;
   - runs `mpd update` so MPD drops it from its database.

Only files inside the **allowed folders** (default `/mnt/HDD`) can be deleted. Requests for any other path get `403`.

## ⚠️ What the installation changes in your system

Read this before installing. The plugin has to change system files, because Volumio plugins cannot add elements to the UI otherwise.

| Change | Where | Why |
|---|---|---|
| Passwordless `sudo` for `cp` and `sed` for user `volumio` | `/etc/sudoers.d/remove_track` and an `@include` line appended to `/etc/sudoers` | The plugin copies the button script and edits `index.html` via `sudo` |
| Script tag `<script src="/remove-track.js">` | `/volumio/http/www3/index.html` | Loads the button |
| Button script | `/volumio/http/www3/remove-track.js` | The button itself |

Consequences:

- **Anything running as user `volumio` can become root without a password using `cp`/`sed`.** On a default Volumio (public default password) this changes little; if you changed the password or the device is on an untrusted network, think twice.
- The plugin opens an **unauthenticated HTTP port** (default `8088`) on all interfaces with `Access-Control-Allow-Origin: *`. Any device on your network can ask it to delete files **inside the allowed folders**. Do not expose the port to the internet. Keep the allowed folders as narrow as possible.
- The install script validates `/etc/sudoers` with `visudo -c` and rolls back on error.
- Volumio updates may overwrite `index.html`: the button disappears. Disable and re-enable the plugin to restore it.

## Installation

Over SSH as user `volumio`:

```bash
mkdir ~/remove_track && cd ~/remove_track
unzip ~/remove_track.zip        # or clone this repository here
volumio plugin install
```

Then open **Plugins → Installed plugins**, enable **Remove Track**, and hard-refresh the browser (`Ctrl+Shift+R`). The red **Remove Track** button appears in the top right corner.

If you previously installed an older version, uninstall it first so the old `uninstall.sh` cleans up.

## Settings

Plugins → Installed plugins → Remove Track → Settings:

| Option | Default | Description |
|---|---|---|
| Server port | `8088` | Local HTTP port used by the button (1024–65535) |
| Allowed folders | `/mnt/HDD` | Comma-separated absolute paths. Nothing outside is ever deleted. Example: `/mnt/HDD,/mnt/NAS/Music` |
| Ask for confirmation | on | Shows a confirm dialog with the track title |

Saving restarts the server and re-installs the button.

## Verification

```bash
sudo ss -lntp | grep 8088                  # server is listening
grep remove-track /volumio/http/www3/index.html
curl -i -X OPTIONS http://localhost:8088/add_delete \
  -H 'Origin: http://volumio.local' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type'     # 204 + CORS headers
```

Test on a copy first:

```bash
sudo mkdir -p /mnt/HDD/_t && sudo cp "<some track>" /mnt/HDD/_t/a.flac
# play it, press the button, then:
ls /mnt/HDD/_t/a.flac                      # No such file
mpc playlist | grep _t                     # empty
sleep 3 && mpc listall | grep _t           # empty
```

## Troubleshooting

| Symptom | Check |
|---|---|
| No button | Plugin enabled? `grep remove-track /volumio/http/www3/index.html`; hard refresh; toggle the plugin off/on |
| Click does nothing | Browser F12 → Console/Network: CORS error or wrong port; `sudo journalctl -u volumio -f \| grep remove_track` |
| `POST 403` | Track is outside the allowed folders (check `mount \| grep HDD` and the setting) |
| `POST 500` | MPD not reachable on `127.0.0.1:6600` or file permissions; see the log |
| Plugin fails to start, "sudo: a password is required" | sudoers rule is not active: `sudo -l -U volumio`, check the `@include` line at the end of `/etc/sudoers` |
| Track returns after reboot | File is outside `/data/...` lists known to the plugin; check `sudo grep -rl '"uri"' /data` |

Logs: `journalctl -u volumio -f | grep remove_track`

## Known limitations

- Not shared with other scripts: there is no file lock with external tools that edit the MPD queue at the same time (e.g. custom timers).
- Removal from Volumio's in-memory queue uses internal core methods (`volumioGetQueue`, `volumioRemoveQueueItem`) that may change between Volumio versions.
- Only the `mpd` service is supported (local files). Streaming services are ignored.
- Contemporary UI only.

## Uninstall

Plugins → Installed plugins → Remove Track → Uninstall. The uninstall script removes the script tag, `remove-track.js`, `/etc/sudoers.d/remove_track` and the `@include` line.

If something went wrong, clean up manually:

```bash
sudo sed -i 's|<script src="/remove-track.js"></script>||' /volumio/http/www3/index.html
sudo rm -f /volumio/http/www3/remove-track.js /etc/sudoers.d/remove_track
sudo sed -i '\|@include /etc/sudoers.d/remove_track|d' /etc/sudoers
sudo visudo -c
```

## Support

None promised. Issues and pull requests are welcome, but I may not respond.

---

<a id="русский"></a>

# Volumio Remove Track — Русский

[English](#volumio-remove-track) · **Русский**

Плагин Volumio, добавляющий кнопку **Remove Track** в интерфейс Contemporary. Один клик переключает на следующий трек и **навсегда** удаляет текущий файл: с диска, из очереди и БД MPD, очереди Volumio, истории, избранного и плейлистов.

> ⚠️ **Неофициальный плагин сообщества. Его нет в магазине Volumio, поддержки и гарантий нет. Удаление необратимо — корзины нет. Используйте на свой риск.**

- Версия: 1.0.1
- Целевая платформа: Volumio 4.x, Contemporary UI (`/volumio/http/www3`)
- Лицензия: ISC

## Что делает

По клику кнопка:

1. Получает URI текущего трека (`/api/v1/getstate`).
2. Переключает на следующий, чтобы Volumio отпустил файл.
3. Отправляет `POST` на небольшой HTTP-сервер плагина.
4. Сервер, обрабатывая запросы по одному:
   - убирает трек из живой очереди MPD;
   - убирает из очереди Volumio в памяти и из `/data/queue`, `/data/laststates.json`, `/data/playlist/*`, `/data/favourites/my-favourites`;
   - удаляет файл;
   - вызывает `mpd update`, чтобы MPD убрал запись из базы.

Удалять можно только файлы внутри **разрешённых папок** (по умолчанию `/mnt/HDD`). Для остальных путей возвращается `403`.

## ⚠️ Что установка меняет в системе

Прочитайте до установки. Плагин вынужден менять системные файлы: иначе добавить элемент в интерфейс Volumio нельзя.

| Изменение | Где | Зачем |
|---|---|---|
| Беспарольный `sudo` для `cp` и `sed` пользователю `volumio` | `/etc/sudoers.d/remove_track` и строка `@include` в конце `/etc/sudoers` | Плагин копирует скрипт кнопки и правит `index.html` через `sudo` |
| Тег `<script src="/remove-track.js">` | `/volumio/http/www3/index.html` | Подгружает кнопку |
| Скрипт кнопки | `/volumio/http/www3/remove-track.js` | Сама кнопка |

Последствия:

- **Любой процесс от пользователя `volumio` может получить root без пароля через `cp`/`sed`.** На стандартном Volumio (публичный пароль по умолчанию) это почти ничего не меняет; если вы сменили пароль или устройство в недоверенной сети — подумайте.
- Плагин открывает **HTTP-порт без авторизации** (по умолчанию `8088`) на всех интерфейсах с `Access-Control-Allow-Origin: *`. Любое устройство в сети может попросить его удалить файлы **внутри разрешённых папок**. Не открывайте порт в интернет. Делайте разрешённые папки как можно уже.
- Скрипт установки проверяет `/etc/sudoers` через `visudo -c` и откатывает изменения при ошибке.
- Обновление Volumio может перезаписать `index.html`: кнопка пропадёт. Выключите и снова включите плагин, чтобы вернуть её.

## Установка

По SSH от пользователя `volumio`:

```bash
mkdir ~/remove_track && cd ~/remove_track
unzip ~/remove_track.zip        # или склонируйте сюда этот репозиторий
volumio plugin install
```

Затем **Плагины → Установленные плагины**, включите **Remove Track** и обновите страницу (`Ctrl+Shift+R`). Красная кнопка **Remove Track** появится в правом верхнем углу.

Если стояла старая версия, сначала удалите её, чтобы отработал старый `uninstall.sh`.

## Настройки

Плагины → Установленные плагины → Remove Track → Настройки:

| Параметр | По умолчанию | Описание |
|---|---|---|
| Порт сервера | `8088` | Локальный HTTP-порт кнопки (1024–65535) |
| Разрешённые папки | `/mnt/HDD` | Абсолютные пути через запятую. Вне них ничего не удаляется. Пример: `/mnt/HDD,/mnt/NAS/Music` |
| Спрашивать подтверждение | вкл. | Показывает диалог с названием трека |

После сохранения сервер перезапускается, кнопка переустанавливается.

## Проверка

```bash
sudo ss -lntp | grep 8088                  # сервер слушает
grep remove-track /volumio/http/www3/index.html
curl -i -X OPTIONS http://localhost:8088/add_delete \
  -H 'Origin: http://volumio.local' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type'     # 204 + заголовки CORS
```

Сначала проверьте на копии:

```bash
sudo mkdir -p /mnt/HDD/_t && sudo cp "<любой трек>" /mnt/HDD/_t/a.flac
# запустите его, нажмите кнопку, затем:
ls /mnt/HDD/_t/a.flac                      # No such file
mpc playlist | grep _t                     # пусто
sleep 3 && mpc listall | grep _t           # пусто
```

## Диагностика

| Симптом | Что проверить |
|---|---|
| Кнопки нет | Плагин включён? `grep remove-track /volumio/http/www3/index.html`; `Ctrl+Shift+R`; выключить/включить плагин |
| Клик ничего не делает | F12 → Console/Network: ошибка CORS или неверный порт; `sudo journalctl -u volumio -f \| grep remove_track` |
| `POST 403` | Трек вне разрешённых папок (`mount \| grep HDD` и настройка) |
| `POST 500` | MPD недоступен на `127.0.0.1:6600` или нет прав на файл; смотрите лог |
| Плагин не стартует, «sudo: a password is required» | Правило sudoers не работает: `sudo -l -U volumio`, проверьте строку `@include` в конце `/etc/sudoers` |
| Трек вернулся после перезагрузки | Он в списке, который плагин не знает; `sudo grep -rl '"uri"' /data` |

Логи: `journalctl -u volumio -f | grep remove_track`

## Известные ограничения

- Нет общего файлового лока с внешними скриптами, которые одновременно правят очередь MPD (например, свои таймеры).
- Удаление из очереди Volumio в памяти использует внутренние методы ядра (`volumioGetQueue`, `volumioRemoveQueueItem`), которые могут измениться в других версиях Volumio.
- Поддерживается только сервис `mpd` (локальные файлы). Стриминговые сервисы игнорируются.
- Только Contemporary UI.

## Удаление

Плагины → Установленные плагины → Remove Track → Удалить. Скрипт удаления убирает тег script, `remove-track.js`, `/etc/sudoers.d/remove_track` и строку `@include`.

Если что-то пошло не так, очистите вручную:

```bash
sudo sed -i 's|<script src="/remove-track.js"></script>||' /volumio/http/www3/index.html
sudo rm -f /volumio/http/www3/remove-track.js /etc/sudoers.d/remove_track
sudo sed -i '\|@include /etc/sudoers.d/remove_track|d' /etc/sudoers
sudo visudo -c
```

## Поддержка

Не обещается. Issues и pull request-ы приветствуются, но я могу не ответить.
