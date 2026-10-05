export function computeTotals(doc) {
  const items = Array.isArray(doc.items) ? doc.items : [];
  const subtotal = items.reduce(
    (sum, it) => sum + (Number(it.price) || 0) * (Number(it.qty) || 0),
    0
  );
  const rate = Number(doc.taxRate) || 0;
  const discountAmount = subtotal * ((Number(doc.discount) || 0) / 100);
  const net = subtotal - discountAmount;
  const taxAmount = rate > 0 ? (net * rate) / (100 + rate) : 0;
  const total = net;
  return { subtotal, discountAmount, taxAmount, total };
}

export function lineTotal(item) {
  return (Number(item.price) || 0) * (Number(item.qty) || 0);
}

export function computePayments(doc) {
  const payments = Array.isArray(doc.payments) ? doc.payments : [];
  const paid = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const { total } = computeTotals(doc);
  const balance = Math.max(total - paid, 0);
  return { paid, balance };
}
