// Small DOM / formatting helpers shared by the UI modules.
export const $ = id => document.getElementById(id);

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s).replace(/[&<>"']/g, c => ENT[c]);

// Eval label from White's point of view.
export const fmtEval = p =>
  p.mate != null ? (p.mate > 0 ? 'M' : '-M') + Math.abs(p.mate)
  : p.cp != null ? (p.cp > 0 ? '+' : '') + (p.cp / 100).toFixed(1)
  : p.win === 100 ? '1-0' : p.win === 0 ? '0-1' : '½';
