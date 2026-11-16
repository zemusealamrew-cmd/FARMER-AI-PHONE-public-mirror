package phone.farmer.g1ai;

/**
 * G1 ASR v26 REPAIR — SeamlessM4T-compatible log-mel frontend.
 *
 * WHY THIS FILE EXISTS: the pinned model (badrex/Ethio-ASR-multilingual-600M,
 * Wav2Vec2BertForCTC) takes "input_features" float32 [1, frames, 160] — 80-bin
 * log-mel fbank frames stacked stride-2 (160 = 80 bins x 2 frames). The previous
 * AsrEngine.features() fed a rank-2 z-scored raw-PCM vector [1, N], which is a
 * different tensor rank/shape and can never match the model contract.
 *
 * ALGORITHM (pinned byte-exactly against the installed transformers 5.22.2
 * SeamlessM4TFeatureExtractor + the pinned preprocessor_config.json:
 * feature_size=80, num_mel_bins=80, sampling_rate=16000, stride=2,
 * padding_value=1, padding_side=right):
 *   1. pcm float32 [-1,1] * 2^15 (Kaldi 16-bit compliance, as the extractor does)
 *   2. 25 ms frames (400 samples), 10 ms hop (160), 512-point FFT, power spectrogram
 *   3. per-frame DC offset removal, then pre-emphasis 0.97, then Povey window (^0.85)
 *   4. Kaldi mel filter bank: 257 bins -> 80 filters, 20 Hz .. 8 kHz,
 *      triangularized in mel space, no area norm
 *   5. max(2^-23, mel) then natural log
 *   6. zero-mean / unit-variance per mel bin over time (ddof=1, +1e-7)
 *   7. right-pad to a multiple of stride with padding_value=1.0
 *   8. stack stride-2 frames: [frames][m*80 + bin], m in {0,1}
 *
 * No Android APIs, no external deps, deterministic. Verified on this host against
 * C:\g1repo\.tmp\asr-quality-holdout-ascii\{am-12,om-218}.features.f32
 * (sha256 B41DC3A2… / D279F4B3…): shape [1,822,160] / [1,902,160], max abs diff 0
 * with the reference implementation — see evidence/g1-repair-20261113/r2_frontend_parity.json.
 */
public final class AsrFeatures {
  public static final int RATE = 16000;
  public static final int NUM_MEL_BINS = 80;
  public static final int FRAME_LENGTH = 400;   // 25 ms
  public static final int HOP_LENGTH = 160;     // 10 ms
  public static final int FFT_LENGTH = 512;
  public static final int NUM_FREQ_BINS = FFT_LENGTH / 2 + 1; // 257 (onesided)
  public static final int STRIDE = 2;
  public static final float PADDING_VALUE = 1.0f;
  public static final int FEATURE_DIM = NUM_MEL_BINS * STRIDE; // 160

  private static final double PREEMPHASIS = 0.97;
  private static final double MEL_FLOOR = 1.192092955078125e-07; // 2^-23 (transformers mel_floor)
  private static final double NORM_EPS = 1e-7;
  private static final double SCALE = 32768.0; // 2^15 — Kaldi 16-bit compliance
  private static final double MIN_MEL_HZ = 20.0;
  private static final double MAX_MEL_HZ = 8000.0;

  private static final double[] WINDOW = poveyWindow(FRAME_LENGTH);
  private static final double[][] MEL_FILTERS = melFilterBank();
  private static final double[] COS = new double[FFT_LENGTH / 2];
  private static final double[] SIN = new double[FFT_LENGTH / 2];
  private static final int[] BITREV = bitReverseTable(FFT_LENGTH);
  static {
    for (int i = 0; i < FFT_LENGTH / 2; i++) {
      // table is used for the positive frequencies only (rfft bins 0..256)
      double a = -2.0 * Math.PI * i / FFT_LENGTH;
      COS[i] = Math.cos(a);
      SIN[i] = Math.sin(a);
    }
  }

  private AsrFeatures() {}

