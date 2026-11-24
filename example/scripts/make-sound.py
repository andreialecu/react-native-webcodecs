# /// script
# dependencies = ["numpy", "scipy"]
# ///
"""The sound of the video export example, synthesized to the card's timeline.

    uv run example/scripts/make-sound.py

writes src/VideoExport/assets/sound.m4a (7 s, 44.1 kHz stereo AAC). Cues,
from card.json at 30 fps:

  0.07 s, 0.23 s   the two floodlights switch on: a relay clunk and a hum
  0.33 to 1.27 s   the card flies in: a riser and a whoosh across
  1.27 s           it lands: a sub drop and an impact, the beat starts
  2.73 to 3.5 s    the footer line draws: a rising bell arpeggio
  3.33 s           the shine sweeps the card: an airy swish
  from 1.27 s      a 120 BPM bed in A minor (kick, sidechained pad, sub,
                   hats), fading out over the last second
"""

import subprocess
import tempfile
import wave
from pathlib import Path

import numpy as np
from scipy import signal

SR = 44100
DUR = 7.0
N = int(SR * DUR)
rng = np.random.default_rng(7)

L = np.zeros(N)
R = np.zeros(N)


def t_of(n):
    return np.arange(n) / SR


def place(sig, at, pan=0.0, gain=1.0):
    """Mixes a mono signal in at `at` seconds, panned -1 (left) to 1."""
    i = int(at * SR)
    if i >= N:
        return
    sig = sig[: N - i] * gain
    a = (pan + 1) * np.pi / 4
    L[i : i + len(sig)] += sig * np.cos(a)
    R[i : i + len(sig)] += sig * np.sin(a)


def place_stereo(left, right, at, gain=1.0):
    i = int(at * SR)
    n = min(len(left), N - i)
    L[i : i + n] += left[:n] * gain
    R[i : i + n] += right[:n] * gain


def env(n, attack, decay):
    t = t_of(n)
    return np.minimum(t / max(attack, 1e-4), 1.0) * np.exp(-t / decay)


