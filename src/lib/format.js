const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export const money = (n) => usd.format(Number(n) || 0);

export const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
};

export const todayISO = () => new Date().toISOString().slice(0, 10);

export const addDaysISO = (iso, days) => {
  const d = iso ? new Date(`${iso}T00:00:00`) : new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};
