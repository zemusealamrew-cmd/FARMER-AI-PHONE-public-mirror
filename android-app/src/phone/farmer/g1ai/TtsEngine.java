package phone.farmer.g1ai;

import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.util.Log;
import ai.onnxruntime.*;
import java.io.*;
import java.nio.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

public class TtsEngine {
  public static final int RATE = 16000;
  /**
   * G1 repair — Amharic punctuation (። ፣ ፤ ፥ ፦ ፧) is normalized to a safe SPACE before
   * tokenization: the approved VITS character vocab is Latin-only and has no ids for these, so
   * they used to be dropped silently and adjacent words ran together. Anything else that is
   * still absent from the vocab is counted and logged by describeDropped() — never silent.
   */
  private static final String AMHARIC_PUNCTUATION = "\u1362\u1363\u1364\u1365\u1366\u1367";

  private static String describeDropped(java.util.Map<Character, Integer> dropped) {
    if (dropped.isEmpty()) return "[]";
    StringBuilder sb = new StringBuilder("[");
    for (java.util.Map.Entry<Character, Integer> e : dropped.entrySet()) {
      if (sb.length() > 1) sb.append(", ");
      char c = e.getKey();
      if (c >= 0x20) sb.append('\'').append(c).append("'x").append(e.getValue());
      else sb.append(String.format("U+%04X", (int) c)).append("x").append(e.getValue());
    }
    return sb.append(']').toString();
  }

  /** Pure-Java tokenization result — unit-testable off-device (no Android/ORT calls). */
  static final class Tokenization {
    final long[] ids;
    final int normalizedPunct;
    final int droppedOov;
    final String droppedDetail;
    Tokenization(long[] ids, int normalizedPunct, int droppedOov, String droppedDetail) {
      this.ids = ids; this.normalizedPunct = normalizedPunct; this.droppedOov = droppedOov; this.droppedDetail = droppedDetail;
    }
  }

  /**
   * Normalizes Amharic punctuation to spaces, applies the uroman fallback and maps the result to
   * VITS char-vocab ids. Pure Java (vocab/uroman passed as JSONObject) so the text-handling rules
   * are unit-testable off-device. Every character absent from the vocab is counted AND described.
   */
  static Tokenization tokenizeForVits(String text, JSONObject vocab, JSONObject uroman) throws Exception {
    int punct = 0;
    char[] cs = text.toCharArray();
    for (int i = 0; i < cs.length; i++) {
      if (AMHARIC_PUNCTUATION.indexOf(cs[i]) >= 0) { cs[i] = ' '; punct++; }
    }
    String normalized = new String(cs);
    StringBuilder roman = new StringBuilder();
    for (int i = 0; i < normalized.length(); i++) {
      String ch = String.valueOf(normalized.charAt(i));
      roman.append(uroman.has(ch) ? uroman.getString(ch) : ch);
    }
    List<Long> ids = new ArrayList<>();
    java.util.Map<Character, Integer> dropped = new java.util.LinkedHashMap<>();
    String rs = roman.toString().toLowerCase();
    for (int i = 0; i < rs.length(); i++) {
      char ch = rs.charAt(i);
      String key = String.valueOf(ch);
      if (vocab.has(key)) ids.add((long) vocab.getInt(key));
      else dropped.merge(ch, 1, Integer::sum);
    }
    int droppedCount = 0;
    for (int n : dropped.values()) droppedCount += n;
    long[] arr = new long[ids.size()];
    for (int i = 0; i < arr.length; i++) arr[i] = ids.get(i);
    return new Tokenization(arr, punct, droppedCount, describeDropped(dropped));
  }

  /** Monotonic cancellation generation. AtomicInteger: volatile ++ was not atomic — two concurrent stopPlayback() calls could read the same value and one cancel could be swallowed. */
  private static final AtomicInteger GEN = new AtomicInteger(0);
  /** Current track. AtomicReference + CAS ownership: exactly ONE thread releases a given track (no double-release / cross-thread use after release). */
  private static final AtomicReference<AudioTrack> TRACK = new AtomicReference<>(null);
  /** v32 safety: while a telephony call is active, no new AI TTS playback may start. */
  private static final AtomicBoolean CALL_ACTIVE = new AtomicBoolean(false);
  public static void setCallActive(boolean active) {
    CALL_ACTIVE.set(active);
    if (active) stopPlayback();
    Log.i("G1CALL", "ttsCallActive=" + active);
  }
  public static boolean isCallActive() { return CALL_ACTIVE.get(); }
  private static String callSkip() {
    Log.i("G1TTS", "TTS skipped: telephone call active — AI audio suppressed");
    return "TTS_SKIPPED_IN_CALL: telephone call active; AI audio suppressed";
  }
  private static OrtEnvironment ENV;
  private static OrtSession SESS;
  private static boolean WARM = false;
  private final Context ctx;
  public TtsEngine(Context c) { this.ctx = c; }

