/**
 * Nuovo Luxury — Google Ads daily spend → Google Sheet "google" tab
 * ------------------------------------------------------------------
 * WHERE THIS RUNS: Google Ads → Tools → Bulk actions → Scripts.
 * NOT Apps Script, NOT the Sheet's own script editor.
 *
 * WHY: the dashboards used to read Google spend from GA4 in the browser, which
 * needs a live OAuth token. That token dies after ~1h, so Google spend silently
 * fell to £0 while Bing (read server-side from this same sheet) kept working —
 * the recurring "it's just Bing" bug. Writing spend into a sheet lets
 * /api/google-spend read it server-side, with nobody signed in.
 *
 * READ BY: https://analytics.nuovoluxury.co.uk/api/google-spend
 * The API expects exactly two columns, header row first: date,spend
 * with date as yyyy-MM-dd TEXT.
 */

var SHEET_URL  = 'https://docs.google.com/spreadsheets/d/1ntgddBfjOFrPhzt2Zc93t6ZG4EHCLkXnGRyt-mErMo4/edit';
var TAB_NAME   = 'google';   // must match api/google-spend.js TAB_NAME exactly
var LOOKBACK_DAYS = 90;      // rewrite this window each run; older rows are kept

// ONE-TIME BACKFILL. Leave as '' for normal daily runs. To pull your whole spend
// history, set this to the date to start from (e.g. '2023-01-01'), Run once, then
// set it back to '' and save. Existing rows are merged, never dropped, so running
// it twice is harmless. Google Ads Scripts only ever execute main(), which is why
// this is a constant rather than a separate function you could pick from a menu.
var BACKFILL_FROM = '';

function main() {
  var ss = SpreadsheetApp.openByUrl(SHEET_URL);
  var sheet = ss.getSheetByName(TAB_NAME) || ss.insertSheet(TAB_NAME);

  var tz  = AdsApp.currentAccount().getTimeZone();
  var fmt = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };
  var end   = new Date();
  var start = BACKFILL_FROM
    ? new Date(BACKFILL_FROM + 'T12:00:00Z')   // noon avoids DST edge cases
    : new Date(end.getTime() - LOOKBACK_DAYS * 86400000);

  // Pull account-level cost per day, a year at a time. Chunking keeps each report
  // well inside Google Ads' row limits on a multi-year backfill; for the normal
  // 90-day run it is a single pass.
  var spend = {};
  var chunkStart = new Date(start.getTime());
  while (chunkStart.getTime() <= end.getTime()) {
    var chunkEnd = new Date(Math.min(chunkStart.getTime() + 364 * 86400000, end.getTime()));
    var rows = AdsApp.search(
      'SELECT segments.date, metrics.cost_micros FROM customer ' +
      'WHERE segments.date BETWEEN "' + fmt(chunkStart) + '" AND "' + fmt(chunkEnd) + '"'
    );
    while (rows.hasNext()) {
      var r = rows.next();
      spend[r.segments.date] = (spend[r.segments.date] || 0) +
                               Number(r.metrics.costMicros) / 1000000;
    }
    chunkStart = new Date(chunkEnd.getTime() + 86400000);
  }

  // Keep whatever history is already in the tab, so the sheet accumulates past
  // the lookback window instead of being truncated to 90 days on every run.
  var merged = {};
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var old = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    for (var i = 0; i < old.length; i++) {
      var d = old[i][0];
      // A previous run (or a manual edit) may have left a real Date object here.
      if (d instanceof Date) d = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
      d = String(d).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) merged[d] = Number(old[i][1]) || 0;
    }
  }

  // Fresh figures win, and every day in the window is present even at £0 —
  // a missing row would otherwise read as a gap rather than a zero-spend day.
  for (var t = start.getTime(); t <= end.getTime(); t += 86400000) {
    var key = fmt(new Date(t));
    merged[key] = Math.round((spend[key] || 0) * 100) / 100;
  }

  var dates = Object.keys(merged).sort();
  var out = [['date', 'spend']];
  for (var j = 0; j < dates.length; j++) out.push([dates[j], merged[dates[j]]]);

  sheet.clear();
  // Force column A to TEXT *before* writing. If Sheets stores these as Date
  // objects, gviz exports the date cell EMPTY and the dashboard loses the day.
  // That exact failure hit the Bing tab on 2026-06-10.
  sheet.getRange(1, 1, out.length, 1).setNumberFormat('@');
  sheet.getRange(1, 1, out.length, 2).setValues(out);

  Logger.log('Wrote ' + (out.length - 1) + ' rows to "' + TAB_NAME + '"' +
             (BACKFILL_FROM ? ' (BACKFILL from ' + BACKFILL_FROM + ')' : '') + '. ' +
             'Range: ' + dates[0] + ' to ' + dates[dates.length - 1] + '. ' +
             'Latest: ' + merged[dates[dates.length - 1]]);
  if (BACKFILL_FROM) Logger.log('Backfill done - now set BACKFILL_FROM back to \'\' and save.');
}
