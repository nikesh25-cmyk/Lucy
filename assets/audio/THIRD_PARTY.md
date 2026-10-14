# Sampled CC0 audio

14 short clips, all **CC0 1.0 Universal** (public domain dedication), by [Kenney](https://kenney.nl).
Each file's source pack, byte size and SHA-256 are recorded in [`manifest.json`](manifest.json);
the whole pool and its fetch pipeline are described in
[`asset-pool/POOL.md`](../asset-pool/POOL.md).

| Clip | Use | Kenney pack |
| --- | --- | --- |
| `ui-click`, `ui-confirm`, `ui-close` | interface feedback | UI Audio, Interface Sounds |
| `world-step-grass`, `world-step-stone` | a confirmed tile step | Impact Sounds (footsteps) |
| `world-place`, `world-remove` | a saved block saved or removed | Interface Sounds, RPG Audio |
| `world-door-open`, `world-door-close` | a doorway used | RPG Audio |
| `world-chop` | a crop gathered | RPG Audio |
| `world-coin` | a chime (a chime only — **not** a currency sound) | Interface Sounds |
| `music-jingle-1`, `music-jingle-2`, `music-jingle-3` | short completion jingles | Music Jingles |

CC0 requires no attribution; the author is credited here as good practice. These clips are played by
[`src/ui/audio-bank.js`](../../src/ui/audio-bank.js) through the ambient bed in
[`src/game-audio.js`](../../src/game-audio.js), so the world's existing mute and volume govern them
too. No clip was traced from, or substitutes for, any Minecraft, Luanti or Terasology asset. This is
not legal advice; it records what was verified from the files actually downloaded.
