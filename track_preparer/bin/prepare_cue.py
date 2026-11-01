#!/usr/bin/env python3
# prepare_cue.py <dir|file.cue>
# CUE -> UTF-8, образ -> треки с тегами.
# Работает с любой структурой каталогов (рекурсивно, регистронезависимо).
# Исходники удаляются только после ПОЛНОГО успеха.
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from common import (get_easy_tag, natural_key, note, problem, progress, rm,
                    safe_filename, set_easy_tags)

AUDIO_EXTS = ("flac", "wav", "m4a", "aiff", "mp3", "ape", "wv")
# порядок предпочтения, если в каталоге несколько аудиофайлов
IMAGE_PRIORITY = ("flac", "wav", "m4a", "aiff", "mp3", "ape", "wv")
CUE_ENCODINGS = ("utf-8-sig", "utf-8", "cp1251", "cp866",
                 "koi8-r", "cp1252", "latin-1")


def safe_name(s):
    return re.sub(r'[\\/:*?"<>|]', "_", s).strip() or "Track"


def read_cue(path):
    raw = path.read_bytes()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        try:
            return raw.decode("utf-16")
        except UnicodeDecodeError:
            pass
    for enc in CUE_ENCODINGS:
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    problem(f"cannot decode cue (tried {CUE_ENCODINGS}): {path}")
    return None


def atomic_write(path, text):
    fd, name = tempfile.mkstemp(dir=str(path.parent), prefix=".cue.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, str(path))
    except Exception:
        rm(name)
        raise


def convert_to_utf8(cue):
    text = read_cue(cue)
    if text is None:
        return False
    atomic_write(cue, text.lstrip("\ufeff"))
    return True


def audio_files(d):
    """Аудиофайлы в каталоге (не рекурсивно), без скрытых."""
    if not d.is_dir():
        return []
    return [p for p in d.iterdir()
            if p.is_file() and not p.name.startswith(".")
            and p.suffix[1:].lower() in AUDIO_EXTS]


_CUE_FILE_RE = re.compile(r'(?im)^\s*FILE\s+(?:"([^"]*)"|(\S+))')


def cue_file_name(cue):
    """Имя файла из первой директивы FILE (только basename) или ''."""
    m = _CUE_FILE_RE.search(cue.read_text(encoding="utf-8"))
    if not m:
        return ""
    return (m.group(1) or m.group(2) or "").replace("\\", "/").split("/")[-1]


_KNOWN_EXTS = {"flac", "wv", "ape", "wav", "wave", "tta", "m4a", "mp3", "aiff", "aif",
               "ogg", "opus", "wma", "iso", "cue", "image", "img"}


def norm_name(name):
    """Имя без цепочки известных расширений и без знаков: 'Album.iso.wv' -> 'album',
    'Album.flac' -> 'album' (образ мог быть переименован/сконвертирован)."""
    s = name.lower()
    while True:
        base, dot, ext = s.rpartition(".")
        if dot and base and ext in _KNOWN_EXTS:
            s = base
        else:
            break
    return re.sub(r"[\W_]+", "", s)


def find_image(cue):
    """Образ для cue. Порядок поиска (расширение и «хвосты» вроде .iso.wv не важны):
      1. файл с точным именем из FILE;
      2. имя из FILE совпадает с файлом после нормализации (Album.iso.wv ~ Album.flac);
      3. имя самого cue совпадает с файлом после нормализации;
      4. единственный аудиофайл в папке;
      5. единственный файл, длинный настолько, что в него укладывается cue
         (или заметно длиннее остальных) — образ среди нескольких аудиофайлов.
    Иначе None — чтобы не принять за образ один из уже нарезанных треков."""
    files = audio_files(cue.parent)
    if not files:
        return None

    def rank(p):
        ext = p.suffix[1:].lower()
        return (IMAGE_PRIORITY.index(ext) if ext in IMAGE_PRIORITY
                else len(IMAGE_PRIORITY))

    ref = cue_file_name(cue)
    if ref:
        exact = [p for p in files if p.name.lower() == ref.lower()]
        if exact:
            return exact[0]
        n = norm_name(ref)
        same = [p for p in files if n and norm_name(p.name) == n]
        if same:
            return sorted(same, key=rank)[0]
    n = norm_name(cue.name)
    same = [p for p in files if n and norm_name(p.name) == n]
    if same:
        return sorted(same, key=rank)[0]
    if len(files) == 1:
        return files[0]

    # несколько аудиофайлов: образ — тот, в который укладывается cue и который заметно длиннее
    try:
        last_start = max(t_["start"] for t_ in parse_cue_tracks(cue))
    except (ValueError, OSError):
        return None
    durs = sorted(((file_duration(p) or 0.0, p) for p in files),
                  key=lambda x: x[0], reverse=True)
    fits = [(d, p) for d, p in durs if d > last_start]
    if len(fits) == 1 and durs[0][1] == fits[0][1]:
        return fits[0][1]
    if fits and len(durs) > 1 and durs[0][0] >= 1.5 * durs[1][0] and durs[0][0] > last_start:
        return durs[0][1]
    return None


def to_flac(src):
    dst = src.with_suffix(".flac")
    # не перезаписываем возможный исходный flac с тем же именем
    if dst.exists() and dst.resolve() != src.resolve():
        dst = src.with_name(src.stem + ".conv.flac")
    r = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(src), "-vn",
         "-c:a", "flac", "-compression_level", "8",
         "-map_metadata", "0", "-y", str(dst)],
        capture_output=True, text=True, stdin=subprocess.DEVNULL)
    if r.returncode or not dst.is_file():
        rm(dst)
        problem(f"to_flac {src}: {r.stderr.strip()}")
        return None
    return dst