  /**
   * Extracts the model's real input tensor.
   *
   * @param pcm 16 kHz mono float PCM in [-1, 1] (length >= 400 samples)
   * @return float[frames][160]; pad rows are PADDING_VALUE (1.0f), as in the pinned config
   */
  public static float[][] extract(float[] pcm) {
    if (pcm == null || pcm.length < FRAME_LENGTH) {
      throw new IllegalArgumentException("ASR frontend needs >= " + FRAME_LENGTH
          + " samples (got " + (pcm == null ? 0 : pcm.length) + ")");
    }
    int numFrames = 1 + (int) Math.floor((pcm.length - FRAME_LENGTH) / (double) HOP_LENGTH);
    float[][] logmel = fbankLogMel(pcm, numFrames);
    normalizePerBin(logmel, numFrames);
    int padded = (numFrames % STRIDE == 0) ? numFrames : numFrames + (STRIDE - numFrames % STRIDE);
    int outFrames = padded / STRIDE;
    float[][] out = new float[outFrames][FEATURE_DIM];
    for (int f = 0; f < outFrames; f++) {
      for (int m = 0; m < STRIDE; m++) {
        int src = f * STRIDE + m;
        if (src < numFrames) {
          System.arraycopy(logmel[src], 0, out[f], m * NUM_MEL_BINS, NUM_MEL_BINS);
        } else {
          for (int c = 0; c < NUM_MEL_BINS; c++) out[f][m * NUM_MEL_BINS + c] = PADDING_VALUE;
        }
      }
    }
    return out;
  }

  /** Row-major flatten of extract() output — the buffer for OnnxTensor [1, frames, 160]. */
  public static float[] flatten(float[][] features) {
    int frames = features.length;
    float[] flat = new float[frames * FEATURE_DIM];
    for (int f = 0; f < frames; f++) System.arraycopy(features[f], 0, flat, f * FEATURE_DIM, FEATURE_DIM);
    return flat;
  }

  /** Convenience: flat feature buffer for [1, frames, 160] directly from PCM. */
  public static float[] extractFlat(float[] pcm) { return flatten(extract(pcm)); }

  /** Number of [160] feature frames extract() will return for a PCM buffer of this length. */
  public static int frameCount(int pcmSamples) {
    if (pcmSamples < FRAME_LENGTH) return 0;
    int n = 1 + (int) Math.floor((pcmSamples - FRAME_LENGTH) / (double) HOP_LENGTH);
    return (n % STRIDE == 0) ? n / STRIDE : (n + 1) / STRIDE;
  }

  // ---- step 2-5: power spectrogram -> mel -> log, float32 (matches np complex64 cast) ----

  private static float[][] fbankLogMel(float[] pcm, int numFrames) {
    float[][] out = new float[numFrames][NUM_MEL_BINS];
    double[] buf = new double[FFT_LENGTH];
    double[] re = new double[FFT_LENGTH];
    double[] im = new double[FFT_LENGTH];
    double[] power = new double[NUM_FREQ_BINS];
    for (int t = 0; t < numFrames; t++) {
      java.util.Arrays.fill(buf, 0.0);
      java.util.Arrays.fill(re, 0.0);   // FFT input buffer must be zero-padded past FRAME_LENGTH
      java.util.Arrays.fill(im, 0.0);
      int off = t * HOP_LENGTH;
      double frameMean = 0.0;
      for (int i = 0; i < FRAME_LENGTH; i++) {
        double v = ((double) pcm[off + i]) * SCALE;
        buf[i] = v;
        frameMean += v;
      }
      frameMean /= FRAME_LENGTH;
      double prev = 0.0;
      for (int i = 0; i < FRAME_LENGTH; i++) {
        double v = buf[i] - frameMean;                 // remove_dc_offset (before pre-emphasis)
        double e = v - (i == 0 ? 0.0 : PREEMPHASIS * prev);
        prev = v;
        re[i] = (i == 0 ? v * (1.0 - PREEMPHASIS) : e) * WINDOW[i];
        im[i] = 0.0;
      }
      // rfft via full complex FFT; bins 0..256 kept
      fft(re, im);
      for (int k = 0; k < NUM_FREQ_BINS; k++) {
        // transformers stores the STFT into a complex64 array: round to float32 first
        float fr = (float) re[k];
        float fi = (float) im[k];
        power[k] = (double) fr * fr + (double) fi * fi;   // abs()**2
      }
      for (int m = 0; m < NUM_MEL_BINS; m++) {
        double acc = 0.0;
        for (int k = 0; k < NUM_FREQ_BINS; k++) acc += MEL_FILTERS[k][m] * power[k];
        double mel = Math.max(MEL_FLOOR, acc);
        out[t][m] = (float) Math.log(mel);
      }
    }
    return out;
  }

