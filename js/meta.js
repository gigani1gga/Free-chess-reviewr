// Move-classification metadata (no dependencies, so the UI can import it cheaply).
// Icons are Lucide (ISC licence); the deploy workflow downloads them into icons/ (see ICON_FILES there).
export const META = {
  brilliant:  { color: '#1bada6', label: 'brilliant',  icon: 'sparkles' },
  great:      { color: '#5c8bb0', label: 'great',      icon: 'zap' },
  best:       { color: '#7fa650', label: 'best',       icon: 'star' },
  excellent:  { color: '#8fb35a', label: 'excellent',  icon: 'thumbs-up' },
  good:       { color: '#97a0a8', label: 'good',       icon: 'check' },
  inaccuracy: { color: '#e0b02a', label: 'inaccuracy', icon: 'circle-alert' },
  mistake:    { color: '#e58f2a', label: 'mistake',    icon: 'triangle-alert' },
  miss:       { color: '#d9775b', label: 'miss',       icon: 'x' },
  blunder:    { color: '#c93a35', label: 'blunder',    icon: 'octagon-x' },
};

export const BAD = ['inaccuracy', 'mistake', 'miss', 'blunder'];

// An icon drawn with a CSS mask, so it takes the current text colour.
export const iconHtml = name => `<span class="ic" style="--i:url(icons/${name}.svg)" aria-hidden="true"></span>`;
export const moveIcon = cls => iconHtml(META[cls].icon);
