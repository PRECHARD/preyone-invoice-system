import { money, fmtDate } from '../lib/format.js';
import { computeTotals } from '../lib/calc.js';
import { computeFillerRows } from '../lib/docLayout.js';

function FillerRows({ count }) {
  if (count <= 0) return null;
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <tr className="filler" key={`filler-${i}`}>
          <td>&nbsp;</td>
          <td className="num">&nbsp;</td>
          <td className="num">&nbsp;</td>
          <td className="num">&nbsp;</td>
        </tr>
      ))}
    </>
  );
}

export default function DocumentSheet({ doc, settings }) {
  const s = settings || {};
  const isInvoice = doc.type === 'invoice';
  const { subtotal, discountAmount, taxAmount, total } = computeTotals(doc);
  const items = Array.isArray(doc.items) ? doc.items : [];
  const totalPaid = (Array.isArray(doc.payments) ? doc.payments : []).reduce(
    (sum, p) => sum + (Number(p.amount) || 0),
    0
  );
  const balanceDue = Math.max(total - totalPaid, 0);
  const paid = doc.status === 'paid' || (total > 0 && totalPaid >= total - 0.005);

  const addrLines = String(s.address || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const hasBandInfo = Boolean(s.companyName || addrLines.length || s.phone || s.email || s.website);

  return (
    <div className="sheet" data-type={doc.type}>
      {paid && <img src="/brand/PAID.svg" alt="PAID" className="stamp" />}

      <header className="doc-head">
        <div className="brand">
          <img className="brand-logo" src="/brand/Preyone.svg" alt={s.companyName || 'Preyone enterprise'} />
        </div>
        <div className="doc-mark">
          <img
            className="wordmark"
            src={isInvoice ? '/brand/invoice-wordmark.svg' : '/brand/quotation-wordmark.svg'}
            alt={isInvoice ? 'Invoice' : 'Quotation'}
          />
          <div className="number-bar">No. {doc.number}</div>
        </div>
      </header>

      <section className="doc-meta">
        <div className="bill-to">
          <div className="meta-label">Bill To</div>
          <div className="client-name">{doc.client?.name || '—'}</div>
          <div className="client-lines">
            {[doc.client?.address, doc.client?.email, doc.client?.phone].filter(Boolean).join('\n')}
          </div>
        </div>
        <div>
          <div className="meta-label">{isInvoice ? 'Invoice Details' : 'Quote Details'}</div>
          <dl className="meta-grid">
            <dt>Date</dt>
            <dd>{fmtDate(doc.issueDate)}</dd>
            {isInvoice && doc.dueDate && (
              <>
                <dt>Due Date</dt>
                <dd>{fmtDate(doc.dueDate)}</dd>
              </>
            )}
            {!isInvoice && doc.dueDate && (
              <>
                <dt>Valid Until</dt>
                <dd>{fmtDate(doc.dueDate)}</dd>
              </>
            )}
            <dt>Status</dt>
            <dd style={{ textTransform: 'capitalize' }}>{doc.status}</dd>
          </dl>
        </div>
      </section>

      <table className="items-table">
        <colgroup>
          <col className="c-product" />
          <col className="c-price" />
          <col className="c-qty" />
          <col className="c-total" />
        </colgroup>
        <thead>
          <tr>
            <th>Product</th>
            <th>Price</th>
            <th>Qty</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}>
              <td>{it.description || '—'}</td>
              <td className="num">{money(it.price)}</td>
              <td className="num">{it.qty}</td>
              <td className="num">{money((Number(it.price) || 0) * (Number(it.qty) || 0))}</td>
            </tr>
          ))}
          <FillerRows count={computeFillerRows(doc, items.length)} />
        </tbody>
      </table>

      <div className="totals-wrap">
        <div className="totals">
          <div className="row">
            <span className="lbl">Subtotal</span>
            <span className="val">{money(subtotal)}</span>
          </div>
          {Number(doc.discount) > 0 && (
            <div className="row">
              <span className="lbl">Discount ({Number(doc.discount)}%)</span>
              <span className="val">−{money(discountAmount)}</span>
            </div>
          )}
          {Number(doc.taxRate) > 0 && (
            <div className="row">
              <span className="lbl">VAT ({Number(doc.taxRate)}%) (incl.)</span>
              <span className="val">{money(taxAmount)}</span>
            </div>
          )}
          <div className="row grand">
            <span className="lbl">Total</span>
            <span className="val">{money(total)}</span>
          </div>
          {totalPaid > 0 && (
            <>
              <div className="row paid-row">
                <span className="lbl">Amount Paid</span>
                <span className="val">−{money(totalPaid)}</span>
              </div>
              <div className="row balance">
                <span className="lbl">Balance Due</span>
                <span className="val">{money(balanceDue)}</span>
              </div>
            </>
          )}
        </div>
      </div>

      {doc.notes && (
        <div className="notes-block">
          <div className="meta-label">Payment Information</div>
          <p>{doc.notes}</p>
        </div>
      )}

      <footer className="sheet-footer">
        <div className="thanks">THANKS FOR YOUR PURCHASE</div>
        <div className="terms-note">Terms &amp; conditions</div>
        {s.terms && <p className="terms-text">{s.terms}</p>}
        {s.tagline && <div className="tagline">{s.tagline}</div>}
        <div className="footer-band">
          {(s.companyName || addrLines.length > 0) && (
            <div className="band-col band-address">
              {[s.companyName, ...addrLines].filter(Boolean).map((l, i) => (
                <span key={i}>{l}</span>
              ))}
            </div>
          )}
          {hasBandInfo && <div className="band-divider" />}
          {(s.phone || s.email || s.website) && (
            <div className="band-col band-contact">
              {s.phone && <span>{[s.phone, s.phone2].filter(Boolean).join('  |  ')}</span>}
              {s.email && <span className="email">{s.email}</span>}
              {s.website && <span>{s.website}</span>}
            </div>
          )}
        </div>
      </footer>
    </div>
  );
}
