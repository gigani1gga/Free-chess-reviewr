// Turns a game link (Chess.com / Lichess) or raw PGN into PGN text.
const get = async url => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status + ' from ' + new URL(url).host);
  return r;
};

export async function loadGame(input, usernameHint = '') {
  const text = input.trim();
  if (/^(\[|1\.)/.test(text)) return text; // already a PGN
  let u;
  try { u = new URL(/^https?:/i.test(text) ? text : 'https://' + text); }
  catch { throw new Error('That is not a game link or a PGN.'); }
  const host = u.hostname.replace(/^www\./, '');
  if (host.endsWith('chess.com')) return fromChessCom(u, usernameHint);
  if (host.endsWith('lichess.org')) return fromLichess(u);
  throw new Error('Only Chess.com and Lichess links are supported.');
}

async function fromLichess(u) {
  const id = u.pathname.split('/').filter(Boolean)[0]?.slice(0, 8);
  if (!id) throw new Error('Could not find a game id in that Lichess link.');
  return (await get(`https://lichess.org/game/export/${id}?evals=0&clocks=0&opening=0`)).text();
}

async function fromChessCom(u, hint) {
  const type = /daily/.test(u.pathname) ? 'daily' : 'live';
  const m = (u.pathname + u.search + u.hash).match(/(\d{6,})/);
  if (!m) throw new Error('Could not find a game id in that Chess.com link.');
  const id = m[1];

  // Step 1: ask Chess.com who played and when (may be blocked by the browser).
  let names = [], date = '';
  try {
    const d = await (await get(`https://www.chess.com/callback/${type}/game/${id}`)).json();
    const h = d.game?.pgnHeaders || {};
    names = [h.White, h.Black, d.players?.top?.username, d.players?.bottom?.username];
    date = h.Date || '';
  } catch { /* fall back to the username box */ }
  names = [...new Set([hint, ...names].filter(Boolean).map(n => n.toLowerCase()))];
  if (!names.length) throw new Error('Chess.com blocked the direct lookup. Type your username under Options and try again.');

  // Step 2: find the game in the player's monthly archive (public API).
  const dm = date.match(/(\d{4})[.-](\d{2})/);
  const base = dm ? new Date(Date.UTC(+dm[1], +dm[2] - 1, 15)) : new Date();
  const offsets = dm ? [0, -1, 1] : [0, -1, -2, -3];
  for (const n of names) {
    for (const o of offsets) {
      const d = new Date(base); d.setUTCMonth(d.getUTCMonth() + o);
      const y = d.getUTCFullYear(), mo = String(d.getUTCMonth() + 1).padStart(2, '0');
      try {
        const data = await (await get(`https://api.chess.com/pub/player/${n}/games/${y}/${mo}`)).json();
        const g = data.games?.find(x => x.url && x.url.includes(id));
        if (g?.pgn) return g.pgn;
      } catch { /* month missing, keep looking */ }
    }
  }
  throw new Error('Could not find that game in the archives. Very new games can take a few minutes to appear, or try the PGN box.');
}
