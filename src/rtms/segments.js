/**
 * Transcript segment normalization.
 *
 * The SDK hands the transcript callback `(buffer, size, timestamp, metadata)`.
 * Two details matter and are easy to get wrong:
 *
 * - `buffer` is a Buffer, not a string. Concatenating it directly yields
 *   "[object Object]" for some call sites and mangles multi-byte UTF-8.
 * - `timestamp` is already a Unix timestamp in milliseconds. Older RTMS
 *   examples divide by 1000 to convert from microseconds; doing that here
 *   would put every segment in 1970.
 */

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
      tStartMs: timestamp,
      seqNo: seqNo++,
    };
  };
}
