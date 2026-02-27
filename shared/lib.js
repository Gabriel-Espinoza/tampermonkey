/**
 * Shared library for Itaú (and other bank) Tampermonkey scripts.
 * CSV, date/money helpers, YNAB sync, and generic button injection.
 * Use via @require in each script; expose as window.BankYNABLib or use in same scope.
 */
(function (root) {
  'use strict';

  const INTERVAL_MS = 400;
  const YNAB_API_BASE = 'https://api.ynab.com/v1';
  const YNAB_FLAG_NOT_IN_BANK = 'orange';

  function waitForElement(selector, maxAttempts) {
    maxAttempts = maxAttempts == null ? 50 : maxAttempts;
    return new Promise(function (resolve) {
      var attempts = 0;
      function tick() {
        var el = document.querySelector(selector);
        if (el) {
          resolve(el);
          return;
        }
        attempts += 1;
        if (attempts >= maxAttempts) {
          resolve(null);
          return;
        }
        setTimeout(tick, INTERVAL_MS);
      }
      tick();
    });
  }

  function toCSV(rows, headers) {
    var escape = function (s) {
      var t = String(s == null ? '' : s);
      return t.indexOf('"') !== -1 || t.indexOf(',') !== -1 || t.indexOf('\n') !== -1
        ? '"' + t.replace(/"/g, '""') + '"'
        : t;
    };
    var lines = [headers.map(escape).join(',')];
    for (var i = 0; i < rows.length; i++) {
      var d = rows[i];
      lines.push(headers.map(function (h) { return escape(d[h]); }).join(','));
    }
    return lines.join('\n');
  }

  function downloadCSV(csvContent, filename) {
    var blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function normalizeDate(fechaStr) {
    if (!fechaStr || !String(fechaStr).trim()) return '';
    var s = String(fechaStr).trim();
    var ddmmyyyy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
    var m = s.match(ddmmyyyy);
    if (m) {
      var day = String(parseInt(m[1], 10)).padStart(2, '0');
      var month = String(parseInt(m[2], 10)).padStart(2, '0');
      var year = m[3];
      var d = new Date(year, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
      if (Number.isNaN(d.getTime())) return '';
      return year + '-' + month + '-' + day;
    }
    var d = new Date(s);
    if (Number.isNaN(d.getTime())) return '';
    var y = d.getFullYear();
    var mo = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + mo + '-' + day;
  }

  /**
   * Parse CLP amount string to milliunits. Chilean format: thousands dot, decimal comma; optional "$ ".
   * @param {string} value
   * @param {boolean} isEgreso - true for negative (cargos).
   * @returns {number} milliunits
   */
  function parseMilliunits(value, isEgreso) {
    if (!value || !String(value).trim()) return 0;
    var s = String(value).trim().replace(/\s*\$\s*/g, '').replace(/\./g, '').replace(',', '.');
    var num = parseFloat(s);
    if (Number.isNaN(num)) return 0;
    var milli = Math.round(num * 1000);
    return isEgreso ? -milli : milli;
  }

  /**
   * Parse USD amount string (e.g. "USD$ 14,99") to numeric dollars.
   * @param {string} value
   * @returns {number} dollars
   */
  function parseUSDToNumber(value) {
    if (!value || !String(value).trim()) return 0;
    var s = String(value).trim().replace(/USD\s*\$\s*/gi, '').replace(/,/g, '.');
    var num = parseFloat(s);
    return Number.isNaN(num) ? 0 : num;
  }

  /**
   * Add import_id (and ensure dateNorm, amountMilli) to each movement. Movements must have fecha, dateNorm, amountMilli, movimientos (or descripcion).
   * If amountMilli is missing but cargos/abonos exist, they are parsed (CLP).
   * @param {Array<Object>} datos - rows with at least fecha, and either amountMilli or cargos/abonos, and movimientos or descripcion
   * @param {Object} opts - { normalizeDate: fn, parseMilliunits: fn } optional overrides
   * @returns {Array<Object>} same rows with dateNorm, amountMilli, import_id
   */
  function buildMovimientosWithImportIds(datos, opts) {
    opts = opts || {};
    var norm = opts.normalizeDate || normalizeDate;
    var parse = opts.parseMilliunits || parseMilliunits;
    var countByKey = Object.create(null);
    var result = [];
    for (var i = 0; i < datos.length; i++) {
      var d = datos[i];
      var dateNorm = d.dateNorm != null ? d.dateNorm : norm(d.fecha);
      var amountMilli = d.amountMilli;
      if (amountMilli == null) {
        if (d.cargos) amountMilli = parse(d.cargos, true);
        else if (d.abonos) amountMilli = parse(d.abonos, false);
        else amountMilli = 0;
      }
      var key = dateNorm + ':' + amountMilli;
      countByKey[key] = (countByKey[key] || 0) + 1;
      var occurrence = countByKey[key];
      var import_id = 'YNAB:' + amountMilli + ':' + dateNorm + ':' + occurrence;
      var out = {};
      for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) out[k] = d[k];
      out.dateNorm = dateNorm;
      out.amountMilli = amountMilli;
      out.import_id = import_id;
      result.push(out);
    }
    return result;
  }

  function ynabFetch(accessToken, budgetId, path, options) {
    options = options || {};
    var url = YNAB_API_BASE + path;
    var headers = {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    };
    for (var h in (options.headers || {})) headers[h] = options.headers[h];
    return fetch(url, (function (o) { var r = {}; for (var k in o) if (k !== 'headers') r[k] = o[k]; r.headers = headers; return r; })(options));
  }

  function getYNABTransactions(accessToken, budgetId, accountId, sinceDate, untilDate) {
    var path = '/budgets/' + budgetId + '/transactions?since_date=' + sinceDate;
    return ynabFetch(accessToken, budgetId, path).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { return { transactions: [], error: 'YNAB ' + res.status + ': ' + t }; });
      return res.json().then(function (data) {
        var all = (data.data && data.data.transactions) ? data.data.transactions : [];
        var filtered = all.filter(function (t) { return t.account_id === accountId; });
        var inRange = filtered.filter(function (t) { return t.date >= sinceDate && t.date <= untilDate; });
        return { transactions: inRange, error: null };
      });
    });
  }

  function createYNABTransaction(accessToken, budgetId, tx) {
    var path = '/budgets/' + budgetId + '/transactions';
    var body = { transaction: tx };
    return ynabFetch(accessToken, budgetId, path, { method: 'POST', body: JSON.stringify(body) }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { return { success: false, error: res.status + ': ' + t }; });
      return { success: true, error: null };
    });
  }

  function updateYNABTransaction(accessToken, budgetId, transactionId, updates) {
    var path = '/budgets/' + budgetId + '/transactions/' + transactionId;
    var body = { transaction: updates };
    return ynabFetch(accessToken, budgetId, path, { method: 'PATCH', body: JSON.stringify(body) }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { return { success: false, error: res.status + ': ' + t }; });
      return { success: true, error: null };
    });
  }

  /**
   * Run YNAB sync: create missing transactions, mark "only in YNAB" with flag and memo suffix.
   * @param {Array<Object>} movimientos - must have dateNorm, amountMilli, import_id, movimientos or descripcion (payee), optional memo
   * @param {Object} config - { accessToken, budgetId, accountId, memoSuffix?, skipMarkNotInBank? }
   *   skipMarkNotInBank: if true, skip flagging YNAB transactions not found in bank data (use for paginated tables where DOM shows partial data)
   * @returns {Promise<void>} shows alert with result
   */
  function runSyncYNAB(movimientos, config) {
    var accessToken = config.accessToken;
    var budgetId = config.budgetId;
    var accountId = config.accountId;
    var memoSuffix = config.memoSuffix != null ? config.memoSuffix : ' [No aparece en extracto Itaú]';

    if (String(accessToken).indexOf('insert') !== -1 || String(budgetId).indexOf('insert') !== -1 || String(accountId).indexOf('insert') !== -1) {
      alert('Configura YNAB_ACCESS_TOKEN, YNAB_BUDGET_ID y YNAB_ACCOUNT_ID al inicio del script.');
      return Promise.resolve();
    }

    var fechas = movimientos.map(function (m) { return m.dateNorm; }).filter(Boolean);
    if (fechas.length === 0) {
      alert('No se pudieron normalizar fechas.');
      return Promise.resolve();
    }
    var sinceDate = fechas.reduce(function (a, b) { return a < b ? a : b; });
    var untilDate = fechas.reduce(function (a, b) { return a > b ? a : b; });

    return getYNABTransactions(accessToken, budgetId, accountId, sinceDate, untilDate).then(function (r) {
      var ynabTx = r.transactions;
      var fetchError = r.error;
      if (fetchError) {
        if (fetchError.indexOf('401') !== -1) alert('Token YNAB inválido o revocado.');
        else if (fetchError.indexOf('429') !== -1) alert('Demasiadas peticiones a YNAB. Espera un rato.');
        else alert('Error al obtener transacciones de YNAB: ' + fetchError);
        return;
      }

      var validMovement = function (m) { return Boolean(m.dateNorm && m.amountMilli !== 0); };
      var aCrear;
      if (ynabTx.length === 0) {
        aCrear = movimientos.filter(validMovement);
      } else {
        var existingImportIds = new Set(ynabTx.map(function (t) { return t.import_id; }).filter(Boolean));
        aCrear = movimientos.filter(function (m) { return validMovement(m) && !existingImportIds.has(m.import_id); });
      }

      var created = 0;
      var createErrors = [];
      var createPromises = aCrear.map(function (mov) {
        var payee = (mov.movimientos != null ? mov.movimientos : mov.descripcion) || '(sin descripción)';
        var tx = {
          account_id: accountId,
          date: mov.dateNorm,
          amount: mov.amountMilli,
          payee_name: payee,
          import_id: mov.import_id
        };
        if (mov.memo) tx.memo = mov.memo;
        return createYNABTransaction(accessToken, budgetId, tx).then(function (res) {
          if (res.success) created++;
          else createErrors.push(res.error);
        });
      });

      return Promise.all(createPromises).then(function () {
        if (config.skipMarkNotInBank) {
          var msg = 'Listo. Creadas en YNAB: ' + created + '.';
          if (createErrors.length) msg += ' Errores al crear: ' + createErrors.slice(0, 3).join('; ');
          alert(msg);
          return;
        }

        var bankImportIds = new Set(movimientos.map(function (m) { return m.import_id; }));
        var bankKeys = new Set(movimientos.map(function (m) { return m.dateNorm + ':' + m.amountMilli; }));
        var soloEnYNAB = ynabTx.filter(function (t) {
          if (t.import_id) return !bankImportIds.has(t.import_id);
          var key = t.date + ':' + t.amount;
          return !bankKeys.has(key);
        });

        var marked = 0;
        var markErrors = [];
        var markPromises = soloEnYNAB.map(function (t) {
          var newMemo = (t.memo || '') + memoSuffix;
          return updateYNABTransaction(accessToken, budgetId, t.id, { flag_color: YNAB_FLAG_NOT_IN_BANK, memo: newMemo }).then(function (res) {
            if (res.success) marked++;
            else markErrors.push(res.error);
          });
        });

        return Promise.all(markPromises).then(function () {
          var msg = 'Listo. Creadas en YNAB: ' + created + '. Marcadas (no en extracto): ' + marked + '.';
          if (createErrors.length) msg += ' Errores al crear: ' + createErrors.slice(0, 3).join('; ');
          if (markErrors.length) msg += ' Errores al marcar: ' + markErrors.slice(0, 3).join('; ');
          alert(msg);
        });
      });
    });
  }

  /**
   * Build CSV-ready preview rows reflecting what a YNAB sync would do.
   * Calls the YNAB API to compare bank movements against existing transactions.
   * @param {Array<Object>} movimientos - must have dateNorm, amountMilli, import_id, movimientos or descripcion, optional memo
   * @param {Object} config - { accessToken, budgetId, accountId, memoSuffix?, skipMarkNotInBank? }
   *   skipMarkNotInBank: if true, omit "marcar" rows from preview (use for paginated tables)
   * @returns {Promise<{rows: Array<Object>, error: string|null}>}
   */
  function buildYNABPreviewRows(movimientos, config) {
    var accessToken = config.accessToken;
    var budgetId = config.budgetId;
    var accountId = config.accountId;
    var memoSuffix = config.memoSuffix != null ? config.memoSuffix : ' [No aparece en extracto Itaú]';

    if (String(accessToken).indexOf('insert') !== -1 || String(budgetId).indexOf('insert') !== -1 || String(accountId).indexOf('insert') !== -1) {
      return Promise.resolve({ rows: [], error: 'Configura YNAB_ACCESS_TOKEN, YNAB_BUDGET_ID y YNAB_ACCOUNT_ID al inicio del script.' });
    }

    var fechas = movimientos.map(function (m) { return m.dateNorm; }).filter(Boolean);
    if (fechas.length === 0) return Promise.resolve({ rows: [], error: 'No se pudieron normalizar fechas.' });
    var sinceDate = fechas.reduce(function (a, b) { return a < b ? a : b; });
    var untilDate = fechas.reduce(function (a, b) { return a > b ? a : b; });

    return getYNABTransactions(accessToken, budgetId, accountId, sinceDate, untilDate)
      .then(function (r) {
        if (r.error) return { rows: [], error: r.error };
        var ynabTx = r.transactions;
        var rows = [];

        var existingByImportId = {};
        for (var t = 0; t < ynabTx.length; t++) {
          var tx = ynabTx[t];
          if (tx.import_id) existingByImportId[tx.import_id] = tx;
        }

        var bankImportIds = new Set();
        var bankKeys = new Set();
        for (var i = 0; i < movimientos.length; i++) {
          var m = movimientos[i];
          bankImportIds.add(m.import_id);
          bankKeys.add(m.dateNorm + ':' + m.amountMilli);
          var payee = (m.movimientos != null ? m.movimientos : m.descripcion) || '(sin descripción)';
          var matched = existingByImportId[m.import_id] || null;
          rows.push({
            fecha: m.dateNorm,
            payee: payee,
            monto: m.amountMilli,
            memo: m.memo || '',
            import_id: m.import_id,
            accion: matched ? 'ya existe' : 'crear',
            flag_color: matched ? (matched.flag_color || '') : '',
            marcar: ''
          });
        }

        if (!config.skipMarkNotInBank) {
          var soloEnYNAB = ynabTx.filter(function (t) {
            if (t.import_id) return !bankImportIds.has(t.import_id);
            var key = t.date + ':' + t.amount;
            return !bankKeys.has(key);
          });
          for (var j = 0; j < soloEnYNAB.length; j++) {
            var s = soloEnYNAB[j];
            rows.push({
              fecha: s.date,
              payee: s.payee_name || '',
              monto: s.amount,
              memo: s.memo || '',
              import_id: s.import_id || '',
              accion: 'marcar',
              flag_color: s.flag_color || '',
              marcar: memoSuffix.trim()
            });
          }
        }

        return { rows: rows, error: null };
      });
  }

  /**
   * Inject buttons into one or more containers. Each container: { selector, dataId, linkHtml, linkClass }.
   * @param {Array<{ selector: string, dataId: string, linkHtml: string, linkClass: string }>} containers
   * @param {Function} onClick
   */
  function injectButton(containers, onClick) {
    for (var c = 0; c < containers.length; c++) {
      var cont = containers[c];
      var el = document.querySelector(cont.selector);
      if (!el || el.querySelector('[data-' + cont.dataId + ']')) continue;
      var wrap = document.createElement(cont.wrapTag || 'div');
      if (cont.wrapName) wrap.setAttribute('name', cont.wrapName);
      wrap.setAttribute('data-' + cont.dataId, 'true');
      var link = document.createElement('a');
      link.href = 'javascript:void 0';
      link.className = cont.linkClass;
      if (cont.linkName) link.setAttribute('name', cont.linkName);
      link.innerHTML = cont.linkHtml;
      link.addEventListener('click', function (e) {
        e.preventDefault();
        onClick();
      });
      wrap.appendChild(link);
      el.appendChild(wrap);
    }
  }

  var api = {
    waitForElement: waitForElement,
    toCSV: toCSV,
    downloadCSV: downloadCSV,
    normalizeDate: normalizeDate,
    parseMilliunits: parseMilliunits,
    parseUSDToNumber: parseUSDToNumber,
    buildMovimientosWithImportIds: buildMovimientosWithImportIds,
    getYNABTransactions: getYNABTransactions,
    createYNABTransaction: createYNABTransaction,
    updateYNABTransaction: updateYNABTransaction,
    runSyncYNAB: runSyncYNAB,
    buildYNABPreviewRows: buildYNABPreviewRows,
    injectButton: injectButton
  };

  if (typeof root !== 'undefined') root.BankYNABLib = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
