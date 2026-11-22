// Small DOM / formatting helpers shared by the UI modules.
export const $ = id => document.getElementById(id);

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s).replace(/[&<>"']/g, c => ENT[c]);

// 0.04 pawns reads "0.0", never "-0.0".
const signed = cp => { const s = (cp / 100).toFixed(1); return s === '0.0' || s === '-0.0' ? '0.0' : (cp > 0 ? '+' : '') + s; };

// Eval label from White's point of view.
export const fmtEval = p =>
  p.mate != null ? (p.mate > 0 ? 'M' : '-M') + Math.abs(p.mate)
  : p.cp != null ? signed(p.cp)
  : p.win === 100 ? '1-0' : p.win === 0 ? '0-1' : '½';
