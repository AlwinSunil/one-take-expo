"""Bounded, sample-addressed PCM input; never reads or changes original media."""
from array import array
from dataclasses import dataclass
import sys
import wave


@dataclass(frozen=True)
class AudioWindow:
    start_sample: int
    valid_samples: int
    samples: list[float]


def inspect_wave(path, sample_rate):
    with wave.open(str(path), "rb") as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, sample_rate, "NONE"):
            raise ValueError(f"Expected mono PCM16 WAV at {sample_rate} Hz; decode/resample explicitly first")
        count = audio.getnframes()
        if count <= 0 or count > sample_rate * 60 * 60:
            raise ValueError("Audio must contain samples and be at most one hour")
        return count


def windows(path, sample_rate, window_samples, hop_samples):
    """Seek by integer samples; only the last window is zero padded."""
    if not 0 < hop_samples <= window_samples:
        raise ValueError("Require 0 < hop_samples <= window_samples")
    count = inspect_wave(path, sample_rate)
    with wave.open(str(path), "rb") as audio:
        for start in range(0, count, hop_samples):
            audio.setpos(start)
            valid = min(window_samples, count - start)
            raw = audio.readframes(valid)
            if len(raw) != valid * 2:
                raise ValueError("Truncated PCM audio")
            pcm = array("h")
            pcm.frombytes(raw)
            if sys.byteorder != "little":
                pcm.byteswap()
            values = [sample / 32768.0 for sample in pcm]
            values.extend([0.0] * (window_samples - valid))
            yield AudioWindow(start, valid, values)
            if start + window_samples >= count:
                break