_FILE_RE = re.compile(r'(?im)^(\s*FILE\s+)"[^"]*"(\s+\S+\s*)$')


def _patch_file_line(cue_text, new_name):
    """Подменяет имя файла в директиве FILE ... WAVE на new_name."""
    return _FILE_RE.sub(
        lambda m: f'{m.group(1)}"{new_name}"{m.group(2)}',
        cue_text, count=1)


def split_lossless(cue, image, expected=0):
    """shnsplit (если установлен и справился), иначе ffmpeg.
    shnsplit не понимает hi-res/многоканальный flac (WAVE_FORMAT_EXTENSIBLE, 0xfffe)
    и некоторые cue — тогда нарезка автоматически идёт через ffmpeg."""
    if shutil.which("shnsplit"):
        before = {p.resolve() for p in cue.parent.glob("*.flac")}
        # shnsplit читает FILE из cue — патчим на реальный файл образа
        text = cue.read_text(encoding="utf-8")
        patched = _patch_file_line(text, image.name)
        tmp_cue = cue.parent / (cue.name + ".shn.tmp")
        atomic_write(tmp_cue, patched)
        try:
            r = subprocess.run(
                ["shnsplit", "-O", "always", "-f", str(tmp_cue),
                 "-t", "%n", "-o", "flac", str(image)],
                cwd=str(cue.parent), capture_output=True, text=True,
                stdin=subprocess.DEVNULL)
        finally:
            rm(tmp_cue)
        new = sorted({p.resolve() for p in cue.parent.glob("*.flac")} - before,
                     key=natural_key)
        if r.returncode == 0 and len(new) >= expected:
            return new
        reason = (r.stderr.strip().splitlines() or ["incomplete result"])[0][:160]
        note(f"shnsplit failed ({reason}), splitting with ffmpeg instead")
        for f in new:                               # убрать недоделанное
            rm(f)
        return split_ffmpeg(cue, image, ".flac")
    note("shnsplit not found, splitting with ffmpeg")
    return split_ffmpeg(cue, image, ".flac")


def _val(line, key):
    m = re.match(rf'\s*{key}\s+"(.*)"\s*$', line, re.I)
    if m:
        return m.group(1).strip()
    m = re.match(rf"\s*{key}\s+(\S.*?)\s*$", line, re.I)
    return m.group(1).strip() if m else None


