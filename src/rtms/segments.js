/**
 * Transcript segment normalization.
 *
 * The SDK hands the transcript callback `(buffer, size, timestamp, metadata)`.
 * Two details matter and are easy to get wrong:
 *
 * - `buffer` is a Buffer, not a string. Concatenating it directly yields
 *   "[object Object]" for some call sites and mangles multi-byte UTF-8.
 * - `timestamp` arrives in Unix microseconds from @zoom/rtms 1.1.0 (observed:
 *   1793300024893609 for 2026-10-29 18:53:44 UTC). Everything downstream
 *   works in milliseconds: the suppression window, the model's context
 *   window, and audit timestamps. Left unconverted, a 60 s window is 60 ms.
 */

/**
 * Microseconds to milliseconds, tolerating an SDK that already sends ms.
 * Current Unix time is ~1.8e12 in ms and ~1.8e15 in µs; 1e14 sits between
 * them for centuries either way.
 */
export function toUnixMs(timestamp) {
  return timestamp > 1e14 ? Math.floor(timestamp / 1000) : timestamp;
}

/** Applied when the SDK delivers a segment without speaker identity. */
export const SPEAKER_DEFAULTS = Object.freeze({
  speakerId: null,
  speakerLabel: 'Unknown speaker',
});

/**
 * Create a normalizer scoped to one RTMS stream.
 *
 * Sequence numbers are assigned here because the SDK does not provide one, and
 * the panel needs a stable order to append in. The counter is per stream: a
 * failover creates a new normalizer and restarts at 0.
 *
 * @returns {(buffer: Buffer, size: number, timestamp: number, metadata?: {userId?: number, userName?: string}) => object}
 */
export function createSegmentNormalizer() {
  let seqNo = 0;

  return function normalize(buffer, _size, timestamp, metadata) {
    const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer ?? '');

    return {
      speakerId: metadata?.userId ?? SPEAKER_DEFAULTS.speakerId,
      speakerLabel: metadata?.userName ?? SPEAKER_DEFAULTS.speakerLabel,
      text,
      tStartMs: toUnixMs(timestamp),
      seqNo: seqNo++,
    };
  };
}
