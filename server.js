'use strict';
/**
 * VANTA update server — zero dependencies, Node >= 18.
 *
 *  - Serves the website (public/index.html)
 *  - Polls movie / TV / anime sources on a schedule
 *  - Remembers every title it has seen, flags the ones that are new
 *  - Exposes GET /api/updates  (what the "New releases" tab reads)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- config ---
const env = process.env;
const CONFIG = {
  port: Number(env.PORT) || 3000,
  dataDir: env.DATA_DIR || path.join(__dirname, 'data'),
  intervalMin: Math.max(5, Number(env.UPDATE_INTERVAL_MIN) || 360), // default: every 6 h
  pages: Math.min(5, Math.max(1, Number(env.PAGES_PER_SOURCE) || 2)),
  maxStored: Number(env.MAX_STORED) || 3000,
  newDays: Number(env.NEW_WINDOW_DAYS) || 30,
  adminToken: env.ADMIN_TOKEN || '',
  tmdbKey: env.TMDB_API_KEY || '',                    // optional, improves movie/TV data
  // Overridable so tests (or mirrors) can point elsewhere:
  vidspark: env.VIDSPARK_BASE || 'https://vidspark.to',
  anilist: env.ANILIST_URL || 'https://graphql.anilist.co',
  tmdb: env.TMDB_BASE || 'https://api.themoviedb.org/3',
};
const DB_FILE = path.join(CONFIG.dataDir, 'catalog.json');
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ----------------------------------------------------------------- store ---
let db = { titles: {}, run: null };           // titles: id -> title object
function load() {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); db.titles ||= {}; }
  catch { db = { titles: {}, run: null }; }
}
function save() {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);                // atomic: never leaves a half-written file
}

// --------------------------------------------------------------- helpers ---
async function getJSON(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000),
    headers: { Accept: 'application/json', 'User-Agent': 'VANTA-update-server/1.0', ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${new URL(url).host} responded ${r.status}`);
  return r.json();
}
const poster = (imdb) => /^tt\d+$/.test(imdb || '') ? `https://images.metahub.space/poster/small/${imdb}/img` : '';
const base = (o) => ({
  genre: 'Other', rating: '—', ratingSource: '', runtime: '—', director: 'Not available',
  writer: 'Not available', cast: [], synopsis: 'Description unavailable from this provider.',
  poster: '', tag: '', ...o,
});

// --------------------------------------------------------------- sources ---
// Each source returns an array of titles in the exact shape the site uses.

// 1) VidSpark — the same catalog the site already searches, so IDs are playable.
async function fromVidspark(kind) {               // kind: 'movies' | 'tv'
  const out = [];
  for (let page = 1; page <= CONFIG.pages; page++) {
    const u = new URL(`/api/discover/${kind}`, CONFIG.vidspark);
    u.searchParams.set('page', page); u.searchParams.set('resultsPerPage', '100');
    const j = await getJSON(u);
    if (!Array.isArray(j.data)) throw new Error('unexpected vidspark response');
    for (const x of j.data) {
      if (!/^\d+$/.test(String(x.tmdbid))) continue;
      const tv = kind === 'tv', imdb = /^tt\d+$/.test(x.imdb_id || '') ? x.imdb_id : null;
      out.push(base({
        id: `vidspark-${tv ? 'tv' : 'movie'}-${x.tmdbid}`, title: x.orig_title || 'Untitled',
        imdbId: imdb, year: x.year || '—', runtime: tv ? 'Series' : '—',
        poster: poster(imdb), tag: tv ? 'SERIES' : (x.quality || ''), type: tv ? 'Series' : 'Movie',
      }));
    }
  }
  return out;
}

// 2) TMDB (optional, needs TMDB_API_KEY) — recent releases with real posters/ratings.
async function fromTmdb(kind) {                   // kind: 'movie' | 'tv'
  if (!CONFIG.tmdbKey) return [];
  const tv = kind === 'tv', since = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
  const u = new URL(`${CONFIG.tmdb}/discover/${kind}`);
  u.searchParams.set('api_key', CONFIG.tmdbKey);
  u.searchParams.set('sort_by', tv ? 'first_air_date.desc' : 'primary_release_date.desc');
  u.searchParams.set(tv ? 'first_air_date.gte' : 'primary_release_date.gte', since);
  u.searchParams.set(tv ? 'first_air_date.lte' : 'primary_release_date.lte', new Date().toISOString().slice(0, 10));
  const j = await getJSON(u);
  const rows = (j.results || []).slice(0, 40);
  const imdbs = await Promise.all(rows.map((x) =>
    getJSON(`${CONFIG.tmdb}/${kind}/${x.id}/external_ids?api_key=${CONFIG.tmdbKey}`).then((e) => e.imdb_id || null).catch(() => null)));
  return rows.map((x, i) => base({
    imdbId: /^tt\d+$/.test(imdbs[i] || '') ? imdbs[i] : null,
    id: `tmdb-${kind}-${x.id}`, title: x.title || x.name || 'Untitled',
    year: (x.release_date || x.first_air_date || '').slice(0, 4) || '—',
    rating: x.vote_average ? x.vote_average.toFixed(1) : '—', ratingSource: x.vote_average ? 'TMDB' : '',
    runtime: tv ? 'Series' : '—', synopsis: x.overview || 'Description unavailable from this provider.',
    poster: x.poster_path ? `https://image.tmdb.org/t/p/w500${x.poster_path}` : '',
    tag: tv ? 'SERIES' : 'MOVIE', type: tv ? 'Series' : 'Movie',
  }));
}

// 3) AniList — currently airing anime, newest first.
async function fromAnilist() {
  const gql = `query($page:Int){Page(page:$page,perPage:50){media(type:ANIME,status:RELEASING,sort:START_DATE_DESC){
    id title{english romaji native} synonyms coverImage{large} startDate{year} genres averageScore description(asHtml:false) format
    nextAiringEpisode{episode}}}}`;
  const out = [];
  for (let page = 1; page <= CONFIG.pages; page++) {
    const j = await getJSON(CONFIG.anilist, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: gql, variables: { page } }) });
    const media = j.data?.Page?.media;
    if (!media) throw new Error('invalid anilist response');
    for (const x of media) out.push(base({
      id: 'anime-' + x.id, title: x.title.english || x.title.romaji, year: x.startDate?.year || '—',
      altTitles: [x.title.english, x.title.romaji, ...(x.synonyms || [])].filter(Boolean).slice(0, 6),
      genre: x.genres?.[0] || 'Anime', rating: x.averageScore ? (x.averageScore / 10).toFixed(1) : '—',
      ratingSource: x.averageScore ? 'AniList' : '', runtime: x.format === 'MOVIE' ? 'Movie' : 'Series',
      synopsis: (x.description || 'Description not available.').replace(/<[^>]+>/g, ''),
      poster: x.coverImage?.large || '', tag: 'ANIME', type: x.format === 'MOVIE' ? 'Movie' : 'Series',
    }));
    if (media.length < 50) break;
  }
  return out;
}

const SOURCES = [
  ['movies', () => fromVidspark('movies')], ['tv', () => fromVidspark('tv')],
  ['tmdb-movies', () => fromTmdb('movie')], ['tmdb-tv', () => fromTmdb('tv')],
  ['anime', fromAnilist],
];


// ------------------------------------------------- connect to the players ---
// The site streams through VidSpark / VidSrc / VidFast, all keyed by TMDB id.
// A title is playable when its id looks like vidspark-(movie|tv)-N or tmdb-(movie|tv)-N.
// Anything else (anime from AniList) is matched against the VidSpark catalog by title.
const PLAYABLE = /^(vidspark|tmdb)-(movie|tv)-\d+$/;
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

async function findPlayer(t) {
  const kinds = t.type === 'Movie' ? ['movies', 'tv'] : ['tv', 'movies'];
  const wanted = new Set([t.title, ...(t.altTitles || [])].map(norm).filter(Boolean));
  for (const name of [...wanted].filter((n) => n.length >= 3).slice(0, 4)) {
    for (const kind of kinds) {
      const u = new URL(`/api/discover/${kind}`, CONFIG.vidspark);
      u.searchParams.set('page', 1); u.searchParams.set('resultsPerPage', '50'); u.searchParams.set('query', name);
      const j = await getJSON(u);
      for (const x of j.data || []) {
        if (!/^\d+$/.test(String(x.tmdbid)) || !wanted.has(norm(x.orig_title))) continue;
        const yr = Number(x.year), want = Number(t.year);
        if (yr && want && Math.abs(yr - want) > 1 && kind === 'movies') continue; // same name, different film
        return { playId: `vidspark-${kind === 'tv' ? 'tv' : 'movie'}-${x.tmdbid}`,
                 playType: kind === 'tv' ? 'Series' : 'Movie',
                 playImdb: /^tt\d+$/.test(x.imdb_id || '') ? x.imdb_id : null };
      }
    }
  }
  return null;
}

// Retries every run, so a title the provider adds later gets connected automatically.
async function connectPlayers(limit = 40) {
  let linked = 0, pending = 0;
  const todo = Object.values(db.titles).filter((t) => !PLAYABLE.test(t.id) && !t.playId)
    .sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0));
  for (const t of todo.slice(0, limit)) {
    try { const m = await findPlayer(t); if (m) { Object.assign(db.titles[t.id], m, { linkedAt: Date.now() }); linked++; } else pending++; }
    catch (e) { pending++; log('player lookup failed:', t.title, e.message); }
  }
  return { linked, pending: pending + Math.max(0, todo.length - limit) };
}

// ---------------------------------------------------------------- update ---
let running = false;
async function runUpdate(reason = 'schedule') {
  if (running) return db.run;
  running = true;
  const started = Date.now(), first = Object.keys(db.titles).length === 0;
  const results = [];
  let added = 0;
  for (const [name, fn] of SOURCES) {
    if (name.startsWith('tmdb') && !CONFIG.tmdbKey) continue;
    try {
      const items = await fn();
      let n = 0;
      for (const t of items) {
        const known = db.titles[t.id];
        if (known) { db.titles[t.id] = { ...t, firstSeen: known.firstSeen, lastSeen: started }; continue; }
        // First ever run = baseline (not "new"); afterwards anything unseen is new.
        db.titles[t.id] = { ...t, firstSeen: first ? null : started, lastSeen: started };
        if (!first) n++;
      }
      added += n; results.push({ source: name, ok: true, fetched: items.length, added: n });
    } catch (e) { results.push({ source: name, ok: false, error: e.message }); log('source failed:', name, e.message); }
  }
  let players = { linked: 0, pending: 0 };
  try { players = await connectPlayers(); } catch (e) { log('connectPlayers failed:', e.message); }
  // prune: keep newest-seen entries only
  const ids = Object.keys(db.titles);
  if (ids.length > CONFIG.maxStored) {
    ids.sort((a, b) => (db.titles[b].firstSeen || 0) - (db.titles[a].firstSeen || 0))
       .slice(CONFIG.maxStored).forEach((id) => delete db.titles[id]);
  }
  const failed = results.filter((r) => !r.ok).length;
  db.run = {
    started, completed: Date.now(), reason,
    status: failed === 0 ? 'ok' : failed === results.length ? 'failed' : 'partial',
    added, players, sources: results,
    message: first ? `Catalog initialised with ${Object.keys(db.titles).length} titles`
      : `${added} new title${added === 1 ? '' : 's'} found` + (players.pending ? ` · ${players.pending} awaiting a player` : '') + (failed ? ` · ${failed} source(s) unavailable` : ''),
  };
  // If every source failed keep the previous good data timestamp semantics: still record the failed run.
  try { save(); } catch (e) { log('save failed:', e.message); }
  log('update finished:', db.run.message);
  running = false;
  return db.run;
}

// ------------------------------------------------------------------- api ---
function listUpdates(q, page) {
  const now = Date.now(), win = CONFIG.newDays * 864e5;
  let items = Object.values(db.titles);
  if (q) { const s = q.toLowerCase(); items = items.filter((t) => String(t.title).toLowerCase().includes(s)); }
  items.sort((a, b) => {
    const an = a.firstSeen && now - a.firstSeen < win, bn = b.firstSeen && now - b.firstSeen < win;
    if (an !== bn) return an ? -1 : 1;                       // genuinely new titles first
    if (an && bn) return b.firstSeen - a.firstSeen;           // newest detection first
    return (Number(b.year) || 0) - (Number(a.year) || 0);     // then by release year
  });
  // Expose the id the site's players understand; collapse duplicates (e.g. anime also in the VidSpark list).
  const seen = new Map();
  for (const it of items) {
    const out = { ...it };
    if (it.playId) { out.id = it.playId; out.type = it.playType || it.type; if (it.playImdb) out.imdbId = it.playImdb;
      if (out.type === 'Series') out.runtime = 'Series'; }
    out.playable = PLAYABLE.test(out.id);
    const prev = seen.get(out.id);
    if (!prev) { seen.set(out.id, out); continue; }
    const rich = (x) => x.synopsis && !/unavailable/i.test(x.synopsis);
    const keep = rich(out) && !rich(prev) ? { ...out, firstSeen: prev.firstSeen || out.firstSeen } : prev;
    seen.set(out.id, keep);
  }
  const per = 100, all = [...seen.values()], slice = page === 0 ? all : all.slice((page - 1) * per, page * per);
  return slice.map(({ firstSeen, lastSeen, altTitles, playId, playType, playImdb, linkedAt, ...t }) =>
    (firstSeen && now - firstSeen < win) ? { ...t, tag: 'NEW' } : t);
}

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(INDEX_FILE).pipe(res);
    }
    if (req.method === 'GET' && u.pathname === '/api/updates') {
      const page = Math.max(1, Number(u.searchParams.get('page')) || 1);
      return json(res, 200, { titles: listUpdates((u.searchParams.get('q') || '').trim(), page), run: db.run });
    }
    if (req.method === 'GET' && u.pathname === '/healthz')
      return json(res, 200, { ok: true, titles: Object.keys(db.titles).length, run: db.run && { status: db.run.status, completed: db.run.completed } });
    if (req.method === 'POST' && u.pathname === '/admin/refresh') {
      const tok = (req.headers.authorization || '').replace(/^Bearer /, '') || u.searchParams.get('token');
      if (!CONFIG.adminToken || tok !== CONFIG.adminToken) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, { run: await runUpdate('manual') });
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) { log('request error', e); json(res, 500, { error: 'Server error' }); }
});

// ----------------------------------------------------------------- start ---
function start() {
  load();
  server.listen(CONFIG.port, () => log(`VANTA server on :${CONFIG.port} · updating every ${CONFIG.intervalMin} min`));
  const age = db.run ? Date.now() - db.run.completed : Infinity;
  setTimeout(() => runUpdate('startup'), age > CONFIG.intervalMin * 6e4 ? 1000 : age < 0 ? 1000 : CONFIG.intervalMin * 6e4 - age);
  setInterval(() => runUpdate('schedule'), CONFIG.intervalMin * 6e4).unref?.();
}
if (require.main === module) start();
module.exports = { server, runUpdate, load, listUpdates, save, CONFIG, get db() { return db; } };
