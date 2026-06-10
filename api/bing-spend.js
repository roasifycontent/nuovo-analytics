// Microsoft Ads (Bing) daily spend — reads the "history" tab of a shared
// Google Sheet (anyone-with-link view). Sheet is self-updating daily back to
// 2023-06-10, so we just read this one CSV and slice by requested date range.
//
// Env: none — sheet ID is hardcoded since the sheet is shared / public-view.
//
// Request:  GET /api/bing-spend?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// Response: { daily: { 'YYYY-MM-DD': number, ... }, total, startDate, endDate,
//             cached, fetchedAt, source }
//
// In-memory cache: 1 hour. Vercel's serverless functions may cold-start so the
// cache is best-effort per warm container, but combined with the public CDN
// Cache-Control header (max-age=3600) the upstream sheet is hit at most ~once
// per hour per region.

const SHEET_ID = '1ntgddBfjOFrPhzt2Zc93t6ZG4EHCLkXnGRyt-mErMo4';
const TAB_NAME = 'history';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(TAB_NAME)}`;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let _cache = null; // { fetchedAt: number, daily: {...} }

function parseCsv(text) {
  // Two-column CSV: "YYYY-MM-DD","spend". Header row first. Blank spend → 0.
  const daily = {};
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = line.match(/^"([^"]*)","([^"]*)"\s*$/);
    if (!m) continue;
    const date = m[1].trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const raw = m[2].trim();
    const spend = raw === '' ? 0 : parseFloat(raw);
    daily[date] = Number.isFinite(spend) ? spend : 0;
  }
  return daily;
}

async function loadDaily() {
  const now = Date.now();
  if (_cache && (now - _cache.fetchedAt) < CACHE_TTL_MS) {
    return { daily: _cache.daily, cached: true, fetchedAt: _cache.fetchedAt };
  }
  const r = await fetch(CSV_URL, { redirect: 'follow' });
  if (!r.ok) throw new Error(`Sheet HTTP ${r.status} ${r.statusText}`);
  const text = await r.text();
  const daily = parseCsv(text);
  if (Object.keys(daily).length === 0) throw new Error('Sheet returned 0 valid rows — check tab name "history" and column order date,spend');
  _cache = { fetchedAt: now, daily };
  return { daily, cached: false, fetchedAt: now };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const url = new URL(req.url, `https://${req.headers.host}`);
  const startDate = url.searchParams.get('startDate');
  const endDate = url.searchParams.get('endDate');

  if (!startDate || !endDate) {
    res.status(400).json({ error: 'startDate and endDate required (YYYY-MM-DD)' });
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    res.status(400).json({ error: 'dates must be YYYY-MM-DD' });
    return;
  }
  if (startDate > endDate) {
    res.status(400).json({ error: 'startDate must be <= endDate' });
    return;
  }

  try {
    const { daily, cached, fetchedAt } = await loadDaily();
    const filtered = {};
    let total = 0;
    Object.entries(daily).forEach(([d, v]) => {
      if (d >= startDate && d <= endDate) {
        filtered[d] = v;
        total += v;
      }
    });
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    res.status(200).json({
      daily: filtered,
      total,
      startDate,
      endDate,
      days: Object.keys(filtered).length,
      cached,
      fetchedAt: new Date(fetchedAt).toISOString(),
      source: 'microsoft-ads-sheet'
    });
  } catch (e) {
    res.status(502).json({ error: `Failed to load Bing spend: ${e.message}`, source: 'microsoft-ads-sheet' });
  }
};