  /** Cancels current and any pending playback. Thread-safe; atomic bump guarantees no swallowed cancels. */
  public static void stopPlayback() {
    GEN.incrementAndGet();
    AudioTrack t = TRACK.getAndSet(null);
    if (t != null) { try { t.pause(); t.flush(); t.stop(); t.release(); } catch (Exception ignored) {} }
  }

  /** Release tr ONLY if we still own it (CAS). At most one caller ever releases a given track. */
  private static boolean releaseIfOwner(AudioTrack tr) {
    if (tr == null) return false;
    if (TRACK.compareAndSet(tr, null)) { try { tr.pause(); tr.stop(); tr.release(); } catch (Exception ignored) {} return true; }
    return false;
  }

  /** Lifecycle cleanup — releases static ORT session/env. */
  public static synchronized void shutdown() {
    stopPlayback();
    OrtSession s = SESS; SESS = null; WARM = false;
    if (s != null) { try { s.close(); } catch (Exception ignored) {} }
    OrtEnvironment e = ENV; ENV = null;
    if (e != null) { try { e.close(); } catch (Exception ignored) {} }
  }

  private File asset(String name, File out) throws Exception {
    if (out.exists() && out.length() > 1000) return out;
    InputStream in = null;
    for (String p : new String[]{"tts/" + name, "tts\\" + name}) { try { in = ctx.getAssets().open(p); break; } catch (Exception ignored) {} }
    if (in == null) throw new FileNotFoundException("asset tts/" + name);
    FileOutputStream fo = new FileOutputStream(out);
    byte[] b = new byte[1 << 20]; int n; while ((n = in.read(b)) > 0) fo.write(b, 0, n);
    fo.close(); in.close(); return out;
  }

  /**
   * v25 FIX (staging audit): the approved model files are NEVER packaged in the APK
   * (weights are not committed — verified), so the packaged-assets-only lookup could not
   * find vits.onnx on a real device even after the owner pushed it. Resolution order now:
   *   1) external-files /tts  (v29 transfer package + owner staging paths)
   *   2) internal files/tts   (v29 transfer package fallback + previous asset copy)
   *   3) packaged assets/tts  (vocabulary only in this build; vits.onnx absent — verified)
   */
  private File resolveModelFile() throws Exception {
    File ext = ctx.getExternalFilesDir(null);
    File extModel = ext == null ? null : new File(ext, "tts/vits.onnx");
    if (extModel != null && extModel.exists() && extModel.length() > 1000) {
      Log.i("G1TTS", "model=" + extModel.getAbsolutePath() + " bytes=" + extModel.length() + " source=external-files/tts");
      return extModel;
    }
    File dir = new File(ctx.getFilesDir(), "tts"); dir.mkdirs();
    File intModel = new File(dir, "vits.onnx");
    if (intModel.exists() && intModel.length() > 1000) {
      Log.i("G1TTS", "model=" + intModel.getAbsolutePath() + " bytes=" + intModel.length() + " source=internal-files/tts");
      return intModel;
    }
    File m = asset("vits.onnx", intModel);
    Log.i("G1TTS", "model=" + m.getAbsolutePath() + " bytes=" + m.length() + " source=assets/tts");
    return m;
  }

  /**
   * v29: Oromo TTS lookup (OPTIONAL — facebook/mms-tts-orm export, staged from the
   * transfer package). Returns null when not staged; the caller then speaks Amharic
   * (the Oromo-TTS GAP is logged explicitly — never silently hidden).
   */
  private File resolveOrmModelFile() {
    File ext = ctx.getExternalFilesDir(null);
    if (ext != null) {
      File f = new File(ext, "tts/vits-orm.onnx");
      if (f.exists() && f.length() > 1000) return f;
    }
    File f = new File(ctx.getFilesDir(), "tts/vits-orm.onnx");
    if (f.exists() && f.length() > 1000) return f;
    return null;
  }

  /** v29: Oromo vocab lookup — transfer-packaged vocab-orm.json, else Amharic asset fallback. */
  private File resolveOrmVocab() throws Exception {
    File ext = ctx.getExternalFilesDir(null);
    if (ext != null) {
      File f = new File(ext, "tts/vocab-orm.json");
      if (f.exists() && f.length() > 0) return f;
    }
    File f = new File(ctx.getFilesDir(), "tts/vocab-orm.json");
    if (f.exists() && f.length() > 0) return f;
    File dir = new File(ctx.getFilesDir(), "tts"); dir.mkdirs();
    return asset("vocab.json", new File(dir, "vocab.json"));
  }

