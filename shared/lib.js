/**
 * Shared library for Itaú (and other bank) Tampermonkey scripts.
 * CSV, date/money helpers, YNAB sync, and generic button injection.
 * Use via @require in each script; expose as window.BankYNABLib or use in same scope.
 */
(function (root) {
  'use strict';

  const INTERVAL_MS = 400;
  const YNAB_API_BASE = 'https://api.ynab.com/v1';
  const YNAB_FLAG_DATE_CORRECTED = 'orange';
  const YNAB_FLAG_NOT_IN_BANK = 'red';
  const YNAB_CATEGORY_CACHE = Object.create(null);

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

  function daysBetween(dateA, dateB) {
    var a = new Date(dateA + 'T00:00:00');
    var b = new Date(dateB + 'T00:00:00');
    return Math.round(Math.abs(a - b) / 86400000);
  }

  function shiftDate(dateStr, days) {
    var d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + days);
    var y = d.getFullYear();
    var mo = String(d.getMonth() + 1).padStart(2, '0');
    var dy = String(d.getDate()).padStart(2, '0');
    return y + '-' + mo + '-' + dy;
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
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise(function (resolve, reject) {
        GM_xmlhttpRequest({
          method: options.method || 'GET',
          url: url,
          headers: headers,
          data: options.body,
          responseType: 'text',
          onload: function (res) {
            resolve({
              ok: res.status >= 200 && res.status < 300,
              status: res.status,
              text: function () { return Promise.resolve(res.responseText || ''); },
              json: function () {
                try {
                  return Promise.resolve(JSON.parse(res.responseText || '{}'));
                } catch (e) {
                  return Promise.reject(e);
                }
              }
            });
          },
          onerror: function (err) {
            reject(new Error('GM_xmlhttpRequest failed: ' + ((err && err.error) || 'network error')));
          },
          ontimeout: function () {
            reject(new Error('GM_xmlhttpRequest timed out'));
          }
        });
      });
    }
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

  function chunkArray(arr, size) {
    var chunks = [];
    for (var i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  function createYNABTransaction(accessToken, budgetId, tx) {
    var path = '/budgets/' + budgetId + '/transactions';
    var body = { transaction: tx };
    return ynabFetch(accessToken, budgetId, path, { method: 'POST', body: JSON.stringify(body) }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { return { success: false, error: res.status + ': ' + t }; });
      return { success: true, error: null };
    });
  }

  function createYNABTransactionsBulk(accessToken, budgetId, transactions) {
    if (transactions.length === 0) return Promise.resolve({ success: true, created: 0, duplicates: [], errors: [] });
    var path = '/budgets/' + budgetId + '/transactions';
    var body = { transactions: transactions };
    return ynabFetch(accessToken, budgetId, path, { method: 'POST', body: JSON.stringify(body) }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { return { success: false, created: 0, duplicates: [], errors: [res.status + ': ' + t] }; });
      return res.json().then(function (data) {
        var d = data.data || {};
        var created = Array.isArray(d.transactions) ? d.transactions.length : 0;
        var duplicates = Array.isArray(d.duplicate_import_ids) ? d.duplicate_import_ids : [];
        return { success: true, created: created, duplicates: duplicates, errors: [] };
      });
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

  function updateYNABTransactionsBulk(accessToken, budgetId, updates) {
    if (updates.length === 0) return Promise.resolve({ success: true, updated: 0, errors: [] });
    var path = '/budgets/' + budgetId + '/transactions';
    var body = { transactions: updates };
    return ynabFetch(accessToken, budgetId, path, { method: 'PATCH', body: JSON.stringify(body) }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { return { success: false, updated: 0, errors: [res.status + ': ' + t] }; });
      return res.json().then(function (data) {
        var d = data.data || {};
        var updated = Array.isArray(d.transactions) ? d.transactions.length : 0;
        return { success: true, updated: updated, errors: [] };
      });
    });
  }

  function normalizePayeeKey(value) {
    if (!value || !String(value).trim()) return '';
    var s = String(value).toLowerCase().trim().replace(/\u00a0/g, ' ');
    if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    s = s.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    return s;
  }

  function inferCategory(payeeName) {
    var rules = root.YNABCategoryRules;
    if (!rules) return null;
    var key = normalizePayeeKey(payeeName);
    if (!key) return null;

    var skip = Array.isArray(rules.skip) ? rules.skip : [];
    for (var i = 0; i < skip.length; i++) {
      var skipKey = normalizePayeeKey(skip[i]);
      if (!skipKey) continue;
      if (key === skipKey || key.indexOf(skipKey + ' ') === 0) return null;
    }

    var exact = rules.exact || {};
    if (exact[key]) return exact[key];
    // Fallback: rule keys may be stored in original form (e.g. capitals, punctuation).
    // Normalize each key and match to support manually edited or inconsistently cased rules.
    for (var ruleKey in exact) {
      if (Object.prototype.hasOwnProperty.call(exact, ruleKey) && normalizePayeeKey(ruleKey) === key) {
        return exact[ruleKey];
      }
    }

    var patterns = Array.isArray(rules.patterns) ? rules.patterns : [];
    for (var p = 0; p < patterns.length; p++) {
      var pat = patterns[p];
      if (!pat || !pat.type || !pat.value || !pat.category) continue;
      var value = normalizePayeeKey(pat.value);
      if (!value) continue;
      if (pat.type === 'startsWith' && (key === value || key.indexOf(value + ' ') === 0)) return pat.category;
      if (pat.type === 'contains' && key.indexOf(value) !== -1) return pat.category;
    }
    return null;
  }

  function getYNABCategories(accessToken, budgetId) {
    if (YNAB_CATEGORY_CACHE[budgetId]) {
      return Promise.resolve({ map: YNAB_CATEGORY_CACHE[budgetId], error: null });
    }
    var path = '/budgets/' + budgetId + '/categories';
    return ynabFetch(accessToken, budgetId, path).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          return { map: null, error: 'YNAB ' + res.status + ': ' + t };
        });
      }
      return res.json().then(function (data) {
        var groups = (data.data && data.data.category_groups) ? data.data.category_groups : [];
        var map = {};
        for (var gi = 0; gi < groups.length; gi++) {
          var g = groups[gi];
          if (!g || g.deleted) continue;
          var cats = Array.isArray(g.categories) ? g.categories : [];
          for (var ci = 0; ci < cats.length; ci++) {
            var c = cats[ci];
            if (!c || c.deleted || !c.id || !c.name) continue;
            var fullName = g.name + ': ' + c.name;
            map[fullName] = c.id;
          }
        }
        YNAB_CATEGORY_CACHE[budgetId] = map;
        return { map: map, error: null };
      });
    });
  }

  /**
   * Run YNAB sync: create missing transactions, mark "only in YNAB" with flag and memo suffix.
   * @param {Array<Object>} movimientos - must have dateNorm, amountMilli, import_id, movimientos or descripcion (payee), optional memo
   * @param {Object} config - { accessToken, budgetId, accountId, memoSuffix?, skipMarkNotInBank?, fuzzyDateDays?, skipMarkAfterDate? }
   *   skipMarkNotInBank: if true, skip flagging YNAB transactions not found in bank data (use for paginated tables where DOM shows partial data)
   *   fuzzyDateDays: max days offset for fuzzy date matching on manual YNAB entries (default 7, 0 to disable)
   *   skipMarkAfterDate: if set (YYYY-MM-DD), skip marking YNAB transactions with date > this value (use for facturado where recent transactions aren't billed yet)
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
    var fuzzyDays = config.fuzzyDateDays != null ? config.fuzzyDateDays : 7;
    var apiSinceDate = fuzzyDays > 0 ? shiftDate(sinceDate, -fuzzyDays) : sinceDate;
    var apiUntilDate = fuzzyDays > 0 ? shiftDate(untilDate, fuzzyDays) : untilDate;

    return getYNABTransactions(accessToken, budgetId, accountId, apiSinceDate, apiUntilDate).then(function (r) {
      var ynabTx = r.transactions;
      var fetchError = r.error;
      if (fetchError) {
        if (fetchError.indexOf('401') !== -1) alert('Token YNAB inválido o revocado.');
        else if (fetchError.indexOf('429') !== -1) alert('Demasiadas peticiones a YNAB. Espera un rato.');
        else alert('Error al obtener transacciones de YNAB: ' + fetchError);
        return;
      }

      var validMovement = function (m) { return Boolean(m.dateNorm && m.amountMilli !== 0); };
      var matchedYnabIds = new Set();
      var fuzzyUpdates = [];
      var aCrear;
      if (ynabTx.length === 0) {
        aCrear = movimientos.filter(validMovement);
      } else {
        var existingByImportId = {};
        var ynabByKey = {};
        var ynabByAmount = {};
        for (var ti = 0; ti < ynabTx.length; ti++) {
          var txn = ynabTx[ti];
          if (txn.import_id) {
            existingByImportId[txn.import_id] = txn;
          } else {
            var tk = txn.date + ':' + txn.amount;
            if (!ynabByKey[tk]) ynabByKey[tk] = [];
            ynabByKey[tk].push(txn);
            var amtK = String(txn.amount);
            if (!ynabByAmount[amtK]) ynabByAmount[amtK] = [];
            ynabByAmount[amtK].push(txn);
          }
        }
        var exactMatched = new Set();
        for (var mi = 0; mi < movimientos.length; mi++) {
          var m = movimientos[mi];
          if (!validMovement(m)) continue;
          var byImport = existingByImportId[m.import_id];
          if (byImport) {
            matchedYnabIds.add(byImport.id);
            exactMatched.add(mi);
            continue;
          }
          var fbArr = ynabByKey[m.dateNorm + ':' + m.amountMilli];
          if (fbArr) {
            for (var fi = 0; fi < fbArr.length; fi++) {
              if (!matchedYnabIds.has(fbArr[fi].id)) {
                matchedYnabIds.add(fbArr[fi].id);
                exactMatched.add(mi);
                break;
              }
            }
          }
        }

        if (fuzzyDays > 0) {
          for (var mi = 0; mi < movimientos.length; mi++) {
            if (exactMatched.has(mi)) continue;
            var m = movimientos[mi];
            if (!validMovement(m)) continue;
            var candidates = ynabByAmount[String(m.amountMilli)];
            if (candidates) {
              var best = null, bestDist = Infinity;
              for (var ci = 0; ci < candidates.length; ci++) {
                if (matchedYnabIds.has(candidates[ci].id)) continue;
                var dist = daysBetween(m.dateNorm, candidates[ci].date);
                if (dist > 0 && dist <= fuzzyDays && dist < bestDist) {
                  bestDist = dist;
                  best = candidates[ci];
                }
              }
              if (best) {
                matchedYnabIds.add(best.id);
                exactMatched.add(mi);
                fuzzyUpdates.push({ id: best.id, newDate: m.dateNorm, existingFlag: best.flag_color || null });
              }
            }
          }
        }

        aCrear = movimientos.filter(function (m, idx) {
          if (!validMovement(m)) return false;
          return !exactMatched.has(idx);
        });
      }

      return getYNABCategories(accessToken, budgetId).then(function (catRes) {
        var categoryMap = (catRes && catRes.map) ? catRes.map : null;
        if (catRes && catRes.error) {
          // Category inference is best-effort; sync continues even if category fetch fails.
          console.warn('[BankYNABLib] No se pudieron cargar categorías de YNAB:', catRes.error);
        }

        var transactionsToCreate = aCrear.map(function (mov) {
          var payee = (mov.movimientos != null ? mov.movimientos : mov.descripcion) || '(sin descripción)';
          var tx = {
            account_id: accountId,
            date: mov.dateNorm,
            amount: mov.amountMilli,
            payee_name: payee,
            import_id: mov.import_id
          };
          if (mov.memo) tx.memo = mov.memo;
          if (mov.category_id) tx.category_id = mov.category_id;
          if (!tx.category_id && categoryMap) {
            var inferredCategory = inferCategory(payee);
            if (inferredCategory && categoryMap[inferredCategory]) {
              tx.category_id = categoryMap[inferredCategory];
            }
          }
          return tx;
        });

        var created = 0;
        var createDuplicates = 0;
        var createErrors = [];
        var createChunks = chunkArray(transactionsToCreate, 50);

        var createChainPromise = createChunks.reduce(function (chain, chunk) {
          return chain.then(function () {
            return createYNABTransactionsBulk(accessToken, budgetId, chunk).then(function (res) {
              if (res.success) {
                created += res.created;
                createDuplicates += res.duplicates.length;
              } else {
                createErrors = createErrors.concat(res.errors);
              }
            });
          });
        }, Promise.resolve());

        return createChainPromise.then(function () {
        var corrected = 0;
        var marked = 0;
        var updateErrors = [];

        var patchPayload = [];

        fuzzyUpdates.forEach(function (u) {
          var patch = { id: u.id, date: u.newDate };
          if (!u.existingFlag) patch.flag_color = YNAB_FLAG_DATE_CORRECTED;
          patch._type = 'fuzzy';
          patchPayload.push(patch);
        });

        if (!config.skipMarkNotInBank) {
          var soloEnYNAB = ynabTx.filter(function (t) {
            if (config.skipReconciled && t.cleared === 'reconciled') return false;
            if (config.skipMarkAfterDate && t.date > config.skipMarkAfterDate) return false;
            return !matchedYnabIds.has(t.id);
          });
          soloEnYNAB.forEach(function (t) {
            var newMemo = (t.memo || '') + memoSuffix;
            var patch = { id: t.id, memo: newMemo };
            if (!t.flag_color) patch.flag_color = YNAB_FLAG_NOT_IN_BANK;
            patch._type = 'mark';
            patchPayload.push(patch);
          });
        }

        var updateChunks = chunkArray(patchPayload, 50);
        var updateChainPromise = updateChunks.reduce(function (chain, chunk) {
          return chain.then(function () {
            var chunkFuzzyCount = 0;
            var chunkMarkCount = 0;
            var cleanChunk = chunk.map(function (p) {
              if (p._type === 'fuzzy') chunkFuzzyCount++;
              else if (p._type === 'mark') chunkMarkCount++;
              var clean = {};
              for (var k in p) if (k !== '_type') clean[k] = p[k];
              return clean;
            });
            return updateYNABTransactionsBulk(accessToken, budgetId, cleanChunk).then(function (res) {
              if (res.success) {
                corrected += chunkFuzzyCount;
                marked += chunkMarkCount;
              } else {
                updateErrors = updateErrors.concat(res.errors);
              }
            });
          });
        }, Promise.resolve());

        return updateChainPromise.then(function () {
          var msg = 'Listo. Creadas: ' + created + '.';
          if (createDuplicates > 0) msg += ' Duplicadas (omitidas): ' + createDuplicates + '.';
          if (corrected > 0) msg += ' Fechas corregidas: ' + corrected + '.';
          if (!config.skipMarkNotInBank) msg += ' Marcadas (no en extracto): ' + marked + '.';
          if (createErrors.length) msg += ' Errores al crear: ' + createErrors.slice(0, 3).join('; ');
          if (updateErrors.length) msg += ' Errores al actualizar: ' + updateErrors.slice(0, 3).join('; ');
          alert(msg);
        });
      });
      });
    }).catch(function (err) {
      alert('Error de red al contactar YNAB: ' + (err.message || String(err)));
    });
  }

  /**
   * Build CSV-ready preview rows reflecting what a YNAB sync would do.
   * Calls the YNAB API to compare bank movements against existing transactions.
   * @param {Array<Object>} movimientos - must have dateNorm, amountMilli, import_id, movimientos or descripcion, optional memo
   * @param {Object} config - { accessToken, budgetId, accountId, memoSuffix?, skipMarkNotInBank?, skipReconciled?, fuzzyDateDays?, skipMarkAfterDate? }
   *   skipMarkNotInBank: if true, omit "marcar" rows from preview (use for paginated tables)
   *   skipReconciled: if true, ignore reconciled YNAB transactions when building "marcar" rows
   *   fuzzyDateDays: max days offset for fuzzy date matching on manual YNAB entries (default 7, 0 to disable)
   *   skipMarkAfterDate: if set (YYYY-MM-DD), skip marking YNAB transactions with date > this value (use for facturado where recent transactions aren't billed yet)
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
    var fuzzyDays = config.fuzzyDateDays != null ? config.fuzzyDateDays : 7;
    var apiSinceDate = fuzzyDays > 0 ? shiftDate(sinceDate, -fuzzyDays) : sinceDate;
    var apiUntilDate = fuzzyDays > 0 ? shiftDate(untilDate, fuzzyDays) : untilDate;

    return getYNABTransactions(accessToken, budgetId, accountId, apiSinceDate, apiUntilDate)
      .then(function (r) {
        if (r.error) return { rows: [], error: r.error };
        var ynabTx = r.transactions;
        var rows = [];

        var existingByImportId = {};
        var ynabByKey = {};
        var ynabByAmount = {};
        for (var t = 0; t < ynabTx.length; t++) {
          var tx = ynabTx[t];
          if (tx.import_id) {
            existingByImportId[tx.import_id] = tx;
          } else {
            var txKey = tx.date + ':' + tx.amount;
            if (!ynabByKey[txKey]) ynabByKey[txKey] = [];
            ynabByKey[txKey].push(tx);
            var amtKey = String(tx.amount);
            if (!ynabByAmount[amtKey]) ynabByAmount[amtKey] = [];
            ynabByAmount[amtKey].push(tx);
          }
        }

        var matchedYnabIds = new Set();
        var matchResults = [];
        for (var i = 0; i < movimientos.length; i++) matchResults.push(null);

        for (var i = 0; i < movimientos.length; i++) {
          var m = movimientos[i];
          var matched = existingByImportId[m.import_id] || null;
          if (matched) {
            matchedYnabIds.add(matched.id);
            matchResults[i] = { matched: matched, fuzzy: false };
            continue;
          }
          var fbArr = ynabByKey[m.dateNorm + ':' + m.amountMilli];
          if (fbArr) {
            for (var fi = 0; fi < fbArr.length; fi++) {
              if (!matchedYnabIds.has(fbArr[fi].id)) {
                matchedYnabIds.add(fbArr[fi].id);
                matchResults[i] = { matched: fbArr[fi], fuzzy: false };
                break;
              }
            }
          }
        }

        if (fuzzyDays > 0) {
          for (var i = 0; i < movimientos.length; i++) {
            if (matchResults[i]) continue;
            var m = movimientos[i];
            var candidates = ynabByAmount[String(m.amountMilli)];
            if (candidates) {
              var best = null, bestDist = Infinity;
              for (var ci = 0; ci < candidates.length; ci++) {
                if (matchedYnabIds.has(candidates[ci].id)) continue;
                var dist = daysBetween(m.dateNorm, candidates[ci].date);
                if (dist > 0 && dist <= fuzzyDays && dist < bestDist) {
                  bestDist = dist;
                  best = candidates[ci];
                }
              }
              if (best) {
                matchedYnabIds.add(best.id);
                matchResults[i] = { matched: best, fuzzy: true };
              }
            }
          }
        }

        for (var i = 0; i < movimientos.length; i++) {
          var m = movimientos[i];
          var payee = (m.movimientos != null ? m.movimientos : m.descripcion) || '(sin descripción)';
          var inferredCategory = inferCategory(payee);
          var result = matchResults[i];
          var matched = result ? result.matched : null;
          var fuzzyMatched = result ? result.fuzzy : false;
          var accion = matched
            ? (fuzzyMatched ? 'corregir fecha (YNAB: ' + matched.date + ')' : 'ya existe')
            : 'crear';
          var rowFlagColor = matched
            ? (matched.flag_color || (fuzzyMatched ? 'orange' : ''))
            : '';
          rows.push({
            fecha: m.dateNorm,
            payee: payee,
            monto: m.amountMilli,
            memo: m.memo || '',
            import_id: m.import_id,
            categoria_inferida: inferredCategory || '',
            accion: accion,
            flag_color: rowFlagColor,
            marcar: ''
          });
        }

        if (!config.skipMarkNotInBank) {
          var soloEnYNAB = ynabTx.filter(function (t) {
            if (config.skipReconciled && t.cleared === 'reconciled') return false;
            if (config.skipMarkAfterDate && t.date > config.skipMarkAfterDate) return false;
            return !matchedYnabIds.has(t.id);
          });
          for (var j = 0; j < soloEnYNAB.length; j++) {
            var s = soloEnYNAB[j];
            rows.push({
              fecha: s.date,
              payee: s.payee_name || '',
              monto: s.amount,
              memo: s.memo || '',
              import_id: s.import_id || '',
              categoria_inferida: '',
              accion: 'marcar',
              flag_color: s.flag_color || 'red',
              marcar: memoSuffix.trim()
            });
          }
        }

        return { rows: rows, error: null };
      })
      .catch(function (err) {
        return { rows: [], error: 'Error de red: ' + (err.message || String(err)) };
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
    chunkArray: chunkArray,
    getYNABTransactions: getYNABTransactions,
    createYNABTransaction: createYNABTransaction,
    createYNABTransactionsBulk: createYNABTransactionsBulk,
    updateYNABTransaction: updateYNABTransaction,
    updateYNABTransactionsBulk: updateYNABTransactionsBulk,
    inferCategory: inferCategory,
    getYNABCategories: getYNABCategories,
    runSyncYNAB: runSyncYNAB,
    buildYNABPreviewRows: buildYNABPreviewRows,
    injectButton: injectButton
  };

  if (typeof root !== 'undefined') root.BankYNABLib = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);