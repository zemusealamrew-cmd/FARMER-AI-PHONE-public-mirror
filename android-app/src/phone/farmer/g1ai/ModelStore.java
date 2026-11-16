package phone.farmer.g1ai;

import android.content.Context;
import android.util.Log;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * In-app model downloader (owner decision 2026-11-13: NO USB/adb — the phone must download the
 * approved models itself from their verified sources).
 *
 * SOURCES ARE EVIDENCE-BASED (verified from model_registry/offline-g1-profile.json and
 * offline-g1-qwen-profile.json — pinned revisions + sha256). Only artifacts that actually
 * exist at a public pinned source are fetchable:
 *
 *   FETCHABLE (downloaded by the phone):
 *     - Qwen3-4B-Q4_K_M.gguf  (approved primary LLM) — unsloth/Qwen3-4B-GGUF @ 22c9fc8a
 *     - ASR vocab.json                          — badrex/Ethio-ASR-multilingual-600M @ 5a099192
 *
 *   NOT FETCHABLE (NO public source — local exports on the owner's Windows machine only;
 *   verified: HF repo file lists contain safetensors, not these ONNX exports):
 *     - asr.onnx (4,536,652 B, sha256 3d8ed3db…) + external-data companion (~2.32 GB)
 *     - mms-tts-amh-vits-nonoise.onnx (114,169,203 B, sha256 128815e6…)
 *     - featspec.json
 *   These are carried by the v29 TRANSFER PACKAGE (tools/package-g1-models.ps1) — one zip over
 *   the owner's private channel, verified in-app against the owner manifest (TransferPackage.java).
 *
 * 2026-11-13 REPAIR (transport hardening only — artifact pins, URLs, bytes, SHA-256 and the
 * download design are UNCHANGED; no version/BUILD_TAG change):
 *   1. explicit connect (20 s) and read (30 s) timeouts on every attempt;
 *   2. bounded retry (3 transient attempts) with exponential backoff, each attempt resuming
 *      from the surviving .part instead of restarting from zero;
 *   3. Range/416 correctness: an oversized .part is dropped up-front, a 416 deletes the .part
 *      and restarts once from zero, a 200 answer to a Range request still restarts clean, and a
 *      206 whose Content-Range start does not match the requested offset discards the .part so a
 *      corrupt append is impossible; a short-but-clean body KEEPS the .part so the next attempt
 *      can resume (the old code deleted it and lost all progress);
 *   4. a staged destination file is no longer trusted on length alone: size + full SHA-256 are
 *      verified against the pin, and a mismatch deletes and re-downloads;
 *   5. the GGUF magic ('G','G','U','F') is verified on the part file before it is renamed into
 *      place for any *.gguf artifact;
 *   6. the storage pre-check can no longer compute a negative requirement;
 *   7. every attempt logs ONE G1DL line with attempt number, HTTP code, resume offset and target
 *      size, plus explicit G1DL lines for 416/backoff/staged-verify/sha-mismatch/final staging.
 * Download discipline (unchanged): resume via HTTP Range (a .part file continues), size
 * verification against the registry value, SHA-256 verification against the registry hash,
 * storage pre-check, and explicit error messages.
 */
public final class ModelStore {
  private ModelStore() {}

  // ---- transport policy (2026-11-13 repair) ----
  /** TCP connect timeout; without this the JVM default is 0 = wait forever. */
  private static final int CONNECT_TIMEOUT_MS = 20_000;
  /** Socket read timeout; a stalled body aborts the attempt so the retry loop can resume. */
  private static final int READ_TIMEOUT_MS = 30_000;
  /** Total transient attempts per artifact (each resumes from the current .part). */
  private static final int MAX_TRANSIENT_ATTEMPTS = 3;
  private static final long BACKOFF_BASE_MS = 2_000L;
  private static final long BACKOFF_MAX_MS = 15_000L;
  /** One free restart-from-zero after an HTTP 416 before the .part is declared unusable. */
  private static final int MAX_RANGE_RESTARTS = 1;
  private static final long PROGRESS_EVERY_BYTES = 50L << 20;
  private static final long HASH_PROGRESS_EVERY_BYTES = 256L << 20;
  private static final byte[] GGUF_MAGIC = new byte[] {'G', 'G', 'U', 'F'};