  /**
   * v31: speak() overload that picks the TTS model by the ASR language tag.
   * ORM replies use vits-orm.onnx ONLY when an approved Oromo voice is staged.
   * If it is absent, the reply is NOT spoken with the Amharic model: a wrong-language
   * voice is misleading for the farmer. The call returns an explicit skipped status and
   * the UI/TTS caller logs it (G1 gap surfaced, not hidden).
   */
  public String speak(String text, String lang) throws Exception {
    if (CALL_ACTIVE.get()) return callSkip();
    // FINAL-OUTPUT SAFETY GATE: even AI text that was not flagged at the query stage is checked for
    // numeric dose/administration content before synthesis; the gate result is what gets spoken.
    text = SafetyGuard.ttsGate(null, lang, text);
    if ("ORM".equals(lang)) {
      File ormModel = resolveOrmModelFile();
      if (ormModel != null) return speakInternal(text, ormModel, resolveOrmVocab(), true);
      Log.i("G1TTS", "ORM reply requested but vits-orm.onnx NOT staged — Amharic fallback DISABLED; reply not spoken (no approved Oromo voice)");
      return "TTS_SKIPPED_NO_OROMO_VOICE: reply not spoken (no approved Oromo voice; Amharic fallback disabled)";
    }
    return speak(text);
  }

  public String speak(String text) throws Exception {
    if (CALL_ACTIVE.get()) return callSkip();
    text = SafetyGuard.ttsGate(null, "AMH", text);
    return speakInternal(text, resolveModelFile(), null, true);
  }

  /**
   * PRIVACY variant for SMS content: identical synthesis/playback, but the dropped-character LIST
   * is redacted in the G1TTS log lines (counts are still logged). SMS bodies are never allowed to
   * leak even partially into logcat, and the only dropped characters would come from the body.
   */
  public String speakPrivate(String text) throws Exception {
    if (CALL_ACTIVE.get()) return callSkip();
    return speakInternal(text, resolveModelFile(), null, false);
  }

