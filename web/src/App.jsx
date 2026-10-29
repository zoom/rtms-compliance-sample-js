import { useEffect, useRef, useState } from 'react';
import zoomSdk from '@zoom/appssdk';

import { useComplianceSocket } from './useComplianceSocket.js';
import { AlertList } from './components/AlertList.jsx';
import { DisclosureChecklist } from './components/DisclosureChecklist.jsx';
import { TranscriptView } from './components/TranscriptView.jsx';

const CONNECTION_LABEL = {
  connecting: 'Connecting',
  disconnected: 'Disconnected',
  unauthorized: 'Not authorized',
  error: 'Connection error',
};

/**
 * How long to wait for the backend to report the stream after Zoom accepts
 * startRTMS. Past this, the webhook is almost certainly not reaching us.
 */
const STREAM_ARRIVAL_TIMEOUT_MS = 30_000;

/**
 * The badge says "Live" only when the backend is receiving transcripts. An
 * open socket to this server is not screening; claiming otherwise is the
 * exact false assurance a compliance tool must not give.
 */
function statusOf({ connection, stream, pending }) {
  if (connection !== 'connected') {
    return { key: connection, label: CONNECTION_LABEL[connection] ?? connection };
  }
  if (stream === 'streaming') return { key: 'live', label: 'Live' };
  if (stream === 'interrupted') return { key: 'interrupted', label: 'Interrupted' };
  if (pending === 'starting') return { key: 'pending', label: 'Starting' };
  return { key: 'idle', label: 'Not screening' };
}

