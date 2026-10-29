import { useEffect, useRef, useState } from 'react';

/**
 * Live connection to the compliance backend.
 *
 * Two behaviors worth noting:
 *
 * - The server sends a state snapshot before any incremental update, so a
 *   panel that reconnects mid-meeting shows the real checklist rather than an
 *   empty one. The snapshot replaces local state; updates append to it.
 * - `connection` is only the socket to this backend. Whether the backend is
 *   receiving the RTMS stream is `stream`, reported by the server. An open
 *   socket with no stream is not screening anything.
 * - Segments are inserted in seqNo order. They usually arrive in order, but
 *   "usually" is not something to build a transcript on.
 */
const alertKey = (alert) => `${alert.ruleId}:${alert.seqNo}`;

export function useComplianceSocket({ token, meetingId }) {
  const [connection, setConnection] = useState('connecting');
  const [segments, setSegments] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [disclosures, setDisclosures] = useState([]);
  const [stream, setStream] = useState('idle');
  const [streamError, setStreamError] = useState(null);
  /** True once the first snapshot has arrived, so `stream` reflects the server. */
  const [synced, setSynced] = useState(false);
  const socketRef = useRef(null);
  /** Dismissed alerts stay dismissed when their adjudicated version arrives. */
  const dismissedRef = useRef(new Set());

  useEffect(() => {
    if (!token || !meetingId) return undefined;

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(
      `${protocol}://${window.location.host}/ws?token=${encodeURIComponent(token)}`,
    );
    socketRef.current = socket;

    socket.onopen = () => {
      setConnection('connected');
      socket.send(JSON.stringify({ type: 'subscribe', meetingId }));
    };

    socket.onmessage = (event) => {
      const { type, data } = JSON.parse(event.data);

      switch (type) {
        case 'state.snapshot':
          setAlerts((data.alerts ?? []).filter((a) => !dismissedRef.current.has(alertKey(a))));
          setDisclosures(data.disclosures ?? []);
          setStream(data.stream ?? 'idle');
          setSynced(true);
          break;

        case 'stream.state':
          setStream(data.state);
          if (data.state !== 'idle') setStreamError(null);
          break;

        case 'stream.error':
          setStreamError(data.message);
          break;

        case 'transcript.segment':
          setSegments((prior) => {
            if (prior.some((s) => s.seqNo === data.seqNo)) return prior;
            return [...prior, data].sort((a, b) => a.seqNo - b.seqNo);
          });
          break;

        case 'compliance.alert':
          // An alert arrives twice: provisional on the rule match, then
          // adjudicated. The second replaces the first in place.
          if (dismissedRef.current.has(alertKey(data))) break;
          setAlerts((prior) => {
            const index = prior.findIndex((a) => alertKey(a) === alertKey(data));
            if (index === -1) return [...prior, data];
            const next = [...prior];
            next[index] = data;
            return next;
          });
          break;

        case 'disclosure.state':
          setDisclosures(data);
          break;

        default:
          break;
      }
    };

    socket.onclose = (event) => {
      // 4401 is the server's unauthorized code. Retrying will not help.
      setConnection(event.code === 4401 ? 'unauthorized' : 'disconnected');
    };

    socket.onerror = () => setConnection('error');

    return () => socket.close();
  }, [token, meetingId]);

  /** Dismissing writes an audit record attributing it to this user. */
  const dismiss = (alert) => {
    dismissedRef.current.add(alertKey(alert));
    socketRef.current?.send(
      JSON.stringify({
        type: 'dismiss',
        meetingId,
        ruleId: alert.ruleId,
        seqNo: alert.seqNo,
      }),
    );
    setAlerts((prior) =>
      prior.filter((a) => !(a.ruleId === alert.ruleId && a.seqNo === alert.seqNo)),
    );
  };

  /** Zoom client-side RTMS events, so the server log shows what Zoom told the panel. */
  const reportRtms = (data) =>
    socketRef.current?.send(JSON.stringify({ type: 'client.rtms', meetingId, ...data }));

  return {
    connection,
    synced,
    stream,
    streamError,
    segments,
    alerts,
    disclosures,
    dismiss,
    reportRtms,
  };
}
