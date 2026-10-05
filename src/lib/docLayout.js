import { computeTotals } from './calc.js';

// A4 (mm) with box-sizing:border-box. 13mm top + 12mm bottom padding live
// inside the 297mm sheet, so the flex content area is 272mm.
const PAGE_MM = 297;
const PAD_TOP_MM = 13;
const PAD_BOTTOM_MM = 12;
const INNER_MM = PAGE_MM - PAD_TOP_MM - PAD_BOTTOM_MM; // 272

// Fixed layout blocks measured at 96dpi (see probe data in dev logs):
const HEAD_MM = 16;          // doc-head
const META_GAP_MM = 10;      // margin-top
const TABLE_GAP_MM = 9;      // margin-top
const HEADER_ROW_MM = 11.2;  // thead
const ROW_MM = 9.6;          // one items-table body row
const TOTALS_GAP_MM = 7;     // margin-top
const NOTES_GAP_MM = 8;      // margin-top
const FOOTER_MM = 64.8;      // .sheet-footer (bleeds 12mm into bottom padding)
const TOTALS_BASE_MM = 31.5; // subtotal + VAT + grand
const TOTALS_ROW_MM = 8.7;   // extra totals row (discount)
const PAYED_MM = 20.9;       // Amount Paid + bordered Balance Due
const NOTES_ROW_MM = 9.4;    // notes label + first line
const NOTES_LINE_MM = 4.6;   // extra note line

function metaLines(doc) {
  const c = doc && doc.client ? doc.client : {};
  const addr = String(c.address || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const extras = [c.email, c.phone].filter((x) => String(x || '').trim());
  return 1 + addr.length + extras.length; // client-name + address/email/phone lines
}

export function metaHeightMM(doc) {
  // measured: 4 lines → 25.9mm, 7 lines → 40.5mm ⇒ ~5.1mm/line, base 4.8
  return 4.8 + metaLines(doc) * 5.1;
}

export function totalsHeightMM(doc) {
  const totalPaid = (Array.isArray(doc.payments) ? doc.payments : []).reduce(
    (sum, p) => sum + (Number(p.amount) || 0),
    0
  );
  return TOTALS_BASE_MM
    + (Number(doc.discount) > 0 ? TOTALS_ROW_MM : 0)
    + (totalPaid > 0 ? PAYED_MM : 0);
}

export function notesHeightMM(doc) {
  if (!doc.notes) return 0;
  const lines = String(doc.notes).split(/\r?\n/).filter((l) => l.trim()).length;
  return NOTES_ROW_MM + (lines - 1) * NOTES_LINE_MM;
}

// Base design target: never show MORE filler rows than the original MIN_ROWS
// of 6 total (so simple docs look identical), but shrink fillers as the
// document gets fuller so everything always fits one A4 page.
const MIN_TOTAL_ROWS = 6;

export function computeFillerRows(doc, itemCount) {
  const used = HEAD_MM
    + META_GAP_MM + metaHeightMM(doc)
    + TABLE_GAP_MM + HEADER_ROW_MM
    + TOTALS_GAP_MM + totalsHeightMM(doc)
    + (doc.notes ? NOTES_GAP_MM + notesHeightMM(doc) : 0)
    + FOOTER_MM;
  const availRows = Math.floor((INNER_MM - used) / ROW_MM);
  const maxByDesign = Math.max(0, MIN_TOTAL_ROWS - itemCount);
  return Math.max(0, Math.min(maxByDesign, availRows - itemCount));
}

export { INNER_MM };