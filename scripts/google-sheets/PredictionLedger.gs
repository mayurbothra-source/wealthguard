/**
 * WealthGuard — Prediction Ledger (Google Apps Script, bound to the ledger sheet).
 *
 * Pulls every house prediction and its Weekly / Monthly / Quarterly / Annual
 * results from the WealthGuard backend and writes them to per-month tabs
 * (e.g. "Sep 2026", "Oct 2026", "Nov 2026") — each row green when the
 * prediction was right, red when wrong — plus a combined "Accuracy" tab.
 *
 * SETUP (once — see docs/PREDICTION_LEDGER.md):
 *   1. Extensions → Apps Script → paste this file → Save.
 *   2. Project Settings → Script properties → add
 *        LEDGER_URL    https://wealthguard-backend.onrender.com/api/ledger/predictions
 *        LEDGER_TOKEN  (the same value as LEDGER_TOKEN in Render)
 *   3. Run `installDailyTrigger` once and approve the permissions.
 *   4. Run `syncLedger` once to fill the sheet now.
 *
 * The backend sleeps on Render's free plan; the first request wakes it, so the
 * script retries for up to ~4 minutes before giving up (the next daily run
 * tries again). Nothing is written unless a full, valid response arrives.
 */

var GREEN = '#d9ead3', RED = '#f4cccc', GREEN_CELL = '#b6d7a8', RED_CELL = '#ea9999', HEADER = '#1b5e3f';
var HEAD = ['Date', 'Instrument', 'Prediction', 'Entry price (₹)', 'Weekly', 'Monthly', 'Quarterly', 'Annual', 'Overall'];
var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function syncLedger() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('LEDGER_URL'), token = props.getProperty('LEDGER_TOKEN');
  if (!url || !token) throw new Error('Set LEDGER_URL and LEDGER_TOKEN in Project Settings → Script properties.');

  var data = fetchWithWake_(url, token);
  writeMonthlyPredictions_(data);
  writeAccuracy_(data);
}

function fetchWithWake_(url, token) {
  var health = url.replace(/\/api\/.*$/, '/healthz');
  var lastErr = '';
  for (var i = 0; i < 6; i++) {
    try { UrlFetchApp.fetch(health, { muteHttpExceptions: true }); } catch (e) { /* waking */ }
    try {
      var res = UrlFetchApp.fetch(url, { headers: { 'x-ledger-token': token }, muteHttpExceptions: true });
      var code = res.getResponseCode();
      if (code === 200) {
        var json = JSON.parse(res.getContentText());
        if (json && json.rows && json.summary) return json;
        lastErr = 'response had no rows';
      } else if (code === 401 || code === 503) {
        throw new Error('Backend refused the token (HTTP ' + code + '): check LEDGER_TOKEN here and in Render.');
      } else {
        lastErr = 'HTTP ' + code;
      }
    } catch (e) {
      if (/refused the token/.test(e.message)) throw e;
      lastErr = e.message;
    }
    Utilities.sleep(40000);   // the server is waking up
  }
  throw new Error('Backend did not answer after ~4 minutes (' + lastErr + '). The next scheduled run will retry.');
}