  /** HTTP 416: the resume offset is not satisfiable for this resource. */
  private static final class RangeNotSatisfiable extends IOException {
    private static final long serialVersionUID = 1L;
    RangeNotSatisfiable(String m) { super(m); }
  }

  public static class Artifact {
    public final String key;        // short id for UI/logs
    public final String fileName;   // staged file name
    public final String destSubdir; // "models" | "asr" | "tts"
    public final long bytes;        // expected size (-1 = unknown)
    public final String sha256;     // expected sha256 (null = unverified)
    public final String url;        // pinned approved source (null = NOT fetchable)
    public final String note;
    Artifact(String key, String fileName, String destSubdir, long bytes, String sha256, String url, String note) {
      this.key = key; this.fileName = fileName; this.destSubdir = destSubdir;
      this.bytes = bytes; this.sha256 = sha256; this.url = url; this.note = note;
    }
    public boolean fetchable() { return url != null; }
    public File stagedFile(Context ctx) {
      File ext = ctx.getExternalFilesDir(null);
      if (ext != null) { File f = new File(new File(ext, destSubdir), fileName); if (f.exists()) return f; }
      return new File(new File(ctx.getFilesDir(), destSubdir), fileName);
    }
  }

  public static final Artifact[] ARTIFACTS = {
    new Artifact("llm-qwen", "qwen.gguf", "models",
      2497281312L,
      "f6f851777709861056efcdad3af01da38b31223a3ba26e61a4f8bf3a2195813a",
      "https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/22c9fc8a8c7700b76a1789366280a6a5a1ad1120/Qwen3-4B-Q4_K_M.gguf",
      "Qwen3-4B-Q4_K_M — approved primary LLM (apache-2.0)"),
    new Artifact("asr-vocab", "vocab.json", "asr",
      5601L,
      "c1c8889303e956ca2e669385ae2e4f9fc15ced5d9adc2a7e0a6f27b0f49a66c5",
      "https://huggingface.co/badrex/Ethio-ASR-multilingual-600M/resolve/5a099192a8a56f118d3515f70f5f44428fd29730/vocab.json",
      "ASR vocab (cc-by-4.0)"),
    new Artifact("asr-onnx", "asr.onnx", "asr",
      4536652L,
      "3d8ed3db46bf9729b8773dee92f9662c2aeda922407cda365a485674426558a4",
      null,
      "LOCAL export — use the v29 transfer package (g1-models-transfer.zip)"),
    new Artifact("asr-extdata", "asr.onnx.data", "asr",
      -1L, null, null,
      "LOCAL export — v29 transfer package (manifest SHA-256 verified)"),
    new Artifact("asr-featspec", "featspec.json", "asr",
      -1L, null, null,
      "LOCAL export — v29 transfer package (manifest SHA-256 verified)"),
    new Artifact("tts-vits", "vits.onnx", "tts",
      114169203L,
      "128815e6a06c291c8f2046f139a14453bcb1088ea7976fd76a010b818eedeb50",
      null,
      "LOCAL export — v29 transfer package"),
  };

  public interface Progress { void onProgress(String line); }

