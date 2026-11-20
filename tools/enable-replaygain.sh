#!/bin/bash
#
# enable-replaygain.sh — включает ReplayGain в MPD на Volumio 4.
#
# Track Preparer записывает теги ReplayGain, но MPD их не использует, пока
# ReplayGain не включён в конфиге. Volumio пересобирает /etc/mpd.conf из шаблона
# /volumio/app/plugins/music_service/mpd/mpd.conf.tmpl, поэтому править нужно шаблон.
#
#   sudo bash tools/enable-replaygain.sh             включить (−8 дБ для радио)
#   sudo bash tools/enable-replaygain.sh --preamp -7 другой уровень для потоков без тегов
#   sudo bash tools/enable-replaygain.sh --dry-run   только показать, что изменится
#   sudo bash tools/enable-replaygain.sh --restore   вернуть последний бэкап шаблона
#
# Каждый запуск делает резервную копию шаблона рядом с ним: mpd.conf.tmpl.bak.ГГГГММДД-ЧЧММСС
#
set -euo pipefail

TPL="${TPL:-/volumio/app/plugins/music_service/mpd/mpd.conf.tmpl}"
PREAMP="-8"
MODE="apply"

while [ $# -gt 0 ]; do
  case "$1" in
    --preamp)  PREAMP="${2:?нужно число, например -8}"; shift 2 ;;
    --dry-run) MODE="dry"; shift ;;
    --restore) MODE="restore"; shift ;;
    -h|--help) sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "неизвестный ключ: $1 (см. --help)"; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }

[ "$MODE" = "dry" ] || [ "$(id -u)" -eq 0 ] || {
  say "нужен root: sudo bash $0 $*"
  exit 1
}

[ -f "$TPL" ] || { say "не найден шаблон MPD: $TPL"; exit 1; }

# Начиная с 1.12.0 сам плагин добавляет эти строки через MPD-плагин Volumio
# (registerConfigCallback). Если он это уже делает, правка шаблона даст дубль
# директив, и MPD не запустится.
if grep -q 'track_preparer plugin: ReplayGain' /etc/mpd.conf 2>/dev/null; then
  say "Track Preparer уже управляет ReplayGain через MPD-плагин (маркер в /etc/mpd.conf)."
  say "Ничего не меняю: включите или выключите тумблер в настройках плагина."
  exit 1
fi

# ---------- restore ----------
if [ "$MODE" = "restore" ]; then
  LAST=$(ls -1t "$TPL".bak.* 2>/dev/null | head -1 || true)
  [ -n "$LAST" ] || { say "бэкапов нет: $TPL.bak.*"; exit 1; }
  cp -p "$LAST" "$TPL"
  say "восстановлен $LAST"
  systemctl restart volumio || true
  say "Volumio перезапущен, проверь: grep replaygain /etc/mpd.conf"
  exit 0
fi

if [ "$MODE" != "dry" ]; then
  BK="$TPL.bak.$(date +%Y%m%d-%H%M%S)"
  cp -p "$TPL" "$BK"
  say "резервная копия шаблона: $BK"
fi

# ---------- edit template ----------
python3 - "$TPL" "$PREAMP" "$MODE" <<'PY'
import re, sys

tpl, preamp, mode = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(tpl, encoding='utf-8').read().splitlines(True)

block = [
    'replaygain                      "track"\n',
    'replaygain_preamp               "0"\n',
    'replaygain_missing_preamp       "%s"\n' % preamp,
    'replaygain_limit                "yes"\n',
]

# строки, которые заменяем целиком (в шаблоне они закомментированы или заданы иначе)
pat = re.compile(r'^\s*#?\s*replaygain(?:_preamp|_missing_preamp|_limit)?\s')
hits = [i for i, l in enumerate(lines) if pat.match(l)]

if hits:
    out, inserted = [], False
    for i, l in enumerate(lines):
        if i in hits:
            if not inserted:
                out.extend(block)
                inserted = True
            continue
        out.append(l)
    where = 'на место старых строк replaygain (строка %d)' % (hits[0] + 1)
else:
    # вставляем перед volume_normalization, если он есть, иначе перед audio_output
    anchor = next((i for i, l in enumerate(lines)
                   if re.match(r'^\s*#?\s*volume_normalization\b', l)), None)
    if anchor is None:
        anchor = next((i for i, l in enumerate(lines)
                       if re.match(r'^\s*audio_output\b', l)), None)
    if anchor is None:
        anchor = len(lines)
    out = lines[:anchor] + block + lines[anchor:]
    where = 'перед строкой %d' % (anchor + 1)

new = ''.join(out)
old = ''.join(lines)
if new == old:
    print('шаблон уже настроен так же — менять нечего')
    sys.exit(0)

if mode == 'dry':
    import difflib
    sys.stdout.writelines(difflib.unified_diff(
        old.splitlines(True), new.splitlines(True),
        fromfile=tpl, tofile=tpl + ' (после правки)'))
    print('\nэто проверка, файл не изменён')
    sys.exit(0)

open(tpl, 'w', encoding='utf-8').write(new)
print('добавлено в шаблон (%s):' % where)
print(''.join('    ' + l for l in block))
PY

if [ "$MODE" = "dry" ]; then
  exit 0
fi

# ---------- rebuild and verify ----------
if [ "${SKIP_RESTART:-0}" = "1" ]; then
  say "SKIP_RESTART=1 — перезапуск Volumio пропущен"
else
  say "пересобираю /etc/mpd.conf: перезапуск Volumio (это занимает ~15 секунд)"
  systemctl restart volumio || say "ВНИМАНИЕ: не удалось перезапустить Volumio, перезапусти вручную"
fi

for _ in $(seq 1 20); do
  grep -q '^replaygain' /etc/mpd.conf 2>/dev/null && break
  sleep 1
done

say ""
if grep -q '^replaygain' /etc/mpd.conf 2>/dev/null; then
  say "готово, рабочий конфиг:"
  grep -n '^replaygain' /etc/mpd.conf | sed 's/^/    /'
  say ""
  say "Проверить в плеере: включи трек и веб-радио — уровень должен быть похожим."
else
  say "в /etc/mpd.conf строк replaygain нет."
  say "Проверь, что Volumio перезапустился, и снова: grep replaygain /etc/mpd.conf"
  say "Вернуть как было: sudo bash $0 --restore"
  exit 1
fi
