import { useEffect, useRef } from 'react';

/** Live transcript, newest at the bottom, auto-scrolled. */
export function TranscriptView({ segments }) {
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [segments.length]);

  return (
    <section className="panel transcript">
      <h2>Transcript</h2>

      {segments.length === 0 ? (
        <p className="empty">Waiting for transcription to start.</p>
      ) : (
        <ol className="segment-list">
          {segments.map((segment) => (
            <li key={segment.seqNo}>
              <span className="speaker">{segment.speakerLabel}</span>
              <span className="text">{segment.text}</span>
            </li>
          ))}
        </ol>
      )}

      <div ref={endRef} />
    </section>
  );
}
