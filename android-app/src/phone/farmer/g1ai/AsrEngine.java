package phone.farmer.g1ai;

import android.content.Context;
import android.util.Log;
import ai.onnxruntime.*;
import java.io.*;
import java.nio.*;
import java.util.*;
import org.json.JSONObject;

/**
 * G1 ASR — offline Amharic/Afaan Oromo speech-to-text on the approved
 * badrex/Ethio-ASR-multilingual-600M ONNX export (see research/onnx-export-20261111/export-report.json:
 * sha256 3d8ed3db…58a4, EXPORTED_AND_VERIFIED on real audio, same token IDs + text vs torch).
 *
 * MODEL CONTRACT (verified from export.py + tools/asr_wer_cer.py — do not change):
 *   input : "input_features"  float32 [1, frames, 160]  (SeamlessM4T 80-bin log-mel,
 *           stride-2 stacked; see AsrFeatures.java — pinned preprocessor_config.json)
 *   output: "logits"           float32 [1, frames, vocab]
 *   decode: CTC collapse — drop blank id 408 and consecutive repeats
 *   vocab : '|' = word separator; leading '[AMH]' / '[ORM]' = language tag
 *
 * v25 FIX (staging audit — owner instruction 2026-11-13: "do not assume staging works"):
 *   locate() previously searched ONLY internal files/asr and packaged assets. The external-files
 *   path (plain `adb push ... /sdcard/Android/data/phone.farmer.g1ai/files/asr/`, no run-as) —
 *   the path the v24 Model Status button recommends — was NEVER read. Now searched:
 *     1) internal files/asr      (adb push via run-as, or previous asset copy)
 *     2) external-files /asr    (plain adb push — the documented A53 staging path)
 *     3) packaged assets/asr    (copy to internal files/asr-staged for reuse)
 *   Same order for locateInt8(). Companion (.data/.bin) check applies to whichever dir wins.
 *
 * v23: releaseSession() frees the fp32 ASR session without closing the JVM-wide OrtEnvironment
 *   (TtsEngine shares it) — enforces the sequential-stage RAM constraint documented in
 *   docs/builder3/asr-integration-path-20261112.md (ASR peak 1.55–1.65 GB must not co-reside
 *   with the ~2.5 GB Qwen3-4B LLM).
 * v21: checked JSONException handling in loadVocab — logged explicitly, rethrown as IOException.
 * v17: optional int8 RESEARCH COMPARISON session — separate from the approved fp32 primary;
 *   never replaces it. Result.argmaxIds for parity probes.
 *
 * FILES THE OWNER MUST STAGE (none are in the repo — verified):
 *   asr.onnx + external-data companion (.data/.bin) + vocab.json + featspec.json
 *   (approved fp32 — PRIMARY; files/asr-int8/ research copy for comparison only)
 */
public class AsrEngine {
  public static final int RATE = 16000;
  /** CTC blank id — verified in tools/asr_wer_cer.py (BLANK_ID = 408). */
  static final int BLANK_ID = 408;

  private static OrtEnvironment ENV;
  private static OrtSession SESS;
  private static String MODEL_PATH_IN_USE;
  private static OrtSession SESS_INT8;          // research comparison copy — separate session
  private static String MODEL_INT8_PATH_IN_USE; // research comparison copy path
  private final Context ctx;

  public AsrEngine(Context c) { this.ctx = c; }

  /** Lifecycle cleanup — mirrors TtsEngine.shutdown() discipline (full teardown, incl. env). */
  public static synchronized void shutdown() {
    OrtSession s = SESS; SESS = null; MODEL_PATH_IN_USE = null;
    if (s != null) { try { s.close(); } catch (Exception ignored) {} }
    OrtSession s8 = SESS_INT8; SESS_INT8 = null; MODEL_INT8_PATH_IN_USE = null;
    if (s8 != null) { try { s8.close(); } catch (Exception ignored) {} }
    OrtEnvironment e = ENV; ENV = null;
    if (e != null) { try { e.close(); } catch (Exception ignored) {} }
  }

