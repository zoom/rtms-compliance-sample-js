import { useEffect, useState } from 'react';
import zoomSdk from '@zoom/appssdk';

import { useComplianceSocket } from './useComplianceSocket.js';
import { AlertList } from './components/AlertList.jsx';
import { DisclosureChecklist } from './components/DisclosureChecklist.jsx';
import { TranscriptView } from './components/TranscriptView.jsx';

const CONNECTION_LABEL = {
  connecting: 'Connecting',
  connected: 'Live',
  disconnected: 'Disconnected',
  unauthorized: 'Not authorized',
  error: 'Connection error',
};

export function App() {
  const [session, setSession] = useState(null);
  const [bootError, setBootError] = useState(null);

  useEffect(() => {
    async function boot() {
      try {
        await zoomSdk.config({
          capabilities: [
            'getMeetingContext',
            'getMeetingUUID',
            'getRunningContext',
            'getUserContext',
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
        setSession({ token, meetingId: meetingUUID });
      } catch (err) {
        setBootError(err.message);
      }
    }

    boot();
  }, []);

  const { connection, segments, alerts, disclosures, dismiss } = useComplianceSocket({
    token: session?.token,
    meetingId: session?.meetingId,
  });

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
        <span className={`status status-${connection}`}>
          {CONNECTION_LABEL[connection] ?? connection}
        </span>
      </header>

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
