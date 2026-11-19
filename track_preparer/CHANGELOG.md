# Changelog / История изменений

## 1.9.0
- **Discs marked in the album tag are merged into one album.** A trailing disc marker — `Album CD1`, `Album - CD 2`, `Album, disc 2`, `Album (Disc 1)`, `Album [CD3]` (1–2 digits, so `CD 2000` is left alone) — is removed from the `album` tag and from the output folder name, and `discnumber` is filled in if empty. Discs that arrive as separate folders, even in different runs and in any order, end up in one folder; track numbers are then renumbered continuously in "disc, track" order (like `merge_discs` does). Re-running changes nothing.
- Диски с меткой в названии альбома (`CD1`, `- Disc 2`, `(Disc 1)`) теперь складываются в один альбом: метка убирается из тега `album` и имени папки, заполняется `discnumber`, нумерация треков становится сквозной независимо от порядка прихода дисков.

## 1.8.2
- **ReplayGain fixed on ffmpeg 4.x–5.1 (Debian 12 / Volumio 4).** The filter option `ebur128=framelog=quiet` is not accepted by these versions: ffmpeg exits with an error but still prints an empty summary (`I: 0.0 LUFS`, `Peak: -inf`), which was taken for a real result — every track got gain `-18.00 dB` and no peak. Now the ffmpeg exit code is checked, `framelog` is no longer used, and the loudness is read only from a real `Summary:` block. Verified with ffmpeg 4.2, 4.4, 5.1, 6.1 and 7.0 (identical results).
- If a track cannot be measured (silence, damaged file, ffmpeg failure) its old ReplayGain tags are removed (no tags are better than false ones) and the run window shows one calm `⚠` line per folder instead of a `✖` line per track; details go to `errors.log` only. Such tracks no longer count as problems.
- Исправлено: на ffmpeg 4.x–5.1 (Debian 12) каждый трек измерялся как 0 LUFS (gain −18,00 dB, без пиков). Теперь проверяется код возврата ffmpeg, `framelog` не используется. Неизмеренный трек остаётся без тегов (старые удаляются), а в окне — одна спокойная строка на папку вместо «✖» на каждый трек.

## 1.8.1
- ReplayGain: a measured loudness of about 0 LUFS (decode failure — it produced "−18.00 dB" gain tags without peaks) is rejected instead of written; after writing, the track gain tag is read back and compared; `diagnose.py` now runs an end-to-end test on a FLAC with an embedded cover and stale `-18.00 dB`/album tags.
- Исправлено: нулевая громкость (сбой замера) больше не записывается как gain −18,00 dB; запись тега проверяется чтением; `diagnose.py` проверяет flac со встроенной обложкой и старыми тегами.

## 1.8.0
- Volumio 4 / Bookworm only: `package.json` brought to the Bookworm plugin template (`os: bookworm`, Node >= 20, Volumio >= 4, dependencies); `install.sh` no longer creates anything on the disk at install time (folders are created in `onStart`); the plugin stops a running job in `onStop`.
- CUE: several `.cue` files in one folder (each with its own image; discs go to `CD1`, `CD2`… and are merged later, or to subfolders by cue name when the albums differ); one cue with several `FILE` images (side A / side B); one cue whose image is stored in parts (`Side A.flac` + `Side B.flac`); cue whose timecodes restart on side B; mixed cases.
- An unresolved cue next to a long image keeps the whole folder in the input (nothing is moved or deleted), also for 4+ files and short sides.
- Исправлено то же по-русски: поддержаны несколько cue в папке, один cue с образами сторон A/B, образ частями; неразобранный cue больше не приводит к переносу образа в библиотеку.

## 1.7.1
- cue for already split tracks (FILE per track, or as many audio files as cue tracks) is no longer an error: missing tags are filled from the cue (existing tags untouched) and the cue is removed, audio is not touched; real multi-FILE images still reported.

## 1.7.0
- album gain removed (shuffle library; stale album tags purged), only track gain + peak; every file re-measured and tags force-rewritten; advice list for tracks with True Peak above 0 dBTP.

## 1.6.3
- rsgain removed (not installable on Volumio), ReplayGain is the built-in ffmpeg+mutagen calculator only; fixed: RVA2/RVAD tags not purged, silence measured as -70 LUFS (+52 dB gain), album loudness wrong for mixed sample rates, multi-disc album gain skipped, wasted album pass for mixed albums, album gain written without peak, ffmpeg output decode errors; progress and errors now shown per file.

## 1.6.2
- cue/image matching ignores name and extension differences (.iso.wv vs .flac), picks the image by duration; cue with a wrong extension is renamed.

## 1.6.1
- shnsplit failure falls back to ffmpeg (hi-res/multichannel); an image that failed to split is no longer processed as one track and nothing is deleted.

## 1.6.0
- archives (.iso.wv/.zip/.iso) unpacked first; ReplayGain via rsgain as the last step on output files; disc number tag.

## 1.5.0
- every nested folder is processed as is, output sorted by tags (artist/album); new interface; safe cross-filesystem move.

## 1.4.0
- audiobooks removed; unpack of iso.wv/ape/wav images first; recursive album detection; no cover file in output; numbering stripped from names; stale ReplayGain tags purged.

## 1.3.0
- single clean window (start + live log in one page), hardcoded paths.

## 1.2.0
- progress window, graceful stop, per-album transfer.
