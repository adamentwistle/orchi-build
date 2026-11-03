#!/usr/bin/env python3
"""Makes sounds/worker.mp3, one quiet note, from plain tones. The other two sounds are downloads: see sounds/README.md."""
import math, struct, subprocess, sys, tempfile, wave
from pathlib import Path

RATE = 44100
PARTIALS = [(1, 1.0), (2, 0.28), (3, 0.09), (4.2, 0.04)]  # A soft mallet: mostly the note, a little shimmer.
SOUNDS = {
    "worker": {"notes": [(783.99, 0.0)], "length": 0.45, "decay": 9.0, "peak": 0.35},
}


def render(notes, length, decay, peak):
    samples = [0.0] * int(RATE * length)
    for freq, start in notes:
        for i in range(int(RATE * start), len(samples)):
            at = i / RATE - start
            envelope = min(at / 0.005, 1) * math.exp(-decay * at)
            samples[i] += envelope * sum(gain * math.sin(2 * math.pi * freq * ratio * at) for ratio, gain in PARTIALS)
    top = max(abs(s) for s in samples)
    fade = int(RATE * 0.03)  # Ends at silence, so there's no click.
    return [s / top * peak * min((len(samples) - i) / fade, 1) for i, s in enumerate(samples)]


def main():
    out = Path(__file__).resolve().parent.parent / "sounds"
    out.mkdir(exist_ok=True)
    for name, spec in SOUNDS.items():
        with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
            with wave.open(tmp.name, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(RATE)
                w.writeframes(b"".join(struct.pack("<h", int(s * 32767)) for s in render(**spec)))
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", tmp.name, "-codec:a", "libmp3lame", "-q:a", "3", str(out / f"{name}.mp3")], check=True)
        print(out / f"{name}.mp3")


if __name__ == "__main__":
    sys.exit(main())