  /** Runs the full download pass for all FETCHABLE artifacts; reports every artifact. */
  public static String downloadAll(Context ctx, Progress p) {
    StringBuilder report = new StringBuilder();
    for (Artifact a : ARTIFACTS) {
      try {
        if (!a.fetchable()) {
          File staged = a.stagedFile(ctx);
          boolean present = staged != null && staged.exists() && (a.bytes < 0 || staged.length() == a.bytes);
          if (present) {
            Log.i("G1DL", a.key + " already staged (size-only; no pinned source) bytes=" + staged.length());
            report.append(a.key).append(": አስቀድሞ ተዘርግቷል ✓\n");
          } else {
            Log.i("G1DL", a.key + " NOT fetchable — " + a.note);
            report.append(a.key).append(": ከድረ-ገጽ አይወርድም — ").append(a.note).append("\n");
          }
          continue;
        }
        String r = download(ctx, a, p);
        report.append(a.key).append(": ").append(r).append("\n");
      } catch (Exception e) {
        Log.e("G1DL", a.key + " FAILED: " + e, e);
        report.append(a.key).append(": አልተሳካም — ").append(e.getMessage()).append("\n");
      }
    }
    Log.i("G1DL", "download pass complete — report lines=" + report.length());
    return report.toString();
  }

  public static String download(Context ctx, Artifact a, Progress p) throws Exception {
    if (!a.fetchable()) throw new IllegalStateException("የተረጋገጠ ምንጭ የለም (no pinned source): " + a.note);
    File dir = new File(ctx.getExternalFilesDir(null), a.destSubdir);
    if (dir == null) dir = new File(ctx.getFilesDir(), a.destSubdir);
    dir.mkdirs();
    File dest = new File(dir, a.fileName);
    File part = new File(dir, a.fileName + ".part");

    // (4) staged destination: size + SHA-256 against the pin, never length-only.
    String stagedResult = verifyStaged(a, dest, p);
    if (stagedResult != null) return stagedResult;

    // (3a) an oversized .part can never satisfy Range: drop it before any network work.
    if (a.bytes > 0 && part.exists() && part.length() > a.bytes) {
      Log.w("G1DL", a.key + " .part oversized resume=" + part.length() + "B > target=" + a.bytes + "B → deleting .part, restart from 0");
      part.delete();
    }

    // (3b) a .part that is already complete is verified and staged WITHOUT the network, which is
    // the recovery path for a process death between the size check and the rename.
    if (a.bytes > 0 && part.exists() && part.length() == a.bytes) {
      Log.i("G1DL", a.key + " .part already complete bytes=" + a.bytes + " → verifying without network");
      String sha;
      try {
        sha = sha256Of(part, a.key, p);
      } catch (IOException io) {
        Log.w("G1DL", a.key + " complete .part unreadable (" + io + ") → deleting .part");
        part.delete();
        sha = null;
      }
      if (sha != null && (a.sha256 == null || a.sha256.equalsIgnoreCase(sha))) {
        verifyGguf(a, part);
        if (!part.renameTo(dest)) { part.delete(); throw new IllegalStateException("ማስቀመጥ አልተሳካም"); }
        Log.i("G1DL", a.key + " staged from complete .part path=" + dest.getAbsolutePath()
            + " bytes=" + dest.length() + " sha256=" + sha.substring(0, 16) + "…");
        return "ወርዶ ተረጋግጧል ✓ (" + (dest.length() >> 20) + "MB)";
      }
      if (sha != null) {
        Log.w("G1DL", a.key + " complete .part sha256=" + sha.substring(0, 16) + "… ≠ pin "
            + a.sha256.substring(0, 16) + "… → deleting .part and re-downloading");
        part.delete();
      }
    }

    long have = part.exists() ? part.length() : 0L;

    // (6) storage pre-check; remaining can never go negative now.
    if (a.bytes > 0) {
      long remaining = a.bytes - have;
      if (remaining < 0L) remaining = 0L;
      long need = remaining + (64L << 20);
      android.os.StatFs sf = new android.os.StatFs(dir.getAbsolutePath());
      long avail = sf.getAvailableBytes();
      if (avail < need) {
        throw new IllegalStateException("ቦታ አይበቃም፦ ነፃ " + (avail >> 20) + "MB፣ ያስፈልጋል " + (need >> 20) + "MB");
      }
      Log.i("G1DL", a.key + " precheck avail=" + (avail >> 20) + "MB need=" + (need >> 20)
          + "MB resume=" + have + "B target=" + a.bytes + "B");
    }

    // (2)(3)(7) bounded retry with resume; 416 gets one free restart-from-zero.
    int attempt = 0;
    int transientFailures = 0;
    int rangeRestarts = 0;
    Exception last = null;
    while (transientFailures < MAX_TRANSIENT_ATTEMPTS) {
      attempt++;
      long resumeFrom = part.exists() ? part.length() : 0L;
      if (a.bytes > 0 && resumeFrom > a.bytes) {
        Log.w("G1DL", a.key + " attempt " + attempt + " resume=" + resumeFrom + "B > target → deleting .part, restart from 0");
        part.delete();
        resumeFrom = 0L;
      }
      try {
        return downloadOnce(a, dest, part, p, attempt, resumeFrom);
      } catch (RangeNotSatisfiable r416) {
        part.delete();
        last = r416;
        if (rangeRestarts < MAX_RANGE_RESTARTS) {
          rangeRestarts++;
          Log.w("G1DL", a.key + " attempt " + attempt + " HTTP 416 resume=" + resumeFrom
              + "B → .part deleted, restarting once from 0 (range_restart=" + rangeRestarts + "/" + MAX_RANGE_RESTARTS + ")");
          continue;
        }
        transientFailures++;
        Log.e("G1DL", a.key + " attempt " + attempt + " HTTP 416 again after restart → giving up on range");
      } catch (IOException ioe) {
        last = ioe;
        transientFailures++;
        Log.w("G1DL", a.key + " attempt " + attempt + " transient failure (" + transientFailures
            + "/" + MAX_TRANSIENT_ATTEMPTS + ") resume=" + resumeFrom + "B: " + ioe);
        if (transientFailures < MAX_TRANSIENT_ATTEMPTS) sleepBackoff(transientFailures, a.key);
      }
    }
    throw new IllegalStateException("አልተሳካም — " + MAX_TRANSIENT_ATTEMPTS + " ሙከራ ከተደረገ በኋላ፦ "
        + (last == null ? "unknown" : String.valueOf(last)));
  }

