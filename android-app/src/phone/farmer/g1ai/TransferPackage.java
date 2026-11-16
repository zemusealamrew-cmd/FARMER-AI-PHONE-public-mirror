package phone.farmer.g1ai;

import android.content.Context;
import android.net.Uri;
import android.util.Log;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * v29: one-tap import of the owner's g1-models-transfer.zip (created by
 * tools/package-g1-models.ps1 on the owner's Windows machine and carried to the phone
 * by the owner's own PRIVATE channel — the app never uploads/downloads anything here).
 *
 * VERIFICATION DISCIPLINE (identical to every other staged artifact):
 *   - manifest.json (inside the zip, owner-generated) carries SHA-256 + size for EVERY file.
 *     This closes the registry-hash gap for asr.onnx.data / featspec.json, which had no
 *     recorded hash until now — they are now verified against the owner's own packaging
 *     hash instead of being staged hash-unverified.
 *   - asr.onnx / vocab.json / vits.onnx are ALSO checked against the in-app registry hashes
 *     (pinned from model_registry/offline-g1-profile.json + export-report.json).
 *   - A file that fails ANY check is NOT staged. The report says exactly which file and why.
 *
 * vits-orm.onnx / vocab-orm.json are OPTIONAL (Oromo TTS — packaged when the owner runs
 * tools/export-orm-tts.py). If present they close the Oromo-TTS gap; if absent the report
 * states the gap explicitly.
 */
public final class TransferPackage {
  private TransferPackage() {}

  public interface Progress { void onProgress(String line); }

  // Registry hashes (evidence: offline-g1-profile.json + export-report.json).
  private static final String SHA_ASR = "3d8ed3db46bf9729b8773dee92f9662c2aeda922407cda365a485674426558a4";
  private static final long BYTES_ASR = 4536652L;
  private static final String SHA_VOCAB = "c1c8889303e956ca2e669385ae2e4f9fc15ced5d9adc2a7e0a6f27b0f49a66c5";
  private static final long BYTES_VOCAB = 5601L;
  private static final String SHA_TTS = "128815e6a06c291c8f2046f139a14453bcb1088ea7976fd76a010b818eedeb50";
  private static final long BYTES_TTS = 114169203L;

  /** Maps a zip entry name to its final staged destination (v25 discovery paths). */
  private static File destFor(Context ctx, String name) {
    File ext = ctx.getExternalFilesDir(null);
    if ("asr.onnx".equals(name) || "asr.onnx.data".equals(name) || "featspec.json".equals(name) || "vocab.json".equals(name))
      return new File(ext == null ? new File(ctx.getFilesDir(), "asr") : new File(ext, "asr"), name);
    if ("vits.onnx".equals(name) || "vocab-orm.json".equals(name) || "vits-orm.onnx".equals(name))
      return new File(ext == null ? new File(ctx.getFilesDir(), "tts") : new File(ext, "tts"), name);
    return null;
  }

  private static String registryShaFor(String name) {
    if ("asr.onnx".equals(name)) return SHA_ASR;
    if ("vocab.json".equals(name)) return SHA_VOCAB;
    if ("vits.onnx".equals(name)) return SHA_TTS;
    return null; // external-data / featspec / orm files: verified against the owner manifest
  }
  private static Long registryBytesFor(String name) {
    if ("asr.onnx".equals(name)) return BYTES_ASR;
    if ("vocab.json".equals(name)) return BYTES_VOCAB;
    if ("vits.onnx".equals(name)) return BYTES_TTS;
    return null;
  }