  /**
   * v23: releases ONLY the approved fp32 session (and the int8 research session),
   * WITHOUT closing the JVM-wide OrtEnvironment singleton that TtsEngine also holds.
   * The voice loop calls this after each transcription so ASR weights are freed before
   * the LLM runs. Closing the session frees the ORT weight allocations; env stays for TTS.
   */
  public static synchronized void releaseSession() {
    OrtSession s = SESS; SESS = null; MODEL_PATH_IN_USE = null;
    if (s != null) { try { s.close(); } catch (Exception ignored) {} }
    OrtSession s8 = SESS_INT8; SESS_INT8 = null; MODEL_INT8_PATH_IN_USE = null;
    if (s8 != null) { try { s8.close(); } catch (Exception ignored) {} }
  }

  private static class Staged {
    final File model, vocab, featspec;
    Staged(File m, File v, File f) { model = m; vocab = v; featspec = f; }
  }

  /** Copies an asset to out if missing. Returns null when the asset does not exist. */
  private static File asset(Context ctx, String name, File out) throws IOException {
    if (out.exists() && out.length() > 0) return out;
    InputStream in = null;
    for (String p : new String[]{"asr/" + name, "asr\\" + name, "asr-int8/" + name, "asr-int8\\" + name}) {
      try { in = ctx.getAssets().open(p); break; } catch (Exception ignored) {}
    }
    if (in == null) return null;
    FileOutputStream fo = new FileOutputStream(out);
    byte[] b = new byte[1 << 20]; int n;
    while ((n = in.read(b)) > 0) fo.write(b, 0, n);
    fo.close(); in.close();
    return out;
  }

  /**
   * v25: candidate directories a staged model set may live in, in priority order:
   * internal files/asr, then external-files /asr (plain adb push — no run-as needed).
   */
  private File[] asrDirs() {
    File ext = ctx.getExternalFilesDir(null);
    return new File[] { new File(ctx.getFilesDir(), "asr"), ext == null ? null : new File(ext, "asr") };
  }
  private File[] asrInt8Dirs() {
    File ext = ctx.getExternalFilesDir(null);
    return new File[] { new File(ctx.getFilesDir(), "asr-int8"), ext == null ? null : new File(ext, "asr-int8") };
  }

  /** True when dir holds a usable model set (model + vocab present, readable). */
  private static boolean hasSet(File dir, String modelName) {
    return dir != null && dir.isDirectory()
        && new File(dir, modelName).exists() && new File(dir, modelName).length() > 0
        && new File(dir, "vocab.json").exists();
  }

  /**
   * Locates the staged model set (v25 order): internal files/asr -> external-files /asr
   * -> packaged assets/asr (copied to files/asr-staged). Logs which path was used and
   * whether the external-data companion file is present — the fp32 export will fail to
   * load without it.
   */
  private Staged locate() throws Exception {
    for (File dir : asrDirs()) {
      if (hasSet(dir, "asr.onnx")) {
        String companion = null;
        String base = new File(dir, "asr.onnx").getAbsolutePath();
        for (String ext : new String[]{".data", ".bin", "_data"}) {
          File c = new File(base + ext);
          if (c.exists()) { companion = c.getName(); break; }
        }
        if (companion == null) {
          // previous rank may have renamed the companion to the ONNX-recorded name already
          try {
            String rec = recordedExternalDataName(new File(dir, "asr.onnx"));
            if (rec != null && new File(dir, rec).exists()) companion = rec;
          } catch (Exception ignored) {}
        }
        Log.i("G1ASR", "model=" + base + " bytes=" + new File(dir, "asr.onnx").length()
            + " companion=" + (companion != null ? companion : "<none — fp32 export may fail to load>")
            + " source=" + dir.getAbsolutePath());
        File model = new File(dir, "asr.onnx");
        File comp = companion == null ? null : new File(dir, companion);
        ensureExternalDataName(model, comp);
        return new Staged(model, new File(dir, "vocab.json"), new File(dir, "featspec.json"));
      }
    }
    // packaged-asset fallback (copy to internal for reuse)
    File dirA = new File(ctx.getFilesDir(), "asr-staged"); dirA.mkdirs();
    File m = asset(ctx, "asr.onnx", new File(dirA, "asr.onnx"));
    File v = asset(ctx, "vocab.json", new File(dirA, "vocab.json"));
    File f = asset(ctx, "featspec.json", new File(dirA, "featspec.json"));
    if (m == null || v == null)
      throw new FileNotFoundException("ASR model not staged: no files/asr/, no external-files asr/, and no assets/asr/ in APK. Owner must stage the approved export (asr.onnx + external-data companion + vocab.json + featspec.json).");
    String companion = null;
    String base = m.getAbsolutePath();
    for (String ext : new String[]{".data", ".bin", "_data"}) {
      File c = new File(base + ext);
      if (c.exists()) { companion = c.getName(); break; }
    }
    Log.i("G1ASR", "model=" + base + " bytes=" + m.length() + " companion=" + (companion != null ? companion : "<none — fp32 export may fail to load>") + " source=assets(asr-staged)");
    ensureExternalDataName(m, companion == null ? null : new File(dirA, companion));
    return new Staged(m, v, f);
  }

