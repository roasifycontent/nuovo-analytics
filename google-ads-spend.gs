/**
 * Nuovo Luxury — Google Ads daily spend → Google Sheet "google" tab
 * ------------------------------------------------------------------
 * WHERE THIS RUNS: Google Ads → Tools → Bulk actions → Scripts.
 * NOT Apps Script (script.google.com) — this uses AdsApp, which only exists in
 * Google Ads Scripts. The Bing merge script IS an Apps Script, which is the trap.
 *
 * WHY: the dashboards used to read Google spend from GA4 in the browser, which
 * needs a live OAuth token. That token dies after ~1h, so Google spend silently
 * fell to £0 while Bing (read server-side from this same sheet) kept working —
 * the recurring "it's just Bing" bug.
 *
 * READ BY: https://analytics.nuovoluxury.co.uk/api/google-spend
 * Expects exactly two columns, header row first: date,spend — date as yyyy-MM-dd TEXT.
 *
 * SELF-BACKFILLING: on a run where the tab does not already reach back to
 * HISTORY_FROM, it pulls everything from that date (chunked by year). Afterwards
 * it only refreshes the last LOOKBACK_DAYS. Nothing to switch on or off, and
 * running it twice is harmless because rows are merged, never dropped.
 */

var SHEET_URL     = 'https://docs.google.com/spreadsheets/d/1ntgddBfjOFrPhzt2Zc93t6ZG4EHCLkXnGRyt-mErMo4/edit';
var TAB_NAME      = 'google';       // must match api/google-spend.js TAB_NAME exactly
var LOOKBACK_DAYS = 90;             // normal daily refresh window
var HISTORY_FROM  = '2023-01-01';   // history must reach this far back (Bing starts 2023-06-10)

function main() {
  var ss = SpreadsheetApp.openByUrl(SHEET_URL);
  var sheet = ss.getSheetByName(TAB_NAME) || ss.insertSheet(TAB_NAME);

  var tz  = AdsApp.currentAccount().getTimeZone();
  var fmt = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };

  // Keep whatever history is already in the tab, so the sheet accumulates instead
  // of being truncated to the lookback window on every run.
  var merged = {};
  var earliest = null;
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var old = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    for (var i = 0; i < old.length; i++) {
      var d = old[i][0];
      // A previous run or a manual edit may have left a real Date object here.
      if (d instanceof Date) d = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
      d = String(d).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      merged[d] = Number(old[i][1]) || 0;
      if (!earliest || d < earliest) earliest = d;
    }
  }

  // Backfill automatically whenever the tab does not yet reach HISTORY_FROM.
  var backfilling = !earliest || earliest > HISTORY_FROM;
  var end   = new Date();
  var start = backfilling
    ? new Date(HISTORY_FROM + 'T12:00:00Z')            // noon avoids DST edge cases
    : new Date(end.getTime() - LOOKBACK_DAYS * 86400000);

  // Pull account-level cost per day, a year at a time. Chunking keeps each report
  // well inside Google Ads' row limits on a multi-year backfill; the normal run is
  // a single pass.
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

  // Fresh figures win, and every day in the window is present even at £0 — a
  // missing row would otherwise read as a gap rather than a zero-spend day.
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

  Logger.log((backfilling ? 'BACKFILL: ' : 'Daily run: ') +
             'wrote ' + (out.length - 1) + ' rows to "' + TAB_NAME + '". ' +
             dates[0] + ' to ' + dates[dates.length - 1] + '. ' +
             'Latest spend: ' + merged[dates[dates.length - 1]]);
}
