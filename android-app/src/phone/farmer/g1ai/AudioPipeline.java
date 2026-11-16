package phone.farmer.g1ai;

import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

public class AudioPipeline {
  public interface Listener { void onResult(String msg); }
  /** ASR capture listener — receives raw 16 kHz mono float PCM after capture ends.
   *  ADDITIVE (v17): existing Listener/playback paths unchanged; when asrListener is set
   *  the capture result is ALSO delivered to ASR. */
  public interface AsrListener { void onCaptured(float[] pcm, long voicedMs, int peak); }
  public static final int RATE = 16000;
  private static final int MIN_RMS = 350;
  private AudioRecord rec;
  /** Monotonic playback generation — AtomicInteger (volatile ++ was not atomic). */
  private static final AtomicInteger PLAY_GEN = new AtomicInteger(0);
  /** Current playback track — AtomicReference + CAS ownership: exactly one releaser, no double-release. */
  private static final AtomicReference<AudioTrack> PLAY_TRACK = new AtomicReference<>(null);
  private Thread thread;
  private volatile boolean recording = false;
  private volatile AsrListener asrListener = null;

  /** Sets the ASR consumer. Null disables ASR delivery (pure echo test path, unchanged). */
  public void setAsrListener(AsrListener l) { this.asrListener = l; }

  public synchronized void start(final Listener l) {
    if (recording) return;
    int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
    try {
      rec = new AudioRecord(MediaRecorder.AudioSource.MIC, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, RATE * 2));
      if (rec.getState() != AudioRecord.STATE_INITIALIZED) { Log.e("G1AUDIO","AudioRecord INIT FAILED"); l.onResult("AudioRecord INIT FAILED"); return; }
      rec.startRecording(); recording = true;
      thread = new Thread(() -> {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[3200]; long voicedMs = 0; long total = 0; int peak = 0;
        long end = System.currentTimeMillis() + 4000;
        while (recording && System.currentTimeMillis() < end) {
          int n = rec.read(buf, 0, buf.length);
          if (n > 0) {
            bos.write(buf, 0, n); total += n / 2;
            int sum = 0; for (int i = 0; i + 1 < n; i += 2) { int v = (short) ((buf[i] & 0xff) | (buf[i+1] << 8)); sum += v * v; if (Math.abs(v) > peak) peak = Math.abs(v); }
            int rms = (int) Math.sqrt(sum / Math.max(1, n / 2));
            if (rms > MIN_RMS) voicedMs += (n / 2) * 1000 / RATE;
          }
        }
        stopRec();
        byte[] pcm = bos.toByteArray();
        // ADDITIVE (v17): deliver raw capture to the ASR consumer when set.
        // 16-bit PCM -> float [-1,1] conversion for AsrEngine.transcribe().
        AsrListener asr = asrListener;
        if (asr != null && pcm.length >= 2 * RATE) { // >=1s of audio
          float[] floats = new float[pcm.length / 2];
          for (int i = 0; i < floats.length; i++) {
            int v = (short) ((pcm[2*i] & 0xff) | (pcm[2*i+1] << 8));
            floats[i] = v / 32768f;
          }
          try { asr.onCaptured(floats, voicedMs, peak); }
          catch (Exception e) { Log.e("G1AUDIO", "ASR delivery FAILED", e); }
        }
        // v18 (owner instruction 2026-11-13): in ASR voice-loop mode there is NO echo
        // playback after the ASR callback. Playing the just-captured audio back through
        // the speaker immediately after capture is an unwanted audible repeat and a
        // mic re-capture hazard (speaker->mic feedback) on real devices. Recording has
        // already stopped (stopRec above), so no re-capture can occur WITHIN this cycle;
        // skipping the speaker output entirely removes the cross-cycle hazard too.
        // The plain mic_test echo path (asrListener == null) is preserved byte-for-byte.
        String play;
        if (asr != null) play = "AudioTrack skipped (ASR voice-loop mode — no echo after ASR callback)";
        else play = play(pcm);
        Log.i("G1AUDIO","captured result"); l.onResult("AudioRecord OK: " + total + " samples, voicedMs=" + voicedMs + ", peak=" + peak + "; " + play);
      });
      thread.start();
    } catch (Exception e) { Log.e("G1AUDIO","AudioRecord FAILED", e); l.onResult("AudioRecord FAILED: " + e); }
  }

  /** Stops recording and cancels playback. Thread-safe; atomic bump — no swallowed cancels. */
  public synchronized void stop() {
    PLAY_GEN.incrementAndGet();
    recording = false;
    AudioTrack t = PLAY_TRACK.getAndSet(null);
    if (t != null) { try { t.pause(); t.flush(); t.stop(); t.release(); } catch (Exception ignored) {} }
  }

  private void stopRec() { try { if (rec != null) { rec.stop(); rec.release(); rec = null; } } catch (Exception ignored) {} recording = false; }

  private static boolean releaseIfOwner(AudioTrack t) {
    if (t == null) return false;
    if (PLAY_TRACK.compareAndSet(t, null)) { try { t.pause(); t.stop(); t.release(); } catch (Exception ignored) {} return true; }
    return false;
  }

  private String play(byte[] pcm) {
    if (pcm.length < 1000) return "AudioTrack skipped (no audio)";
    int myGen = PLAY_GEN.get();
    try {
      int min = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
      AudioTrack t = new AudioTrack(AudioManager.STREAM_MUSIC, RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, pcm.length), AudioTrack.MODE_STATIC);
      try {
        t.write(pcm, 0, pcm.length);
      } catch (Exception e) {
        try { t.release(); } catch (Exception ignored) {}
        return "AudioTrack write interrupted: " + e;
      }
      if (PLAY_GEN.get() != myGen) { try { t.release(); } catch (Exception ignored) {} return "AudioTrack cancelled"; }
      AudioTrack prev = PLAY_TRACK.getAndSet(t);
      if (prev != null && prev != t) { try { prev.pause(); prev.stop(); prev.release(); } catch (Exception ignored) {} }
      t.play();
      int totalSamples = pcm.length / 2;
      long deadline = System.currentTimeMillis() + (totalSamples * 1000L / RATE) + 200;
      while (System.currentTimeMillis() < deadline) {
        if (PLAY_GEN.get() != myGen) return "AudioTrack cancelled";
        if (PLAY_TRACK.get() != t) return "AudioTrack cancelled";
        if (t.getPlaybackHeadPosition() >= totalSamples) break;
        Thread.sleep(25);
      }
      releaseIfOwner(t);
      Log.i("G1AUDIO","AudioTrack played " + pcm.length + " bytes"); return "AudioTrack played " + pcm.length + " bytes";
    } catch (Exception e) { Log.e("G1AUDIO","AudioTrack FAILED", e); return "AudioTrack FAILED: " + e; }
  }
}
