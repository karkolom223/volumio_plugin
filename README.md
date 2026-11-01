# Unofficial Volumio Plugins

[🇬🇧 English](README.md) | [🇷🇺 Русский](README.ru.md)

This repository contains unofficial plugins for Volumio, developed by the community.

## Available Plugins:

1. **HDD Automount** — Automatically mounts internal and USB drives, creates symlinks, and updates the MPD library.
2. **Remove Track** — Adds a "Remove Track" button to the UI (removes the track from playlists, database, and disk).
3. **Track Preparer** — Music preparation tools (CUE splitting, silence trimming, covers, ReplayGain, multi-disc merging).

---

## Installation Guide (via SSH)

Since these plugins are unofficial, installation must be done manually via the terminal.

1. Connect to your Volumio via SSH (default login/password: `volumio`).
2. Run the following commands one by one:

```bash
# Clone the repository (only needed the first time)
git clone https://github.com/karkolom223/volumio.git
