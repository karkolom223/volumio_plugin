**Файл 2: `README.ru.md` (Русский)**
```markdown
# Неофициальные плагины для Volumio

[🇬🇧 English](README.md) | [🇷🇺 Русский](README.ru.md)

Этот репозиторий содержит неофициальные плагины для Volumio, созданные сообществом.

## Доступные плагины:

1. **HDD Automount** — Автоматическое монтирование внутренних и USB дисков, создание симлинков и обновление библиотеки MPD.
2. **Remove Track** — Добавляет кнопку удаления трека в интерфейс (удаляет из плейлиста, базы и с диска).
3. **Track Preparer** — Подготовка музыки (нарезка CUE, обрезка тишины, обложки, ReplayGain, объединение многодисковых альбомов).

---

## Инструкция по установке (через SSH)

Поскольку плагины неофициальные, установка производится вручную через терминал.

1. Подключитесь к вашему Volumio по SSH (логин и пароль по умолчанию: `volumio`).
2. Выполните следующие команды по одной:

```bash
# Клонируем репозиторий (только в первый раз)
git clone https://github.com/karkolom223/volumio.git

cd volumio/hdd_automount
volumio plugin install

cd volumio/remove_track
volumio plugin install

cd volumio/track_preparer
volumio plugin install
