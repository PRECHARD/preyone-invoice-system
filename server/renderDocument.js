import { computeTotals } from '../src/lib/calc.js';
import { money, fmtDate } from '../src/lib/format.js';
import { computeFillerRows } from '../src/lib/docLayout.js';

const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const joinContact = (primary, secondary) =>
  [primary, secondary].filter(Boolean).join('  |  ');

export function renderDocumentHTML(doc, settings = {}) {
  const isInvoice = doc.type === 'invoice';
  const { subtotal, discountAmount, taxAmount, total } = computeTotals(doc);
  const items = Array.isArray(doc.items) ? doc.items : [];
  const fillerCount = computeFillerRows(doc, items.length);
  const totalPaid = (Array.isArray(doc.payments) ? doc.payments : []).reduce(
    (sum, p) => sum + (Number(p.amount) || 0),
    0
  );
  const balanceDue = Math.max(total - totalPaid, 0);
  const paid = doc.status === 'paid' || (total > 0 && totalPaid >= total - 0.005);
  const fillers = Array.from({ length: fillerCount }, () => `
        <tr class="filler"><td>&nbsp;</td><td class="num">&nbsp;</td><td class="num">&nbsp;</td><td class="num">&nbsp;</td></tr>`).join('');

  const addrLines = String(settings.address || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const addrSpans = [settings.companyName, ...addrLines]
    .filter(Boolean)
    .map((l) => `<span>${esc(l)}</span>`)
    .join('');
  const contactSpans = [
    settings.phone ? `<span>${esc(joinContact(settings.phone, settings.phone2))}</span>` : '',
    settings.email ? `<span class="email">${esc(settings.email)}</span>` : '',
    settings.website ? `<span>${esc(settings.website)}</span>` : ''
  ].join('');
  const hasBandInfo = Boolean(addrSpans || contactSpans);

  const clientLines = [doc.client?.address, doc.client?.email, doc.client?.phone]
    .filter(Boolean)
    .map(esc)
    .join('\n');

  const dueLabel = isInvoice ? 'Due Date' : 'Valid Until';

  return `<div class="sheet" data-type="${esc(doc.type)}">
      ${paid ? '<img src="/brand/PAID.svg" alt="PAID" class="stamp" />' : ''}

      <header class="doc-head">
        <div class="brand">
          <img class="brand-logo" src="/brand/Preyone.svg" alt="${esc(settings.companyName || 'Preyone enterprise')}" />
        </div>
        <div class="doc-mark">
          <img
            class="wordmark"
            src="${isInvoice ? '/brand/invoice-wordmark.svg' : '/brand/quotation-wordmark.svg'}"
            alt="${isInvoice ? 'Invoice' : 'Quotation'}"
          />
          <div class="number-bar">No. ${esc(doc.number)}</div>
        </div>
      </header>

      <section class="doc-meta">
        <div class="bill-to">
          <div class="meta-label">Bill To</div>
          <div class="client-name">${esc(doc.client?.name) || '—'}</div>
          <div class="client-lines">${clientLines}</div>
        </div>
        <div>
          <div class="meta-label">${isInvoice ? 'Invoice Details' : 'Quote Details'}</div>
          <dl class="meta-grid">
            <dt>Date</dt><dd>${fmtDate(doc.issueDate)}</dd>
            ${doc.dueDate ? `<dt>${dueLabel}</dt><dd>${fmtDate(doc.dueDate)}</dd>` : ''}
            <dt>Status</dt><dd style="text-transform:capitalize">${esc(doc.status)}</dd>
          </dl>
        </div>
      </section>

      <table class="items-table">
        <colgroup>
          <col class="c-product" /><col class="c-price" /><col class="c-qty" /><col class="c-total" />
        </colgroup>
        <thead>
          <tr><th>Product</th><th>Price</th><th>Qty</th><th>Total</th></tr>
        </thead>
        <tbody>
          ${items
            .map(
              (it) => `
          <tr>
            <td>${esc(it.description) || '—'}</td>
            <td class="num">${money(it.price)}</td>
            <td class="num">${esc(it.qty)}</td>
            <td class="num">${money((Number(it.price) || 0) * (Number(it.qty) || 0))}</td>
          </tr>`
            )
            .join('')}
          ${fillers}
        </tbody>
      </table>

      <div class="totals-wrap">
        <div class="totals">
          <div class="row"><span class="lbl">Subtotal</span><span class="val">${money(subtotal)}</span></div>
          ${Number(doc.discount) > 0 ? `<div class="row"><span class="lbl">Discount (${Number(doc.discount)}%)</span><span class="val">−${money(discountAmount)}</span></div>` : ''}
          ${Number(doc.taxRate) > 0 ? `<div class="row"><span class="lbl">VAT (${Number(doc.taxRate)}%) Incl.</span><span class="val">${money(taxAmount)}</span></div>` : ''}
          <div class="row grand"><span class="lbl">Total</span><span class="val">${money(total)}</span></div>
          ${totalPaid > 0 ? `
          <div class="row paid-row"><span class="lbl">Amount Paid</span><span class="val">−${money(totalPaid)}</span></div>
          <div class="row balance"><span class="lbl">Balance Due</span><span class="val">${money(balanceDue)}</span></div>` : ''}
        </div>
      </div>

      ${doc.notes ? `<div class="notes-block"><div class="meta-label">Payment Information</div><p>${esc(doc.notes)}</p></div>` : ''}

      <footer class="sheet-footer">
        <div class="thanks">THANKS FOR YOUR PURCHASE</div>
        <div class="terms-note">Terms &amp; conditions</div>
        ${settings.terms ? `<p class="terms-text">${esc(settings.terms)}</p>` : ''}
        ${settings.tagline ? `<div class="tagline">${esc(settings.tagline)}</div>` : ''}
        <div class="footer-band">
          ${addrSpans ? `<div class="band-col band-address">${addrSpans}</div>` : ''}
          ${hasBandInfo ? '<div class="band-divider"></div>' : ''}
          ${contactSpans ? `<div class="band-col band-contact">${contactSpans}</div>` : ''}
        </div>
      </footer>
    </div>`;
}

export function renderPrintPage(doc, settings) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${esc(doc.number)} — ${esc(settings.companyName || 'Preyone enterprise')}</title>
<link rel="stylesheet" href="/css/fonts.css" />
<link rel="stylesheet" href="/css/tokens.css" />
<link rel="stylesheet" href="/css/document.css" />
<style>body { margin: 0; background: #fff; }</style>
</head>
<body>
<div id="print-mount">
${renderDocumentHTML(doc, settings)}
</div>
</body>
</html>`;
}
