// Bank statement check for a petty cash wallet. Pure: the page feeds it OCR lines and its own data.
// Runs in the browser (window.PCReconcile) and in node tests (module.exports). Nothing is stored.
(function (root) {
  'use strict';
  // OCR drops or swaps separators ("2680.00", "15.906.74", "7156126"); statement amounts always carry satang,
  // so a money token is digits with optional , or . and its last two digits are the satang
  function isMoneyToken(t) { return /^[\d.,]+$/.test(t) && t.replace(/\D/g, '').length >= 3; }
  var money = function (t) { return Number(t.replace(/\D/g, '')) / 100; };
  var DATE = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g;
  var cents = function (n) { return Math.round(n * 100); };
  var two = function (n) { return (n < 10 ? '0' : '') + n; };

  // Thai statements print Buddhist years, often as two digits (69 = 2569 = 2026)
  function iso(d, m, y) {
    if (Number(d) < 1 || Number(d) > 31 || Number(m) < 1 || Number(m) > 12) return null; // OCR misread
    y = Number(y);
    if (y < 100) y += 2500;
    if (y > 2400) y -= 543;
    return y + '-' + two(Number(m)) + '-' + two(Number(d));
  }
  function datesIn(text) {
    var out = [], m;
    DATE.lastIndex = 0;
    while ((m = DATE.exec(text))) out.push(iso(m[1], m[2], m[3]));
    return out.filter(Boolean);
  }

  // lines: [{ text, xs }] where xs[i] is the x (0..1 of the image width) of the i-th money token on the line
  function parseStatement(lines) {
    var rows = [], from = null, to = null, footer = [];
    lines.forEach(function (l) {
      var text = String(l.text || '').trim();
      var amounts = text.split(/\s+/).filter(isMoneyToken);
      var lead = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(text);
      if (lead && !iso(lead[1], lead[2], lead[3])) lead = null;
      if (lead && amounts.length >= 2) {
        var xs = l.xs || [];
        rows.push({
          date: iso(lead[1], lead[2], lead[3]),
          amount: money(amounts[amounts.length - 2]),
          balance: money(amounts[amounts.length - 1]),
          x: xs.length >= 2 ? xs[xs.length - 2] : null,
        });
        return;
      }
      var ds = datesIn(text);
      if (!rows.length && ds.length >= 2 && !from) { from = ds[0]; to = ds[1]; return; }
      // footer: "<count> <total>" for withdrawals, then for deposits
      var f = /^\D{0,40}?(\d{1,4})\s+([\d.,]+)\s*$/.exec(text);
      if (rows.length && !lead && f && isMoneyToken(f[2])) footer.push(money(f[2]));
    });

    // money in or out: the running balance decides; where a row is missing (blurred, OCR miss) the column decides
    rows.forEach(function (r, i) {
      var prev = i ? rows[i - 1].balance : null;
      if (prev === null) return;
      if (cents(prev - r.amount) === cents(r.balance)) r.dir = 'out';
      else if (cents(prev + r.amount) === cents(r.balance)) r.dir = 'in';
    });
    var colX = function (dir) {
      var xs = rows.filter(function (r) { return r.dir === dir && r.x !== null; }).map(function (r) { return r.x; });
      return xs.length ? xs.reduce(function (a, b) { return a + b; }, 0) / xs.length : null;
    };
    var outX = colX('out'), inX = colX('in');
    rows.forEach(function (r) {
      if (r.dir) return;
      if (r.x === null || (outX === null && inX === null)) r.dir = 'out';
      else if (outX !== null && inX !== null) r.dir = Math.abs(r.x - outX) <= Math.abs(r.x - inX) ? 'out' : 'in';
      else if (outX !== null) r.dir = Math.abs(r.x - outX) <= 0.05 ? 'out' : 'in';
      else r.dir = Math.abs(r.x - inX) <= 0.05 ? 'in' : 'out';
    });

    var sum = function (dir) { return rows.filter(function (r) { return r.dir === dir; }).reduce(function (s, r) { return s + r.amount; }, 0); };
    var totals = footer.length >= 2 ? { out: footer[0], in: footer[1], outOk: cents(sum('out')) === cents(footer[0]), inOk: cents(sum('in')) === cents(footer[1]) } : null;
    if (!from && rows.length) { from = rows[0].date; to = rows[rows.length - 1].date; }
    return {
      rows: rows.map(function (r) { return { date: r.date, amount: r.amount, dir: r.dir, balance: r.balance }; }),
      from: from, to: to, totals: totals,
    };
  }

  // a timestamp as a Bangkok calendar date
  function bkk(ts) {
    if (!ts) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(ts)) return ts;
    var d = new Date(new Date(ts).getTime() + 7 * 3600 * 1000);
    return d.getUTCFullYear() + '-' + two(d.getUTCMonth() + 1) + '-' + two(d.getUTCDate());
  }

  // which statement rows have no record here. Out: a payment on a clearing, same amount, same pay date.
  // In: a reimbursed clearing or a plus adjustment, same amount, same month. Each record matches one row.
  function reconcile(rows, data, from, to) {
    var outPool = (data.payments || []).filter(function (p) { return p.clearing_id && p.status === 'cleared'; })
      .map(function (p) { return { key: bkk(p.ai_date || p.created_at), c: cents(Number(p.amount)), used: false }; });
    var inPool = (data.clearings || []).filter(function (c) { return c.status === 'reimbursed'; })
      .map(function (c) { return { key: bkk(c.reimbursed_at).slice(0, 7), c: cents(Number(c.total)), used: false }; })
      .concat((data.adjustments || []).filter(function (a) { return !a.voided_at && Number(a.amount) > 0; })
        .map(function (a) { return { key: bkk(a.created_at).slice(0, 7), c: cents(Number(a.amount)), used: false }; }));
    var res = { missingOut: [], missingIn: [], matchedOut: 0, matchedIn: 0 };
    rows.forEach(function (r) {
      if ((from && r.date < from) || (to && r.date > to)) return;
      var out = r.dir === 'out';
      var key = out ? r.date : r.date.slice(0, 7);
      var hit = (out ? outPool : inPool).find(function (x) { return !x.used && x.key === key && x.c === cents(r.amount); });
      if (hit) { hit.used = true; res[out ? 'matchedOut' : 'matchedIn']++; }
      else res[out ? 'missingOut' : 'missingIn'].push(r);
    });
    return res;
  }

  var api = { parseStatement: parseStatement, reconcile: reconcile, bkk: bkk, isMoneyToken: isMoneyToken };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PCReconcile = api;
})(this);