function sheet_(name) {
  var ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/** Group rows by "Mon YYYY" and write one tab per month, newest month first. */
function writeMonthlyPredictions_(data) {
  var buckets = {};
  var order = [];
  data.rows.forEach(function (r) {
    var parts = String(r.date).split('-');
    var key = MONTHS[+parts[1] - 1] + ' ' + parts[0];   // "Nov 2026"
    if (!buckets[key]) { buckets[key] = []; order.push(key); }
    buckets[key].push([r.date, r.instrument, r.prediction, r.entry == null ? '' : r.entry, r.weekly, r.monthly, r.quarterly, r.annual, r.overall]);
  });

  // Remove the old single "Predictions" tab if it still exists.
  var ss = SpreadsheetApp.getActive();
  var old = ss.getSheetByName('Predictions');
  if (old && order.length) { try { ss.deleteSheet(old); } catch (e) { /* only sheet — ignore */ } }

  order.forEach(function (month) {
    var sh = sheet_(month);
    var rows = buckets[month];
    sh.clear();
    sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold').setFontColor('#ffffff').setBackground(HEADER);
    sh.setFrozenRows(1);
    if (!rows.length) return;
    sh.getRange(2, 1, rows.length, HEAD.length).setValues(rows);
    applyColours_(sh, rows.length);
    sh.getRange(2, 4, rows.length, 1).setNumberFormat('#,##0.00');
    sh.autoResizeColumns(1, HEAD.length);
    if (!sh.getFilter()) sh.getRange(1, 1, rows.length + 1, HEAD.length).createFilter();
  });

  // Move Accuracy tab to the front so it's the landing page.
  var acc = ss.getSheetByName('Accuracy');
  if (acc) { ss.setActiveSheet(acc); ss.moveActiveSheet(1); }
}

/**
 * Colours as conditional-formatting rules, so they stay right after sorting or
 * filtering: the whole row green when Overall is "Right", red when "Wrong";
 * each Weekly / Monthly / Quarterly / Annual cell darker green for ✓, red for ✗.
 */
function applyColours_(sh, n) {
  var rowRange = sh.getRange(2, 1, n, HEAD.length);
  var cells = sh.getRange(2, 5, n, 4);
  var rule = SpreadsheetApp.newConditionalFormatRule;
  sh.setConditionalFormatRules([
    rule().whenTextStartsWith('✓').setBackground(GREEN_CELL).setRanges([cells]).build(),
    rule().whenTextStartsWith('✗').setBackground(RED_CELL).setRanges([cells]).build(),
    rule().whenFormulaSatisfied('=$I2="Right"').setBackground(GREEN).setRanges([rowRange]).build(),
    rule().whenFormulaSatisfied('=$I2="Wrong"').setBackground(RED).setRanges([rowRange]).build(),
  ]);
}

function writeAccuracy_(data) {
  var sh = sheet_('Accuracy');
  sh.clear();
  var s = data.summary, o = s.overall;
  var out = [
    ['WealthGuard — prediction accuracy', '', '', '', ''],
    ['Updated', new Date(data.generated_at), '', '', ''],
    ['Track-record engine last ran', data.engine ? new Date(data.engine.run_at) : 'unknown',
     data.engine ? (data.engine.status + ', ' + data.engine.items_processed + ' scored') : '', '', ''],
    ['', '', '', '', ''],
    ['Overall (strictest: any wrong checkpoint = wrong)', 'Right', 'Wrong', 'Pending / no verdict', 'Accuracy'],
    ['All predictions (' + o.predictions + ')', o.right, o.wrong, o.pending + o.no_verdict, o.accuracy_text],
    ['', '', '', '', ''],
    ['Checkpoint / prediction', 'Right', 'Wrong', 'Scored', 'Accuracy'],
  ];
  s.table.forEach(function (t) {
    out.push([t.checkpoint + ' — ' + t.prediction, t.right, t.wrong, t.scored, t.accuracy_text]);
  });
  out.push(['', '', '', '', '']);
  out.push(['A percentage is shown only once ' + s.min_for_percent + ' predictions have a verdict. 0.00% moves, frozen price feeds and instruments with no market price are never counted as right.', '', '', '', '']);
  out.push(['BUY right if the price rose · SELL right if it fell · HOLD right if within ±2% · WATCH right if within ±3% (no big move missed).', '', '', '', '']);
  sh.getRange(1, 1, out.length, 5).setValues(out);
  sh.getRange('A1').setFontWeight('bold').setFontSize(14);
  [5, 8].forEach(function (r) { sh.getRange(r, 1, 1, 5).setFontWeight('bold').setBackground('#e8f5ee'); });
  sh.autoResizeColumns(1, 5);
}

/** Run once: syncs every evening (after the 16:30 IST scoring run) and again at night as a retry. */
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncLedger') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncLedger').timeBased().everyDays(1).atHour(19).inTimezone('Asia/Kolkata').create();
  ScriptApp.newTrigger('syncLedger').timeBased().everyDays(1).atHour(22).inTimezone('Asia/Kolkata').create();
}

/** Adds a WealthGuard menu so the sheet can be refreshed by hand. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('WealthGuard').addItem('Refresh ledger now', 'syncLedger').addToUi();
}
