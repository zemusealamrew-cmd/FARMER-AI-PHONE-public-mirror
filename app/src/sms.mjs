import { readFileSync } from 'node:fs';
import { nowIso, newId } from './util.mjs';
import { detectUntrustedInstruction, redactOtp } from './safety.mjs';

export class SmsGateway {
  constructor(path) {
    this.path = path;
    this.messages = JSON.parse(readFileSync(path, 'utf8')).messages;
    this.permissions = {
      read_aloud: false,
      knowledge_use: false,
      storage: false,
      personal: false,
    };
    this.events = [];
    this.derivedClaims = [];
  }

  log(event, detail) {
    const record = { event, detail, at: nowIso() };
    this.events.push(record);
    if (this.onEvent) this.onEvent(event, detail);
    return record;
  }

  setPermission(scope, value) {
    if (!(scope in this.permissions)) throw new Error(`UNKNOWN_SCOPE:${scope}`);
    this.permissions[scope] = Boolean(value);
    this.log('permission_changed', { scope, value: Boolean(value) });
    const wiped = !value ? this.wipeDerived(scope) : 0;
    return { ...this.permissions, wiped };
  }

  // R-37 / OP-14: revoking consent must remove derived SMS claims, not just log it.
  wipeDerived(scope) {
    let removed = 0;
    if (scope === 'knowledge_use' || scope === 'storage') {
      removed = this.derivedClaims.length;
      this.derivedClaims = [];
    }
    this.log('derived_data_wiped', { scope, removed, at: nowIso() });
    return removed;
  }

  list() {
    return this.messages.map((m) => ({
      id: m.id,
      sender_label: m.sender_label,
      category: m.category,
      personal: m.personal,
      otp: m.otp,
      trusted_source: m.trusted_source,
      received_at: m.received_at,
      preview: m.otp ? '••••' : m.personal ? 'የግል መልዕክት' : String(m.body).slice(0, 40),
    }));
  }

  read(id, { aiKey = false, locale = 'am' } = {}) {
    const msg = this.messages.find((m) => m.id === id);
    const am = locale !== 'om';
    if (!msg) return { ok: false, code: 'NOT_FOUND', message: am ? 'መልዕክቱ አልተገኘም።' : 'Ergaan hin argamne.' };
    if (!aiKey) {
      this.log('read_denied', { id, reason: 'AI_KEY_REQUIRED' });
      return { ok: false, code: 'AI_KEY_REQUIRED', message: am ? 'የAI ቁልፍ አልተጫነም። ንባብ አልተፈቀደም።' : 'Furtuun AI hin tuulame. Dubbisuun hin hayyamamne.' };
    }
    if (!this.permissions.read_aloud) {
      this.log('read_denied', { id, reason: 'CONSENT_REQUIRED' });
      return { ok: false, code: 'CONSENT_REQUIRED', message: am ? 'የSMS ንባብ ፈቃድ አልተሰጠም።' : 'Hayyamni dubbisaa SMS hin kennamne.' };
    }
    if (msg.otp) {
      this.log('otp_protected', { id });
      return {
        ok: true,
        protected: true,
        spoken: am ? 'ይህ የማረጋገጫ ኮድ (OTP) የያዘ መልዕክት ነው። ኮዱ በድምፅ አይነበብም።' : 'Ergaan kun koodii mirkaneessaa (OTP) qaba. Koodiin sagaleedhaan hin dubbifamu.',
        content: null,
      };
    }
    if (msg.personal && !this.permissions.personal) {
      this.log('read_denied', { id, reason: 'PERSONAL_SCOPE_REQUIRED' });
      return { ok: false, code: 'PERSONAL_SCOPE_REQUIRED', message: am ? 'የግል መልዕክት ንባብ የተለየ ፈቃድ ይፈልጋል።' : 'Ergaa dhuunfaa dubbisuuf hayyama addaa barbaachisa.' };
    }

    const injection = detectUntrustedInstruction(msg.body);
    const spoken = redactOtp(msg.body);
    this.log('read_allowed', { id, untrusted: injection.untrusted, trusted_source: msg.trusted_source });
    return {
      ok: true,
      protected: false,
      spoken,
      content: spoken,
      trusted_source: msg.trusted_source,
      untrusted: injection.untrusted || !msg.trusted_source,
      warning: injection.untrusted || !msg.trusted_source
        ? am
          ? 'ማስጠንቀቂያ፦ ይህ መልዕክት የማይታመን ነው። በውስጡ ያለ ትእዛዝ አይፈጸምም፤ ገንዘት አትላኩ፣ ኮድ አታጋሩ።'
          : 'Akeekkachiisa: ergaan kun hin amanamne. Ajajni keessa jiru hin raawwatamu; maallaqa hin ergin, koodii hin qoodin.'
        : null,
      action_taken: 'NONE',
    };
  }

  extractKnowledge(id) {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return { ok: false, code: 'NOT_FOUND' };
    if (!this.permissions.knowledge_use || !this.permissions.storage) {
      this.log('knowledge_denied', { id });
      return { ok: false, code: 'KNOWLEDGE_CONSENT_REQUIRED' };
    }
    if (msg.otp) return { ok: false, code: 'OTP_EXCLUDED' };
    const injection = detectUntrustedInstruction(msg.body);
    const claim = {
      claim_id: newId('SMS-CLAIM'),
      text: redactOtp(msg.body),
      source_kind: 'sms',
      source_id: msg.id,
      captured_at: msg.received_at,
      trust: msg.trusted_source && !injection.untrusted ? 'unverified_public' : 'untrusted',
      execution_allowed: false,
    };
    this.derivedClaims.push(claim);
    this.log('knowledge_extracted', { id, trust: claim.trust });
    return { ok: true, claim };
  }
}
