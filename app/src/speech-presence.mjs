// Cheap negative-only preflight. Passing this check is NOT evidence of speech.
// Normalized correlation avoids an amplitude floor that would reject quiet speech.
export function inspectSpeechSignal(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.length < 44) return { ok: true };
  let format, data;
  for (let at = 12; at + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(at + 4), body = at + 8;
    if (body + size > buffer.length) return { ok: true };
    const id = buffer.toString('ascii', at, at + 4);
    if (id === 'fmt ' && size >= 16) format = { encoding: buffer.readUInt16LE(body), channels: buffer.readUInt16LE(body + 2), rate: buffer.readUInt32LE(body + 4), bits: buffer.readUInt16LE(body + 14) };
    if (id === 'data') { data = buffer.subarray(body, body + size); break; }
    at = body + size + size % 2;
  }
  if (!format || !data || format.encoding !== 1 || format.bits !== 16 || format.channels !== 1 || format.rate !== 16000) return { ok: true };
  const count = Math.min(data.length / 2, 16000);
  const samples = Array.from({ length: count }, (_, i) => data.readInt16LE(i * 2));
  let energy = 0, sum = 0;
  for (const v of samples) { energy += v * v; sum += v; }
  if (!energy) return { ok: true }; // inspectWav owns SILENT_CAPTURE.
  const dc = sum * sum / count / energy;
  if (dc > 0.9999) return { ok: false, code: 'NON_SPEECH_CAPTURE', reason: 'constant signal', detector: 'negative-only-periodicity-v1' };
  // Match a signal against a delayed copy. Pure periodic test tones (including quiet ones)
  // approach 1; real speech normally varies in pitch, envelope, and spectral structure.
  let best = 0;
  for (let lag = 8; lag <= 800; lag++) {
    let dot = 0, a = 0, b = 0;
    for (let i = lag; i < count; i += 2) { const x = samples[i], y = samples[i - lag]; dot += x * y; a += x*x; b += y*y; }
    const correlation = dot / Math.sqrt(a * b || 1);
    if (correlation > best) best = correlation;
  }
  if (best > 0.9998) return { ok: false, code: 'NON_SPEECH_CAPTURE', reason: 'near-exact stationary periodic signal', correlation: best, detector: 'negative-only-periodicity-v1' };
  return { ok: true, detector: 'negative-only-periodicity-v1', speech_verified: false };
}

export function validUtterance(text) {
  const spoken = String(text ?? '').replace(/\[[^\]]*\]|<\|[^|]*\|>/g, '').trim();
  return /[\p{L}\p{N}]/u.test(spoken);
}
