import { nowIso } from './util.mjs';

export const AI_PHASES = Object.freeze({
  LISTENING: 'LISTENING',
  THINKING: 'THINKING',
  SPEAKING: 'SPEAKING',
});
const PHASE_VALUES = new Set(Object.values(AI_PHASES));

export class CallController {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.phase = 'IDLE';
    this.suspended = null;
    this.call = null;
    this.events = [];
    this.aiSession = null;
    this.aiTopicId = null;
    this.aiTurn = null;
  }

  _emit(event) {
    const record = { at: nowIso(), ...event };
    this.events.push(record);
    this.log(record);
    return record;
  }

  _assertPhase(kind) {
    if (!PHASE_VALUES.has(kind)) throw new Error(`bad_ai_phase:${kind}`);
  }

  _bindAi(sessionId, { turn, topicId } = {}) {
    if (sessionId !== undefined) this.aiSession = sessionId ?? null;
    if (turn !== undefined) this.aiTurn = turn ?? null;
    if (topicId !== undefined) this.aiTopicId = topicId ?? null;
  }

  // ማቋረጥ ከተከናወነ በኋላ ለመቀጠል የትኛው ዙር እንደተቋረጠ መታወቅ አለበት (R-04 / RU-13 / R-37)
  _aiSnapshot() {
    if (!this.isAiActive()) return null;
    return { phase: this.phase, session_id: this.aiSession, topic_id: this.aiTopicId, turn: this.aiTurn };
  }

  aiStarted(sessionId, kind = 'LISTENING', context = {}) {
    this._assertPhase(kind);
    if (this.call) {
      this._emit({ event: 'ai_blocked_by_call', session_id: sessionId, phase: kind });
      return { allowed: false, code: 'CALL_ACTIVE' };
    }
    this._bindAi(sessionId, context);
    this.phase = kind;
    this._emit({ event: 'ai_started', session_id: sessionId, phase: kind });
    return { allowed: true };
  }

  aiPhase(kind, context = {}) {
    this._assertPhase(kind);
    if (this.call) return { allowed: false, code: 'CALL_ACTIVE' };
    this._bindAi(context.sessionId, context);
    this.phase = kind;
    this._emit({ event: 'ai_phase', phase: kind, session_id: this.aiSession, turn: this.aiTurn });
    return { allowed: true };
  }

  aiFinished() {
    this.phase = 'IDLE';
    this.aiSession = null;
    this.aiTopicId = null;
    this.aiTurn = null;
    this._emit({ event: 'ai_finished' });
  }

  isAiActive() {
    return PHASE_VALUES.has(this.phase);
  }

  incoming({ from = 'unknown', kind = 'normal' } = {}) {
    if (this.call) {
      this._emit({ event: 'call_rejected_busy', from, kind });
      return { preempted: false, code: 'ALREADY_IN_CALL', phase: this.phase };
    }
    const snapshot = this._aiSnapshot();
    if (snapshot) {
      this.suspended = { ...snapshot, suspended_at: nowIso(), call_kind: kind, from };
      this._emit({ event: 'ai_preempted', snapshot: this.suspended });
    }
    this.call = { from, kind, started_at: nowIso() };
    this.phase = 'RINGING';
    this._emit({ event: 'call_incoming', from, kind, preempted: Boolean(snapshot) });
    return { preempted: Boolean(snapshot), code: snapshot ? 'AI_PREEMPTED' : 'CALL_ACCEPTED', snapshot: this.suspended };
  }

  outgoing({ to = 'unknown', kind = 'normal' } = {}) {
    if (this.call) return { preempted: false, code: 'ALREADY_IN_CALL' };
    // የወጪ ጥሪ ናሙና ከገቢ ጋር እኩል መረጃ ሊኖረው ይገባ — ክፍለ-ጊዜ/ዙር/ርዕስ ካጣ መልሶ መቀጠል አይቻልም
    const snapshot = this._aiSnapshot();
    if (snapshot) this.suspended = { ...snapshot, suspended_at: nowIso(), call_kind: kind, from: to };
    this.call = { to, kind, started_at: nowIso(), direction: 'outgoing' };
    this.phase = 'DIALING';
    this._emit({ event: 'call_outgoing', to, kind, preempted: Boolean(snapshot) });
    return { preempted: Boolean(snapshot), snapshot };
  }

  accept() {
    if (!this.call) return { ok: false, code: 'NO_CALL' };
    this.phase = 'CALL_ACTIVE';
    this._emit({ event: 'call_answered' });
    return { ok: true };
  }

  end() {
    if (!this.call) return { ok: false, code: 'NO_CALL' };
    const ended = this.call;
    this.call = null;
    this.phase = 'IDLE';
    this._emit({ event: 'call_ended', duration_hint: ended.started_at });
    const snapshot = this.suspended;
    this.suspended = null;
    if (snapshot) {
      this._emit({ event: 'ai_resume_pending_consent', snapshot });
      return { ok: true, resume_requires_consent: true, snapshot };
    }
    return { ok: true, resume_requires_consent: false, snapshot: null };
  }

  assertAiAllowed() {
    return this.call ? { allowed: false, code: 'CALL_ACTIVE' } : { allowed: true };
  }
}