  private String speakInternal(String text, File model, File ormVocab, boolean logDroppedChars) throws Exception {
    long t0 = System.currentTimeMillis(); long tLoad, tTok, tSess, tInfer, tPlay;
    int myGen = GEN.get(); // captured BEFORE heavy work: a stop arriving during load/infer/write invalidates this run
    File dir = new File(ctx.getFilesDir(), "tts"); dir.mkdirs();
    File vocab = (ormVocab != null) ? ormVocab : asset("vocab.json", new File(dir, "vocab.json"));
    byte[] vb = new byte[(int) vocab.length()]; FileInputStream vf = new FileInputStream(vocab); vf.read(vb); vf.close(); JSONObject v = new JSONObject(new String(vb, "UTF-8"));
    if (text == null) return "TTS tokenize empty (null text)";
    File ur = asset("uroman.json", new File(dir, "uroman.json"));
    byte[] ub = new byte[(int) ur.length()]; FileInputStream uf = new FileInputStream(ur); uf.read(ub); uf.close(); JSONObject um = new JSONObject(new String(ub, "UTF-8"));
    // G1 repair — normalize Amharic punctuation to safe separators BEFORE tokenization, then
    // COUNT AND LOG every character still absent from the vocab (no silent drops). The pure
    // tokenizer is tokenizeForVits() so these rules are unit-tested off-device.
    final Tokenization tk = tokenizeForVits(text, v, um);
    final int punct = tk.normalizedPunct;
    final int droppedCount = tk.droppedOov;
    tLoad = System.currentTimeMillis();
    List<Long> ids = new ArrayList<>();
    for (long id : tk.ids) ids.add(id);
    Log.i("G1TTS", "text normalized: amharicPunctuation=" + punct + " chars->space; droppedOov=" + droppedCount
        + " chars " + (logDroppedChars ? tk.droppedDetail : "[redacted: private SMS content]"));
    if (ids.isEmpty()) return "TTS tokenize empty (normalizedPunct=" + punct + ", droppedOov=" + droppedCount + ")";
    java.util.List<Long> blanked = new ArrayList<>();
    blanked.add(0L);
    for (Long id : ids) { blanked.add(id); blanked.add(0L); }
    ids = blanked;
    long[] arr = new long[ids.size()]; for (int i = 0; i < arr.length; i++) arr[i] = ids.get(i);
    tTok = System.currentTimeMillis();
    boolean reused = WARM && SESS != null;
    tSess = System.currentTimeMillis();
    if (!reused) { ENV = OrtEnvironment.getEnvironment(); OrtSession.SessionOptions so = new OrtSession.SessionOptions(); SESS = ENV.createSession(model.getAbsolutePath(), so); WARM = true; }
    tSess = System.currentTimeMillis() - tSess;
    OrtEnvironment env = ENV; OrtSession sess = SESS;
    Map<String, OnnxTensor> inputs = new HashMap<>();
    inputs.put("input_ids", OnnxTensor.createTensor(env, LongBuffer.wrap(arr), new long[]{1, arr.length}));
    long ti = System.currentTimeMillis();
    OrtSession.Result res = sess.run(inputs);
    tInfer = System.currentTimeMillis() - ti;
    float[][] wav = (float[][]) ((OnnxTensor) res.get(0)).getValue();
    int nSamples = wav[0].length;
    short[] pcm = new short[nSamples];
    for (int i = 0; i < nSamples; i++) { float x = Math.max(-1f, Math.min(1f, wav[0][i])); pcm[i] = (short) (x * 32767); }
    if (GEN.get() != myGen) return "TTS cancelled before play (gen " + myGen + ")";
    long tp = System.currentTimeMillis();
    int min = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
    AudioTrack tr = new AudioTrack(AudioManager.STREAM_MUSIC, RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, pcm.length * 2), AudioTrack.MODE_STATIC);
    try {
      tr.write(pcm, 0, pcm.length);
    } catch (Exception e) {
      try { tr.release(); } catch (Exception ignored) {}
      return "TTS write interrupted: " + e;
    }
    if (GEN.get() != myGen) { try { tr.release(); } catch (Exception ignored) {} return "TTS cancelled before play (gen " + myGen + ")"; }
    AudioTrack prev = TRACK.getAndSet(tr);
    if (prev != null && prev != tr) { try { prev.pause(); prev.stop(); prev.release(); } catch (Exception ignored) {} } // never leak a stale track
    tr.play();
    Log.i("G1TTS", "playbackStart samples=" + nSamples + " gen=" + myGen);
    // True playback completion: poll head position; cancel on generation change or lost ownership; deadline is a safety net only.
    long deadline = tp + (nSamples * 1000L / RATE) + 500;
    boolean cancelled = false;
    while (System.currentTimeMillis() < deadline) {
      if (GEN.get() != myGen) { cancelled = true; break; }
      if (TRACK.get() != tr) { cancelled = true; break; }
      if (tr.getPlaybackHeadPosition() >= nSamples) break;
      Thread.sleep(25);
    }
    releaseIfOwner(tr);
    tPlay = System.currentTimeMillis() - tp;
    // write WAV evidence (NEVER for private/SMS content: no private text is persisted to files/)
    if (logDroppedChars) try {
      java.io.ByteArrayOutputStream wb = new java.io.ByteArrayOutputStream();
      java.nio.ByteBuffer h = java.nio.ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN);
      h.put("RIFF".getBytes()); h.putInt(36 + pcm.length * 2); h.put("WAVE".getBytes()); h.put("fmt ".getBytes()); h.putInt(16); h.putShort((short) 1); h.putShort((short) 1); h.putInt(RATE); h.putInt(RATE * 2); h.putShort((short) 2); h.putShort((short) 16); h.put("data".getBytes()); h.putInt(pcm.length * 2); wb.write(h.array());
      for (short s : pcm) { wb.write(s & 0xff); wb.write((s >> 8) & 0xff); }
      File wf = new File(dir, "tts_out.wav"); FileOutputStream wo = new FileOutputStream(wf); wo.write(wb.toByteArray()); wo.close();
      Log.i("G1TTS", "WAV=" + wf.getAbsolutePath() + " bytes=" + wf.length());
    } catch (Exception ignored) {}
    long t3 = System.currentTimeMillis();
    Log.i("G1TTS", "model=" + model.getName() + " tokens=" + arr.length + " samples=" + nSamples + " reused=" + reused + " cancelled=" + cancelled + " normalizedPunct=" + punct + " droppedOov=" + droppedCount + " chars "
        + (logDroppedChars ? tk.droppedDetail : "[redacted: private SMS content]") + " load=" + (tLoad-t0) + "ms tokenize=" + (tTok-tLoad) + "ms session=" + tSess + "ms infer=" + tInfer + "ms play=" + tPlay + "ms total=" + (t3-t0) + "ms");
    return "TTS OK: model=" + model.getName() + ", tokens=" + arr.length + ", samples=" + nSamples + " (" + (nSamples / (double) RATE) + "s), normalizedPunct=" + punct + ", droppedOov=" + droppedCount + ", load=" + (tLoad-t0) + "ms, infer=" + tInfer + "ms, play=" + tPlay + "ms, cancelled=" + cancelled + ", " + (logDroppedChars ? "WAV saved" : "WAV not saved (private SMS content)");
  }
}