  /**
   * 2026-11-14 REPAIR (DEF-ASR-EXTDATA-NAME): the ONNX model records the external-data file
   * name INSIDE the model (for the approved export: ethio-asr-wav2vec2bert.onnx.data), and
   * ORT resolves that exact name relative to the model path. The approved staging procedure
   * names the file asr.onnx.data, so ORT failed with "in file_size: No such file" while the
   * bytes were present. Before opening the session we read the recorded name from the model
   * bytes and create a same-directory hardlink (symlink fallback) under that name. The staged
   * names, pins and the documented transfer path stay unchanged; no bytes are copied.
   */
  private static String recordedExternalDataName(File model) throws IOException {
    final int max = 8 << 20;
    final byte[] b = new byte[(int) Math.min(model.length(), max)];
    try (FileInputStream fi = new FileInputStream(model)) {
      int off = 0, n;
      while (off < b.length && (n = fi.read(b, off, b.length - off)) > 0) off += n;
    }
    final String s = new String(b, "ISO-8859-1");
    int idx = s.indexOf(".onnx.data");
    if (idx < 0) idx = s.indexOf(".onnx.bin");
    if (idx < 0) return null;
    int end = idx + (s.startsWith(".onnx.bin", idx) ? ".onnx.bin".length() : ".onnx.data".length());
    int start = idx;
    while (start > 0) {
      char c = s.charAt(start - 1);
      if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.') start--;
      else break;
    }
    return s.substring(start, end);
  }

  private static void ensureExternalDataName(File model, File companion) {
    if (model == null || companion == null || !companion.exists()) return;
    try {
      final String rec = recordedExternalDataName(model);
      if (rec == null || rec.isEmpty()) {
        Log.w("G1ASR", "external-data recorded name not found in ONNX; relying on staged name " + companion.getName());
        return;
      }
      final File expected = new File(model.getParentFile(), rec);
      if (expected.exists() || expected.equals(companion)) {
        Log.i("G1ASR", "external-data name OK: " + rec);
        return;
      }
      boolean linked = false;
      try {
        android.system.Os.link(companion.getAbsolutePath(), expected.getAbsolutePath());
        linked = true;
      } catch (Throwable t) {
        Log.w("G1ASR", "hardlink " + companion.getName() + " -> " + rec + " failed (" + t + "); trying symlink");
        try {
          android.system.Os.symlink(companion.getAbsolutePath(), expected.getAbsolutePath());
          linked = true;
        } catch (Throwable t2) {
          Log.e("G1ASR", "cannot link external data under recorded name " + rec + ": " + t2);
        }
      }
      if (!(linked && expected.exists())) {
        // FUSE/MediaProvider denies app-created hardlinks/symlinks (EACCES). A same-directory
        // RENAME is permitted, needs no extra space, and puts the same bytes under the name
        // ORT resolves. This is the owner-path fix.
        if (companion.renameTo(expected)) {
          linked = true;
          Log.i("G1ASR", "external-data RENAMED staged " + companion.getName() + " -> ONNX-recorded " + rec + " (same bytes, no copy)");
        } else {
          Log.e("G1ASR", "EXTERNAL DATA MISMATCH: ONNX requires " + rec + " next to " + model.getName()
              + "; link and rename both failed (staged=" + companion.getName() + ")");
        }
      } else {
        Log.i("G1ASR", "external-data linked under ONNX-recorded name " + rec + " (staged=" + companion.getName() + ")");
      }
    } catch (Throwable t) {
      Log.e("G1ASR", "external-data name check failed (continuing; ORT may report a filesystem error)", t);
    }
  }

