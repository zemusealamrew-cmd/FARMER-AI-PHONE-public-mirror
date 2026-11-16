// Local diagnostics only. No network, identifiers, transcripts, or speech acceptance.
globalThis.CaptureAudit = (() => {
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  function signal(samples, rate) {
    let energy = 0, sum = 0, peak = 0, nonzero = 0, clipped = 0, invalid = 0, zeroRun = 0, longestZeroRun = 0;
    const window = Math.max(1, Math.round(rate * 0.02));
    let windowEnergy = 0, windowsAbovePcm16Lsb = 0, windows = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      if (!Number.isFinite(v)) { invalid++; continue; }
      energy += v * v; sum += v; windowEnergy += v * v; peak = Math.max(peak, Math.abs(v));
      if (v !== 0) { nonzero++; zeroRun = 0; } else { zeroRun++; longestZeroRun = Math.max(longestZeroRun, zeroRun); }
      if (Math.abs(v) >= 0.999) clipped++;
      if ((i + 1) % window === 0 || i === samples.length - 1) {
        const size = (i % window) + 1;
        if (Math.sqrt(windowEnergy / size) >= 1 / 32768) windowsAbovePcm16Lsb++;
        windows++; windowEnergy = 0;
      }
    }
    return { frames: samples.length, sample_rate: rate, seconds: samples.length / rate,
      peak, rms: Math.sqrt(energy / (samples.length || 1)), dc: sum / (samples.length || 1),
      nonzero_frames: nonzero, invalid_frames: invalid, clipped_frames: clipped,
      longest_digital_zero_seconds: longestZeroRun / rate, windows_20ms: windows,
      windows_at_or_above_one_pcm16_lsb: windowsAbovePcm16Lsb, speech_verified: false };
  }
  function resample(input, from, to) {
    if (!(Number.isFinite(from) && Number.isFinite(to) && from > 0 && to > 0)) throw new Error('INVALID_SAMPLE_RATE');
    for (const v of input) if (!Number.isFinite(v)) throw new Error('NONFINITE_PCM');
    if (from === to) return input;
    const out = new Float32Array(Math.floor(input.length * to / from));
    // Windowed-sinc low-pass before downsampling: linear interpolation alone aliases
    // frequencies above the destination Nyquist limit into the audible passband.
    const radius = 32, cutoff = 0.47 * Math.min(1, to / from);
    for (let i = 0; i < out.length; i++) {
      const at = i * from / to;
      let value = 0, weight = 0;
      for (let j = Math.max(0, Math.ceil(at - radius)); j <= Math.min(input.length - 1, Math.floor(at + radius)); j++) {
        const distance = j - at, x = 2 * cutoff * distance;
        const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const w = 2 * cutoff * sinc * (0.5 + 0.5 * Math.cos(Math.PI * distance / radius));
        value += input[j] * w; weight += w;
      }
      out[i] = weight ? value / weight : 0;
    }
    return out;
  }
  function begin(stream, context, selectedExplicitly) {
    const track = stream.getAudioTracks()[0], settings = track?.getSettings?.() ?? {};
    const audit = { started_ms: now(), callbacks: 0, frames: 0, first_callback_ms: null,
      last_callback_ms: null, max_callback_gap_ms: 0, events: [],
      input: { selected_explicitly: selectedExplicitly, track_sample_rate: settings.sampleRate ?? null,
        channels: settings.channelCount ?? null, echo_cancellation: settings.echoCancellation ?? null,
        noise_suppression: settings.noiseSuppression ?? null, auto_gain_control: settings.autoGainControl ?? null,
        synthetic_label_hint: /fake.*audio|fake.*input/i.test(track?.label ?? ''),
        enabled: track?.enabled ?? null, muted: track?.muted ?? null, ready_state: track?.readyState ?? null },
      context: { state_at_start: context.state, sample_rate: context.sampleRate }, native: { code: 'UNSUPPORTED', chunks: [] } };
    const event = type => { if (audit.events.length < 32) audit.events.push({ type, elapsed_ms: now() - audit.started_ms }); };
    const listeners = ['mute', 'unmute', 'ended'].map(type => {
      const fn = () => event(type); track?.addEventListener?.(type, fn); return [type, fn];
    });
    audit.cleanup = () => { for (const [type, fn] of listeners) track?.removeEventListener?.(type, fn); };
    if (typeof MediaRecorder === 'function') {
      try {
        const native = audit.native = { code: 'RECORDING', chunks: [], bytes: 0, discard: false, recorder: new MediaRecorder(stream) };
        native.done = new Promise(resolve => { native.resolve = resolve; });
        native.recorder.ondataavailable = e => {
          if (!native.discard && e.data?.size) {
            native.bytes += e.data.size;
            if (native.bytes <= 8 * 1024 * 1024) native.chunks.push(e.data);
            else { native.code = 'SIZE_LIMIT'; native.discard = true; native.chunks = []; if (native.recorder.state !== 'inactive') native.recorder.stop(); }
          }
        };
        native.recorder.onerror = e => { native.code = e.error?.name ?? 'NATIVE_RECORDER_ERROR'; native.resolve(); };
        native.recorder.onstop = () => { if (native.code === 'RECORDING') native.code = 'STOPPED'; native.resolve(); };
        native.recorder.start(1000);
      } catch (e) { audit.native = { code: e.name ?? 'START_FAILED', chunks: [] }; }
    }
    return audit;
  }
  function frame(audit, event, length) {
    if (!audit) return;
    const t = now();
    if (audit.last_callback_ms !== null) audit.max_callback_gap_ms = Math.max(audit.max_callback_gap_ms, t - audit.last_callback_ms);
    audit.first_callback_ms ??= t; audit.last_callback_ms = t;
    audit.callbacks++; audit.frames += length;
    audit.buffer_sample_rate = event.inputBuffer.sampleRate ?? null;
    audit.buffer_channels = event.inputBuffer.numberOfChannels ?? null;
  }
  async function finish(audit, keep) {
    if (!audit) return { report: { code: 'AUDIT_UNAVAILABLE' }, blob: null };
    audit.cleanup();
    const elapsed = now() - audit.started_ms, native = audit.native;
    if (!keep) { native.discard = true; native.chunks = []; }
    if (native.recorder) {
      if (native.recorder.state !== 'inactive') native.recorder.stop();
      if (keep) {
        let timeout;
        await Promise.race([native.done, new Promise(resolve => { timeout = setTimeout(() => { native.code = 'STOP_TIMEOUT'; native.discard = true; native.chunks = []; resolve(); }, 3000); })]);
        clearTimeout(timeout);
      } else if (native.code === 'RECORDING') native.code = 'DISCARDED'; // calls never wait for diagnostic encoding
    }
    const blob = keep && !native.discard && native.chunks.length ? new Blob(native.chunks, { type: native.recorder?.mimeType || native.chunks[0].type }) : null;
    native.chunks = [];
    return { blob, report: { input: audit.input, context: audit.context, wall_ms: elapsed,
      callbacks: audit.callbacks, frames: audit.frames, buffer_sample_rate: audit.buffer_sample_rate ?? null,
      buffer_channels: audit.buffer_channels ?? null, max_callback_gap_ms: audit.max_callback_gap_ms,
      first_callback_delay_ms: audit.first_callback_ms === null ? null : audit.first_callback_ms - audit.started_ms,
      last_callback_before_stop_ms: audit.last_callback_ms === null ? null : audit.started_ms + elapsed - audit.last_callback_ms,
      audio_seconds_from_frames: audit.frames / audit.context.sample_rate,
      events: audit.events, native: { code: native.code, bytes: blob?.size ?? 0, mime: blob?.type ?? null },
      speech_verified: false } };
  }
  async function decoded(blob, rate) {
    if (typeof OfflineAudioContext !== 'function') return { code: 'DECODE_UNAVAILABLE' };
    try {
      const context = new OfflineAudioContext(1, 1, rate);
      const buffer = await context.decodeAudioData(await blob.arrayBuffer());
      return { code: 'DECODED', channels: buffer.numberOfChannels, duration: buffer.duration,
        signal: signal(buffer.getChannelData(0), buffer.sampleRate) };
    } catch (e) { return { code: 'DECODE_FAILED', error: e.name }; }
  }
  return Object.freeze({ signal, resample, begin, frame, finish, decoded });
})();
