package phone.farmer.g1ai;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.util.Log;

/**
 * v28: consent-controlled SMS reading (G1 85-req scope).
 *
 * PRIVACY CONTRACT (verified against the product requirement — do not weaken):
 *   - SMS is read ONLY when the user explicitly presses the «የSMS ንባብ (AI ቁልፍ)» button
 *     (or the CI sms_test probe) — there is NO receiver, NO background listener, NO
 *     auto-read on arrival. Nothing happens without an explicit request.
 *   - The request is additionally gated by the AI key: key OFF / in-call / RAM-guard
 *     denial → refused with a clear message (checked in MainActivity before this class runs).
 *   - OTP / one-time-code messages are NEVER spoken and NEVER logged: the body is
 *     classified and discarded. The refusal record carries metadata only — NO sender identity,
 *     NO body, and NO body length/hash.
 *   - Logs NEVER contain the sender identity or the message body; the caller logs only
 *     non-identifying metadata (e.g. the OTP classification flag).
 *   - READ_SMS is NOT requested at launch: MainActivity requests it on the first explicit
 *     SMS-button use (and the read itself is still gated by the AI key/call/RAM guard).
 *
 * NO message content is persisted by this class. Only one latest message is ever fetched.
 */
public final class SmsReader {
  private SmsReader() {}

  public static final class Sms {
    public final String sender;
    public final String body;
    public final long date;
    Sms(String s, String b, long d) { sender = s; body = b; date = d; }
  }

  /** Fetches ONLY the single latest inbox message. Returns null when the inbox is empty. */
  public static Sms readLatest(Context ctx) {
    Cursor c = null;
    try {
      c = ctx.getContentResolver().query(
          Uri.parse("content://sms/inbox"),
          new String[]{"address", "body", "date"},
          null, null, "date DESC LIMIT 1");
      if (c == null || !c.moveToFirst()) return null;
      String sender = c.getString(0) == null ? "" : c.getString(0);
      String body = c.getString(1) == null ? "" : c.getString(1);
      long date = c.getLong(2);
      return new Sms(sender, body, date);
    } catch (Exception e) {
      Log.e("G1SMS", "inbox query failed", e);
      return null;
    } finally {
      if (c != null) try { c.close(); } catch (Exception ignored) {}
    }
  }

  /**
   * OTP classifier — a message classified as OTP is NEVER spoken and its body is NEVER
   * logged. Deliberately broad (privacy errs on the side of refusal):
   *   - a standalone 3–8 digit code, or “code/otp/pin/verification/ቁጥር” + digits
   *   - common banking/telecom one-time-code phrasings
   */
  public static boolean isOtp(String body) {
    if (body == null) return false;
    String b = body.trim();
    String low = b.toLowerCase(java.util.Locale.ROOT);
    if (b.matches("\\d{3,8}")) return true;
    if (low.matches(".*\\b(code|otp|pin|passcode|verification|verify)\\b.*\\d{3,8}.*")) return true;
    if (low.matches(".*\\d{3,8}\\b.*\\b(code|otp|pin|passcode|verification)\\b.*")) return true;
    if (low.contains("ቁጥር") && b.matches(".*\\d{3,8}.*")) return true;
    return false;
  }
}