  /**
   * Locates the RESEARCH int8 comparison copy (optional; v25 external path added).
   * NEVER used as primary — only via transcribeInt8Compare(). Returns null when not staged.
   */
  private Staged locateInt8() throws Exception {
    for (File dir : asrInt8Dirs()) {
      if (hasSet(dir, "asr-int8.onnx")) {
        Log.i("G1ASR", "int8 research copy=" + new File(dir, "asr-int8.onnx").getAbsolutePath()
            + " bytes=" + new File(dir, "asr-int8.onnx").length() + " source=" + dir.getAbsolutePath()
            + " (COMPARISON ONLY — never the primary model)");
        return new Staged(new File(dir, "asr-int8.onnx"), new File(dir, "vocab.json"), new File(dir, "featspec.json"));
      }
    }
    File dirA = new File(ctx.getFilesDir(), "asr-int8-staged"); dirA.mkdirs();
    File m = asset(ctx, "asr-int8.onnx", new File(dirA, "asr-int8.onnx"));
    File v = asset(ctx, "vocab.json", new File(dirA, "vocab.json"));
    File f = asset(ctx, "featspec.json", new File(dirA, "featspec.json"));
    if (m == null || v == null) return null;
    Log.i("G1ASR", "int8 research copy=" + m.getAbsolutePath() + " bytes=" + m.length() + " source=assets(asr-int8-staged) (COMPARISON ONLY)");
    return new Staged(m, v, f);
  }

  // v26 REPAIR: the old private float[] features(float[] pcm) (rank-2 z-scored raw PCM,
  // [1, N] tensor) was WRONG for this model and has been removed. Feature extraction now
  // lives in AsrFeatures.extract()/flatten() (SeamlessM4T 80-bin fbank, stride-2, 160 dims),
  // exactly matching the pinned preprocessor_config.json. See AsrFeatures.java.

  /** CTC collapse + vocab decode — the verified rule from tools/asr_wer_cer.py. */
  private static String decode(long[] argmax, Map<Integer, String> idToPiece, String[] langOut) {
    StringBuilder out = new StringBuilder();
    int prev = BLANK_ID;
    for (long idL : argmax) {
      int id = (int) idL;
      if (id == BLANK_ID) { prev = BLANK_ID; continue; }
      if (id != prev) out.append(idToPiece.getOrDefault(id, ""));
      prev = id;
    }
    String text = out.toString().replace("<pad>", "").replace("<s>", "").replace("</s>", "").replace("|", " ");
    // REPAIR 2026-11-13: capture the language tag BEFORE stripping it. The old code stripped
    // [AMH]/[ORM] here and then tested text.startsWith("[ORM]") afterwards, so the language was
    // ALWAYS reported as AMH (Oromo replies were routed to Amharic TTS). The tag is part of the
    // model contract and must not be lost.
    if (langOut != null) {
      langOut[0] = text.trim().startsWith("[ORM]") ? "ORM" : (text.trim().startsWith("[AMH]") ? "AMH" : null);
    }
    for (String tag : new String[]{"[AMH]", "[ORM]"}) {
      if (text.startsWith(tag)) { text = text.substring(tag.length()); break; }
    }
    return text.trim();
  }

  /**
   * v21 FIX: Android org.json.JSONException is CHECKED; every JSON failure is
   * LOGGED EXPLICITLY (path, size, cause) and rethrown as a descriptive IOException —
   * the error is surfaced, never hidden.
   */
  private static Map<Integer, String> loadVocab(File vocabFile) throws IOException {
    byte[] b = new byte[(int) vocabFile.length()];
    try (FileInputStream fi = new FileInputStream(vocabFile)) { fi.read(b); }
    final JSONObject v;
    try {
      v = new JSONObject(new String(b, "UTF-8"));
    } catch (org.json.JSONException e) {
      Log.e("G1ASR", "vocab.json parse FAILED: file=" + vocabFile.getAbsolutePath() + " bytes=" + b.length + " cause=" + e.getMessage());
      throw new IOException("vocab.json parse failed at " + vocabFile.getAbsolutePath() + " (" + b.length + " bytes): " + e.getMessage(), e);
    }
    Map<Integer, String> idToPiece = new HashMap<>();
    for (Iterator<String> it = v.keys(); it.hasNext(); ) {
      String piece = it.next();
      try {
        idToPiece.put(v.getInt(piece), piece);
      } catch (org.json.JSONException e) {
        Log.e("G1ASR", "vocab.json bad id for piece '" + piece + "' in " + vocabFile.getAbsolutePath() + ": " + e.getMessage());
        throw new IOException("vocab.json bad id for piece '" + piece + "' in " + vocabFile.getAbsolutePath() + ": " + e.getMessage(), e);
      }
    }
    return idToPiece;
  }

