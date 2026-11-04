# Sounds

| File | Means | What it is | Source | Licence |
| --- | --- | --- | --- | --- |
| `needs-you.mp3` | An agent needs a decision | A doorbell, by frosty ham | [Doorbell](https://opengameart.org/content/doorbell) | CC0 |
| `done.mp3` | An agent finished | A retro level passed sound, `level_passed_2.wav` by FrogPog | [Chiptune SFX Pack](https://opengameart.org/content/chiptune-sfx-pack) | CC0 |
| `worker.mp3` | A worker finished | One quiet note | `scripts/build-sounds.py` | Made here |

The downloads were trimmed of silence and levelled to peak at -3 dB with `ffmpeg`. `done.mp3` was then turned down
to 70% (`volume=0.7`), so it peaks at about -5.5 dB.
