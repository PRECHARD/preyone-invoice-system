export default function UpgradePlan({ entitlement, onSignOut }) {
  const plans = entitlement?.plans || [];
  return (
    <div className="app-shell">
      <header className="app-topbar no-print">
        <div className="logo">
          <img src="/brand/Preyone.svg" alt="Preyone enterprise" />
        </div>
        <div className="login-user">
          <button type="button" onClick={onSignOut}>Sign out</button>
        </div>
      </header>
      <main className="page" style={{ maxWidth: 880, margin: '0 auto', padding: '2rem 1.25rem' }}>
        <section className="card">
          <h2>Invoice is not on your plan</h2>
          <p>
            {entitlement?.planName
              ? `This company is on ${entitlement.planName}. That plan includes the till only.`
              : 'This company does not have an Invoice plan yet.'}
            {' '}Upgrade to PreBiz or higher to open invoices and quotations here, on the desktop app, and on the phone.
          </p>
          <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginTop: '1rem' }}>
            {plans.map((plan) => (
              <article key={plan.id} className="card" style={{ margin: 0, opacity: plan.includesInvoice ? 1 : 0.72 }}>
                <strong>{plan.name}</strong>
                <div>${plan.price}/month</div>
                <div style={{ fontSize: '0.85rem' }}>{plan.tagline}</div>
              </article>
            ))}
          </div>
          <p style={{ marginTop: '1rem' }}>
            A manager can change the plan from POS Settings or the admin console. The payment is the usual monthly Pesepay checkout.
          </p>
        </section>
      </main>
    </div>
  );
}