export function App() {
  const [session, setSession] = useState(null);
  const [bootError, setBootError] = useState(null);

  useEffect(() => {
    async function boot() {
      try {
        const configured = await zoomSdk.config({
          capabilities: [
            'getMeetingContext',
            'getMeetingUUID',
            'getRunningContext',
            'getUserContext',
            'startRTMS',
            'onRTMSStatusChange',
            'getRTMSStatus',
          ],
        });

        const [{ meetingUUID }, user] = await Promise.all([
          zoomSdk.getMeetingUUID(),
          zoomSdk.getUserContext(),
        ]);

        // The backend decides what this token may see. Asking for a role does
        // not grant it; the server issues what it is willing to issue.
        const response = await fetch('/api/panel/token', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            meetingId: meetingUUID,
            userId: user.participantUUID ?? user.participantId,
            role: user.role === 'host' ? 'host' : 'representative',
          }),
        });

        if (!response.ok) throw new Error(`token request failed: ${response.status}`);

        const { token } = await response.json();
        setSession({
          token,
          meetingId: meetingUUID,
          // Reported to the server log once the socket is up. An API missing
          // from Marketplace shows up here, not as an error at call time.
          configInfo: {
            unsupportedApis: configured.unsupportedApis,
            clientVersion: configured.clientVersion,
            runningContext: configured.runningContext,
            role: user.role,
          },
        });
      } catch (err) {
        setBootError(err.message);
      }
    }

    boot();
  }, []);

  const {
    connection,
    synced,
    stream,
    streamError,
    segments,
    alerts,
    disclosures,
    dismiss,
    reportRtms,
  } = useComplianceSocket({
    token: session?.token,
    meetingId: session?.meetingId,
  });

  // 'starting' | null. Cleared by the server's stream state, not
  // by startRTMS resolving: Zoom accepting the request does not mean the
  // stream reached this backend.
  const [pending, setPending] = useState(null);
  const [rtmsError, setRtmsError] = useState(null);
  // What the Zoom client says about RTMS, independent of what reached the server.
  const [zoomStatus, setZoomStatus] = useState(null);
  const zoomStatusRef = useRef(zoomStatus);
  zoomStatusRef.current = zoomStatus;
  const reportRef = useRef(reportRtms);
  reportRef.current = reportRtms;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    if (pending === 'starting' && stream !== 'idle') setPending(null);
  }, [pending, stream]);

  // The server reports a failed join directly; no need to wait for the timeout.
  useEffect(() => {
    if (!streamError) return;
    setPending(null);
    setRtmsError(streamError);
  }, [streamError]);

  useEffect(() => {
    if (pending !== 'starting') return undefined;
    const timer = setTimeout(() => {
      setPending(null);
      const zoomSays = zoomStatusRef.current;
      setRtmsError(
        zoomSays === 'started'
          ? 'Zoom reports the stream as started, but this server never received a ' +
              'meeting.rtms_started webhook for this app. Check this app’s Event Subscription.'
          : `startRTMS returned, but Zoom never reported the stream starting (last Zoom ` +
              `status: ${zoomSays ?? 'none'}). No webhook is sent until it starts.`,
      );
    }, STREAM_ARRIVAL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  useEffect(() => {
    if (!session) return;
    zoomSdk.onRTMSStatusChange((event) => {
      setZoomStatus(event.status);
      reportRef.current?.({ event: 'onRTMSStatusChange', ...event });
      // Stopped from the Zoom client's own control, or Zoom refused to start.
      if (event.status === 'stopped' && pendingRef.current === 'starting') setPending(null);
    });
  }, [session]);

  useEffect(() => {
    if (connection === 'connected' && session?.configInfo) {
      reportRtms({ event: 'config', ...session.configInfo });
    }
    // reportRtms changes identity every render; the connection edge is what matters.
  }, [connection, session]);

  // Screening starts when the panel opens; there is no manual control. Once
  // per open, and only after the server's snapshot, so a stream that is
  // already running is not started twice.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || !synced || connection !== 'connected') return;
    autoStarted.current = true;
    if (stream === 'idle') startScreening();
  }, [synced, connection, stream]);

  async function startScreening() {
    setRtmsError(null);
    setZoomStatus(null);
    setPending('starting');
    try {
      const result = await zoomSdk.startRTMS();
      reportRtms({ event: 'startRTMS resolved', result });
      // Ask Zoom directly rather than relying only on status-change events.
      setTimeout(() => {
        zoomSdk
          .getRTMSStatus()
          .then((status) => reportRtms({ event: 'getRTMSStatus', status }))
          .catch((err) => reportRtms({ event: 'getRTMSStatus rejected', error: err.message }));
      }, 5000);
    } catch (err) {
      reportRtms({ event: 'startRTMS rejected', error: err.message, code: err.code });
      setPending(null);
      setRtmsError(`Could not start transcription: ${err.message}`);
    }
  }

  const status = statusOf({ connection, stream, pending });

  if (bootError) {
    return (
      <main className="app">
        <h1>Compliance Advisor</h1>
        <p className="warning">Could not start: {bootError}</p>
        <p className="empty">Open this app from inside a Zoom meeting.</p>
      </main>
    );
  }

  return (
    <main className="app">
      <header>
        <h1>Compliance Advisor</h1>
        <span className={`status status-${status.key}`}>{status.label}</span>
      </header>

      <section className="screening">
        {stream === 'idle' && pending === null && !rtmsError && (
          <p className="empty">
            Nothing is being screened. Reopen the app to start screening again.
          </p>
        )}
        {stream === 'interrupted' && (
          <p className="warning">
            The media connection dropped. Anything said until it recovers is not screened.
          </p>
        )}
        {rtmsError && <p className="warning">{rtmsError}</p>}
        {zoomStatus && <p className="empty">Zoom reports RTMS: {zoomStatus}</p>}
      </section>

      <AlertList alerts={alerts} onDismiss={dismiss} />
      <DisclosureChecklist disclosures={disclosures} />
      <TranscriptView segments={segments} />

      <footer>
        <p className="disclaimer">
          Screening is advisory. It does not replace supervisory review, and the shipped rule packs
          are illustrative examples.
        </p>
      </footer>
    </main>
  );
}
