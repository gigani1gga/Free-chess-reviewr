// Turns a game link (Chess.com / Lichess) or raw PGN into PGN text.
const LIMIT_MS = 30000; // a site that never answers must end in a clear message, not an endless "Finding your game"
const LATE = host => `${host} did not answer in time. You can paste the PGN under Options instead.`;

// GET `url` and read the whole body ('text' or 'json') inside the time limit. A timeout is marked `.timeout` so callers
// can tell "the site is not answering" (stop) from "that page does not exist" (keep looking).
const get = async (url, as = 'text') => {
  const host = new URL(url).host, ctl = new AbortController();
  let late = false;
  const timer = setTimeout(() => { late = true; ctl.abort(); }, LIMIT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(r.status + ' from ' + host);
    return await r[as]();
  } catch (e) {
    if (late) throw Object.assign(new Error(LATE(host)), { timeout: true });
    throw e;
  } finally {
    clearTimeout(timer);
  }
};

export async function loadGame(input, usernameHint = '', say = () => {}) {
  const text = input.trim();
  if (/^(\[|1\.)/.test(text)) return text; // already a PGN
  let u;
  try { u = new URL(/^https?:/i.test(text) ? text : 'https://' + text); }
  catch { throw new Error('That is not a game link or a PGN.'); }
  const host = u.hostname.replace(/^www\./, '');
  if (host.endsWith('chess.com')) return fromChessCom(u, usernameHint, say);
  if (host.endsWith('lichess.org')) return fromLichess(u, say);
  throw new Error('Only Chess.com and Lichess links are supported.');
}

async function fromLichess(u, say) {
  const id = u.pathname.split('/').filter(Boolean)[0]?.slice(0, 8);
  if (!id) throw new Error('Could not find a game id in that Lichess link.');
  say('Asking Lichess…');
  try {
    return await get(`https://lichess.org/game/export/${id}?evals=0&clocks=0&opening=0`);
  } catch (e) {
    // fetch() says only "Failed to fetch" when the browser is offline or the request is blocked
    if (e instanceof TypeError) throw new Error('Could not reach lichess.org. Check your connection, or paste the PGN under Options.');
    throw e;
  }
}

async function fromChessCom(u, hint, say) {
  const type = /daily/.test(u.pathname) ? 'daily' : 'live';
  const m = (u.pathname + u.search + u.hash).match(/(\d{6,})/);
  if (!m) throw new Error('Could not find a game id in that Chess.com link.');
  const id = m[1];

  // Step 1: ask Chess.com who played and when (may be blocked by the browser).
  let names = [], date = '';
  say('Asking Chess.com…');
  try {
    const d = await get(`https://www.chess.com/callback/${type}/game/${id}`, 'json');
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
      say(`Searching ${n}’s Chess.com games…`);
      try {
        const data = await get(`https://api.chess.com/pub/player/${n}/games/${y}/${mo}`, 'json');
        // Compare whole numbers: a short id must not match inside a longer one (12345678 is not part of 112345678).
        const g = data.games?.find(x => x.url && x.url.split(/\D+/).includes(id));
        if (g?.pgn) return g.pgn;
      } catch (e) {
        if (e.timeout) throw e; // the site is not answering: stop, don't wait again for every month
        /* month missing, keep looking */
      }
    }
  }
  throw new Error('Could not find that game in the archives. Very new games can take a few minutes to appear, or try the PGN box.');
}