def parse_cue(cue):
    """-> (meta, tracks); tracks = [{num, title, performer, start}]."""
    meta = {"performer": "", "title": "", "date": "", "genre": ""}
    tracks, cur = [], None
    for line in cue.read_text(encoding="utf-8").splitlines():
        m = re.match(r"\s*TRACK\s+(\d+)\s+AUDIO", line, re.I)
        if m:
            if cur:
                tracks.append(cur)
            cur = {"num": int(m.group(1)), "title": "", "performer": "",
                   "start": None}
            continue
        target = cur if cur is not None else meta
        v = _val(line, "TITLE")
        if v is not None and not target["title"]:
            target["title"] = v
            continue
        v = _val(line, "PERFORMER")
        if v is not None and not target["performer"]:
            target["performer"] = v
            continue
        if cur is None:
            v = _val(line, r"REM\s+DATE")
            if v is not None:
                meta["date"] = v.strip('"')
            v = _val(line, r"REM\s+GENRE")
            if v is not None:
                meta["genre"] = v.strip('"')
            continue
        m = re.match(r"\s*INDEX\s+01\s+(\d+):(\d+):(\d+)", line, re.I)
        if m:
            cur["start"] = (int(m.group(1)) * 60 + int(m.group(2))
                            + int(m.group(3)) / 75)
    if cur:
        tracks.append(cur)
    return meta, [t for t in tracks if t["start"] is not None]


def parse_cue_tracks(cue):
    return parse_cue(cue)[1]


def file_duration(path):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return None


def split_ffmpeg(cue, image, ext):
    """mp3 — копированием потока, flac — lossless-перекодированием."""
    tracks = parse_cue_tracks(cue)
    dur = file_duration(image)
    if dur is None:
        problem(f"no duration: {image}")
        return []
    codec = (["-c:a", "flac", "-compression_level", "8"] if ext == ".flac"
             else ["-c", "copy"])
    starts = [t["start"] for t in tracks] + [dur]
    new = []
    for i, t in enumerate(tracks):
        progress(i=i, n=len(tracks), file=t['title'] or f"track {t['num']}")
        out = cue.parent / f"{t['num']:02d} - {safe_name(t['title'] or 'Track')}{ext}"
        r = subprocess.run(
            ["ffmpeg", "-loglevel", "error",
             "-ss", f"{starts[i]:.6f}", "-i", str(image),
             "-t", f"{starts[i + 1] - starts[i]:.6f}",
             "-vn", "-map_metadata", "-1", *codec, "-y", str(out)],
            capture_output=True, text=True, stdin=subprocess.DEVNULL)
        if r.returncode or not out.is_file():
            problem(f"split track {t['num']}: {r.stderr.strip()}")
            rm(out)
            continue
        new.append(out)
    return new


def tag_tracks(files, meta, tracks):
    for f, t in zip(files, tracks):
        tags = {"title": t["title"], "tracknumber": t["num"],
                "artist": t["performer"] or meta["performer"],
                "albumartist": meta["performer"], "album": meta["title"],
                "date": meta["date"], "genre": meta["genre"]}
        try:
            set_easy_tags(f, **{k: v for k, v in tags.items() if str(v) != ""})
        except Exception as e:
            problem(f"tagging {f.name}: {e}")


FAILED = []        # cue, для которых образ найден, но нарезать не удалось


def fail_image(cue, msg):
    problem(msg)
    if cue not in FAILED:
        FAILED.append(cue)