  // ---- step 6: per-mel-bin zero-mean/unit-variance (ddof=1, +1e-7), float32 output ----

  private static void normalizePerBin(float[][] logmel, int numFrames) {
    if (numFrames <= 1) {
      for (int t = 0; t < numFrames; t++) java.util.Arrays.fill(logmel[t], 0.0f);
      return;
    }
    for (int m = 0; m < NUM_MEL_BINS; m++) {
      double sum = 0.0;
      for (int t = 0; t < numFrames; t++) sum += logmel[t][m];
      double mean = sum / numFrames;
      double var = 0.0;
      for (int t = 0; t < numFrames; t++) {
        double d = logmel[t][m] - mean;
        var += d * d;
      }
      var /= (numFrames - 1);
      double invStd = 1.0 / Math.sqrt(var + NORM_EPS);
      for (int t = 0; t < numFrames; t++) {
        logmel[t][m] = (float) ((logmel[t][m] - mean) * invStd);
      }
    }
  }

  // ---- FFT (radix-2, in-place, length 512) ----

  private static void fft(double[] re, double[] im) {
    for (int i = 0; i < FFT_LENGTH; i++) {
      int j = BITREV[i];
      if (j > i) {
        double tr = re[i]; re[i] = re[j]; re[j] = tr;
        double ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (int size = 2; size <= FFT_LENGTH; size <<= 1) {
      int half = size >> 1;
      int step = FFT_LENGTH / size;
      for (int start = 0; start < FFT_LENGTH; start += size) {
        for (int k = 0; k < half; k++) {
          int a = start + k;
          int b = a + half;
          double wr = COS[k * step];
          double wi = SIN[k * step];
          double xr = re[b] * wr - im[b] * wi;
          double xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] = re[a] + xr; im[a] = im[a] + xi;
        }
      }
    }
  }

  private static int[] bitReverseTable(int n) {
    int bits = Integer.numberOfTrailingZeros(n);
    int[] table = new int[n];
    for (int i = 0; i < n; i++) {
      int r = 0;
      for (int b = 0; b < bits; b++) if ((i & (1 << b)) != 0) r |= 1 << (bits - 1 - b);
      table[i] = r;
    }
    return table;
  }

  // ---- window + mel filter bank (exact port of transformers.audio_utils) ----

  private static double[] poveyWindow(int length) {
    // window_function(length, "povey", periodic=False) == np.power(np.hanning(length), 0.85)
    double[] w = new double[length];
    for (int n = 0; n < length; n++) {
      double hann = 0.5 - 0.5 * Math.cos(2.0 * Math.PI * n / (length - 1));
      w[n] = Math.pow(hann, 0.85);
    }
    return w;
  }

  private static double hertzToMel(double hz) {
    // mel_scale="kaldi"
    return 1127.0 * Math.log(1.0 + hz / 700.0);
  }

  private static double[][] melFilterBank() {
    double melMin = hertzToMel(MIN_MEL_HZ);
    double melMax = hertzToMel(MAX_MEL_HZ);
    double[] melFreqs = new double[NUM_MEL_BINS + 2];
    for (int i = 0; i < melFreqs.length; i++) {
      melFreqs[i] = melMin + (melMax - melMin) * i / (double) (melFreqs.length - 1);
    }
    // triangularize_in_mel_space=True: fft bin freqs and filter freqs both in mel space
    double fftBinWidth = RATE / (double) ((NUM_FREQ_BINS - 1) * 2);
    double[] fftFreqs = new double[NUM_FREQ_BINS];
    for (int i = 0; i < NUM_FREQ_BINS; i++) fftFreqs[i] = hertzToMel(fftBinWidth * i);
    double[][] filters = new double[NUM_FREQ_BINS][NUM_MEL_BINS];
    for (int k = 0; k < NUM_FREQ_BINS; k++) {
      for (int m = 0; m < NUM_MEL_BINS; m++) {
        double down = -(melFreqs[m] - fftFreqs[k]) / (melFreqs[m + 1] - melFreqs[m]);
        double up = (melFreqs[m + 2] - fftFreqs[k]) / (melFreqs[m + 2] - melFreqs[m + 1]);
        filters[k][m] = Math.max(0.0, Math.min(down, up));
      }
    }
    return filters;
  }
}