def bandpass(x, lo, hi, order=2):
    sos = signal.butter(order, [lo, hi], btype="band", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def lowpass(x, f, order=2):
    sos = signal.butter(order, f, btype="low", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def highpass(x, f, order=2):
    sos = signal.butter(order, f, btype="high", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def sweep_filter(x, f0, f1, q=2.0, block=256):
    """A band-pass whose center glides from f0 to f1 (exponentially)."""
    out = np.zeros_like(x)
    zi = None
    for s in range(0, len(x), block):
        k = s / len(x)
        f = f0 * (f1 / f0) ** k
        bw = f / q
        sos = signal.butter(
            2, [max(f - bw / 2, 20), min(f + bw / 2, SR / 2 - 100)],
            btype="band", fs=SR, output="sos",
        )
        if zi is None:
            zi = signal.sosfilt_zi(sos) * 0
        out[s : s + block], zi = signal.sosfilt(sos, x[s : s + block], zi=zi)
    return out


def note(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


# --- Floodlights: a relay clunk, a click, a short electric hum ------------
def lamp():
    n = int(0.9 * SR)
    t = t_of(n)
    thump = np.sin(2 * np.pi * (90 * t - 40 * t**2)) * env(n, 0.001, 0.05)
    click = highpass(rng.standard_normal(n), 2500) * env(n, 0.0005, 0.006)
    metal = bandpass(rng.standard_normal(n), 1800, 2600, 4) * env(n, 0.001, 0.04)
    hum_env = np.minimum(t / 0.02, 1) * np.exp(-t / 0.35)
    hum = (
        np.sin(2 * np.pi * 100 * t)
        + 0.5 * np.sin(2 * np.pi * 200 * t)
        + 0.25 * np.sign(np.sin(2 * np.pi * 100 * t))
    ) * hum_env
    return 0.9 * thump + 0.5 * click + 0.6 * metal + 0.03 * lowpass(hum, 800)


place(lamp(), 2 / 30, pan=-0.6, gain=0.7)
place(lamp(), 7 / 30, pan=0.6, gain=0.7)

# --- Riser into the landing: noise sweeping up, a rising tone -------------
rise_n = int((38 - 10) / 30 * SR)
rt = t_of(rise_n)
riser_noise = sweep_filter(rng.standard_normal(rise_n), 300, 6000, q=1.5)
riser_tone = np.sin(2 * np.pi * np.cumsum(220 * 2 ** (2 * rt / rt[-1])) / SR)
riser_env = (rt / rt[-1]) ** 2
place(
    (0.5 * riser_noise + 0.12 * riser_tone) * riser_env, 10 / 30, gain=0.6,
)

# The whoosh of the card, passing from left to right.
wl = sweep_filter(rng.standard_normal(rise_n), 400, 2500, q=1.2)
wr = sweep_filter(rng.standard_normal(rise_n), 450, 2700, q=1.2)
wenv = np.sin(np.pi * np.clip((rt - 0.25) / (rt[-1] - 0.25), 0, 1)) ** 2
pan = np.linspace(-0.8, 0.8, rise_n)
a = (pan + 1) * np.pi / 4
place_stereo(wl * wenv * np.cos(a), wr * wenv * np.sin(a), 10 / 30, gain=0.8)

# --- Landing: a sub drop, a body hit, a noise burst -----------------------
LAND = 38 / 30
n = int(2.0 * SR)
t = t_of(n)
sub = np.sin(2 * np.pi * np.cumsum(30 + 60 * np.exp(-t / 0.12)) / SR)
sub *= env(n, 0.002, 0.45)
body = np.sin(2 * np.pi * np.cumsum(55 + 120 * np.exp(-t / 0.03)) / SR)
body *= env(n, 0.001, 0.15)
burst = lowpass(rng.standard_normal(n), 3500) * env(n, 0.001, 0.12)
place(1.0 * sub + 0.8 * body + 0.5 * burst, LAND, gain=0.9)

# --- The bed: 120 BPM in A minor, from the landing ------------------------
BEAT = 0.5
bed_L = np.zeros(N)
bed_R = np.zeros(N)
side = np.ones(N)  # the pad ducks under the kick

kick_n = int(0.45 * SR)
kt = t_of(kick_n)
kick = np.sin(2 * np.pi * np.cumsum(45 + 110 * np.exp(-kt / 0.035)) / SR)
kick = kick * env(kick_n, 0.001, 0.16)
kick += 0.3 * highpass(rng.standard_normal(kick_n), 3000) * env(kick_n, 0.0005, 0.004)

hat_n = int(0.12 * SR)
hat = highpass(rng.standard_normal(hat_n), 7000, 4) * env(hat_n, 0.0005, 0.03)

beats = np.arange(LAND + BEAT, DUR, BEAT)
for k, b in enumerate(beats):
    i = int(b * SR)
    m = min(kick_n, N - i)
    bed_L[i : i + m] += kick[:m] * 0.6
    bed_R[i : i + m] += kick[:m] * 0.6
    duck = 1 - 0.7 * np.exp(-t_of(m) / 0.12)
    side[i : i + m] = np.minimum(side[i : i + m], duck)
    h = b + BEAT / 2
    j = int(h * SR)
    if j < N:
        mh = min(hat_n, N - j)
        p = 0.3 if k % 2 else -0.3
        bed_L[j : j + mh] += hat[:mh] * 0.22 * (1 - p)
        bed_R[j : j + mh] += hat[:mh] * 0.22 * (1 + p)

# Am, F, C, G, two beats each.
chords = [[57, 60, 64], [53, 57, 60], [48, 55, 64], [55, 59, 62]]
roots = [45, 41, 36, 43]
for k, start in enumerate(np.arange(LAND, DUR, 2 * BEAT)):
    c = k % 4
    n = int(min(2 * BEAT + 0.6, DUR - start) * SR)
    t = t_of(n)
    pad_env = np.minimum(t / 0.08, 1) * np.exp(-t / 1.6)
    for v, m in enumerate(chords[c]):
        for d, side_pan in ((-0.07, -1), (0.07, 1)):
            f = note(m) * 2 ** (d / 12)
            saw = signal.sawtooth(2 * np.pi * f * t + v)
            tone = lowpass(saw, 2400) * pad_env * 0.07
            i = int(start * SR)
            if side_pan < 0:
                bed_L[i : i + n] += tone * side[i : i + n]
            else:
                bed_R[i : i + n] += tone * side[i : i + n]
    bass = np.sin(2 * np.pi * note(roots[c]) * t)
    bass = np.tanh(2 * bass) * np.minimum(t / 0.01, 1) * np.exp(-t / 0.9) * 0.2
    i = int(start * SR)
    bed_L[i : i + n] += bass * side[i : i + n]
    bed_R[i : i + n] += bass * side[i : i + n]

L += bed_L
R += bed_R

# --- The footer line: a rising bell arpeggio ------------------------------
def bell(f, dur=1.6):
    n = int(dur * SR)
    t = t_of(n)
    mod = np.sin(2 * np.pi * f * 3.5 * t) * 2.2 * np.exp(-t / 0.3)
    return np.sin(2 * np.pi * f * t + mod) * env(n, 0.002, 0.5)


for k, m in enumerate([69, 72, 76, 81, 84]):
    place(bell(note(m)), 82 / 30 + k * 0.09, pan=-0.5 + k * 0.25, gain=0.12)

# --- The shine sweeping the card: an airy swish ---------------------------
n = int(0.5 * SR)
t = t_of(n)
swish = sweep_filter(rng.standard_normal(n), 3000, 9000, q=2)
place(swish * np.sin(np.pi * t / t[-1]) ** 2, 100 / 30, pan=0.3, gain=0.35)

# --- Reverb on everything (a decaying noise impulse), then the master -----
ir_n = int(1.8 * SR)
it = t_of(ir_n)
ir_l = rng.standard_normal(ir_n) * np.exp(-it / 0.45)
ir_r = rng.standard_normal(ir_n) * np.exp(-it / 0.45)
ir_l = lowpass(ir_l, 5000)
ir_r = lowpass(ir_r, 5000)
ir_l /= np.sqrt(np.sum(ir_l**2))
ir_r /= np.sqrt(np.sum(ir_r**2))
wet_l = signal.fftconvolve(L, ir_l)[:N]
wet_r = signal.fftconvolve(R, ir_r)[:N]
L = L + 0.25 * wet_l
R = R + 0.25 * wet_r

# Fade out over the last second, keep the low end tidy, soft-clip.
fade = np.ones(N)
f0 = int((DUR - 1.0) * SR)
fade[f0:] = np.cos(np.linspace(0, np.pi / 2, N - f0)) ** 2
L = highpass(L * fade, 28)
R = highpass(R * fade, 28)
peak = max(np.abs(L).max(), np.abs(R).max())
L = np.tanh(1.4 * L / peak) / np.tanh(1.4) * 0.6
R = np.tanh(1.4 * R / peak) / np.tanh(1.4) * 0.6

out = Path(__file__).resolve().parent.parent / "src/VideoExport/assets/sound.m4a"
pcm = (np.stack([L, R], axis=1) * 32767).astype("<i2")
with tempfile.TemporaryDirectory() as tmp:
    wav = Path(tmp) / "sound.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-c:a", "aac",
         "-b:a", "160k", "-movflags", "+faststart", str(out)],
        check=True,
    )
print(out)