def process_cue(cue):
    text = cue.read_text(encoding="utf-8")
    if len(re.findall(r"^\s*FILE\s", text, re.I | re.M)) > 1:
        problem(f"multi-FILE cue not supported, sources kept: {cue}")
        return
    image = find_image(cue)
    if image is None:
        problem(f"image for cue not identified "
                f"({len(audio_files(cue.parent))} audio files in folder), "
                f"sources kept: {cue}")
        return
    cue_tracks = parse_cue_tracks(cue)
    expected = len(cue_tracks)
    if expected == 0:
        fail_image(cue, f"no INDEX 01 in cue, sources kept: {cue}")
        return
    img_dur = file_duration(image)
    if img_dur is not None and cue_tracks[-1]["start"] >= img_dur:
        fail_image(cue, f"cue does not fit image (last track starts at "
                        f"{cue_tracks[-1]['start']:.0f}s, image {img_dur:.0f}s), "
                        f"sources kept: {cue}")
        return

    to_delete = {cue, image}
    intermediate = None
    if image.suffix.lower() == ".mp3":
        tracks = split_ffmpeg(cue, image, ".mp3")
    else:
        if image.suffix.lower() == ".flac":
            flac = image
        else:
            flac = to_flac(image)
            if flac is None:
                fail_image(cue, f"cannot convert image to flac, sources kept: {cue}")
                return
            intermediate = flac
            to_delete.add(flac)
        tracks = split_lossless(cue, flac, expected)

    if len(tracks) < expected:
        fail_image(cue, f"incomplete split ({len(tracks)}/{expected}), sources kept: {cue}")
        for t in tracks:
            rm(t)
        if intermediate:
            rm(intermediate)
        return

    # лишние файлы (pregap "00 - ...") — короткие выбрасываем
    real = tracks[len(tracks) - expected:]
    for extra in tracks[:len(tracks) - expected]:
        d = file_duration(extra)
        if d is not None and d < 15:
            note(f"pregap removed: {extra.name}")
            rm(extra)
    meta, cue_tracks = parse_cue(cue)
    # чего нет в cue — берём из тегов образа (артист, альбом, год, жанр)
    for key, tag in (("performer", "albumartist"), ("title", "album"),
                     ("date", "date"), ("genre", "genre")):
        if not meta[key]:
            meta[key] = (get_easy_tag(image, tag)
                         or (get_easy_tag(image, "artist") if key == "performer" else ""))
    # имена треков: NN - Название.flac (безопасные для NTFS/exFAT/FAT)
    named = []
    for f, ct in zip(real, cue_tracks):
        want = f.with_name(f"{ct['num']:02d} - {safe_name(ct['title'] or 'Track')}{f.suffix}")
        if want != f and not want.exists():
            try:
                f.rename(want)
                f = want
            except OSError as e:
                problem(f"rename {f.name}: {e}")
        named.append(f)
    real = named
    tag_tracks(real, meta, cue_tracks)

    # исходники удаляем, только убедившись, что все треки реально на месте
    bad = [f.name for f in real if not f.is_file() or f.stat().st_size == 0]
    if bad:
        fail_image(cue, f"split result missing/empty ({bad[0]} ...), sources kept: {cue}")
        return
    for f in to_delete:
        try:
            f.unlink()
            print("🗑", f.name)
        except OSError as e:
            problem(f"rm {f}: {e}")


def looks_unsplit(folder):
    """В папке остался cue, а аудио — это 1–3 длинных файла (>15 мин): образ не порезан."""
    files = audio_files(folder)
    if not files or len(files) > 3:
        return False
    return any((file_duration(f) or 0) > 900 for f in files)


def find_cues(root):
    """Регистронезависимый рекурсивный поиск .cue."""
    out = []
    for p in root.rglob("*"):
        try:
            if p.is_file() and p.suffix.lower() == ".cue":
                out.append(p)
        except OSError:
            continue
    return sorted(out)


def handle_one(cue):
    """Обработать один cue. Не зависит от того, как назван каталог."""
    note(f"cue: {cue}")
    if convert_to_utf8(cue):
        process_cue(cue)


def main():
    if len(sys.argv) < 2:
        problem("usage: prepare_cue.py <dir|file.cue>")
        return
    root = Path(sys.argv[1])
    if not root.exists():
        problem(f"not found: {root}")
        return

    if root.is_file():
        if root.suffix.lower() == ".cue":
            handle_one(root)
        else:
            problem(f"not a cue file: {root}")
        return

    cues = find_cues(root)
    if not cues:
        note(f"no cue files under: {root}")
        return

    by_dir = {}
    for cue in cues:
        by_dir.setdefault(cue.parent, []).append(cue)
    for d, cs in by_dir.items():
        if len(cs) > 1:
            problem(f"several cue files in one folder, sources kept: {d}")
            continue
        handle_one(cs[0])

    # cue остались, а образ не порезан -> просим конвейер не трогать эту папку
    for d in by_dir:
        if any(p.suffix.lower() == ".cue" for p in d.iterdir() if p.is_file()) \
                and looks_unsplit(d) and not any(c.parent == d for c in FAILED):
            problem(f"image not split (cue left, long audio file), folder kept: {d}")
            FAILED.append(d / "?")
    if FAILED:
        print(f"CUE_FAILED: {len(FAILED)}")      # последняя строка вывода


if __name__ == "__main__":
    main()