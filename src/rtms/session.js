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
 * @param {object} deps.audit { open, close, joinFailed, coverageGap, attendance }
 * @param {number} [deps.joinOkReason] the SDK's success code (rtms.RTMS_SDK_OK)
 * @param {{client: string, secret: string}} [deps.credentials] passed to join()
 *   explicitly, so the credentials config validated are the ones used
 * @param {string} [deps.proxyUrl] route RTMS traffic through an HTTP proxy
 * @param {object} [deps.logger]
 */
export function createSessionManager({
  clientFactory,
  transcriptLanguage,
  onSegment,
  audit,
  joinOkReason = 0,
  credentials,
  proxyUrl,
  logger = console,
}) {
  /** rtms_stream_id -> session */
  const streams = new Map();
  /** meeting_uuid -> rtms_stream_id, so a failover can find what it replaces */
  const meetingIndex = new Map();

  function closeSession(session, reason, { failed = false } = {}) {
    if (session.closed) return;
    session.closed = true;

    streams.delete(session.streamId);
    if (meetingIndex.get(session.meetingId) === session.streamId) {
      meetingIndex.delete(session.meetingId);
    }

    // A session that never joined has no audit chain to close. Reporting it
    // as a close would record coverage that never existed. A deliberate stop
    // before the join confirmed is not a failure, so it reports nothing.
    if (session.opened) audit.close(session.meetingId, reason);
    else if (failed) audit.joinFailed?.(session.meetingId, reason);
  }

  /** Forgetting the stream lets a webhook retry attempt the join again. */
  function failJoin(session, reason) {
    logger.error?.(
      `RTMS join failed for meeting ${session.meetingId}, stream ${session.streamId}: ${reason}`,
    );
    closeSession(session, reason, { failed: true });
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
      opened: false,
      superseded: false,
    };

    // Everything below happens before join(). Do not reorder.
    session.client.setTranscriptParams({ srcLanguage: transcriptLanguage });

    if (proxyUrl) {
      const ok = session.client.setProxy('http', proxyUrl);
      if (!ok) logger.warn?.('setProxy failed; joining without a proxy');
    }

    session.client.onJoinConfirm((reason) => {
      // The callback fires for failures too. Only the success code means the
      // stream is ours; anything else would claim coverage we do not have.
      if (reason !== joinOkReason) return failJoin(session, `join confirm reason ${reason}`);
      session.opened = true;
      return audit.open(session.meetingId, reason);
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
      // Leaving before a successful confirm means the join never took.
      if (session.opened) closeSession(session, reason);
      else closeSession(session, `leave reason ${reason}`, { failed: true });
    });

    // No audio, video, or deskshare callbacks. This app screens transcripts;
    // subscribing to media we never read would pull it into the process for
    // nothing.

    streams.set(streamId, session);
    meetingIndex.set(meetingId, streamId);

    let joined;
    try {
      joined = session.client.join(credentials ? { ...payload, ...credentials } : payload);
    } catch (err) {
      failJoin(session, `join threw: ${err.message}`);
      return null;
    }

    if (!joined) {
      failJoin(session, 'join returned false');
      return null;
    }

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
