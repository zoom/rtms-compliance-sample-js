const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

/**
 * Active compliance alerts, most severe first.
 *
 * An alert that could not be adjudicated is shown as "unverified" rather than
 * hidden or presented as confirmed. The deterministic rule still matched, and
 * the representative deserves to know that even when the model was unreachable.
 */
export function AlertList({ alerts, onDismiss }) {
  if (alerts.length === 0) {
    return (
      <section className="panel">
        <h2>Alerts</h2>
        <p className="empty">Nothing flagged.</p>
      </section>
    );
  }

  const sorted = [...alerts].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.seqNo - a.seqNo,
  );

  return (
    <section className="panel">
      <h2>Alerts</h2>
      <ul className="alert-list">
        {sorted.map((alert) => (
          <li key={`${alert.ruleId}:${alert.seqNo}`} className={`alert alert-${alert.severity}`}>
            <div className="alert-head">
              <span className="rule-id">{alert.ruleId}</span>
              <span className={`badge badge-${alert.severity}`}>{alert.severity}</span>
              {!alert.adjudicated && alert.adjudication !== 'off' && (
                <span className="badge badge-unverified">
                  {alert.pending ? 'checking' : 'unverified'}
                </span>
              )}
            </div>

            <blockquote>&ldquo;{alert.quote}&rdquo;</blockquote>

            {alert.rationale && <p className="rationale">{alert.rationale}</p>}

            <p className="suggestion">
              <strong>Say instead:</strong> {alert.suggestedLanguage}
            </p>

            <button type="button" onClick={() => onDismiss(alert)}>
              Dismiss
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
