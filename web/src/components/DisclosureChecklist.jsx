/**
 * Required disclosures for the active rule pack.
 *
 * A satisfied item shows the quote that satisfied it. A checkbox with no quote
 * is not evidence of anything, so the quote is part of the UI rather than a
 * detail hidden in the audit export.
 */
export function DisclosureChecklist({ disclosures }) {
  if (disclosures.length === 0) {
    return (
      <section className="panel">
        <h2>Required disclosures</h2>
        <p className="empty">No disclosures in the active pack.</p>
      </section>
    );
  }

  const pendingHigh = disclosures.filter((d) => d.status === 'pending' && d.severity === 'high');

  return (
    <section className="panel">
      <h2>
        Required disclosures{' '}
        <span className="count">
          {disclosures.filter((d) => d.status === 'satisfied').length}/{disclosures.length}
        </span>
      </h2>

      {pendingHigh.length > 0 && (
        <p className="warning">
          {pendingHigh.length} required disclosure{pendingHigh.length > 1 ? 's' : ''} still
          outstanding.
        </p>
      )}

      <ul className="disclosure-list">
        {disclosures.map((disclosure) => (
          <li key={disclosure.id} className={`disclosure disclosure-${disclosure.status}`}>
            <div className="disclosure-head">
              <span aria-hidden="true">{disclosure.status === 'satisfied' ? '✓' : '○'}</span>
              <span className="rule-id">{disclosure.id}</span>
            </div>

            {disclosure.status === 'satisfied' ? (
              <blockquote>&ldquo;{disclosure.quote}&rdquo;</blockquote>
            ) : (
              <p className="prompt">{disclosure.prompt}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
