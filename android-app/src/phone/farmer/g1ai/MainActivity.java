package phone.farmer.g1ai;

import android.Manifest;
import android.media.MediaPlayer;
import android.content.res.AssetFileDescriptor;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.os.StatFs;
import java.security.MessageDigest;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.telephony.PhoneStateListener;
import android.telephony.TelephonyManager;
import android.text.method.ScrollingMovementMethod;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.DataInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.FileReader;
import java.io.FileWriter;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends Activity {
  private static final String PKG = "phone.farmer.g1ai";
  /**
   * v30: build identity — displayed on the launch screen so the owner can verify the
   * installed build in-app (matches AndroidManifest versionName 2.30 / versionCode 38).
   */
  private static final String BUILD_TAG = "v30 · 2.30 · ci-build-apk-20261112";
  /**
   * RAM-guard headroom. UNCALIBRATED placeholder: the guard requires availMem > modelBytes + this.
   * Deliberately NOT a model-size multiplier (a 1.3x rule was rejected as unverified).
   * Must be calibrated by a measured runtime test (T-DQA-20) on target-class hardware before
   * it may be treated as a verified constant.
   */
  private static final long MIN_HEADROOM_BYTES = 384L * 1024 * 1024;

  // ============ v27: approved artifact registry (evidence: model_registry/offline-g1-profile.json,
  // research/onnx-export-20261111/export-report.json). These are the ONLY accepted artifacts. ============
  private static final int IMP_NONE = 0;
  private static final int IMP_LLM = 1;   // Qwen3-4B-Q4_K_M.gguf  (approved primary LLM)
  private static final int IMP_ASR_MAIN = 2;   // asr.onnx (4,536,652 B)
  private static final int IMP_ASR_EXT = 3;     // asr.onnx.data external-data companion (~2.32 GB)
  private static final int IMP_ASR_FEATSPEC = 4; // featspec.json
  private static final int IMP_ASR_VOCAB = 5;    // vocab.json (5,601 B — also downloadable)
  private static final int IMP_TTS = 6;          // vits.onnx (114,169,203 B)
  private static final int IMP_XFER = 7;         // v29: g1-models-transfer.zip (all local exports at once)
  private int pendingImport = IMP_NONE;

  private static final String SHA_LLM  = "f6f851777709861056efcdad3af01da38b31223a3ba26e61a4f8bf3a2195813a";
  private static final long   BYTES_LLM = 2497281312L;
  private static final String SHA_ASR  = "3d8ed3db46bf9729b8773dee92f9662c2aeda922407cda365a485674426558a4";
  private static final long   BYTES_ASR = 4536652L;
  private static final String SHA_VOCAB = "c1c8889303e956ca2e669385ae2e4f9fc15ced5d9adc2a7e0a6f27b0f49a66c5";
  private static final long   BYTES_VOCAB = 5601L;
  private static final String SHA_TTS  = "128815e6a06c291c8f2046f139a14453bcb1088ea7976fd76a010b818eedeb50";
  private static final long   BYTES_TTS = 114169203L;

  private TextView status, replyView;
  private EditText prompt;
  private Button askBtn, aiKeyBtn, importBtn, voiceBtn, modelInfoBtn, modelDlBtn, smsBtn;
  /**
   * G1 repair: explicit AI consent. Default OFF — a plain launch starts with the AI key OFF and
   * nothing reads SMS, opens the mic, or runs a model. The on-screen toggle is the explicit
   * consent. An explicit `ai_key_on` extra always wins (the key-OFF probes pass false); an
   * explicit AI test-hook extra is treated as operator consent for THAT probe only (see
   * hasExplicitAiProbe) so the pre-existing runtime probes keep working without ever turning the
   * key on implicitly for a normal launch.
   */
  private boolean aiKeyOn = false;
  /** True while a first-use READ_SMS permission request (request code 12) awaits its result. */
  private boolean smsReadAfterGrant = false;
  private boolean inCall = false;
  private boolean callStateKnown = false;
  private volatile Process activeLlmProc = null;
  private MediaPlayer kbPlayer = null;
  private String verifiedLastTopic = null;
  private boolean voiceAfterGrant = false;
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private final Handler ui = new Handler(Looper.getMainLooper());
  private final StringBuilder history = new StringBuilder();
  private final AudioPipeline audio = new AudioPipeline();
  private volatile boolean audioBusy = false;
  private final AsrEngine asr = new AsrEngine(this);
  // v22: continuous offline voice loop — under voice_test hook OR the v24 UI button.
  private volatile boolean voiceLoop = false;
  /** Reply hook set by the voice loop so ask() can chain straight into TTS. v29: carries the ASR language. */
  private volatile java.util.function.BiConsumer<String, String> replyHook = null;
  /** v29c: the ASR language for the pending reply. askVoice sets it; ask() consumes it. */
  private volatile String pendingReplyLang = "AMH";

  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    // Android 15+/16 edge-to-edge on A53 draws content under the action bar; remove the
    // overlay title so the AI-key/status controls are reachable, then apply safe insets below.
    getWindow().requestFeature(android.view.Window.FEATURE_NO_TITLE);
    // v23: G1 screen-locked operation (85-req scope).
    setShowWhenLocked(true);
    setTurnScreenOn(true);
    // G1 repair — explicit AI consent: the key defaults OFF. A plain launch does not read SMS,
    // does not open the mic and does not start a model. `ai_key_on` always wins (the key-OFF
    // probes pass false); an explicit AI test-hook extra (CI/runtime probe) is the operator's
    // explicit request for THAT probe and enables the key for that probe only.
    if (getIntent() != null) {
      if (getIntent().hasExtra("ai_key_on")) aiKeyOn = getIntent().getBooleanExtra("ai_key_on", false);
      else if (hasExplicitAiProbe(getIntent())) aiKeyOn = true;
      android.util.Log.i("G1CONSENT", "aiKeyOn=" + aiKeyOn + " source="
          + (getIntent().hasExtra("ai_key_on") ? "ai_key_on extra"
             : (hasExplicitAiProbe(getIntent()) ? "explicit test-hook extra (probe consent)" : "default OFF")));
    }
    if (getIntent() != null && getIntent().getData() != null && "VIEW".equals(getIntent().getAction())) importModel(getIntent().getData());
    if (checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[]{Manifest.permission.READ_PHONE_STATE}, 11);
    }
    // G1 repair — READ_SMS is deliberately NOT requested at launch: it is requested only on the
    // first explicit SMS-button use (request code 12) and the read stays gated by aiAllowed().
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setPadding(24, 32, 24, 24);
    status = new TextView(this); status.setTextSize(15); status.setText("G1 — " + BUILD_TAG);
    replyView = new TextView(this); replyView.setTextSize(18); replyView.setMovementMethod(new ScrollingMovementMethod());
    prompt = new EditText(this); prompt.setText("ሰላም፣ የጎመን ቅጠል ላይ ነጭ ነጥብ አለ። ምን ይሆን?"); prompt.setMinLines(2); prompt.setGravity(Gravity.TOP);
    askBtn = new Button(this); askBtn.setText("ጠይቅ (AI)");
    aiKeyBtn = new Button(this); aiKeyBtn.setText("AI ቁልፍ፦ " + (aiKeyOn ? "ኦን" : "ኦፍ"));
    importBtn = new Button(this); importBtn.setText("ሞዴል አስገባ (ከስልክ ማከማቻ)");
    voiceBtn = new Button(this); voiceBtn.setText("ውይይት ጀምር (ድምፅ)");
    modelInfoBtn = new Button(this); modelInfoBtn.setText("የሞዴል ሁኔታ");
    modelDlBtn = new Button(this); modelDlBtn.setText("ሞዴሎችን አውርድ (ኢንተርኔት)");
    smsBtn = new Button(this); smsBtn.setText("የSMS ንባብ (AI ቁልፍ)");
    root.setOnApplyWindowInsetsListener((v, insets) -> {
      final int top = insets.getSystemWindowInsetTop();
      final int bottom = insets.getSystemWindowInsetBottom();
      v.setPadding(24, 32 + top, 24, 24 + Math.max(0, bottom));
      return insets;
    });
    root.addView(status); root.addView(aiKeyBtn); root.addView(importBtn); root.addView(modelInfoBtn); root.addView(voiceBtn); root.addView(prompt); root.addView(askBtn); root.addView(smsBtn); root.addView(replyView);
    setContentView(root);
    aiKeyBtn.setOnClickListener(v -> {
      boolean wasOn = aiKeyOn;
      aiKeyOn = !aiKeyOn;
      aiKeyBtn.setText("AI ቁልፍ፦ " + (aiKeyOn ? "ኦን" : "ኦፍ"));
      if (wasOn && !aiKeyOn) { audio.stop(); TtsEngine.stopPlayback(); stopCachedKbAudio(); verifiedLastTopic = null; voiceLoop = false; cancelActiveAi(); voiceBtn.setText("ውይይት ጀምር (ድምፅ)"); }
      status.setText(aiKeyOn ? "AI ቁልፍ ኦን" : "AI ቁልፍ ኦፍ — ማይክ/AI ተቆልፏል");
    });
    askBtn.setOnClickListener(v -> ask());
    // G1 repair: consent-controlled SMS reading — ONLY on this explicit button press.
    // READ_SMS is requested HERE on first use (never at launch); the read stays gated by the AI
    // key + call state + RAM guard, and OTP/private message content is never spoken or logged.
    smsBtn.setOnClickListener(v -> {
      if (!aiAllowed()) {
        android.util.Log.i("G1SMS", "button read refused — AI key/call/RAM guard denial (no query, no permission prompt)");
        status.setText("AI ቁልፍ/ጥሪ/ማህደረ ትውስታ ስላልተፈቀደ SMS ንባብ አይጀምርም"); return;
      }
      if (checkSelfPermission("android.permission.READ_SMS") != PackageManager.PERMISSION_GRANTED) {
        smsReadAfterGrant = true;
        status.setText("READ_SMS ፈቃድ በመጠየቅ ላይ…");
        android.util.Log.i("G1SMS", "button read requested READ_SMS permission (first use; no query made)");
        requestPermissions(new String[]{"android.permission.READ_SMS"}, 12);
        return;
      }
      readLatestSmsOnRequest();
    });
    // v27/v29: artifact-type picker; the TRANSFER PACKAGE is listed first.
    importBtn.setOnClickListener(v -> {
      final String[] items = {
        "የማስተላለፊያ ፓኬጅ (g1-models-transfer.zip) — ሁሉም ሞዴሎች በአንድ",
        "Qwen LLM (.gguf)",
        "ASR — asr.onnx",
        "ASR — external-data (asr.onnx.data)",
        "ASR — featspec.json",
        "ASR — vocab.json",
        "TTS — vits.onnx",
      };
      new AlertDialog.Builder(this)
        .setTitle("የትኛው ሞዴል ፋይል ይምረጡ?")
        .setItems(items, (d, w) -> {
          if (w == 0) pendingImport = IMP_XFER;
          else pendingImport = w;
          Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
          i.addCategory(Intent.CATEGORY_OPENABLE);
          i.setType("*/*");
          if (pendingImport == IMP_ASR_FEATSPEC || pendingImport == IMP_ASR_VOCAB) {
            i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/json", "text/plain", "application/octet-stream"});
          } else if (pendingImport == IMP_XFER) {
            i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/zip", "application/octet-stream"});
          } else {
            i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/octet-stream", "application/x-gguf", "application/gguf"});
          }
          i.putExtra(Intent.EXTRA_LOCAL_ONLY, true);
          startActivityForResult(i, 42);
        })
        .setNegativeButton("ተወው", null)
        .show();
    });
    modelInfoBtn.setOnClickListener(v -> worker.execute(() -> {
      final String report = modelStatusReport();
      ui.post(() -> { replyView.setText(report); status.setText(BUILD_TAG); });
    }));
    modelDlBtn.setOnClickListener(v -> {
      modelDlBtn.setEnabled(false);
      status.setText("ሞዴሎች በማውረድ ላይ… (WiFi ይመከራል)");
      worker.execute(() -> {
        final StringBuilder sb = new StringBuilder();
        try {
          String r = ModelStore.downloadAll(this, line -> ui.post(() -> status.setText(line)));
          sb.append(r);
        } catch (Exception e) {
          android.util.Log.e("G1DL", "download pass failed", e);
          sb.append("አልተሳካም፦ ").append(e.getMessage()).append('\n');
        }
        ui.post(() -> {
          replyView.setText(sb.toString());
          status.setText(BUILD_TAG);
          modelDlBtn.setEnabled(true);
        });
      });
    });
    voiceBtn.setOnClickListener(v -> {
      if (voiceLoop) {
        voiceLoop = false; audio.stop(); TtsEngine.stopPlayback();
        voiceBtn.setText("ውይይት ጀምር (ድምፅ)");
        status.setText("ውይይት ቆስቷል");
        return;
      }
      if (!aiAllowed()) { status.setText("AI ቁልፍ/ጥሪ/ማህደረ ትውስታ ስላልተፈቀደ ውይይት አይጀምርም"); return; }
      if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { voiceAfterGrant = true; status.setText("የማይክሮፎን ፈቃድ ይጠየቃል…"); requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 7); return; }
      beginVoiceLoop();
    });
    TelephonyManager tm = (TelephonyManager) getSystemService(TELEPHONY_SERVICE);
    if (tm != null && checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED) { callStateKnown = true; inCall = tm.getCallState() != TelephonyManager.CALL_STATE_IDLE; TtsEngine.setCallActive(inCall); }
    if (tm != null) try { tm.listen(new PhoneStateListener() {
      @Override public void onCallStateChanged(int state, String number) {
        android.util.Log.i("G1CALL", "state=" + state + " inCallBefore=" + inCall + " audioBusy=" + audioBusy);
        inCall = state != TelephonyManager.CALL_STATE_IDLE; TtsEngine.setCallActive(inCall); if (inCall) { audio.stop(); TtsEngine.stopPlayback(); stopCachedKbAudio(); voiceLoop = false; voiceBtn.setText("ውይይት ጀምር (ድምፅ)"); }
        callStateKnown = true;
        android.util.Log.i("G1CALL", "postUpdate inCall=" + inCall + " audioBusy=" + audioBusy + " callStateKnown=" + callStateKnown);
        if (!audioBusy) ui.post(() -> { android.util.Log.i("G1CALL", "uiSet inCall=" + inCall); status.setText(inCall ? "ጥሪ አለ — AI እና ማይክ ተቆልፈዋል" : "ጥሪ አልቀረም — AI ዝግጁ"); });
      }
    }, PhoneStateListener.LISTEN_CALL_STATE); } catch (Exception ignored) { callStateKnown = false; }
    prepareNative();
    if (getIntent() != null && getIntent().getBooleanExtra("tts_test", false)) { if (!aiAllowed()) { status.setText("AI ቁልፍ/ጥሪ/ማህደረ ትውስታ ስላልተፈቀደ TTS አልተጀመረም"); } else {
      new Thread(() -> { try {
        TtsEngine eng = new TtsEngine(this);
        String longText = "የበቆሎ ቅጠል ላይ ቢጫ ነጠብጣብ ካለ በቂ ውሃ እና ማዳበሪያ መስጠት አለብህ።";
        String m1 = eng.speak(longText); android.util.Log.i("G1TTS", "cold: " + m1);
        String m2 = eng.speak("ሰላም ገበሬ"); android.util.Log.i("G1TTS", "warm: " + m2);
        ui.post(() -> status.setText("TTS cold/warm ተጠናቀቀ"));
      } catch (Exception e) { android.util.Log.e("G1TTS", "TTS FAILED", e); ui.post(() -> status.setText("TTS FAILED: " + e)); } }).start();
      }
    }
    if (getIntent() != null && getIntent().getBooleanExtra("mic_test", false)) { if (!aiAllowed()) { status.setText("AI ቁልፍ/ጥሪ/ማህደረ ትውስታ ስላልተፈቀደ mic አልተጀመረም"); } else {
      audioBusy = true; status.setText("AudioRecord በመቅረጽ ላይ…");
      audio.start(msg -> ui.post(() -> { android.util.Log.i("G1AUDIO", msg); status.setText(msg); audioBusy = false; }));
    }
    }
    if (getIntent() != null && getIntent().getBooleanExtra("asr_test", false)) {
      if (!aiAllowed()) { status.setText("AI ቁልፍ/ጥሪ/ማህደረ ትውስታ ስላልተፈቀደ ASR አልተጀመረም"); }
      else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { status.setText("RECORD_AUDIO ስላልተፈቀደ ASR አልተጀመረም"); }
      else {
        audioBusy = true; status.setText("ድምፅ በመቅረጽ ላይ… (4ሰ) — ወደ ASR");
        audio.setAsrListener((pcm16k, voicedMs, peak) -> worker.execute(() -> {
          try {
            AsrEngine.Result r = asr.transcribe(pcm16k);
            android.util.Log.i("G1ASRTEST", "lang=" + r.language + " frames=" + r.frames + " inferMs=" + r.inferMs + " voicedMs=" + voicedMs + " peak=" + peak + " text=" + r.text);
            ui.post(() -> { prompt.setText(r.text); status.setText("ASR ተጠናቀቀ፦ " + r.language + " — " + r.inferMs + "ms"); audioBusy = false; });
          } catch (Exception e) {
            android.util.Log.e("G1ASRTEST", "ASR FAILED", e);
            ui.post(() -> { status.setText("ASR FAILED: " + e.getMessage()); audioBusy = false; });
          }
        }));
        audio.start(msg -> ui.post(() -> { android.util.Log.i("G1AUDIO", msg); }));
      }
    }
    if (getIntent() != null && getIntent().getBooleanExtra("voice_test", false)) {
      if (!aiAllowed()) { status.setText("AI ቁልፍ/ጥሪ/ማህደረ ትውስታ ስላልተፈቀደ ውይይት አልተጀመረም"); }
      else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { status.setText("RECORD_AUDIO ስላልተፈቀደ ውይይት አልተጀመረም"); }
      else { voiceLoop = true; voiceBtn.setText("ውይይት አቁም"); startVoiceTurn(); }
    }
    if (getIntent() != null && getIntent().getBooleanExtra("sms_test", false)) {
      if (!aiAllowed()) {
        status.setText("AI ቁልፍ/ጥሪ/ማህደረ ትውስታ ስላልተፈቀደ SMS ንባብ አይጀምርም");
        android.util.Log.i("G1SMS", "sms_test refused — guard denial (no query made)");
      } else if (checkSelfPermission("android.permission.READ_SMS") != PackageManager.PERMISSION_GRANTED) {
        status.setText("READ_SMS ፈቃድ ስላልተፈቀደ SMS አይነበብም");
        android.util.Log.i("G1SMS", "sms_test refused — READ_SMS not granted (no query made)");
      } else {
        worker.execute(() -> {
          SmsReader.Sms m = SmsReader.readLatest(this);
          if (m == null) {
            android.util.Log.i("G1SMS", "sms_test: inbox empty — read path exercised, nothing to read");
            ui.post(() -> status.setText("SMS ንባብ ተፈትኗል — ግቢት ባዶ ነዋል"));
            return;
          }
          boolean otp = SmsReader.isOtp(m.body);
          // G1 repair: metadata only. NEVER the sender identity or the message body (privacy).
          android.util.Log.i("G1SMS", "sms_test: read-on-request exercised otp=" + otp + " (sender/body not logged)");
          if (otp) {
            android.util.Log.i("G1SMS", "sms_test: OTP-classified — refused, not spoken (sender/body not logged)");
            ui.post(() -> status.setText("OTP/የግል መልእክት — አልተነበበም ✓ (ግላዊነት ጥበቃ)"));
          } else {
            try {
              TtsEngine eng = new TtsEngine(this);
              String r = eng.speakPrivate("ከ" + m.sender + "፦ " + m.body);
              android.util.Log.i("G1SMS", "sms_test tts " + r);
              ui.post(() -> status.setText("SMS ንባብ ተፈትኗል ✓"));
            } catch (Exception e) {
              android.util.Log.i("G1SMS", "sms_test: read OK, TTS not available (" + e.getMessage() + ") — privacy path still verified");
              ui.post(() -> status.setText("SMS ተነበበ እንጂ TTS ሞዴል የለም"));
            }
          }
        });
      }
    }
    // v30: xfer_test hook — CI probe for the TRANSFER-PACKAGE importer (same code path as
    // the owner's one-tap import after double-clicking tools/prepare-g1-models.bat).
    if (getIntent() != null && getIntent().getBooleanExtra("xfer_test", false)) {
      final String uriStr = getIntent().getStringExtra("xfer_uri");
      if (uriStr == null) {
        status.setText("xfer_test፦ xfer_uri አልተሰጠም");
        android.util.Log.i("G1XFER", "xfer_test refused — no xfer_uri (nothing imported)");
      } else {
        status.setText("የማስተላለፊያ ፓኬጅ በማረጋገጥ ላይ… (ሁሉም ፋይሎች በSHA-256)");
        worker.execute(() -> {
          final String r = TransferPackage.importAll(this, Uri.parse(uriStr), line -> ui.post(() -> status.setText(line)));
          ui.post(() -> { replyView.setText(r); status.setText(BUILD_TAG); });
        });
      }
    }
    // G1 repair: additive real-model test hooks (explicit extras only; no behavior change absent).
    if (getIntent() != null && getIntent().hasExtra("asr_wav_test")) {
      runAsrWavTestHook(getIntent().getStringExtra("asr_wav_test"));
    }
    if (getIntent() != null && getIntent().hasExtra("e2e_turns_json")) {
      runE2eTurnsHook(getIntent().getStringExtra("e2e_turns_json"));
    }
    if (getIntent() != null && getIntent().hasExtra("safety_tts_test")) {
      runSafetyTtsProbeHook(getIntent().getStringExtra("safety_tts_test"));
    }
    if (getIntent() != null && getIntent().hasExtra("tts_lang_probe")) {
      runTtsLangProbeHook();
    }
    if (getIntent() != null && getIntent().hasExtra("tts_voices_test")) {
      runAndroidTtsInventoryHook();
    }
    if (getIntent() != null && getIntent().hasExtra("android_tts_render")) {
      runAndroidTtsRenderHook(getIntent().getStringExtra("android_tts_render"),
          getIntent().getStringExtra("android_tts_lang"));
    }
    handlePromptIntent(getIntent());
  }

  @Override protected void onDestroy() {
    super.onDestroy();
    if (isFinishing()) { voiceLoop = false; TtsEngine.shutdown(); AsrEngine.shutdown(); worker.shutdown(); }
  }

  private void handlePromptIntent(Intent it) {
    if (it == null) return;
    String b = it.getStringExtra("prompt_b64");
    if (b != null) {
      try { prompt.setText(new String(android.util.Base64.decode(b, android.util.Base64.DEFAULT), "UTF-8")); } catch (Exception ignored) {}
      ui.postDelayed(this::ask, 1800);
    } else if (it.getBooleanExtra("autorun", false)) { ui.postDelayed(this::ask, 1800); }
  }

  /** On some devices the listener callback arrives after onCreate hooks; read the live
   * permission-gated call state so the AI gate is not falsely denied. No permission bypass. */
  /** Play pre-generated TTS for a verified KB answer; fall back to live TTS if missing. */
  private void playCachedKbAudio(final String id, final String answer, final String lang) {
    stopCachedKbAudio();
    java.io.InputStream in = null;
    try {
      final String[] paths = {"kb_tts/" + id + ".wav", "kb_tts\\" + id + ".wav"};
      for (String p : paths) { try { in = getAssets().open(p); break; } catch (Exception ignored) {} }
      if (in == null) throw new java.io.FileNotFoundException("kb_tts/" + id + ".wav");
      final File kb = new File(getCacheDir(), id + ".wav");
      if (!kb.isFile() || kb.length() == 0) {
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(kb)) {
          byte[] buf = new byte[65536]; int n;
          while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
      }
      final MediaPlayer mp = new MediaPlayer();
      mp.setDataSource(kb.getAbsolutePath());
      mp.setOnCompletionListener(x -> { android.util.Log.i("G1KB", "cached audio completed id=" + id); stopCachedKbAudio(); });
      mp.prepare();
      mp.start();
      kbPlayer = mp;
      android.util.Log.i("G1KB", "cached audio start id=" + id);
    } catch (Exception e) {
      android.util.Log.e("G1KB", "cached audio unavailable id=" + id, e);
      speakTextReply(answer, lang);
    } finally {
      if (in != null) try { in.close(); } catch (Exception ignored) {}
    }
  }

  private void stopCachedKbAudio() {
    final MediaPlayer p = kbPlayer;
    kbPlayer = null;
    if (p != null) { try { p.stop(); } catch (Exception ignored) {} try { p.release(); } catch (Exception ignored) {} }
  }

  /** AI-key/call gate only; retrieval/TTS can run even when the LLM RAM headroom gate is tight. */
  private boolean aiGateAllowed() {
    ensureCallStateKnown();
    return aiKeyOn && callStateKnown && !inCall;
  }

  private void ensureCallStateKnown() {
    if (checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) return;
    try {
      TelephonyManager tm = (TelephonyManager) getSystemService(TELEPHONY_SERVICE);
      if (tm != null) {
        inCall = tm.getCallState() != TelephonyManager.CALL_STATE_IDLE;
        TtsEngine.setCallActive(inCall);
        callStateKnown = true;
      }
    } catch (Exception ignored) { callStateKnown = false; }
  }

  private void beginVoiceLoop() {
    voiceLoop = true;
    voiceBtn.setText("ውይይት አቁም");
    startVoiceTurn();
  }

  private void cancelActiveAi() {
    final Process p = activeLlmProc;
    if (p != null) { try { p.destroyForcibly(); } catch (Exception ignored) {} }
  }

  private boolean aiAllowed() {
    return aiGateAllowed() && ramSufficient();
  }

  private boolean ramSufficient() {
    try {
      android.app.ActivityManager am = (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
      android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
      am.getMemoryInfo(mi);
      long modelBytes = modelFile().length();
      long needed = modelBytes + MIN_HEADROOM_BYTES;
      boolean allowed = mi.availMem > needed;
      android.util.Log.i("G1RAM", "availMem=" + mi.availMem + " modelBytes=" + modelBytes + " needed=" + needed + " allowed=" + allowed);
      return allowed;
    } catch (Exception e) { return false; }
  }

  /**
   * G1 repair — Qwen3-4B-ONLY at use. The approved LLM has exactly one on-device location/name:
   * models/qwen.gguf (external-files first, then internal files). The previous gemma.gguf /
   * any-*.gguf fallback could silently run a NON-approved model; it is removed. A missing
   * qwen.gguf returns a non-existent qwen.gguf path so callers fail loudly instead of running
   * whatever .gguf happened to be present.
   */
  private File modelFile() {
    File ext = getExternalFilesDir(null);
    File intModel = new File(new File(getFilesDir(), "models"), "qwen.gguf");
    File extModel = ext == null ? null : new File(new File(ext, "models"), "qwen.gguf");
    if (extModel != null && extModel.isFile() && extModel.canRead()) return extModel;
    if (intModel.isFile() && intModel.canRead()) return intModel;
    return extModel != null ? extModel : intModel;
  }

  private String modelStatusReport() {
    StringBuilder sb = new StringBuilder();
    sb.append("ግንባታ: ").append(BUILD_TAG).append('\n');
    File ext = getExternalFilesDir(null);
    File llm = modelFile();
    if (llm != null && llm.exists() && llm.canRead()) {
      sb.append("LLM: ").append(llm.getName()).append(" (").append(llm.length() >> 20).append("MB) ✓\n");
      if (llm.length() != BYTES_LLM) {
        sb.append("  ማስጠንቀቂያ፦ የተፈቀደው የQwen3-4B-Q4_K_M መጠን አይደለም (").append(BYTES_LLM >> 20).append("MB) — AI አይጀምርም።\n");
      }
    } else {
      sb.append("LLM: አልተገኘም\n  በ«ሞዴል አስገባ» ብቻ ያስገቡ (ከኢንተርኔት ውጭ)።\n");
    }
    File asrFound = null;
    File[] asrDirs = { new File(getFilesDir(), "asr"), ext == null ? null : new File(ext, "asr") };
    for (File d : asrDirs) {
      if (d != null && new File(d, "asr.onnx").exists() && new File(d, "vocab.json").exists()) { asrFound = d; break; }
    }
    if (asrFound != null) {
      String comp = null;
      for (String e2 : new String[]{".data", ".bin", "_data"}) { if (new File(asrFound, "asr.onnx" + e2).exists()) { comp = "asr.onnx" + e2; break; } }
      sb.append("ASR: asr.onnx + vocab.json ✓ (በ").append(asrFound.getAbsolutePath()).append(")\n");
      sb.append(comp != null ? "  external-data: " + comp + " ✓\n" : "  ማስጠንቀቂያ፦ የexternal-data አባሪ የለም — fp32 አይጫንም!\n");
    } else {
      sb.append("ASR: አልተገኘም\n  asr.onnx + asr.onnx.data + featspec.json በ«የማስተላለፊያ ፓኬጅ» (g1-models-transfer.zip) ያስገቡ።\n");
    }
    File ttsFound = null;
    File[] ttsDirs = { new File(getFilesDir(), "tts"), ext == null ? null : new File(ext, "tts") };
    for (File d : ttsDirs) {
      if (d != null && new File(d, "vits.onnx").exists() && new File(d, "vits.onnx").length() > 1000) { ttsFound = d; break; }
    }
    if (ttsFound != null) {
      sb.append("TTS (አማርኛ): vits.onnx (").append(new File(ttsFound, "vits.onnx").length() >> 20).append("MB) ✓\n");
    } else {
      sb.append("TTS (አማርኛ): አልተገኘም\n  በ«የማስተላለፊያ ፓኬጅ» ያስገቡ።\n");
    }
    boolean ormTts = false;
    for (File d : ttsDirs) {
      if (d != null && new File(d, "vits-orm.onnx").exists() && new File(d, "vits-orm.onnx").length() > 1000) { ormTts = true; break; }
    }
    sb.append(ormTts ? "TTS (ኦሮሞ): vits-orm.onnx ✓\n" : "TTS (ኦሮሞ): የለም — የኦሮሞ መልሶች አይነገሩም (የተሳሳተ የአማርኛ ድምፅ ተከልክሏል፤ GAP)\n");
    try {
      android.app.ActivityManager am = (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
      android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
      am.getMemoryInfo(mi);
      sb.append("RAM: ነፃ ").append(mi.availMem >> 20).append("MB / በጠቅላላ ").append(mi.totalMem >> 20).append("MB\n");
      long qwen = 2497281312L;
      if (mi.availMem < qwen + MIN_HEADROOM_BYTES) {
        sb.append("ማስጠንቀቂያ፦ ነፃ RAM ለQwen (2.3GB) + እርጉጉ (384MB) አይበቃም — Qwen አይጀምርም።\n");
      }
    } catch (Exception ignored) {}
    return sb.toString();
  }

  private void prepareNative() {
    worker.execute(() -> {
      String dir = getApplicationInfo().nativeLibraryDir;
      File exe = new File(dir, "libllama-cli.so");
      ui.post(() -> status.setText(exe.exists() ? "native ዝግጁ፦ " + dir : "native የለም፦ " + dir));
    });
  }

  private void copyAssetDir(String assetPath, File dest) throws Exception {
    String[] names = getAssets().list(assetPath);
    if (names == null) return;
    for (String n : names) {
      String ap = assetPath + "/" + n;
      String[] sub = getAssets().list(ap);
      if (sub != null && sub.length > 0) { File d = new File(dest, n); d.mkdirs(); copyAssetDir(ap, d); }
      else { InputStream in = getAssets().open(ap); File out = new File(dest, n); FileOutputStream fo = new FileOutputStream(out); byte[] buf = new byte[65536]; int r; while ((r = in.read(buf)) > 0) fo.write(buf, 0, r); fo.close(); in.close(); }
    }
  }

  private void startVoiceTurn() {
    logPerf("voice-turn-start");
    ui.post(() -> { audioBusy = true; status.setText("ድምፅ በመቅረጽ ላይ… (ውይይት)"); });
    audio.setAsrListener((pcm16k, voicedMs, peak) -> worker.execute(() -> {
      try {
        long t0 = System.currentTimeMillis();
        AsrEngine.Result r = asr.transcribe(pcm16k);
        android.util.Log.i("G1VOICE", "asr lang=" + r.language + " frames=" + r.frames + " inferMs=" + r.inferMs + " chainMs=" + (System.currentTimeMillis() - t0) + " voicedMs=" + voicedMs + " text=" + r.text);
        AsrEngine.releaseSession();
        android.util.Log.i("G1VOICE", "asr session released (sequential RAM: ASR -> unload -> LLM -> TTS)");
        logPerf("post-asr-release");
        ui.post(() -> { prompt.setText(r.text); status.setText("ተሰማ፦ " + r.text); });
        askVoice(r.text, r.language);
      } catch (Exception e) {
        android.util.Log.e("G1VOICE", "ASR FAILED — voice loop stops", e);
        voiceLoop = false;
        ui.post(() -> { status.setText("ASR FAILED: " + e.getMessage()); audioBusy = false; voiceBtn.setText("ውይይት ጀምር (ድምፅ)"); });
      }
    }));
    audio.start(msg -> ui.post(() -> android.util.Log.i("G1AUDIO", msg)));
  }

  private void askVoice(final String q, final String lang) {
    if (q == null || q.trim().isEmpty()) {
      android.util.Log.i("G1VOICE", "empty ASR text — next turn");
      if (voiceLoop && aiAllowed()) ui.post(this::startVoiceTurn);
      else ui.post(() -> { status.setText("ውይይት ቆስቷል"); audioBusy = false; voiceBtn.setText("ውይይት ጀምር (ድምፅ)"); });
      return;
    }
    pendingReplyLang = (lang != null && "ORM".equals(lang)) ? "ORM" : "AMH";
    replyHook = (reply, replyLang) -> worker.execute(() -> {
      try {
        logPerf("pre-tts");
        TtsEngine eng = new TtsEngine(this);
        long t0 = System.currentTimeMillis();
        String m = eng.speak(reply, replyLang);
        android.util.Log.i("G1VOICE", "tts lang=" + replyLang + " " + m + " speakMs=" + (System.currentTimeMillis() - t0));
        logPerf("post-tts");
      } catch (Exception e) {
        android.util.Log.e("G1VOICE", "TTS FAILED", e);
      }
      if (voiceLoop && aiAllowed()) ui.post(this::startVoiceTurn);
      else ui.post(() -> { status.setText("ውይይት ቆስቷል"); audioBusy = false; voiceBtn.setText("ውይይት ጀምር (ድምፅ)"); });
    });
    ui.post(() -> { prompt.setText(q); ask(); });
  }

  private void logPerf(String stage) {
    try {
      android.app.ActivityManager am = (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
      if (am != null) {
        android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        android.util.Log.i("G1PERF", stage + " availMem=" + mi.availMem + " totalMem=" + mi.totalMem + " lowThreshold=" + mi.threshold);
      }
      try (BufferedReader br = new BufferedReader(new FileReader("/proc/stat"))) {
        String cpu = br.readLine();
        android.util.Log.i("G1PERF", stage + " /proc/stat=" + cpu);
      } catch (Exception ignored) {}
    } catch (Exception ignored) {}
  }

  private void ask() {
    if (!aiGateAllowed()) { status.setText("AI ቁልፍ/ጥሪ/ማህደረ ትውስታ ስላልተፈቀደ AI አይጀምርም"); return; }
    final String q = prompt.getText().toString().trim();
    if (q.isEmpty()) { status.setText("ጥያቄ ባዶ ነው"); return; }
    // P0 SAFETY STOP-GATE: high-risk dose/medical/chemical query → deterministic refusal, and the
    // LLM is NOT invoked at all (no chance for an ungrounded number to be produced or spoken).
    if (SafetyGuard.isHighRiskQuery(q)) {
      final String refusal = SafetyGuard.refusal(pendingReplyLang);
      android.util.Log.i("G1SAFE", "ask(): highRiskQuery=1 quantity=" + SafetyGuard.hasQuantityIntent(q)
          + " injection=" + SafetyGuard.hasInjectionAttempt(q) + " lang=" + pendingReplyLang
          + " -> DETERMINISTIC_REFUSAL (llm_skipped=true)");
      final java.util.function.BiConsumer<String, String> hook0 = replyHook; replyHook = null;
      final String rl = pendingReplyLang; pendingReplyLang = "AMH";
      ui.post(() -> { replyView.setText(refusal); status.setText("የደህንነት መከላከያ፦ ያልተረጋገጠ መጠን አልተሰጠም"); askBtn.setEnabled(true);
        if (hook0 != null) hook0.accept(refusal, rl); });
      return;
    }
    // Fast/reliable offline path for source-cited high-frequency Amharic questions.
    // No LLM is loaded on a knowledge hit; inference remains the fallback for open questions.
    final VerifiedKnowledge.Result vk = VerifiedKnowledge.lookup(q, verifiedLastTopic);
    if (vk != null) {
      verifiedLastTopic = vk.id;
      final String answer = vk.answer;
      final String source = vk.source;
      final java.util.function.BiConsumer<String, String> kbHook = replyHook;
      replyHook = null;
      final String kbLang = pendingReplyLang;
      pendingReplyLang = "AMH";
      ui.post(() -> {
        replyView.setText(answer);
        status.setText("በምንጭ የተደገፈ መልስ — " + source);
        askBtn.setEnabled(true);
        if (kbHook != null) kbHook.accept(answer, kbLang);
        else playCachedKbAudio(vk.id, answer, kbLang);
      });
      return;
    }

    if (!ramSufficient()) { status.setText("LLM ሞዴል ለመጫን በቂ ነፃ RAM የለም — ሌሎች መተግበሪያዎችን ይዝጉ ወይም AI OFF ያድርጉ"); return; }
    final File model = modelFile();
    if (!model.exists() || !model.canRead()) { status.setText("ሞዴል አልተገኘም፦ " + model.getAbsolutePath()); return; }
    final File exe = new File(getApplicationInfo().nativeLibraryDir, "libllama-cli.so");
    if (!exe.exists()) { status.setText("llama native አልተገኘም፦ " + exe.getAbsolutePath()); return; }
    askBtn.setEnabled(false); status.setText("ሞዴል በማረጋገጥ ላይ… (Qwen3-4B size + SHA-256)");
    worker.execute(() -> {
      try {
        // Qwen3-4B native ChatML template (single turn here; runLlama refuses to spawn unless the
        // pinned size + SHA-256 are verified — see llmRejectionReason()).
        final String replyLang0 = pendingReplyLang;
        android.util.Log.i("G1LLM", "ask: lang=" + replyLang0 + " systemPrompt=" + (systemPromptFor(replyLang0).contains("Oromo") ? "OM" : "AM"));
        LlmReply r = runLlama(model, chatPrompt(systemPromptFor(replyLang0), "", q));
        if (!aiAllowed()) throw new IOException("AI_KEY_OFF — reply discarded");
        // P0 SAFETY STOP-GATE: deterministic pre-output guard runs BEFORE the reply is displayed or
        // sent to TTS. Medication/chemical dose questions never surface a model-generated number.
        final String shown = SafetyGuard.guardReply(q, replyLang0, r.text);
        final boolean guarded = !shown.equals(r.text);
        final int c = r.exit; final long msec = r.ms;
        final java.util.function.BiConsumer<String, String> hook = replyHook; replyHook = null;
        final String replyLang = replyLang0; pendingReplyLang = "AMH";
        ui.post(() -> { replyView.setText(shown); status.setText("ተጠናቅቋል exit=" + c + " — " + msec + "ms"); askBtn.setEnabled(true);
          android.util.Log.i("G1LLM", "model=" + model.getName() + " replyMs=" + msec + " exit=" + c + " replyLang=" + replyLang + " safetyGuarded=" + guarded);
          if (hook != null) hook.accept(shown, replyLang);
          else speakTextReply(shown, replyLang);
        });
      } catch (Exception ex) {
        replyHook = null;
        final String msg = ex.getMessage() == null ? ex.toString() : ex.getMessage();
        final boolean modelRejected = ex instanceof ModelVerifyException;
        android.util.Log.e("G1LLM", (modelRejected ? "REFUSED — approved model not verified: " : "llama failed: ") + msg);
        ui.post(() -> {
          status.setText(modelRejected
              ? ("የተፈቀደው Qwen3-4B ሞዴል አልተረጋገጠም — AI አልተጀመረም፦ " + msg)
              : ("የሂደት ስህተት፦ " + msg));
          askBtn.setEnabled(true);
        });
      }
    });
  }

  // ===================== G1 repair: SMS consent privacy (button path) =====================

  /**
   * Explicit SMS-button read path. Only reachable from the SMS button (after the AI-key/call/RAM
   * gate and, on first use, after the READ_SMS permission grant). The read is one query; nothing
   * identifying the sender or the body is ever logged, and OTP/private messages are refused.
   */
  /** Text-ask replies are also spoken when the AI key is on. Voice-loop replies use replyHook. */
  private void speakTextReply(final String text, final String lang) {
    if (text == null || text.trim().isEmpty() || !aiGateAllowed()) return;
    new Thread(() -> {
      try {
        final String r = new TtsEngine(this).speak(text, lang);
        android.util.Log.i("G1TTS", "ask text reply spoken: " + r);
        ui.post(() -> { if (aiKeyOn) status.setText("መልስ በድምጽ ተነግሯል"); });
      } catch (Exception e) {
        android.util.Log.e("G1TTS", "ask TTS FAILED", e);
        ui.post(() -> status.setText("መልስ በድምጽ አልተነገረም — " + e.getMessage()));
      }
    }, "g1-ask-tts").start();
  }

  private void readLatestSmsOnRequest() {
    worker.execute(() -> {
      final SmsReader.Sms m = SmsReader.readLatest(this);
      if (m == null) { ui.post(() -> status.setText("የSMS ግቢት ባዶ ነው")); return; }
      if (SmsReader.isOtp(m.body)) {
        android.util.Log.i("G1SMS", "OTP-classified message — NOT read aloud (refused; sender/body not logged)");
        ui.post(() -> status.setText("የግል/OTP መልእክት — አልተነበበም (ግላዊነት ጥበቃ)"));
        return;
      }
      android.util.Log.i("G1SMS", "read on request: one latest message fetched (sender/body not logged)");
      final String toSpeak = "ከ" + m.sender + "፦ " + m.body;
      try {
        final TtsEngine eng = new TtsEngine(this);
        final String r = eng.speakPrivate(toSpeak);
        android.util.Log.i("G1SMS", "tts " + r);
        ui.post(() -> status.setText("SMS ተነብቧል ✓ (" + r + ")"));
      } catch (Exception e) {
        android.util.Log.e("G1SMS", "TTS FAILED", e);
        ui.post(() -> status.setText("SMS ንባብ፦ TTS ስህተት — " + e.getMessage()));
      }
    });
  }

  @Override public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
    super.onRequestPermissionsResult(req, perms, res);
    if (req == 7) {
      final boolean micGranted = res != null && res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED;
      voiceAfterGrant = false;
      if (!micGranted) { status.setText("MIC ፈቃድ አልተሰጠም — ድምፅ አልጀመረም"); return; }
      if (aiKeyOn) beginVoiceLoop(); else status.setText("AI ቁልፍ OFF — ድምፅ አልጀመረም");
      return;
    }
    if (req != 12) return;
    final boolean granted = res != null && res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED;
    if (!granted) {
      smsReadAfterGrant = false;
      android.util.Log.i("G1SMS", "READ_SMS denied by the user — no query made");
      status.setText("READ_SMS ፈቃድ ስላልተፈቀደ SMS አይነበብም");
      return;
    }
    if (!smsReadAfterGrant) return;
    smsReadAfterGrant = false;
    if (!aiAllowed()) {
      android.util.Log.i("G1SMS", "READ_SMS granted but AI gate denied — no query made");
      status.setText("AI ቁልፍ/ጥሪ/ማህደረ ትውስታ ስላልተፈቀደ SMS ንባብ አይጀምርም");
      return;
    }
    readLatestSmsOnRequest();
  }

  // ================= G1 repair: approved Qwen3-4B identity at use (size + SHA-256) =================

  /** SharedPreferences key holding "<path>|<mtime>|<bytes>|<sha256>" of the last verified LLM. */
  private static final String PREF_LLM_VERIFIED = "llm_verified_v1";
  /** In-process cache of verified model stamps (path + mtime + size) -> verified sha256. */
  private static final ConcurrentHashMap<String, String> VERIFIED_LLM_CACHE = new ConcurrentHashMap<>();

  private android.content.SharedPreferences prefs() {
    return getSharedPreferences("g1-model-verify", MODE_PRIVATE);
  }

  private static String sha256(final File f) throws IOException {
    final MessageDigest md;
    try {
      md = MessageDigest.getInstance("SHA-256");
    } catch (java.security.NoSuchAlgorithmException e) {
      throw new IOException("SHA-256 not available", e);
    }
    try (BufferedInputStream in = new BufferedInputStream(new FileInputStream(f), 1 << 20)) {
      final byte[] buf = new byte[1 << 20];
      int n;
      while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
    }
    return toHex(md.digest());
  }

  /**
   * Returns null when the file is the pinned Qwen3-4B-Q4_K_M (size + SHA-256 verified), otherwise
   * a clear human-readable rejection reason. The verified result is cached per path+mtime+size
   * (memory + SharedPreferences) so the 2.4 GB hash is not repeated on every turn/restart.
   */
  private String llmRejectionReason(final File model) {
    if (model == null) return "no Qwen model path resolved";
    if (!model.isFile() || !model.canRead()) return "model missing/unreadable: " + model.getAbsolutePath();
    final long len = model.length();
    final String stamp = model.getAbsolutePath() + "|" + model.lastModified() + "|" + len;
    if (SHA_LLM.equals(VERIFIED_LLM_CACHE.get(stamp))) {
      android.util.Log.i("G1MODEL", "verified-model cache hit (memory) " + stamp);
      return null;
    }
    try {
      final String saved = prefs().getString(PREF_LLM_VERIFIED, null);
      if (saved != null && saved.equals(stamp + "|" + SHA_LLM)) {
        VERIFIED_LLM_CACHE.put(stamp, SHA_LLM);
        android.util.Log.i("G1MODEL", "verified-model cache hit (persisted) " + stamp);
        return null;
      }
    } catch (Exception ignored) {}
    if (len != BYTES_LLM) {
      return "size mismatch: got " + len + " bytes, expected " + BYTES_LLM + " (approved Qwen3-4B-Q4_K_M) at " + model.getAbsolutePath();
    }
    final byte[] magic = new byte[4];
    try (FileInputStream fi = new FileInputStream(model)) {
      final int n = fi.read(magic);
      if (n != 4 || magic[0] != 'G' || magic[1] != 'G' || magic[2] != 'U' || magic[3] != 'F') {
        return "not a GGUF file (bad magic) at " + model.getAbsolutePath();
      }
    } catch (IOException e) {
      return "cannot read model header: " + e;
    }
    final long t0 = System.currentTimeMillis();
    final String sha;
    try {
      sha = sha256(model);
    } catch (IOException e) {
      return "SHA-256 read failed: " + e;
    }
    android.util.Log.i("G1MODEL", "sha256=" + sha + " bytes=" + len + " hashMs=" + (System.currentTimeMillis() - t0) + " path=" + model.getAbsolutePath());
    if (!SHA_LLM.equalsIgnoreCase(sha)) {
      return "sha256 mismatch: got " + sha + ", expected " + SHA_LLM + " (approved Qwen3-4B-Q4_K_M) — AI NOT started";
    }
    VERIFIED_LLM_CACHE.put(stamp, SHA_LLM);
    try { prefs().edit().putString(PREF_LLM_VERIFIED, stamp + "|" + SHA_LLM).apply(); } catch (Exception ignored) {}
    android.util.Log.i("G1MODEL", "APPROVED Qwen3-4B-Q4_K_M verified (size + SHA-256) " + stamp);
    return null;
  }

  // ============================ G1 repair: Qwen3 ChatML prompt ============================

  /** Language-specific system instructions (Issue #2 item A: response-language routing). */
  private static final String SYSTEM_PROMPT_AM =
      "You are an offline Amharic farming assistant. Answer in ONE short Amharic sentence. Start with the most useful action. If unsure, ask one short clarifying question. Do not repeat words or sentences. Do not show reasoning. Example: Q: «የጎመን ቅጠል ላይ ነጭ ነጥብ አለ። ምን ይሆን?» A: «ብዙውን ጊዜ የሺራ ወይም ፈንገስ ምልክት ነው፤ ቅጠሉን በቅርብ ፎቶ ያሳዩኝ።»";
  private static final String SYSTEM_PROMPT_OM =
      "You are an offline Afaan Oromo farming assistant. Reply ONLY in Afaan Oromo, 1-3 short sentences. Do not show reasoning.";

  private static String systemPromptFor(final String lang) {
    return "ORM".equalsIgnoreCase(lang) ? SYSTEM_PROMPT_OM : SYSTEM_PROMPT_AM;
  }

  /**
   * Qwen3 native ChatML prompt. historyTurns, when provided, is already-formatted ChatML for the
   * earlier turns of the conversation (the e2e/voice history path); the single-turn ask path
   * passes "". The prompt always ends with the assistant generation marker.
   */
  private static String chatPrompt(final String systemInstruction, final String historyTurns, final String question) {
    final StringBuilder sb = new StringBuilder();
    sb.append("<|im_start|>system\n").append(systemInstruction).append("<|im_end|>\n");
    if (historyTurns != null && !historyTurns.isEmpty()) sb.append(historyTurns);
    // Qwen3 soft switch: '/no_think' suppresses the default thinking block. Without it the
    // 96-token budget is consumed by <think> and the reply is empty (verified 2026-11-14).
    sb.append("<|im_start|>user\n").append(question).append(" /no_think").append("<|im_end|>\n");
    sb.append("<|im_start|>assistant\n");
    return sb.toString();
  }

  /** Cuts the reply at the first <|im_end|>, strips ChatML markers, keeps control-line filtering. */
  /** Deterministic UX guard: collapse a phrase repeated 3+ times by a stalled model.
   * Does not change the model, prompt intent or approved requirement scope. */
  private static String collapseRepeatedPhrases(String input) {
    if (input == null) return null;
    final String[] w = input.trim().split("\\s+");
    final java.util.List<String> out = new java.util.ArrayList<>();
    int i = 0;
    while (i < w.length) {
      boolean found = false;
      for (int n = Math.min(6, w.length - i); n >= 2; n--) {
        if (i + 2 * n > w.length) continue;
        boolean same = true;
        for (int k = 0; k < n; k++) if (!w[i + k].equals(w[i + n + k])) { same = false; break; }
        if (!same) continue;
        int reps = 1;
        int j = i + n;
        while (j + n <= w.length) {
          boolean eq = true;
          for (int k = 0; k < n; k++) if (!w[j + k].equals(w[i + k])) { eq = false; break; }
          if (!eq) break;
          reps++; j += n;
        }
        if (reps >= 3) {
          for (int k = 0; k < n; k++) out.add(w[i + k]);
          i = j; found = true; break;
        }
      }
      if (!found) { out.add(w[i]); i++; }
    }
    return String.join(" ", out);
  }

  private static String cleanReply(final String raw) {
    String text = raw == null ? "" : raw;
    // 2026-11-14 repair: llama-cli runs in chat mode and echoes "> <prompt>" to stdout before the
    // answer. Extract the answer segment between the LAST "> " prompt line and the timing/exit
    // trailer, so wrapper banners and prompt echo can never become the reply.
    final int gt = text.lastIndexOf("\n> ");
    if (gt >= 0) {
      final int nl = text.indexOf('\n', gt + 1);
      text = nl >= 0 ? text.substring(nl + 1) : "";
    }
    final int tp = text.indexOf("[ Prompt:");
    if (tp >= 0) text = text.substring(0, tp);
    final int thStart = text.indexOf("<think>");
    final int thEnd = text.indexOf("</think>");
    if (thStart >= 0 && thEnd > thStart) text = text.substring(thEnd + "</think>".length());
    final int ex = text.indexOf("Exiting...");
    if (ex >= 0) text = text.substring(0, ex);
    final int e = text.lastIndexOf("[End thinking]");
    if (e >= 0) {
      text = text.substring(e + "[End thinking]".length());
    } else {
      final int a = text.lastIndexOf("<|im_start|>assistant");
      if (a >= 0) text = text.substring(a + "<|im_start|>assistant".length());
    }
    final int end = text.indexOf("<|im_end|>");
    if (end >= 0) text = text.substring(0, end);
    text = text.replace("<|im_start|>", "").replace("<|im_end|>", "").replace("<|endoftext|>", "")
               .replace("<|end_of_text|>", "").replace("<think>", "").replace("</think>", "");
    final StringBuilder ab = new StringBuilder();
    for (String ln : text.split("\n")) {
      final String t = ln.trim();
      if (t.isEmpty()) continue;
      final String lc = t.toLowerCase(java.util.Locale.ROOT);
      if (lc.startsWith(">") || lc.startsWith("llama") || lc.startsWith("load") || lc.startsWith("build")
          || lc.startsWith("model") || lc.startsWith("ftype") || lc.startsWith("modalities")
          || lc.startsWith("available") || lc.startsWith("commands") || lc.startsWith("/")
          || lc.startsWith("[ prompt") || lc.startsWith("[ generation") || lc.startsWith("exiting")
          || lc.startsWith("you are an offline") || lc.startsWith("reply only") || lc.startsWith("do not show")
          || lc.startsWith("okay, the user") || lc.startsWith("[start thinking]") || lc.startsWith("[end thinking]")
          || lc.contains("main:") || lc.contains("llama_model_loader") || lc.contains("print_info")
          || t.contains("▀") || t.contains("▄") || t.contains("██") || t.contains("▌")) continue;
      ab.append(t).append(" ");
    }
    final String clean = collapseRepeatedPhrases(ab.toString().trim());
    if (!clean.isEmpty()) return clean;
    final String tail = raw == null ? "" : raw.substring(Math.max(0, raw.length() - 300)).replace("\n", " | ");
    return "(empty reply) raw_tail: " + tail;
  }

  private static final class ModelVerifyException extends Exception {
    ModelVerifyException(String m) { super(m); }
  }

  private static final class LlmReply {
    final String text; final String raw; final int exit; final long ms;
    LlmReply(String t, String r, int e, long m) { text = t; raw = r; exit = e; ms = m; }
  }

  /**
   * Single spawn point for llama-cli. REFUSES to start (throws ModelVerifyException) unless the
   * pinned Qwen3-4B-Q4_K_M size + SHA-256 verify; the ask path and the voice/e2e chain both use
   * this so no non-approved model can ever run. Flags and model pin are unchanged.
   */
  /** Explicit per-stage timeout marker: a timeout is a FAIL, never a success. */
  private static final class StageTimeout extends Exception {
    final String stage; final long budgetMs;
    StageTimeout(String stage, long budgetMs, String msg) { super(msg); this.stage = stage; this.budgetMs = budgetMs; }
  }

  /** Runs one pipeline stage with an explicit budget; on timeout the stage is cancelled and FAILs. */
  private static <T> T callWithTimeout(final String stage, final long budgetMs, java.util.concurrent.Callable<T> c) throws Exception {
    final java.util.concurrent.FutureTask<T> ft = new java.util.concurrent.FutureTask<>(c);
    final Thread th = new Thread(ft, "g1-stage-" + stage);
    th.setDaemon(true); th.start();
    try {
      return ft.get(budgetMs, java.util.concurrent.TimeUnit.MILLISECONDS);
    } catch (java.util.concurrent.TimeoutException te) {
      ft.cancel(true);
      throw new StageTimeout(stage, budgetMs, stage + " TIMEOUT after " + budgetMs + " ms");
    } catch (java.util.concurrent.ExecutionException ee) {
      final Throwable cause = ee.getCause();
      if (cause instanceof Exception) throw (Exception) cause;
      throw new Exception(cause);
    }
  }

  private LlmReply runLlama(final File model, final String fullPrompt) throws Exception {
    return runLlama(model, fullPrompt, 900_000L, 48);
  }

  /**
   * Bounded variant used by the E2E harness: explicit per-stage LLM budget (timeout = FAIL) and an
   * explicit generation cap so a stalled turn cannot run unbounded. Production ask() keeps 900 s/96.
   */
  private LlmReply runLlama(final File model, final String fullPrompt, final long timeoutMs, final int nPredict) throws Exception {
    final String reject = llmRejectionReason(model);
    if (reject != null) {
      android.util.Log.e("G1MODEL", "REJECTED at use — llama-cli NOT spawned: " + reject);
      throw new ModelVerifyException(reject);
    }
    final File exe = new File(getApplicationInfo().nativeLibraryDir, "libllama-cli.so");
    if (!exe.exists()) throw new IOException("llama native not found: " + exe.getAbsolutePath());
    final long t0 = System.currentTimeMillis();
    Process proc = null;
    try {
      final ProcessBuilder pb = new ProcessBuilder(exe.getAbsolutePath(), "--offline", "-m", model.getAbsolutePath(), "-p", fullPrompt,
          "--single-turn", "--no-warmup", "--reasoning", "off", "--simple-io", "--no-display-prompt", "--no-jinja",
          "-n", String.valueOf(nPredict), "-c", "2048", "-t", "4", "--temp", "0", "--seed", "42");
      pb.directory(new File(getApplicationInfo().nativeLibraryDir));
      pb.redirectErrorStream(true);
      pb.redirectInput(ProcessBuilder.Redirect.from(new File("/dev/null")));
      pb.environment().put("LD_LIBRARY_PATH", getApplicationInfo().nativeLibraryDir);
      proc = pb.start();
      activeLlmProc = proc;
      final Process procF = proc;
      ui.post(() -> status.setText("llama ሂደት ተጀምሯል — በማስላት ላይ…"));
      // BOUNDED READ (2026-11-14 repair): the wrapper can outlive its child and block forever on
      // a read; a 900 s cap turns a hang into an explicit, diagnosable failure instead of a
      // silent stuck worker. 900 s > measured worst case (~9 min single turn at 0.6 tok/s).
      final StringBuilder out = new StringBuilder();
      final Throwable[] readErr = new Throwable[1];
      final Thread reader = new Thread(() -> {
        try (BufferedReader br = new BufferedReader(new InputStreamReader(procF.getInputStream(), "UTF-8"))) {
          String line;
          while ((line = br.readLine()) != null) out.append(line).append('\n');
        } catch (Throwable t) { readErr[0] = t; }
      }, "g1-llama-reader");
      reader.setDaemon(true);
      reader.start();
      final long progressStart = t0;
      final Thread progress = new Thread(() -> {
        while (procF.isAlive()) {
          try { Thread.sleep(5000L); } catch (InterruptedException ie) { return; }
          if (!aiKeyOn || !procF.isAlive()) return;
          final long sec = (System.currentTimeMillis() - progressStart) / 1000L;
          ui.post(() -> status.setText("ማስላት… " + sec + "s — AI OFF ን በመጫን ማቆም ይችላሉ"));
        }
      }, "g1-llama-progress");
      progress.setDaemon(true);
      progress.start();
      final long deadline = t0 + timeoutMs;
      while (reader.isAlive() && System.currentTimeMillis() < deadline) {
        try { Thread.sleep(200L); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
      }
      if (reader.isAlive()) {
        proc.destroyForcibly();
        throw new StageTimeout("llm", timeoutMs, "llama produced no complete output within " + timeoutMs + " ms (process destroyed)");
      }
      if (!aiKeyOn) { proc.destroyForcibly(); throw new IOException("AI_KEY_OFF — inference cancelled"); }
      if (readErr[0] != null) throw new IOException("llama stdout read failed: " + readErr[0]);
      final int code = proc.waitFor();
      final long ms = System.currentTimeMillis() - t0;
      final String raw = out.toString();
      try { final FileWriter rw = new FileWriter(new File(getFilesDir(), "last-raw.txt")); rw.write(raw); rw.close(); } catch (Exception ignored) {}
      return new LlmReply(cleanReply(raw), raw, code, ms);
    } finally {
      if (proc != null) proc.destroy();
      if (activeLlmProc == proc) activeLlmProc = null;
    }
  }

  // ============================ G1 repair: additive test hooks ============================

  /** Explicit AI probe extras double as operator consent for that probe (see onCreate). */
  private static boolean hasExplicitAiProbe(Intent it) {
    if (it == null) return false;
    for (String x : new String[]{"tts_test", "mic_test", "asr_test", "voice_test", "sms_test",
                                 "asr_wav_test", "e2e_turns_json", "safety_tts_test", "autorun", "prompt_b64"}) {
      if (it.hasExtra(x)) return true;
    }
    return false;
  }

  /** Resolves a hook fixture path: must be absolute and inside this app's files dir(s). */
  private File requireHookFile(final String path) throws Exception {
    if (path == null || path.trim().isEmpty()) throw new IOException("empty hook path");
    final File f = new File(path.trim());
    if (!f.isAbsolute()) throw new IOException("hook path must be absolute: " + path);
    final String canon = f.getCanonicalPath();
    final String files = getFilesDir().getCanonicalPath();
    final File ext = getExternalFilesDir(null);
    final String extPath = ext == null ? null : ext.getCanonicalPath();
    final boolean inside = canon.startsWith(files + File.separator)
        || (extPath != null && canon.startsWith(extPath + File.separator));
    if (!inside) throw new SecurityException("hook path outside the app files dir: " + canon);
    if (!f.isFile() || !f.canRead()) throw new IOException("hook file missing/unreadable: " + canon);
    return f;
  }

  private static String readUtf8(final File f) throws Exception {
    final byte[] b = new byte[(int) f.length()];
    try (FileInputStream in = new FileInputStream(f)) {
      int off = 0;
      while (off < b.length) { final int n = in.read(b, off, b.length - off); if (n < 0) break; off += n; }
      if (off != b.length) throw new IOException("short read: " + f);
    }
    return new String(b, StandardCharsets.UTF_8);
  }

  private long availableRamMb() {
    try {
      final android.app.ActivityManager am = (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
      final android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
      am.getMemoryInfo(mi);
      return mi.availMem >> 20;
    } catch (Exception ignored) { return -1L; }
  }

  private static void put(final JSONObject o, final String k, final Object v) {
    try { o.put(k, v); } catch (Exception ignored) {}
  }

  /**
   * Hook «asr_wav_test»: decode a 16 kHz mono PCM16 WAV fixture and run the REAL AsrEngine path
   * on its PCM. Additive — only runs when the intent extra is present.
   */
  private void runAsrWavTestHook(final String path) {
    if (!aiAllowed()) {
      android.util.Log.i("G1ASR", "WAVTEST refused — AI gate denied (no audio decoded, no model loaded)");
      status.setText("የWAV ASR ፍተሻ ተከልክሏል — AI ቁልፍ/ጥሪ/ማህደረ ትውስታ ፈቃድ የለም");
      return;
    }
    status.setText("WAV ፍተሻ፦ ወደ ASR…");
    worker.execute(() -> {
      final long t0 = System.currentTimeMillis();
      final JSONObject ev = new JSONObject();
      put(ev, "type", "asr_wav_test");
      try {
        final File wav = requireHookFile(path);
        put(ev, "wav", wav.getAbsolutePath());
        put(ev, "wav_bytes", wav.length());
        final float[] pcm = readWav16kMonoPcm16(wav);
        put(ev, "samples", pcm.length);
        final AsrEngine.Result r = asr.transcribe(pcm);
        put(ev, "transcript", r.text);
        put(ev, "lang", r.language);
        put(ev, "frames", r.frames);
        put(ev, "asr_infer_ms", r.inferMs);
        put(ev, "chain_ms", System.currentTimeMillis() - t0);
        put(ev, "ram_mb", availableRamMb());
        put(ev, "ok", true);
        android.util.Log.i("G1ASR", "WAVTEST text=" + r.text + " lang=" + r.language + " frames=" + r.frames + " inferMs=" + r.inferMs);
        android.util.Log.i("G1E2E", ev.toString());
        AsrEngine.releaseSession();
        final String txt = r.text;
        ui.post(() -> status.setText("ASR WAVTEST ✓ " + txt));
      } catch (Exception e) {
        put(ev, "ok", false);
        put(ev, "error", e.toString());
        put(ev, "chain_ms", System.currentTimeMillis() - t0);
        put(ev, "ram_mb", availableRamMb());
        android.util.Log.e("G1ASR", "WAVTEST FAILED: " + e);
        android.util.Log.e("G1E2E", ev.toString());
        final String msg = e.getMessage() == null ? e.toString() : e.getMessage();
        ui.post(() -> status.setText("ASR WAVTEST FAILED: " + msg));
      }
    });
  }

  /**
   * Hook «e2e_turns_json»: JSON array [{"wav":path,"text":optional,"lang":"AMH|ORM"}] run
   * sequentially through the REAL pipeline (ASR from the WAV when no text is given; LLM with the
   * accumulated conversation history; TTS of the reply). Emits one G1E2E JSON line per turn plus
   * a final summary line. Additive — only runs when the intent extra is present.
   */
  private void runE2eTurnsHook(final String path) {
    if (!aiAllowed()) {
      android.util.Log.i("G1E2E", "E2E refused — AI gate denied (no turn started)");
      status.setText("E2E ፍተሻ ተከልክሏል — AI ቁልፍ/ጥሪ/ማህደረ ትውስታ ፈቃድ የለም");
      return;
    }
    status.setText("E2E ውይይት ፍተሻ፦ በማሄድ ላይ…");
    worker.execute(() -> {
      final long t0 = System.currentTimeMillis();
      int total = 0, ok = 0, failed = 0;
      boolean stopAfterFailure = false;
      final StringBuilder conv = new StringBuilder();
      final JSONArray turns;
      try {
        final File jf = requireHookFile(path);
        turns = new JSONArray(readUtf8(jf));
        total = turns.length();
        android.util.Log.i("G1E2E", "E2E start turns=" + total + " json=" + jf.getAbsolutePath());
      } catch (Exception e) {
        final JSONObject err = new JSONObject();
        put(err, "type", "e2e_summary");
        put(err, "ok", false);
        put(err, "load_error", e.toString());
        put(err, "ram_mb", availableRamMb());
        android.util.Log.e("G1E2E", err.toString());
        android.util.Log.e("G1E2E", "SUMMARY turns=0 ok=0 failed=1 load_error=" + e);
        final String msg = e.getMessage() == null ? e.toString() : e.getMessage();
        ui.post(() -> status.setText("E2E ፍተሻ ስህተት፦ " + msg));
        return;
      }
      for (int i = 0; i < turns.length(); i++) {
        final JSONObject ev = new JSONObject();
        put(ev, "type", "e2e_turn");
        put(ev, "turn", i + 1);
        final long tt0 = System.currentTimeMillis();
        try {
          if (!aiAllowed()) throw new IllegalStateException("AI key/phone-call/RAM gate denied — no AI stage started");
          final JSONObject turn = turns.optJSONObject(i);
          if (turn == null) throw new IllegalArgumentException("turn " + (i + 1) + " is not a JSON object");
          String lang = turn.optString("lang", "AMH");
          // Explicit per-stage budgets (defaults sized from measured emulator runs). A timeout is FAIL.
          final JSONObject bud = turn.optJSONObject("budget_ms");
          final long bAsr = bud == null ? 240_000L : bud.optLong("asr", 240_000L);
          final long bLlm = bud == null ? 600_000L : bud.optLong("llm", 600_000L);
          final long bTts = bud == null ? 120_000L : bud.optLong("tts", 120_000L);
          final int maxTokens = turn.optInt("max_tokens", 96);
          put(ev, "budget_ms", "asr=" + bAsr + ",llm=" + bLlm + ",tts=" + bTts);
          put(ev, "max_tokens", maxTokens);
          String transcript = turn.has("text") ? turn.optString("text", null) : null;
          final String wavPath = turn.optString("wav", null);
          final boolean hasWav = wavPath != null && !wavPath.isEmpty();
          long asrMs = 0;
          // A given WAV ALWAYS goes through the REAL ASR front end; "text" is for LLM-only turns.
          if (hasWav) {
            final File wav = requireHookFile(wavPath);
            put(ev, "wav", wav.getAbsolutePath());
            final float[] pcm = readWav16kMonoPcm16(wav);
            put(ev, "samples", pcm.length);
            final long a0 = System.currentTimeMillis();
            final float[] pcmF = pcm;
            final AsrEngine.Result ar = callWithTimeout("asr", bAsr, () -> asr.transcribe(pcmF));
            asrMs = System.currentTimeMillis() - a0;
            transcript = ar.text;
            if (ar.language != null && !ar.language.isEmpty()) lang = ar.language;
            put(ev, "frames", ar.frames);
            put(ev, "asr_infer_ms", ar.inferMs);
            AsrEngine.releaseSession();
            logPerf("e2e-post-asr-release");
          } else if (transcript == null || transcript.isEmpty()) {
            throw new IllegalArgumentException("turn " + (i + 1) + " has neither \"wav\" nor \"text\"");
          }
          put(ev, "transcript", transcript);
          put(ev, "lang", lang);
          put(ev, "asr_ms", asrMs);
          final File model = modelFile();
          final long l0 = System.currentTimeMillis();
          final boolean highRisk = SafetyGuard.isHighRiskQuery(transcript);
          final String safeReply;
          final String replyRaw;
          final int llmExit;
          final boolean safetyGuarded;
          if (highRisk) {
            // P0: deterministic refusal BEFORE any model call; llm_skipped=true is part of the evidence.
            replyRaw = "";
            safeReply = SafetyGuard.refusal(lang);
            llmExit = -1;
            safetyGuarded = true;
            android.util.Log.i("G1SAFE", "e2e turn " + (i + 1) + " highRiskQuery=1 quantity="
                + SafetyGuard.hasQuantityIntent(transcript) + " injection=" + SafetyGuard.hasInjectionAttempt(transcript)
                + " lang=" + lang + " -> DETERMINISTIC_REFUSAL (llm_skipped=true)");
          } else {
            android.util.Log.i("G1LLM", "e2e turn " + (i + 1) + " lang=" + lang + " systemPrompt=" + (systemPromptFor(lang).contains("Oromo") ? "OM" : "AM"));
          final LlmReply reply = runLlama(model, chatPrompt(systemPromptFor(lang), conv.toString(), transcript), bLlm, maxTokens);
            replyRaw = reply.text;
            final String post = SafetyGuard.guardReply(transcript, lang, reply.text);
            safetyGuarded = !post.equals(reply.text);
            safeReply = post;
            llmExit = reply.exit;
          }
          if (!highRisk && (llmExit != 0 || replyRaw == null || replyRaw.trim().isEmpty())) {
            throw new IllegalStateException("LLM_NOT_COMPLETED: exit=" + llmExit + " raw=" + (replyRaw == null ? "null" : replyRaw.trim().substring(0, Math.min(80, replyRaw.trim().length()))));
          }
          if (!highRisk && replyRaw != null && replyRaw.contains("failed to get a free port")) {
            throw new IllegalStateException("LLM_NOT_COMPLETED: llama runtime could not bind a port");
          }
          put(ev, "reply_raw", replyRaw);
          put(ev, "reply", safeReply);
          put(ev, "safety_guarded", safetyGuarded);
          put(ev, "high_risk_query", highRisk);
          put(ev, "llm_skipped", highRisk);
          put(ev, "llm_ms", System.currentTimeMillis() - l0);
          put(ev, "llm_exit", llmExit);
          conv.append("<|im_start|>user\n").append(transcript).append("<|im_end|>\n");
          conv.append("<|im_start|>assistant\n").append(safeReply).append("<|im_end|>\n");
          final long s0 = System.currentTimeMillis();
          String tts;
          boolean ttsOk = false;
          try {
            final String safeReplyF = safeReply;
            final String langF = lang;
            tts = callWithTimeout("tts", bTts, () -> new TtsEngine(this).speak(safeReplyF, langF));
            ttsOk = tts != null && tts.startsWith("TTS OK");
          } catch (StageTimeout st) {
            TtsEngine.stopPlayback();
            throw st;
          } catch (Exception te) {
            tts = "TTS FAILED: " + te;
            android.util.Log.e("G1E2E", "turn " + (i + 1) + " TTS FAILED", te);
          }
          put(ev, "tts", tts);
          put(ev, "tts_ok", ttsOk);
          put(ev, "tts_ms", System.currentTimeMillis() - s0);
          put(ev, "ram_mb", availableRamMb());
          put(ev, "turn_total_ms", System.currentTimeMillis() - tt0);
          if (!ttsOk) {
            failed++;
            put(ev, "ok", false);
            put(ev, "error", "TTS_NOT_COMPLETED: " + tts);
            android.util.Log.e("G1E2E", ev.toString());
            android.util.Log.e("G1E2E", "turn " + (i + 1) + " FAIL: TTS_NOT_COMPLETED — turn not counted as full voice pass");
            continue;
          }
          put(ev, "ok", true);
          ok++;
          android.util.Log.i("G1E2E", ev.toString());
        } catch (Exception e) {
          failed++;
          put(ev, "ok", false);
          put(ev, "error", e.toString());
          if (e instanceof StageTimeout) {
            final StageTimeout st = (StageTimeout) e;
            put(ev, "timeout_stage", st.stage);
            put(ev, "timeout_budget_ms", st.budgetMs);
            put(ev, "stage_terminated", true);
            stopAfterFailure = true;
          }
          put(ev, "ram_mb", availableRamMb());
          put(ev, "turn_total_ms", System.currentTimeMillis() - tt0);
          android.util.Log.e("G1E2E", ev.toString());
          if (stopAfterFailure) {
            android.util.Log.e("G1E2E", "STOP after explicit stage timeout — run marked FAIL at turn " + (i + 1));
            break;
          }
        }
      }
      final int totalF = total, okF = ok, failedF = failed;
      final long totalMs = System.currentTimeMillis() - t0;
      final JSONObject sum = new JSONObject();
      put(sum, "type", "e2e_summary");
      put(sum, "turns", totalF);
      put(sum, "ok", okF);
      put(sum, "failed", failedF);
      put(sum, "total_ms", totalMs);
      put(sum, "ram_mb", availableRamMb());
      android.util.Log.i("G1E2E", sum.toString());
      android.util.Log.i("G1E2E", "SUMMARY turns=" + totalF + " ok=" + okF + " failed=" + failedF + " totalMs=" + totalMs);
      ui.post(() -> status.setText("G1E2E: " + okF + "/" + totalF + " ዙሮች ተጠናቀዋል, " + failedF + " ያልተሳኩ"));
    });
  }

  /**
   * TEST-ONLY (debug build) integration probe for the FINAL-OUTPUT safety boundary. It feeds a
   * SYNTHETIC reply string through the SAME SafetyGuard + TtsEngine path used by production display
   * and speech (no model call; no inference is claimed), and verifies the harmful text is replaced
   * before display/TTS. Release builds refuse the extra. This is not a production mock hook.
   */

  /** Debug-only: verify ORM TTS does NOT silently fall back to the Amharic voice. */
  private void runTtsLangProbeHook() {
    final boolean debuggable = (getApplicationInfo().flags
        & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    if (!debuggable) { android.util.Log.e("G1TTS", "tts_lang_probe refused: not debuggable"); return; }
    worker.execute(() -> {
      String res;
      try { res = new TtsEngine(this).speak("Akkam, boqqolloon koo akkamitti guddisuu danda'a?", "ORM"); }
      catch (Exception e) { res = "TTS_LANG_PROBE_EXCEPTION: " + e; }
      android.util.Log.i("G1TTS", "tts_lang_probe " + res);
      final String out = res;
      ui.post(() -> status.setText(out.startsWith("TTS_SKIPPED_NO_OROMO_VOICE") ? "ORM TTS skipped: no approved Oromo voice ✓" : out));
    });
  }

  /** T2: inventory the actual Android TTS engines/voices and offline flags (debug-only). */
  private void runAndroidTtsInventoryHook() {
    final boolean debuggable = (getApplicationInfo().flags
        & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    if (!debuggable) { android.util.Log.e("G1ANDTTS", "tts_voices_test refused: not debuggable"); return; }
    worker.execute(() -> {
      final JSONObject ev = new JSONObject();
      put(ev, "type", "android_tts_inventory");
      put(ev, "test_only", true);
      final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
      final android.speech.tts.TextToSpeech[] ttsRef = new android.speech.tts.TextToSpeech[1];
      ttsRef[0] = new android.speech.tts.TextToSpeech(this, ttsStatus -> {
        try {
          put(ev, "init_status", ttsStatus);
          put(ev, "default_engine", ttsRef[0].getDefaultEngine());
          org.json.JSONArray engines = new org.json.JSONArray();
          for (android.speech.tts.TextToSpeech.EngineInfo e : ttsRef[0].getEngines()) {
            JSONObject o = new JSONObject(); put(o, "name", e.name); put(o, "label", e.label); engines.put(o);
          }
          put(ev, "engines", engines);
          org.json.JSONArray langResults = new org.json.JSONArray();
          for (String tag : new String[]{"om", "af", "am"}) {
            JSONObject o = new JSONObject();
            put(o, "lang", tag);
            put(o, "available", ttsRef[0].isLanguageAvailable(new java.util.Locale(tag)));
            langResults.put(o);
          }
          put(ev, "language_availability", langResults);
          int vc = 0;
          org.json.JSONArray vmatches = new org.json.JSONArray();
          org.json.JSONArray vlocales = new org.json.JSONArray();
          for (android.speech.tts.Voice v : ttsRef[0].getVoices()) {
            vc++;
            String lt = v.getLocale().toLanguageTag();
            if (vlocales.length() < 40) vlocales.put(lt);
            if (lt.startsWith("om") || lt.startsWith("af") || lt.startsWith("am")) {
              JSONObject o = new JSONObject();
              put(o, "name", v.getName()); put(o, "locale", lt);
              put(o, "network_required", v.isNetworkConnectionRequired());
              vmatches.put(o);
            }
          }
          put(ev, "voice_count", vc);
          put(ev, "locale_sample", vlocales);
          put(ev, "matching_om_af_am_voices", vmatches);
        } catch (Exception e) {
          try { put(ev, "error", e.toString()); } catch (Exception ignored) {}
        } finally {
          try { ttsRef[0].shutdown(); } catch (Exception ignored) {}
          android.util.Log.i("G1ANDTTS", ev.toString());
          ui.post(() -> status.setText("android TTS inventory logged"));
          latch.countDown();
        }
      });
      try { latch.await(60, java.util.concurrent.TimeUnit.SECONDS); } catch (InterruptedException ignored) {}
    });
  }

  /** T1: render text with the selected Android TTS engine offline (debug-only). */
  private void runAndroidTtsRenderHook(final String text, final String langTag) {
    final boolean debuggable = (getApplicationInfo().flags
        & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    if (!debuggable) { android.util.Log.e("G1ANDTTS", "android_tts_render refused: not debuggable"); return; }
    final String lang = (langTag == null || langTag.isEmpty()) ? "om" : langTag;
    worker.execute(() -> {
      final JSONObject ev = new JSONObject();
      put(ev, "type", "android_tts_render");
      put(ev, "test_only", true);
      put(ev, "text", text);
      put(ev, "lang", lang);
      final java.io.File out = new java.io.File(getFilesDir(), "android_tts_" + lang + ".wav");
      final long t0 = System.currentTimeMillis();
      final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
      final android.speech.tts.TextToSpeech[] ttsRef = new android.speech.tts.TextToSpeech[1];
      ttsRef[0] = new android.speech.tts.TextToSpeech(this, ttsStatus -> {
        try {
          put(ev, "init_status", ttsStatus);
          int avail = ttsRef[0].setLanguage(new java.util.Locale(lang));
          put(ev, "language_available_result", avail);
          put(ev, "default_engine", ttsRef[0].getDefaultEngine());
          ttsRef[0].setOnUtteranceProgressListener(new android.speech.tts.UtteranceProgressListener() {
            @Override public void onStart(String id) {}
            @Override public void onDone(String id) {
              try {
                put(ev, "synthesis_ms", System.currentTimeMillis() - t0);
                put(ev, "wav_bytes", out.length());
                android.util.Log.i("G1ANDTTS", ev.toString());
              } catch (Exception ignored) {}
              latch.countDown();
            }
            @Override public void onError(String id) {
              try { put(ev, "error", "utterance_error"); } catch (Exception ignored) {}
              latch.countDown();
            }
          });
          int rc = ttsRef[0].synthesizeToFile(text, null, out, "g1tts_" + lang);
          put(ev, "synthesize_return", rc);
          if (rc != android.speech.tts.TextToSpeech.SUCCESS) { latch.countDown(); }
        } catch (Exception e) {
          try { put(ev, "exception", e.toString()); } catch (Exception ignored) {}
          latch.countDown();
        }
      });
      try { latch.await(90, java.util.concurrent.TimeUnit.SECONDS); } catch (InterruptedException ignored) {}
      try { ttsRef[0].shutdown(); } catch (Exception ignored) {}
      if (latch.getCount() > 0) {
        try { put(ev, "error", "timeout"); } catch (Exception ignored) {}
        android.util.Log.i("G1ANDTTS", ev.toString());
      }
      ui.post(() -> status.setText("android TTS render finished"));
    });
  }

  private void runSafetyTtsProbeHook(final String text) {
    final boolean debuggable = (getApplicationInfo().flags
        & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    if (!debuggable) {
      android.util.Log.e("G1SAFE", "safety_tts_test refused: not a debuggable/test build");
      return;
    }
    worker.execute(() -> {
      final String displayed = SafetyGuard.guardReply("", "AMH", text);
      final String spoken = SafetyGuard.ttsGate("", "AMH", text);
      String tts;
      try { tts = new TtsEngine(this).speak(spoken, "AMH"); }
      catch (Exception e) { tts = "TTS FAILED: " + e; }
      final JSONObject ev = new JSONObject();
      put(ev, "type", "safety_tts_probe");
      put(ev, "test_only", true);
      put(ev, "input", text);
      put(ev, "displayed", displayed);
      put(ev, "spoken", spoken);
      put(ev, "guarded", !spoken.equals(text));
      put(ev, "tts", tts);
      android.util.Log.i("G1SAFE", ev.toString());
      ui.post(() -> status.setText("safety TTS probe: guarded=" + !spoken.equals(text)));
    });
  }

  /**
   * Decodes a 16 kHz mono PCM16 WAV into float PCM [-1,1] for the REAL AsrEngine path. Strict by
   * design: wrong fixtures fail loudly (a hook must never pretend ASR ran).
   */
  private static float[] readWav16kMonoPcm16(final File wav) throws Exception {
    try (DataInputStream in = new DataInputStream(new BufferedInputStream(new FileInputStream(wav), 1 << 16))) {
      final byte[] hdr = new byte[12];
      in.readFully(hdr);
      if (!fourCC(hdr, 0).equals("RIFF") || !fourCC(hdr, 8).equals("WAVE")) {
        throw new IOException("not a RIFF/WAVE file: " + wav.getAbsolutePath());
      }
      int format = -1, channels = -1, bits = -1;
      long rate = -1;
      while (true) {
        final String id = readFourCC(in);
        long size = readU32(in);
        if (id.equals("fmt ")) {
          if (size < 16) throw new IOException("WAV fmt chunk too short (" + size + ")");
          int tag = readU16(in);
          channels = readU16(in);
          rate = readU32(in);
          readU32(in);
          readU16(in);
          bits = readU16(in);
          long rest = size - 16;
          if (tag == 0xFFFE) {
            if (rest < 24) throw new IOException("WAV extensible fmt chunk too short");
            readU16(in);
            readU16(in);
            readU32(in);
            final int sub = readU16(in);
            skipFully(in, 14);
            rest -= 24;
            if (sub != 1) throw new IOException("WAV extensible subformat is not PCM (tag=" + sub + ")");
            tag = 1;
          }
          skipFully(in, rest);
          format = tag;
        } else if (id.equals("data")) {
          if (format != 1 || channels != 1 || rate != AsrEngine.RATE || bits != 16) {
            throw new IOException("WAV must be PCM16 16 kHz mono (format=" + format + " channels=" + channels + " rate=" + rate + " bits=" + bits + ")");
          }
          long n = size;
          if (n <= 0 || n == 0xFFFFFFFFL) n = Math.max(0, wav.length() - 44L);
          if (n > 64L * 1024 * 1024) throw new IOException("WAV data too large for a hook fixture (" + n + " bytes)");
          if ((n & 1L) != 0) n -= 1;
          final byte[] pcm = new byte[(int) n];
          in.readFully(pcm);
          final float[] out = new float[(int) n / 2];
          for (int i = 0; i < out.length; i++) {
            final int v = (short) ((pcm[2 * i] & 0xff) | (pcm[2 * i + 1] << 8));
            out[i] = v / 32768f;
          }
          android.util.Log.i("G1ASR", "WAVTEST decoded wav=" + wav.getAbsolutePath() + " samples=" + out.length + " rate=" + rate + " channels=" + channels + " bits=" + bits);
          return out;
        } else {
          skipFully(in, size + (size & 1L));
        }
      }
    }
  }

  private static String fourCC(final byte[] b, final int off) {
    return new String(b, off, 4, StandardCharsets.US_ASCII);
  }

  private static String readFourCC(final DataInputStream in) throws IOException {
    final byte[] b = new byte[4];
    in.readFully(b);
    return fourCC(b, 0);
  }

  private static int readU16(final DataInputStream in) throws IOException {
    return in.readUnsignedByte() | (in.readUnsignedByte() << 8);
  }

  private static long readU32(final DataInputStream in) throws IOException {
    return (readU16(in) | ((long) readU16(in) << 16)) & 0xFFFFFFFFL;
  }

  private static void skipFully(final DataInputStream in, long n) throws IOException {
    while (n > 0) {
      final long s = in.skip(n);
      if (s <= 0) {
        if (in.read() < 0) return;
        n -= 1;
      } else {
        n -= s;
      }
    }
  }

  @Override protected void onActivityResult(int req, int res, Intent data) {
    super.onActivityResult(req, res, data);
    if (req == 42 && res == RESULT_OK && data != null && data.getData() != null) {
      if (pendingImport == IMP_XFER) {
        status.setText("የማስተላለፊያ ፓኬጅ በማረጋገጥ ላይ… (ሁሉም ፋይሎች በSHA-256)");
        worker.execute(() -> {
          final String r = TransferPackage.importAll(this, data.getData(), line -> ui.post(() -> status.setText(line)));
          ui.post(() -> { replyView.setText(r); status.setText(BUILD_TAG); });
        });
      } else if (pendingImport != IMP_NONE) {
        importArtifact(pendingImport, data.getData());
      } else {
        importModel(data.getData());
      }
      pendingImport = IMP_NONE;
    }
  }

  @Override protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    if (intent != null && intent.getData() != null) importModel(intent.getData());
    handlePromptIntent(intent);
  }

  private static final class ImportSpec {
    final String label; final File dest; final String sha; final long bytes;
    ImportSpec(String l, File d, String s, long b) { label = l; dest = d; sha = s; bytes = b; }
  }

  private ImportSpec specFor(int type) {
    File extDir = getExternalFilesDir(null);
    File extModels = extDir == null ? null : new File(extDir, "models");
    File extAsr = extDir == null ? null : new File(extDir, "asr");
    File extTts = extDir == null ? null : new File(extDir, "tts");
    File intModels = new File(getFilesDir(), "models");
    File intAsr = new File(getFilesDir(), "asr");
    File intTts = new File(getFilesDir(), "tts");
    switch (type) {
      case IMP_LLM:          return new ImportSpec("Qwen LLM", new File(extModels == null ? intModels : extModels, "qwen.gguf"), SHA_LLM, BYTES_LLM);
      case IMP_ASR_MAIN:     return new ImportSpec("ASR asr.onnx", new File(extAsr == null ? intAsr : extAsr, "asr.onnx"), SHA_ASR, BYTES_ASR);
      case IMP_ASR_EXT:       return new ImportSpec("ASR external-data", new File(extAsr == null ? intAsr : extAsr, "asr.onnx.data"), null, -1L);
      case IMP_ASR_FEATSPEC: return new ImportSpec("ASR featspec.json", new File(extAsr == null ? intAsr : extAsr, "featspec.json"), null, -1L);
      case IMP_ASR_VOCAB:    return new ImportSpec("ASR vocab.json", new File(extAsr == null ? intAsr : extAsr, "vocab.json"), SHA_VOCAB, BYTES_VOCAB);
      case IMP_TTS:          return new ImportSpec("TTS vits.onnx", new File(extTts == null ? intTts : extTts, "vits.onnx"), SHA_TTS, BYTES_TTS);
      default: return null;
    }
  }

  private void importArtifact(final int type, final Uri uri) {
    final ImportSpec spec = specFor(type);
    if (spec == null) { status.setText("የማይታወቅ የሞዴል ዓይነት"); return; }
    final File dest = spec.dest;
    ui.post(() -> status.setText(spec.label + " በማስገባት/ማረጋገጥ ላይ…"));
    worker.execute(() -> {
      File tmp = new File(dest.getAbsolutePath() + ".part");
      try {
        dest.getParentFile().mkdirs();
        long declared = -1;
        try (android.database.Cursor c = getContentResolver().query(uri, null, null, null, null)) {
          if (c != null && c.moveToFirst()) { int i = c.getColumnIndex(OpenableColumns.SIZE); if (i >= 0 && !c.isNull(i)) declared = c.getLong(i); }
        }
        if (spec.bytes > 0) {
          long free = new StatFs(dest.getParentFile().getAbsolutePath()).getAvailableBytes();
          if (free < spec.bytes + (64L << 20)) { final long f = free; ui.post(() -> status.setText("በቂ ቦታ የለም፦ ነፃ " + (f >> 20) + "MB፣ ያስፈልጋል " + ((spec.bytes >> 20) + 64) + "MB")); return; }
        }
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        long total = 0;
        try (InputStream in = getContentResolver().openInputStream(uri); FileOutputStream fo = new FileOutputStream(tmp)) {
          if (in == null) throw new Exception("የፋይል መክፈቻ አልተገኘም");
          if (type == IMP_LLM) {
            byte[] magic = new byte[4];
            int mr = in.read(magic);
            if (mr != 4 || magic[0] != 'G' || magic[1] != 'G' || magic[2] != 'U' || magic[3] != 'F') {
              tmp.delete();
              ui.post(() -> status.setText("ይህ ፋይል GGUF ሞዴል አይደለም"));
              return;
            }
            fo.write(magic, 0, 4); md.update(magic, 0, 4); total += 4;
          }
          byte[] buf = new byte[1 << 20]; int r;
          while ((r = in.read(buf)) > 0) { fo.write(buf, 0, r); md.update(buf, 0, r); total += r; }
        }
        final long t = total;
        final long d = declared;
        if (d > 0 && t != d) { tmp.delete(); ui.post(() -> status.setText("ያልተሟላ ቅጂ፦ " + t + " / " + d + " bytes — አልተቀበለም")); return; }
        if (spec.bytes > 0 && t != spec.bytes) {
          tmp.delete(); ui.post(() -> status.setText(spec.label + " መጠን አልተረጋገጠም፦ " + t + " ፈልጎ " + spec.bytes + " — የተፈቀደው ፋይል አይደለም")); return;
        }
        String sha = toHex(md.digest());
        if (spec.sha != null && !spec.sha.equalsIgnoreCase(sha)) {
          tmp.delete(); ui.post(() -> status.setText(spec.label + " SHA-256 አልተረጋገጠም — የተፈቀደው ፋይል አይደለም (አልተቀመጠም)"));
          android.util.Log.e("G1IMP", spec.label + " sha mismatch: got=" + sha);
          return;
        }
        if (!tmp.renameTo(dest)) { tmp.delete(); throw new Exception("ማስቀመጥ አልተሳካም"); }
        android.util.Log.i("G1IMP", spec.label + " staged " + dest.getAbsolutePath() + " bytes=" + t + " sha256=" + (spec.sha != null ? sha.substring(0, 16) + "… (verified)" : "<no registry hash — prefer the transfer package for this file>"));
        final String msg = spec.sha != null
          ? spec.label + " ተረጋግጦ ተጭኗል ✓ (" + (t >> 20) + "MB, SHA-256 ✓)"
          : spec.label + " ተጭኗል (" + (t >> 20) + "MB) — በregistry ሃሽ የለም፤ የማስተላለፊያ ፓኬጁ ይመከራል";
        ui.post(() -> status.setText(msg));
      } catch (Exception e) {
        tmp.delete();
        ui.post(() -> status.setText(spec.label + " ማስገባት ስህተት፦ " + e.getMessage()));
      }
    });
  }

  private void importModel(Uri uri) {
    importArtifact(IMP_LLM, uri);
  }

  private static String toHex(byte[] b) { StringBuilder s = new StringBuilder(); for (byte x : b) s.append(String.format("%02x", x)); return s.toString(); }
}
