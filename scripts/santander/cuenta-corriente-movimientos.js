(function (root) {
  'use strict';

  var ACTIONS_ID = 'ynab-santander-cc-actions';
  var LOG_PREFIX = '[Santander CC]';
  var DATE_RE_FULL = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
  var DATE_RE_SHORT = /^(\d{1,2})\/(\d{1,2})$/;
  var MOVIMIENTOS_HASH_RE = /saldos\/main\/movimientos/i;
  var IFRAME_HOOK_ATTR = 'data-ynab-santander-cc-iframe-hook';

  /** Detalle que suele ser abono (misma heurística que TC para parseChilePesoToMilli). */
  var CREDIT_DETAIL_KEYWORDS = [
    'PAGO',
    'MONTO CANCELADO',
    'ABONO',
    'DEVOLUCION',
    'DEVOLUCIÓN',
    'NOTA DE CREDITO',
    'NOTA DE CRÉDITO',
    'REEMBOLSO'
  ];

  function init(config) {
    var Lib = root.BankYNABLib;
    if (!Lib) {
      console.error(LOG_PREFIX + ' No se cargó BankYNABLib.');
      return;
    }

    if (root.__santanderCcMovsInitDone) {
      warn('init ya se ejecutó en esta pestaña; se ignora.');
      return;
    }
    root.__santanderCcMovsInitDone = true;

    config = config || {};
    var YNAB_ACCESS_TOKEN = config.accessToken || '<insert ynab token here>';
    var YNAB_BUDGET_ID = config.budgetId || '<insert budget id here>';
    var YNAB_ACCOUNT_ID = config.accountId || '<insert account id here>';

    var observers = [];
    var pollTimer = null;
    var scheduledAttempt = null;
    var hasInjected = false;
    var observedDocuments = [];

    var WAIT_ATTEMPTS = 120;
    var WAIT_MS = 400;
    var POLL_MS = 2000;

    function log() {
      var a = Array.prototype.slice.call(arguments);
      a.unshift(LOG_PREFIX);
      console.log.apply(console, a);
    }

    function warn() {
      var a = Array.prototype.slice.call(arguments);
      a.unshift(LOG_PREFIX);
      console.warn.apply(console, a);
    }

    function normalizeText(value) {
      return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    }

    var EXTRACT_IGNORED_DETAIL_NORMALIZED = ['saldo inicial'];

    function isExtractIgnoredDetail(detail) {
      var n = normalizeText(detail).replace(/\.+$/g, '').trim();
      return EXTRACT_IGNORED_DETAIL_NORMALIZED.indexOf(n) !== -1;
    }

    function getDocumentLabel(doc) {
      if (!doc) return 'unknown';
      if (doc === document) return 'top';
      try {
        if (doc.defaultView && doc.defaultView.frameElement) {
          var frame = doc.defaultView.frameElement;
          return 'iframe#' + (frame.id || '(sin-id)');
        }
      } catch (e) {
        return 'iframe(inaccesible)';
      }
      return 'other-document';
    }

    function getSearchDocuments() {
      var docs = [document];
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        try {
          var iframeDoc = iframes[i].contentDocument;
          if (iframeDoc) docs.push(iframeDoc);
        } catch (e) {
          warn('No se pudo acceder a iframe #' + (i + 1) + ':', e && e.message ? e.message : e);
        }
      }
      return docs;
    }

    function wireIframeLoadHooks() {
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        var frame = iframes[i];
        if (frame.getAttribute(IFRAME_HOOK_ATTR)) continue;
        frame.setAttribute(IFRAME_HOOK_ATTR, '1');
        frame.addEventListener(
          'load',
          function () {
            if (!isMovimientosRoute() || hasInjected) return;
            setTimeout(function () {
              tryInject('iframe-load');
              observeNewDocuments();
            }, 200);
          },
          { capture: false }
        );
      }
    }

    function observeNewDocuments() {
      if (!isMovimientosRoute() || hasInjected) return;
      var docs = getSearchDocuments();
      for (var d = 0; d < docs.length; d++) {
        var doc = docs[d];
        if (observedDocuments.indexOf(doc) !== -1) continue;
        if (!doc.body) continue;
        var observer = new MutationObserver(function (mutations) {
          for (var i = 0; i < mutations.length; i++) {
            if (mutations[i].addedNodes && mutations[i].addedNodes.length) {
              wireIframeLoadHooks();
              scheduleRetry('addedNodes');
              return;
            }
          }
        });
        observer.observe(doc.body, { childList: true, subtree: true });
        observers.push(observer);
        observedDocuments.push(doc);
        log('MutationObserver en', getDocumentLabel(doc));
      }
    }

    function startPoll() {
      if (pollTimer || !isMovimientosRoute() || hasInjected) return;
      pollTimer = setInterval(function () {
        if (!isMovimientosRoute()) {
          clearInterval(pollTimer);
          pollTimer = null;
          return;
        }
        if (hasInjected) {
          clearInterval(pollTimer);
          pollTimer = null;
          return;
        }
        wireIframeLoadHooks();
        observeNewDocuments();
        tryInject('interval-poll');
      }, POLL_MS);
      log('Polling cada', POLL_MS / 1000, 's hasta encontrar tabla o salir de la vista');
    }

    function stopPoll() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function isMovimientosRoute() {
      return MOVIMIENTOS_HASH_RE.test(location.hash || '');
    }

    function removeActionsFromAllDocs() {
      var docs = getSearchDocuments();
      for (var i = 0; i < docs.length; i++) {
        var el = docs[i].getElementById(ACTIONS_ID);
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }
    }

    function isCreditDetail(detail) {
      var n = normalizeText(detail);
      for (var i = 0; i < CREDIT_DETAIL_KEYWORDS.length; i++) {
        if (n.indexOf(normalizeText(CREDIT_DETAIL_KEYWORDS[i])) !== -1) return true;
      }
      return false;
    }

    function parseChilePesoToMilli(raw, detail) {
      var s = String(raw || '').trim();
      if (!s) return 0;
      var explicitNeg = /^[\s]*-/.test(s) || /-\s*\$/.test(s) || /\$\s*-\s*\d/.test(s);
      var explicitPos = /\+/.test(s);
      var absStr = s.replace(/\+/g, '').replace(/^[\s-]+/, '').replace(/-\s*\$/g, '$').trim();
      var milliPos = Lib.parseMilliunits(absStr, false);
      var milli = Math.abs(milliPos);
      if (explicitNeg) return -milli;
      if (explicitPos) return milli;
      if (isCreditDetail(detail)) return milli;
      return -milli;
    }

    /** Tabla de movimientos de cuenta corriente: incluye columna Saldo (no presente en TC). */
    function isSantanderCcMovimientosTable(table) {
      if (!table || !table.classList || !table.classList.contains('mat-table')) return false;
      var thead = table.querySelector('thead');
      var h = normalizeText(thead ? thead.textContent : '');
      if (h.indexOf('fecha') === -1 || h.indexOf('detalle') === -1) return false;
      if (h.indexOf('saldo') === -1) return false;
      if (h.indexOf('monto cargo') === -1 && h.indexOf('monto abono') === -1) return false;
      return true;
    }

    function isDateToken(raw) {
      return DATE_RE_FULL.test(raw) || DATE_RE_SHORT.test(raw);
    }

    function extractMovimientos(table) {
      var rows = table.querySelectorAll('tbody tr[mat-row]');
      var lastFecha = '';
      var datos = [];
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var dateEl = row.querySelector('.mat-column-date');
        var dateRaw = dateEl ? String(dateEl.textContent || '').trim() : '';
        if (isDateToken(dateRaw)) lastFecha = dateRaw;
        var fecha = isDateToken(dateRaw) ? dateRaw : lastFecha;
        if (!fecha) {
          warn('Fila sin fecha (sin arrastre previo), se omite:', row.textContent && row.textContent.slice(0, 80));
          continue;
        }
        var detalleEl = row.querySelector('.mat-column-detail');
        var detalle = detalleEl ? String(detalleEl.textContent || '').trim() : '';
        if (!detalle) continue;
        if (isExtractIgnoredDetail(detalle)) continue;

        var cargoEl = row.querySelector('.mat-column-amountCharge');
        var abonoEl = row.querySelector('.mat-column-paymentAmount');
        var cargo = cargoEl ? String(cargoEl.textContent || '').trim() : '';
        var abono = abonoEl ? String(abonoEl.textContent || '').trim() : '';
        datos.push({
          fecha: fecha,
          movimientos: detalle,
          cargos: cargo,
          abonos: abono
        });
      }
      return datos;
    }

    function pad2(n) {
      return String(n).length < 2 ? '0' + n : String(n);
    }

    /**
     * El listado va de más reciente a más antiguo (~40 días). Fechas en DOM suelen ser DD/MM sin año.
     */
    function expandShortFechas(datos) {
      if (!datos || datos.length === 0) return;
      var now = new Date();
      var capEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      var lastMs = null;
      var minYear = now.getFullYear() - 1;

      for (var i = 0; i < datos.length; i++) {
        var raw = String(datos[i].fecha || '').trim();
        var mFull = raw.match(DATE_RE_FULL);
        if (mFull) {
          var yf = parseInt(mFull[3], 10);
          var mf = parseInt(mFull[2], 10);
          var df = parseInt(mFull[1], 10);
          lastMs = new Date(yf, mf - 1, df, 12, 0, 0, 0).getTime();
          continue;
        }
        var mShort = raw.match(DATE_RE_SHORT);
        if (!mShort) continue;
        var d = parseInt(mShort[1], 10);
        var mo = parseInt(mShort[2], 10);
        var y = now.getFullYear();
        var t = new Date(y, mo - 1, d, 12, 0, 0, 0);
        while (t.getTime() > capEnd.getTime() && y > minYear) {
          y -= 1;
          t = new Date(y, mo - 1, d, 12, 0, 0, 0);
        }
        if (lastMs != null) {
          while (t.getTime() > lastMs && y > minYear) {
            y -= 1;
            t = new Date(y, mo - 1, d, 12, 0, 0, 0);
          }
        }
        lastMs = t.getTime();
        datos[i].fecha = pad2(d) + '/' + pad2(mo) + '/' + y;
      }
    }

    function normalizeRowForImport(d) {
      if (d.amountMilli != null) return d;
      var cargo = d.cargos || '';
      var abono = d.abonos || '';
      var amountMilli;
      if (cargo && abono) {
        amountMilli = parseChilePesoToMilli(cargo, d.movimientos);
        if (amountMilli === 0) amountMilli = parseChilePesoToMilli(abono, d.movimientos);
      } else if (cargo) {
        amountMilli = parseChilePesoToMilli(cargo, d.movimientos);
      } else if (abono) {
        amountMilli = parseChilePesoToMilli(abono, d.movimientos);
        if (amountMilli < 0) amountMilli = -amountMilli;
      } else {
        amountMilli = 0;
      }
      var copy = {};
      for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) copy[k] = d[k];
      copy.amountMilli = amountMilli;
      return copy;
    }

    function buildMovimientosWithIds(datos) {
      var copy = datos.map(function (row) {
        var o = {};
        for (var k in row) if (Object.prototype.hasOwnProperty.call(row, k)) o[k] = row[k];
        return o;
      });
      expandShortFechas(copy);
      var normalized = copy.map(normalizeRowForImport);
      return Lib.buildMovimientosWithImportIds(normalized);
    }

    function findMovimientosTable() {
      var docs = getSearchDocuments();
      for (var d = 0; d < docs.length; d++) {
        var doc = docs[d];
        var tables = doc.querySelectorAll('table.mat-table');
        for (var i = 0; i < tables.length; i++) {
          if (isSantanderCcMovimientosTable(tables[i])) {
            return { table: tables[i], doc: doc };
          }
        }
      }
      return null;
    }

    function waitForMovimientosTable() {
      var attempts = 0;
      return new Promise(function (resolve) {
        function tick() {
          wireIframeLoadHooks();
          var match = findMovimientosTable();
          if (match) {
            resolve(match);
            return;
          }
          attempts += 1;
          if (attempts >= WAIT_ATTEMPTS) {
            warn(
              'Tras',
              attempts * WAIT_MS / 1000,
              's no hay tabla; se sigue observando DOM + polling (carga async / iframes).'
            );
            resolve(null);
            return;
          }
          setTimeout(tick, WAIT_MS);
        }
        tick();
      });
    }

    function ensureActionsContainer(table, doc) {
      var existing = doc.getElementById(ACTIONS_ID);
      if (existing) return existing;
      var wrapper = doc.createElement('div');
      wrapper.id = ACTIONS_ID;
      wrapper.style.cssText = 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:8px 0 12px;padding:4px 0;';
      var parent = table.parentNode;
      if (!parent) return null;
      if (table.nextSibling) parent.insertBefore(wrapper, table.nextSibling);
      else parent.appendChild(wrapper);
      return wrapper;
    }

    async function getTableOrWarn() {
      var match = findMovimientosTable();
      if (!match) {
        warn('No se encontró la tabla de movimientos.');
        return null;
      }
      return match;
    }

    async function runDownload() {
      var match = await getTableOrWarn();
      if (!match) {
        alert('No se encontró la tabla de movimientos Santander (cuenta corriente).');
        return;
      }
      var datos = extractMovimientos(match.table);
      if (datos.length === 0) {
        alert('No hay movimientos en la tabla.');
        return;
      }
      var movimientos = buildMovimientosWithIds(datos);
      var result = await Lib.buildYNABPreviewRows(movimientos, {
        accessToken: YNAB_ACCESS_TOKEN,
        budgetId: YNAB_BUDGET_ID,
        accountId: YNAB_ACCOUNT_ID,
        skipMarkNotInBank: true
      });
      if (result.error) {
        alert('Error al obtener datos de YNAB: ' + result.error);
        return;
      }
      var headers = ['fecha', 'payee', 'monto', 'memo', 'import_id', 'categoria_inferida', 'accion', 'flag_color', 'marcar'];
      var csv = Lib.toCSV(result.rows, headers);
      var dateStr = new Date().toISOString().slice(0, 10);
      Lib.downloadCSV(csv, 'movimientos-santander-cc-' + dateStr + '.csv');
    }

    async function runSyncYNAB() {
      var match = await getTableOrWarn();
      if (!match) {
        alert('No se encontró la tabla de movimientos Santander (cuenta corriente).');
        return;
      }
      var datos = extractMovimientos(match.table);
      if (datos.length === 0) {
        alert('No hay movimientos en la tabla.');
        return;
      }
      var movimientos = buildMovimientosWithIds(datos);
      await Lib.runSyncYNAB(movimientos, {
        accessToken: YNAB_ACCESS_TOKEN,
        budgetId: YNAB_BUDGET_ID,
        accountId: YNAB_ACCOUNT_ID,
        skipMarkNotInBank: true
      });
    }

    function injectActionLink(doc, containerEl, dataId, html, handler) {
      if (!containerEl || containerEl.querySelector('[data-' + dataId + ']')) return;
      var wrap = doc.createElement('span');
      wrap.setAttribute('data-' + dataId, 'true');
      var link = doc.createElement('a');
      link.href = 'javascript:void(0)';
      link.className = 'ynab-santander-cc-link';
      link.innerHTML = html;
      link.style.cssText =
        'cursor:pointer;color:#ec0000;text-decoration:underline;font-size:14px;margin-right:8px;';
      link.addEventListener('click', function (e) {
        e.preventDefault();
        handler();
      });
      wrap.appendChild(link);
      containerEl.appendChild(wrap);
    }

    function injectButtons(table, doc) {
      doc = doc || document;
      var actionsRoot = doc.getElementById(ACTIONS_ID);
      if (
        actionsRoot &&
        actionsRoot.querySelector('[data-santander-cc-csv]') &&
        actionsRoot.querySelector('[data-santander-cc-ynab]')
      ) {
        hasInjected = true;
        log('Botones ya inyectados en', getDocumentLabel(doc));
        return true;
      }
      var actions = ensureActionsContainer(table, doc);
      if (!actions) {
        warn('No fue posible crear contenedor de acciones.');
        return false;
      }
      injectActionLink(doc, actions, 'santander-cc-csv', 'Descargar CSV', runDownload);
      injectActionLink(doc, actions, 'santander-cc-ynab', 'Sincronizar con YNAB', runSyncYNAB);
      hasInjected = true;
      log('Botones inyectados en', getDocumentLabel(doc), 'filas:', extractMovimientos(table).length);
      return true;
    }

    function tryInject(source) {
      if (!isMovimientosRoute()) return false;
      log('Intento inyección:', source);
      var match = findMovimientosTable();
      if (!match) return false;
      var ok = injectButtons(match.table, match.doc);
      if (ok) stopWatching('inyección (' + source + ')');
      return ok;
    }

    function scheduleRetry(reason) {
      if (!isMovimientosRoute() || hasInjected || scheduledAttempt) return;
      scheduledAttempt = setTimeout(function () {
        scheduledAttempt = null;
        if (!isMovimientosRoute()) return;
        tryInject('mutation:' + reason);
      }, 150);
    }

    function startAsyncWatch() {
      if (!isMovimientosRoute() || hasInjected) return;
      wireIframeLoadHooks();
      observeNewDocuments();
      startPoll();
    }

    function stopWatching(reason) {
      for (var i = 0; i < observers.length; i++) observers[i].disconnect();
      observers = [];
      stopPoll();
      if (scheduledAttempt) {
        clearTimeout(scheduledAttempt);
        scheduledAttempt = null;
      }
      if (reason) log('Watch detenido:', reason);
    }

    function teardown() {
      removeActionsFromAllDocs();
      stopWatching('');
      hasInjected = false;
      scheduledAttempt = null;
      observedDocuments = [];
    }

    function applyRoute() {
      if (!isMovimientosRoute()) {
        teardown();
        return;
      }
      log('Vista movimientos CC (hash), buscando tabla. accountId:', !!YNAB_ACCOUNT_ID);
      (async function () {
        if (!isMovimientosRoute()) return;
        var match = await waitForMovimientosTable();
        if (!isMovimientosRoute()) return;
        if (match) {
          if (injectButtons(match.table, match.doc)) {
            stopWatching('inyección tras espera inicial');
            return;
          }
          warn('Tabla encontrada pero no se pudo inyectar botones; se mantiene poll/observers.');
        } else {
          warn('Tabla no encontrada al inicio; reintentos y observer.');
        }
        if (document.readyState !== 'complete') {
          window.addEventListener(
            'load',
            function () {
              if (isMovimientosRoute()) tryInject('window.load');
            },
            { once: true }
          );
        }
        tryInject('boot-fallback');
        startAsyncWatch();
      })();
    }

    window.addEventListener('hashchange', function () {
      setTimeout(applyRoute, 0);
    });
    window.addEventListener('popstate', function () {
      setTimeout(applyRoute, 0);
    });
    applyRoute();
  }

  root.SantanderCuentaCorrienteMovimientos = { init: init };
})(window);
