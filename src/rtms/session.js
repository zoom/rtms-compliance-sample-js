/**
 * RTMS stream lifecycle.
 *
 * This module owns exactly one thing: keeping a correct set of joined RTMS
 * clients and turning their callbacks into normalized segments and audit
 * events. Screening is the caller's concern, delivered through `onSegment`.
 *
 * The ordering constraint here is real and unforgiving: every callback and
 * every set*Params call must happen before join(). Anything registered after
 * join() misses the segments that arrived in between, and on a regulated call
 * the opening seconds are the ones that matter most.
 */
import { createSegmentNormalizer } from './segments.js';

/**
 * @param {object} deps
 * @param {() => object} deps.clientFactory produces an RTMS client; injected so
 *   tests can supply a fake instead of loading the native addon
 * @param {number} deps.transcriptLanguage a TranscriptLanguage constant
 * @param {(segment: object, ctx: object) => void} [deps.onSegment]
 * @param {object} deps.audit { open, close, coverageGap, attendance }
 * @param {string} [deps.proxyUrl] route RTMS traffic through an HTTP proxy
 * @param {object} [deps.logger]
 */
export function createSessionManager({
  clientFactory,
  transcriptLanguage,
  onSegment,
  audit,
  proxyUrl,
  logger = console,
}) {
  /** rtms_stream_id -> session */
  const streams = new Map();
  /** meeting_uuid -> rtms_stream_id, so a failover can find what it replaces */
  const meetingIndex = new Map();

  function closeSession(session, reason) {
    if (session.closed) return;
    session.closed = true;

    streams.delete(session.streamId);
    if (meetingIndex.get(session.meetingId) === session.streamId) {
      meetingIndex.delete(session.meetingId);
    }

    audit.close(session.meetingId, reason);
  }

  function startStream(payload) {
    const streamId = payload?.rtms_stream_id;
    const meetingId = payload?.meeting_uuid;

    if (!streamId || !meetingId) {
      logger.warn?.('ignoring rtms_started with no stream id or meeting uuid');
      return null;
    }

    // Zoom retries webhook deliveries. Joining twice would double every
    // segment and corrupt the sequence numbering.
    if (streams.has(streamId)) {
      logger.info?.(`ignoring duplicate rtms_started for stream ${streamId}`);
      return streams.get(streamId);
    }

    // Same meeting, new stream id: the media server failed over. Tear down the
    // old client, but leave the audit chain open. Screening continues for the
    // same meeting, so this is a coverage gap rather than an end of coverage.
    const supersededStreamId = meetingIndex.get(meetingId);
    if (supersededStreamId) {
      const previous = streams.get(supersededStreamId);
      if (previous) {
        previous.superseded = true;
        previous.client.leave();
        streams.delete(supersededStreamId);
        audit.coverageGap(meetingId, Date.now());
        logger.warn?.(
          `stream failover for meeting ${meetingId}: ${supersededStreamId} replaced by ${streamId}`,
        );
      }
    }

    const session = {
      streamId,
      meetingId,
      client: clientFactory(),
      normalize: createSegmentNormalizer(),
      closed: false,
      superseded: false,
    };

    // Everything below happens before join(). Do not reorder.
    session.client.setTranscriptParams({ srcLanguage: transcriptLanguage });

    if (proxyUrl) {
      const ok = session.client.setProxy('http', proxyUrl);
      if (!ok) logger.warn?.('setProxy failed; joining without a proxy');
    }

    session.client.onJoinConfirm((reason) => {
      audit.open(session.meetingId, reason);
    });

    session.client.onTranscriptData((buffer, size, timestamp, metadata) => {
      const segment = session.normalize(buffer, size, timestamp, metadata);
      onSegment?.(segment, { meetingId: session.meetingId, streamId: session.streamId });
    });

    session.client.onParticipantEvent((_event, _timestamp, participants) => {
      audit.attendance(session.meetingId, participants);
    });

    session.client.onMediaConnectionInterrupted((timestamp) => {
      // An audit log that omits this implies the call was screened end to end.
      audit.coverageGap(session.meetingId, timestamp);
    });

    session.client.onLeave((reason) => {
      // The stream can end without a stopped webhook: the host ends the
      // meeting, or the media server drops us. onLeave is the reliable signal.
      // A superseded client's onLeave is failover noise, not an end of stream.
      if (session.superseded) return;
      closeSession(session, reason);
    });

    // No audio, video, or deskshare callbacks. This app screens transcripts;
    // subscribing to media we never read would pull it into the process for
    // nothing.

    streams.set(streamId, session);
    meetingIndex.set(meetingId, streamId);

    session.client.join(payload);

    return session;
  }

  function stopStream(payload) {
    const streamId = payload?.rtms_stream_id;
    const session = streamId ? streams.get(streamId) : undefined;

    if (!session) {
      // Already closed by onLeave, or never ours. Either way, nothing to do.
      return;
    }

    session.client.leave();
    closeSession(session, 'rtms_stopped');
  }

  return {
    startStream,
    stopStream,
    activeStreamCount: () => streams.size,
    hasStream: (streamId) => streams.has(streamId),
    /** Live sessions, for a health endpoint. */
    describe: () =>
      [...streams.values()].map(({ streamId, meetingId }) => ({ streamId, meetingId })),
    /** Leave every stream. Called on SIGTERM so shutdown is not a silent gap. */
    shutdown: () => {
      for (const session of [...streams.values()]) {
        session.client.leave();
        closeSession(session, 'shutdown');
      }
    },
  };
}
