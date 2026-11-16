"""G1 ASR read_audio regression tests (Windows non-ASCII path defect).

Run directly with the product worker interpreter:
    python tests/asr_quality_test.py
Requires soundfile + numpy (the model venv provides them).
"""
import math
import shutil
import sys
import tempfile
import unittest
import wave
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'app/src'))
import io  # noqa: E402
import numpy as np  # noqa: E402

# offline_models.py runs its JSON-lines loop unconditionally at import time, so
# give it an immediately-empty stdin: the import must stay side-effect free here.
sys.stdin = io.StringIO('')

try:
    import soundfile  # noqa: F401
except Exception:  # pragma: no cover
    soundfile = None

import offline_models as om  # noqa: E402


def write_wav(path, samples, rate=16000, channels=1):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        pcm = np.clip(np.asarray(samples), -1.0, 1.0)
        handle.writeframes((pcm * 32767).astype('<i2').tobytes())
    return path


@unittest.skipIf(soundfile is None, 'soundfile not installed')
class ReadAudioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='g1-read-audio-'))
        rate = 16000
        t = np.arange(rate, dtype=np.float64) / rate
        cls.signal = 0.4 * np.sin(2 * math.pi * 440.0 * t)
        cls.ascii_path = write_wav(cls.tmp / 'ascii-clip.wav', cls.signal)
        cls.unicode_dir = cls.tmp / 'ፋርመር ai' / 'ድምጽ'
        cls.unicode_path = write_wav(cls.unicode_dir / 'ሙከራ-ድምጽ.wav', cls.signal)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_ascii_path_reads(self):
        audio = om.read_audio(str(self.ascii_path))
        self.assertEqual(len(audio), 16000)
        self.assertAlmostEqual(float(np.abs(audio).max()), 0.4, places=2)

    def test_non_ascii_path_reads_identically(self):
        self.assertFalse(all(ord(c) < 128 for c in str(self.unicode_path)))
        ascii_audio = om.read_audio(str(self.ascii_path))
        unicode_audio = om.read_audio(str(self.unicode_path))
        np.testing.assert_array_equal(ascii_audio, unicode_audio)

    def test_non_ascii_directory_only_reads(self):
        # non-ASCII directory, ASCII file name (libsndfile fails on the directory too)
        path = write_wav(self.tmp / 'ፋርመር ai' / 'plain-name.wav', self.signal)
        audio = om.read_audio(str(path))
        self.assertEqual(len(audio), 16000)

    def test_stereo_rejected(self):
        stereo = np.stack([self.signal, self.signal], axis=1)
        path = write_wav(self.tmp / 'stereo.wav', stereo, channels=2)
        with self.assertRaises(ValueError) as caught:
            om.read_audio(str(path))
        self.assertIn('AUDIO_FORMAT_UNSUPPORTED', str(caught.exception))

    def test_wrong_sample_rate_rejected(self):
        path = write_wav(self.tmp / 'rate8k.wav', self.signal[::2], rate=8000)
        with self.assertRaises(ValueError) as caught:
            om.read_audio(str(path))
        self.assertIn('AUDIO_FORMAT_UNSUPPORTED', str(caught.exception))

    def test_missing_file_raises_not_crash(self):
        # libsndfile surfaces its own exception type for a missing file; the
        # product worker converts it to OFFLINE_MODEL_FAILED. Assert that the
        # failure is an exception (not a hang), not a specific library class.
        with self.assertRaises((OSError, RuntimeError)):
            om.read_audio(str(self.tmp / 'absent.wav'))

    def test_non_ascii_missing_file_message(self):
        missing = self.tmp / 'ፋርመር ai' / 'የለም.wav'
        with self.assertRaises((OSError, RuntimeError)) as caught:
            om.read_audio(str(missing))
        self.assertIn('ፋርመር ai', str(caught.exception))


if __name__ == '__main__':
    unittest.main(verbosity=2)