  /** One HTTP attempt. Returns the success text; throws {@link IOException} when retryable. */
  private static String downloadOnce(Artifact a, File dest, File part, Progress p, int attempt, long have)
      throws Exception {
    MessageDigest md = MessageDigest.getInstance("SHA-256");
    HttpURLConnection c = (HttpURLConnection) new URL(a.url).openConnection();
    try {
      // (1) explicit timeouts; JVM default is "wait forever" and was the field failure mode.
      c.setConnectTimeout(CONNECT_TIMEOUT_MS);
      c.setReadTimeout(READ_TIMEOUT_MS);
      c.setInstanceFollowRedirects(true);
      if (have > 0) {
        c.setRequestProperty("Range", "bytes=" + have + "-");
        seedDigest(md, part);
      }
      int code = c.getResponseCode();
      Log.i("G1DL", a.key + " attempt " + attempt + "/" + MAX_TRANSIENT_ATTEMPTS + " http=" + code
          + " resume=" + have + "B target=" + (a.bytes < 0 ? "?" : (a.bytes + "B")));
      if (code == 416) throw new RangeNotSatisfiable("HTTP 416 for Range bytes=" + have + "-");
      if (code != 200 && code != 206) {
        String msg = "HTTP " + code;
        if (code >= 500) throw new IOException("transient server " + msg);
        throw new IllegalStateException(msg);
      }
      boolean resume = (code == 206);
      if (!resume && have > 0) {
        Log.i("G1DL", a.key + " attempt " + attempt + " server ignored Range (http=200) → restarting clean from 0");
        part.delete();
        have = 0L;
        md.reset();
      }
      if (resume) {
        long start = contentRangeStart(c);
        if (start < 0) {
          Log.w("G1DL", a.key + " attempt " + attempt + " http=206 without parseable Content-Range (resume=" + have + "B)");
        } else if (start != have) {
          part.delete();
          throw new IOException("Content-Range start=" + start + " ≠ requested resume=" + have + "B → .part discarded");
        }
      }
      if (p != null && have > 0) p.onProgress(a.key + ": ከ " + (have >> 20) + "MB ይቀጥላል…");
      long total = have;
      long lastProgress = have;
      try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part, resume)) {
        byte[] buf = new byte[1 << 20];
        int n;
        while ((n = in.read(buf)) > 0) {
          out.write(buf, 0, n);
          md.update(buf, 0, n);
          total += n;
          if (a.bytes > 0 && total - lastProgress > PROGRESS_EVERY_BYTES) {
            lastProgress = total;
            if (p != null) p.onProgress(a.key + ": " + (total >> 20) + "/" + (a.bytes >> 20) + "MB (" + (total * 100 / a.bytes) + "%)");
          }
        }
      }
      if (a.bytes > 0 && total != a.bytes) {
        if (total > a.bytes) {
          part.delete();
          throw new IOException("body longer than expected " + total + "/" + a.bytes + "B → .part discarded");
        }
        // keep .part: the retry loop resumes from it (old code deleted it and lost all progress)
        throw new IOException("መጠን አልተሟላም፦ " + total + "/" + a.bytes + " bytes (kept .part for resume)");
      }
      String sha = toHex(md.digest());
      if (a.sha256 != null && !a.sha256.equalsIgnoreCase(sha)) {
        part.delete();
        Log.e("G1DL", a.key + " SHA-256 MISMATCH got=" + sha + " expected=" + a.sha256 + " → .part deleted");
        throw new IllegalStateException("SHA-256 አልተረጋገጠም፦ " + sha.substring(0, 16) + "…");
      }
      verifyGguf(a, part);
      if (!part.renameTo(dest)) { part.delete(); throw new IllegalStateException("ማስቀመጥ አልተሳካም"); }
      Log.i("G1DL", a.key + " staged path=" + dest.getAbsolutePath() + " bytes=" + total
          + " sha256=" + sha.substring(0, 16) + "… attempt=" + attempt + " http=" + code);
      return "ወርዶ ተረጋግጧል ✓ (" + (total >> 20) + "MB)";
    } finally {
      c.disconnect();
    }
  }

  /**
   * (4) Staged-destination verification. Returns the "already staged" message when the file is
   * acceptable, or null when the caller must (re)download. Length alone is never trusted when a
   * SHA-256 pin exists.
   */
  private static String verifyStaged(Artifact a, File dest, Progress p) {
    if (!dest.exists()) return null;
    long len = dest.length();
    if (a.bytes > 0 && len != a.bytes) {
      Log.w("G1DL", a.key + " staged size mismatch " + len + "B/" + a.bytes + "B → deleting staged file");
      dest.delete();
      return null;
    }
    if (a.sha256 == null) {
      Log.i("G1DL", a.key + " already staged (size-only; artifact has no sha pin) bytes=" + len);
      return "አስቀድሞ ተዘርግቷል ✓";
    }
    String sha;
    try {
      if (p != null) p.onProgress(a.key + ": የተዘርጋውን ፋይል በSHA-256 በማረጋገጥ…");
      sha = sha256Of(dest, a.key, p);
    } catch (IOException io) {
      Log.w("G1DL", a.key + " staged file unreadable (" + io + ") → deleting and re-downloading");
      dest.delete();
      return null;
    }
    Log.i("G1DL", a.key + " staged-verify sha256=" + sha.substring(0, 16) + "… expected=" + a.sha256.substring(0, 16) + "…");
    if (a.sha256.equalsIgnoreCase(sha)) {
      Log.i("G1DL", a.key + " staged file ACCEPTED (size+SHA-256 match) bytes=" + len);
      return "አስቀድሞ ተዘርግቷል ✓";
    }
    Log.w("G1DL", a.key + " staged-verify SHA-256 MISMATCH got=" + sha.substring(0, 16)
        + "… expected=" + a.sha256.substring(0, 16) + "… → deleting and re-downloading");
    dest.delete();
    return null;
  }

  /** (5) GGUF magic on the part file before it is renamed into place. Fatal, never retried. */
  private static void verifyGguf(Artifact a, File f) {
    if (!a.fileName.toLowerCase(Locale.ROOT).endsWith(".gguf")) return;
    byte[] magic = new byte[4];
    int n = 0;
    try (InputStream in = new FileInputStream(f)) {
      while (n < 4) {
        int r = in.read(magic, n, 4 - n);
        if (r < 0) break;
        n += r;
      }
    } catch (IOException io) {
      f.delete();
      throw new IllegalStateException("GGUF magic ማንበብ አልተቻለም፦ " + io.getMessage());
    }
    if (n != 4) {
      f.delete();
      throw new IllegalStateException("GGUF magic አልተገኘም፦ file shorter than 4 bytes");
    }
    for (int i = 0; i < 4; i++) {
      if (magic[i] != GGUF_MAGIC[i]) {
        f.delete();
        Log.e("G1DL", a.key + " GGUF magic MISMATCH got=0x" + String.format("%02x", magic[0])
            + String.format("%02x", magic[1]) + String.format("%02x", magic[2]) + String.format("%02x", magic[3])
            + " expected=GGUF → .part deleted");
        throw new IllegalStateException("GGUF magic አልተረጋገጠም (ይህ GGUF ሞዴል አይደለም)");
      }
    }
    Log.i("G1DL", a.key + " GGUF magic OK");
  }

  private static void seedDigest(MessageDigest md, File part) throws IOException {
    try (InputStream fin = new FileInputStream(part)) {
      byte[] b = new byte[1 << 20];
      int n;
      while ((n = fin.read(b)) > 0) md.update(b, 0, n);
    }
  }

  private static String sha256Of(File f, String key, Progress p) throws IOException {
    MessageDigest md;
    try {
      md = MessageDigest.getInstance("SHA-256");
    } catch (Exception e) {
      throw new IOException("SHA-256 not available: " + e.getMessage());
    }
    long total = 0L;
    long last = 0L;
    try (InputStream in = new FileInputStream(f)) {
      byte[] b = new byte[1 << 20];
      int n;
      while ((n = in.read(b)) > 0) {
        md.update(b, 0, n);
        total += n;
        if (p != null && total - last > HASH_PROGRESS_EVERY_BYTES) {
          last = total;
          p.onProgress(key + ": በSHA-256 በማረጋገጥ " + (total >> 20) + "MB");
        }
      }
    }
    return toHex(md.digest());
  }

  /** Parses the first byte offset of a "bytes start-end/total" Content-Range header, or -1. */
  private static long contentRangeStart(HttpURLConnection c) {
    String v = c.getHeaderField("Content-Range");
    if (v == null) return -1L;
    v = v.trim();
    if (!v.startsWith("bytes ")) return -1L;
    int dash = v.indexOf('-');
    if (dash < 0) return -1L;
    try {
      return Long.parseLong(v.substring(6, dash).trim());
    } catch (NumberFormatException e) {
      return -1L;
    }
  }

  private static void sleepBackoff(int failures, String key) {
    long ms = BACKOFF_BASE_MS << Math.max(0, failures - 1);
    if (ms > BACKOFF_MAX_MS) ms = BACKOFF_MAX_MS;
    Log.i("G1DL", key + " backoff " + ms + "ms before next attempt");
    try {
      Thread.sleep(ms);
    } catch (InterruptedException ie) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("ተቋርጧል (interrupted)");
    }
  }

  private static String toHex(byte[] b) { StringBuilder s = new StringBuilder(); for (byte x : b) s.append(String.format("%02x", x)); return s.toString(); }
}
