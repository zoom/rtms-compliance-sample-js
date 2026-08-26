import { useEffect, useRef, useState } from 'react';

/**
 * Live connection to the compliance backend.
 *
 * Two behaviors worth noting:
 *
 * - The server sends a state snapshot before any incremental update, so a
 *   panel that reconnects mid-meeting shows the real checklist rather than an
 *   empty one. The snapshot replaces local state; updates append to it.
 * - Segments are inserted in seqNo order. They usually arrive in order, but
 *   "usually" is not something to build a transcript on.
 */
export function useComplianceSocket({ token, meetingId }) {
  const [connection, setConnection] = useState('connecting');
  const [segments, setSegments] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [disclosures, setDisclosures] = useState([]);
  const socketRef = useRef(null);

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
          setAlerts(data.alerts ?? []);
          setDisclosures(data.disclosures ?? []);
          break;

        case 'transcript.segment':
          setSegments((prior) => {
            if (prior.some((s) => s.seqNo === data.seqNo)) return prior;
            return [...prior, data].sort((a, b) => a.seqNo - b.seqNo);
          });
          break;

        case 'compliance.alert':
          setAlerts((prior) => {
            const key = (a) => `${a.ruleId}:${a.seqNo}`;
            if (prior.some((a) => key(a) === key(data))) return prior;
            return [...prior, data];
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

  return { connection, segments, alerts, disclosures, dismiss };
}
