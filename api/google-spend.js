// Google Ads daily spend — reads the "google" tab of the same shared Google Sheet
// used for Microsoft Ads (anyone-with-link view), written daily by a Google Ads Script.
//
// WHY THIS EXISTS
// Google Ads spend used to be pulled browser-side from GA4 (advertiserAdCost), which
// requires the *user's* live OAuth token. That token expires after ~1h and cannot be
// renewed silently in this browser (third-party cookies are blocked, so GIS fails with
// popup_failed_to_open, and prompt=none returns interaction_required). The result was a
// recurring, silent failure: Google spend read £0 while Microsoft — fetched server-side
// from this sheet — kept working, making the Profit page look like "Bing only".
// Reading spend server-side removes the browser token from the path entirely, so this
// works with no one signed in, including on cold loads and scheduled runs.
//
// Env: none — sheet ID is hardcoded since the sheet is shared / public-view.
//
// Request:  GET /api/google-spend?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// Response: { daily: { 'YYYY-MM-DD': number, ... }, total, startDate, endDate,
//             days, cached, fetchedAt, source }
//
// In-memory cache: 1 hour, same as bing-spend. Combined with the CDN header below the
// upstream sheet is hit at most ~once per hour per warm region.

const SHEET_ID = '1ntgddBfjOFrPhzt2Zc93t6ZG4EHCLkXnGRyt-mErMo4';
const TAB_NAME = 'google';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(TAB_NAME)}`;
// CRITICAL GUARD: the gviz endpoint does NOT error on an unknown tab name — it silently
// returns the workbook's FIRST sheet. Since that first sheet is the Microsoft Ads
// "history" tab, a missing "google" tab would hand back Bing's numbers labelled as
// Google, double-counting Bing into total ad spend. So fetch "history" too and refuse to
// serve data that is identical to it. Verified real: before the google tab existed, both
// endpoints returned byte-identical daily values.
const GUARD_TAB = 'history';
const GUARD_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(GUARD_TAB)}`;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let _cache = null; // { fetchedAt: number, daily: {...} }

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function pad2(n) { return String(n).padStart(2, '0'); }

// Normalise a non-YYYY-MM-DD date cell. Sheets/Apps Script sometimes writes a raw Date
// object rather than a string, which exports as "Wed Jun 10 2026 ..." or as an EMPTY
// string depending on cell type. Handle both: parse month-name and dd/mm/yyyy formats,
// and for an empty/unparseable date fall back to prevDate+1, since the tab is a strict
// daily append. (Same hardening as bing-spend, which this bug class already hit once.)
function normaliseDate(s, prevDate) {
  if (s) {
    let m = s.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
    if (m) {
      const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
      if (mon) return `${m[3]}-${pad2(mon)}-${pad2(parseInt(m[2], 10))}`;
    }
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // UK dd/mm/yyyy
    if (m) return `${m[3]}-${pad2(parseInt(m[2], 10))}-${pad2(parseInt(m[1], 10))}`;
  }
  if (prevDate) {
    const d = new Date(prevDate + 'T12:00:00Z'); // noon avoids DST edge cases
    d.setUTCDate(d.getUTCDate() + 1);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }
  return null;
}

function parseCsv(text) {
  // Two-column CSV: "date","spend". Header row first. Blank spend → 0.
  const daily = {};
  const lines = text.split(/\r?\n/);
  let prevDate = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Greedy first group so a date containing a comma ("June 10, 2026") still splits
    // on the LAST "," delimiter.
    const m = line.match(/^"(.*)","([^"]*)"\s*$/);
    if (!m) continue;
    let date = m[1].trim();
    const raw = m[2].trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      date = normaliseDate(date, prevDate);
      if (!date) continue;
    }
    // Strip currency symbols / thousands separators the Ads Script or a manual edit
    // might introduce ("£1,234.56") before parsing.
    const cleaned = raw.replace(/[^0-9.\-]/g, '');
    const spend = cleaned === '' ? 0 : parseFloat(cleaned);
    daily[date] = Number.isFinite(spend) ? spend : 0;
    prevDate = date;
  }
  return daily;
}

async function loadDaily() {
  const now = Date.now();
  if (_cache && (now - _cache.fetchedAt) < CACHE_TTL_MS) {
    return { daily: _cache.daily, cached: true, fetchedAt: _cache.fetchedAt };
  }
  const [r, guardRes] = await Promise.all([
    fetch(CSV_URL, { redirect: 'follow' }),
    fetch(GUARD_URL, { redirect: 'follow' }).catch(() => null)
  ]);
  if (!r.ok) throw new Error(`Sheet HTTP ${r.status} ${r.statusText}`);
  const text = await r.text();
  // Missing-tab guard — see GUARD_URL above. Identical payload means gviz fell back to
  // the Microsoft "history" tab, so serving it would report Bing spend as Google.
  if (guardRes && guardRes.ok) {
    const guardText = await guardRes.text();
    if (text.trim() === guardText.trim()) {
      throw new Error(`tab "${TAB_NAME}" not found — Google Sheets served the "${GUARD_TAB}" (Microsoft Ads) tab instead. Create a tab named exactly "${TAB_NAME}" with columns date,spend so Google spend is not double-counted from Bing.`);
    }
  }
  const daily = parseCsv(text);
  if (Object.keys(daily).length === 0) {
    throw new Error(`Sheet returned 0 valid rows — check the tab is named "${TAB_NAME}" with columns date,spend`);
  }
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
    // s-maxage: CDN caches 1h (protects the sheet). max-age=0 + must-revalidate: the
    // browser must always re-ask the CDN, otherwise it can hold a stale copy for an
    // hour after the sheet updates — the exact failure that hid a Bing fix previously.
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate, s-maxage=3600');
    res.status(200).json({
      daily: filtered,
      total,
      startDate,
      endDate,
      days: Object.keys(filtered).length,
      cached,
      fetchedAt: new Date(fetchedAt).toISOString(),
      source: 'google-ads-sheet'
    });
  } catch (e) {
    res.status(502).json({ error: `Failed to load Google spend: ${e.message}`, source: 'google-ads-sheet' });
  }
};