  public static class Result {
    public final String text; public final String language; public final long inferMs; public final int frames;
    public final long[] argmaxIds; // raw per-frame argmax (parity probes use this)
    Result(String t, String l, long ms, int fr, long[] ids) { text = t; language = l; inferMs = ms; frames = fr; argmaxIds = ids; }
  }

  private OrtSession sessionFor(Staged st, boolean int8) throws Exception {
    synchronized (AsrEngine.class) {
      ENV = (ENV == null) ? OrtEnvironment.getEnvironment() : ENV;
      if (int8) {
        if (SESS_INT8 == null || !st.model.getAbsolutePath().equals(MODEL_INT8_PATH_IN_USE)) {
          OrtSession.SessionOptions so = new OrtSession.SessionOptions();
          SESS_INT8 = ENV.createSession(st.model.getAbsolutePath(), so);
          MODEL_INT8_PATH_IN_USE = st.model.getAbsolutePath();
          Log.i("G1ASR", "int8 session loaded from " + MODEL_INT8_PATH_IN_USE);
        }
        return SESS_INT8;
      }
      if (SESS == null || !st.model.getAbsolutePath().equals(MODEL_PATH_IN_USE)) {
        OrtSession.SessionOptions so = new OrtSession.SessionOptions();
        SESS = ENV.createSession(st.model.getAbsolutePath(), so);
        MODEL_PATH_IN_USE = st.model.getAbsolutePath();
        Log.i("G1ASR", "session loaded from " + MODEL_PATH_IN_USE);
      }
      return SESS;
    }
  }

  /**
   * Transcribes 16 kHz mono float PCM [-1, 1] with the APPROVED fp32 model (primary).
   * Throws with a descriptive message when the model is not staged — the caller surfaces
   * the failure rather than silently pretending speech-to-text ran.
   */
  public Result transcribe(float[] pcm) throws Exception {
    return run(locate(), pcm, false);
  }

  /**
   * RESEARCH COMPARISON ONLY (v17). Runs the optional int8 research copy on the SAME
   * input so a probe can log side-by-side fp32-vs-int8 argmax parity (owner-approved
   * desktop finding: 95.3-95.9% frame parity). Returns null when int8 is not staged.
   * NEVER replaces the approved fp32 path.
   */
  public Result transcribeInt8Compare(float[] pcm) throws Exception {
    Staged st = locateInt8();
    if (st == null) { Log.i("G1ASR", "int8 research copy not staged — comparison skipped"); return null; }
    return run(st, pcm, true);
  }

  private Result run(Staged st, float[] pcm, boolean int8) throws Exception {
    if (pcm.length < RATE / 2) throw new IllegalArgumentException("ASR input too short (" + pcm.length + " samples)");
    Map<Integer, String> idToPiece = loadVocab(st.vocab);
    OrtSession sess = sessionFor(st, int8);
    float[][] feats2d = AsrFeatures.extract(pcm);
    float[] feats = AsrFeatures.flatten(feats2d);
    Map<String, OnnxTensor> inputs = new HashMap<>();
    inputs.put("input_features", OnnxTensor.createTensor(ENV, FloatBuffer.wrap(feats),
        new long[]{1, feats2d.length, AsrFeatures.FEATURE_DIM}));
    long ti = System.currentTimeMillis();
    String text; int frames; long[] argmax;
    final String[] langOut = new String[1];
    try (OrtSession.Result res = sess.run(inputs)) {
      float[][][] logits = (float[][][]) ((OnnxTensor) res.get(0)).getValue();
      frames = logits.length > 0 ? logits[0].length : 0;
      argmax = new long[frames];
      int vocab = logits[0][0].length;
      for (int f = 0; f < frames; f++) {
        int best = 0;
        for (int c = 1; c < vocab; c++) if (logits[0][f][c] > logits[0][f][best]) best = c;
        argmax[f] = best;
      }
      text = decode(argmax, idToPiece, langOut);
    }
    long inferMs = System.currentTimeMillis() - ti;
    String lang = langOut[0] != null ? langOut[0] : "AMH";
    Log.i("G1ASR", (int8 ? "int8compare" : "primary") + " featFrames=" + feats2d.length
        + " frames=" + frames + " infer=" + inferMs + "ms text=" + text);
    return new Result(text, lang, inferMs, frames, argmax);
  }
}