  /**
   * Imports + verifies + stages every file from the transfer zip. Returns a human-readable
   * report (shown in the app + logged under G1XFER). Nothing is staged unless its checks pass.
   */
  public static String importAll(Context ctx, Uri uri, Progress p) {
    StringBuilder report = new StringBuilder();
    File stageDir = new File(ctx.getCacheDir(), "xfer-stage");
    stageDir.mkdirs();
    for (File f : stageDir.listFiles()) f.delete();

    Map<String, long[]> manifest = null; // name -> {bytes, shaPrefix}
    Map<String, File> staged = new HashMap<>();

    // 1) unzip into the private cache stage dir
    try (InputStream in = ctx.getContentResolver().openInputStream(uri);
         ZipInputStream zis = new ZipInputStream(in)) {
      ZipEntry e;
      byte[] buf = new byte[1 << 20];
      while ((e = zis.getNextEntry()) != null) {
        String n = new File(e.getName()).getName(); // defensive: never trust entry paths
        File out = new File(stageDir, n);
        try (FileOutputStream fo = new FileOutputStream(out)) {
          int r; while ((r = zis.read(buf)) > 0) fo.write(buf, 0, r);
        }
        staged.put(n, out);
        if (p != null) p.onProgress("ፓኬጁ በመቅዳት ላይ… " + n);
      }
    } catch (Exception ex) {
      return "የፓኬጅ ማንበብ አልተሳካም፦ " + ex.getMessage();
    }

    // 2) parse + verify the owner manifest
    File mf = staged.get("manifest.json");
    if (mf == null) return "manifest.json በፓኬጁ ውስጥ የለም — የባለቤት ፓኬጅ አይመስልም";
    try (BufferedReader br = new BufferedReader(new InputStreamReader(new FileInputStream(mf), "UTF-8"))) {
      StringBuilder sb = new StringBuilder(); String line;
      while ((line = br.readLine()) != null) sb.append(line);
      JSONObject m = new JSONObject(sb.toString());
      JSONArray files = m.getJSONArray("files");
      manifest = new HashMap<>();
      for (int i = 0; i < files.length(); i++) {
        JSONObject fe = files.getJSONObject(i);
        String sha = fe.getString("sha256");
        long shaPref = Long.parseUnsignedLong(sha.substring(0, 15), 16); // 60-bit prefix
        manifest.put(fe.getString("name"), new long[]{ fe.getLong("bytes"), shaPref });
      }
    } catch (Exception ex) {
      return "manifest.json ማንበብ አልተሳካም፦ " + ex.getMessage();
    }

    // 3) verify each expected file (size + SHA-256 vs manifest; registry hash where pinned)
    String[] required = {"asr.onnx", "asr.onnx.data", "featspec.json", "vocab.json", "vits.onnx"};
    int okCount = 0; int failCount = 0;
    boolean ormTts = false;
    for (Map.Entry<String, long[]> ent : manifest.entrySet()) {
      String name = ent.getKey();
      File f = staged.get(name);
      if (f == null || !f.exists()) { report.append(name).append(": በፓኬጁ ውስጥ አልተገኘም ✗\n"); Log.e("G1XFER", name + ": NOT_IN_ZIP (staged missing)"); failCount++; continue; }
      if ("manifest.json".equals(name)) continue;
      File dest = destFor(ctx, name);
      if (dest == null) { report.append(name).append(": ያልታወቀ የፓኬጅ አባል — ተዘልሏል ✗\n"); Log.e("G1XFER", name + ": UNKNOWN_MEMBER (destFor=null)"); failCount++; continue; }
      try {
        long bytes = f.length();
        if (bytes != ent.getValue()[0]) { report.append(name).append(": መጠን አልተረጋገጠም (").append(bytes).append(" ፈንቃ ").append(ent.getValue()[0]).append(") ✗\n"); Log.e("G1XFER", name + ": SIZE_MISMATCH got=" + bytes + " expected=" + ent.getValue()[0]); failCount++; continue; }
        Long regB = registryBytesFor(name);
        if (regB != null && bytes != regB) { report.append(name).append(": ከregistry መጠን አልተረጋገጠም ✗\n"); Log.e("G1XFER", name + ": REGISTRY_SIZE_MISMATCH got=" + bytes + " expected=" + regB); failCount++; continue; }
        String sha = sha256(f);
        String shaPref = String.format("%015x", Long.parseUnsignedLong(sha.substring(0, 15), 16));
        String expPref = String.format("%015x", ent.getValue()[1]);
        if (!shaPref.equals(expPref)) { report.append(name).append(": ከmanifest SHA-256 አልተረጋገጠም ✗\n"); Log.e("G1XFER", name + " manifest sha mismatch got=" + sha.substring(0, 16)); failCount++; continue; }
        String regSha = registryShaFor(name);
        if (regSha != null && !regSha.equalsIgnoreCase(sha)) { report.append(name).append(": ከregistry SHA-256 አልተረጋገጠም ✗\n"); Log.e("G1XFER", name + " registry sha mismatch got=" + sha); failCount++; continue; }
        dest.getParentFile().mkdirs();
        if (dest.exists()) dest.delete();
        if (!f.renameTo(dest)) {
          // 2026-11-14 REPAIR: rename fails when the unpack dir (cache, internal) and destFor()
          // (external files / internal data) are on different filesystems (CI: EXCEPTION "move"
          // for every fixture). Fall back to a byte copy + delete, which is FS-independent.
          java.io.FileInputStream cin = null;
          java.io.FileOutputStream cout = null;
          try {
            cin = new java.io.FileInputStream(f);
            cout = new java.io.FileOutputStream(dest);
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = cin.read(buf)) > 0) cout.write(buf, 0, n);
            cout.getFD().sync();
          } finally {
            if (cin != null) try { cin.close(); } catch (Exception ignored) {}
            if (cout != null) try { cout.close(); } catch (Exception ignored) {}
          }
          if (!f.delete()) Log.w("G1XFER", name + ": staged copy could not be deleted (non-fatal)");
          Log.i("G1XFER", name + ": cross-filesystem move -> copied (" + dest.length() + " B)");
        }
        report.append(name).append(": ተረጋግጦ ተተክኗል ✓");
        if (regSha != null) report.append(" (registry SHA ✓)");
        report.append("\n");
        okCount++;
        if ("vits-orm.onnx".equals(name)) ormTts = true;
        if (p != null) p.onProgress(name + " ✓");
      } catch (Exception ex) {
        report.append(name).append(": ማረጋገጥ/ማስቀመጥ አልተሳካም — ").append(ex.getMessage()).append(" ✗\n");
        Log.e("G1XFER", name + ": EXCEPTION " + ex);
        failCount++;
      }
    }
    Log.i("G1XFER", "import summary ok=" + okCount + " fail=" + failCount + " manifestEntries=" + manifest.size());
    for (String req : required) if (!manifest.containsKey(req)) { report.append(req).append(": በmanifest ውስጥ የለም ✗\n"); failCount++; }

    // 4) cleanup + summary
    for (File f : stageDir.listFiles()) f.delete();
    report.append("\n—— ማጠቃለያ ——\n");
    report.append("የተረጋገጡ፦ ").append(okCount).append(" | የወደቁ፦ ").append(failCount).append('\n');
    report.append(ormTts ? "የኦሮሞ TTS (vits-orm.onnx)፦ ተተክኗል ✓\n" : "የኦሮሞ TTS፦ በፓኬጁ ውስጥ የለም — የኦሮሞ መልሶች አይነገሩም (GAP)\n");
    Log.i("G1XFER", "transfer import ok=" + okCount + " fail=" + failCount + " ormTts=" + ormTts);
    return report.toString();
  }

  private static String sha256(File f) throws Exception {
    MessageDigest md = MessageDigest.getInstance("SHA-256");
    try (InputStream in = new FileInputStream(f)) {
      byte[] b = new byte[1 << 20]; int n;
      while ((n = in.read(b)) > 0) md.update(b, 0, n);
    }
    StringBuilder s = new StringBuilder();
    for (byte x : md.digest()) s.append(String.format("%02x", x));
    return s.toString();
  }
}
