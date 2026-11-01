#!/bin/sh
# Track Preparer — установка зависимостей. Запускается Volumio от root.
PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
export DEBIAN_FRONTEND=noninteractive

echo "Installing Track Preparer dependencies..."

have_cmd() { command -v "$1" >/dev/null 2>&1; }
have_py()  { python3 -c "import $1" >/dev/null 2>&1; }

NEED_UPDATE=0
{ have_cmd python3 && have_cmd ffmpeg && have_cmd ffprobe && have_cmd metaflac \
  && have_py PIL && have_py mutagen; } || NEED_UPDATE=1
[ "$NEED_UPDATE" = "1" ] && { apt-get update || echo "WARNING: apt-get update failed, trying anyway"; }

FAILED=""
install_pkg() {  # install_pkg <package>
    apt-get install -y --no-install-recommends "$1" || FAILED="$FAILED $1"
}

have_cmd python3                      || install_pkg python3
have_py PIL                           || install_pkg python3-pil
have_py mutagen                       || install_pkg python3-mutagen
{ have_cmd ffmpeg && have_cmd ffprobe; } || install_pkg ffmpeg
have_cmd metaflac                     || install_pkg flac

if [ -n "$FAILED" ]; then
    echo "ERROR: required packages could not be installed:$FAILED"
    exit 1
fi

# Необязательно: shnsplit (если нет — нарезка идёт через ffmpeg)
have_cmd shnsplit || apt-get install -y --no-install-recommends shntool \
    || echo "NOTE: shntool not available, CUE splitting will use ffmpeg"

# Необязательно: распаковка настоящих ISO-образов (zip распаковывается средствами Python)
{ have_cmd 7z || have_cmd 7za || have_cmd bsdtar; } || apt-get install -y --no-install-recommends p7zip-full \
    || echo "NOTE: p7zip not available, real .iso images will not be unpacked"

PYV="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
echo "Python $PYV, ffmpeg: $(ffmpeg -version 2>/dev/null | head -n 1)"

mkdir -p "$PLUGIN_DIR/log"
chown -R volumio:volumio "$PLUGIN_DIR/log" 2>/dev/null
if [ -d /mnt/HDD ]; then
    mkdir -p /mnt/HDD/in/music /mnt/HDD/out/music
    chown -R volumio:volumio /mnt/HDD/in /mnt/HDD/out 2>/dev/null
else
    echo "WARNING: /mnt/HDD not found. Mount the disk; folders will be created when the plugin starts."
fi
chmod +x "$PLUGIN_DIR"/bin/*.py

echo "plugininstallend"
