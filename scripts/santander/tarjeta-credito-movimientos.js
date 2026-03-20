(function (root) {
  'use strict';

  var ACTIONS_ID = 'ynab-santander-tc-actions';
  var LOG_PREFIX = '[Santander TC]';
  var DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
  var BILL_HASH_RE = /Saldos_TC\/main\/bill/;

  /** Detalle que suele ser abono / reducción de deuda (flujo positivo en cuenta tarjeta YNAB). */
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

    if (root.__santanderTcInitDone) {
      warn('init ya se ejecutó en esta pestaña; se ignora.');
      return;
    }
    root.__santanderTcInitDone = true;

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

    /** Iframes cuyo documento aún no existe (carga async); se reengancha en `load`. */
    function wireIframeLoadHooks() {
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        var frame = iframes[i];
        if (frame.getAttribute('data-ynab-santander-iframe-hook')) continue;
        frame.setAttribute('data-ynab-santander-iframe-hook', '1');
        frame.addEventListener(
          'load',
          function () {
            if (!isBillRoute() || hasInjected) return;
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
      if (!isBillRoute() || hasInjected) return;
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
      if (pollTimer || !isBillRoute() || hasInjected) return;
      pollTimer = setInterval(function () {
        if (!isBillRoute()) {
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

    function isBillRoute() {
      return BILL_HASH_RE.test(location.hash || '');
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

    /**
     * Pesos chilenos a milliunits YNAB. Respeta -/$ ; si no hay signo, usa heurística por detalle.
     */
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

    function tableMode(table) {
      var thead = table.querySelector('thead');
      var h = normalizeText(thead ? thead.textContent : table.textContent || '');
      if (h.indexOf('monto cargo') !== -1 || h.indexOf('monto abono') !== -1) return 'cargo-abono';
      return 'single-monto';
    }

    function isSantanderMovimientosTable(table) {
      if (!table || !table.classList || !table.classList.contains('mat-table')) return false;
      var thead = table.querySelector('thead');
      var h = normalizeText(thead ? thead.textContent : '');
      if (h.indexOf('fecha') === -1 || h.indexOf('detalle') === -1) return false;
      if (h.indexOf('monto cargo') !== -1) return true;
      if (h.indexOf('monto abono') !== -1) return true;
      return h.indexOf('monto') !== -1;
    }

    function extractMovimientos(table) {
      var mode = tableMode(table);
      var rows = table.querySelectorAll('tbody tr[mat-row]');
      var lastFecha = '';
      var datos = [];
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var dateEl = row.querySelector('.mat-column-date');
        var dateRaw = dateEl ? String(dateEl.textContent || '').trim() : '';
        if (DATE_RE.test(dateRaw)) lastFecha = dateRaw;
        var fecha = DATE_RE.test(dateRaw) ? dateRaw : lastFecha;
        if (!fecha) {
          warn('Fila sin fecha (sin arrastre previo), se omite:', row.textContent && row.textContent.slice(0, 80));
          continue;
        }
        var detalleEl = row.querySelector('.mat-column-detail');
        var detalle = detalleEl ? String(detalleEl.textContent || '').trim() : '';
        if (!detalle) continue;

        if (mode === 'cargo-abono') {
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
        } else {
          var amtEl = row.querySelector('.mat-column-amount');
          var amtRaw = amtEl ? String(amtEl.textContent || '').trim() : '';
          var amountMilli = parseChilePesoToMilli(amtRaw, detalle);
          datos.push({
            fecha: fecha,
            movimientos: detalle,
            amountMilli: amountMilli
          });
        }
      }
      return datos;
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
      var normalized = datos.map(normalizeRowForImport);
      return Lib.buildMovimientosWithImportIds(normalized);
    }

    function findMovimientosTable() {
      var docs = getSearchDocuments();
      for (var d = 0; d < docs.length; d++) {
        var doc = docs[d];
        var tables = doc.querySelectorAll('table.mat-table');
        for (var i = 0; i < tables.length; i++) {
          if (isSantanderMovimientosTable(tables[i])) {
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
        alert('No se encontró la tabla de movimientos Santander.');
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
      Lib.downloadCSV(csv, 'movimientos-santander-tc-' + dateStr + '.csv');
    }

    async function runSyncYNAB() {
      var match = await getTableOrWarn();
      if (!match) {
        alert('No se encontró la tabla de movimientos Santander.');
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
      link.className = 'ynab-santander-tc-link';
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
        actionsRoot.querySelector('[data-santander-tc-csv]') &&
        actionsRoot.querySelector('[data-santander-tc-ynab]')
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
      injectActionLink(doc, actions, 'santander-tc-csv', 'Descargar CSV', runDownload);
      injectActionLink(doc, actions, 'santander-tc-ynab', 'Sincronizar con YNAB', runSyncYNAB);
      hasInjected = true;
      log('Botones inyectados en', getDocumentLabel(doc), 'filas:', extractMovimientos(table).length);
      return true;
    }

    function tryInject(source) {
      if (!isBillRoute()) return false;
      log('Intento inyección:', source);
      var match = findMovimientosTable();
      if (!match) return false;
      var ok = injectButtons(match.table, match.doc);
      if (ok) stopWatching('inyección (' + source + ')');
      return ok;
    }

    function scheduleRetry(reason) {
      if (!isBillRoute() || hasInjected || scheduledAttempt) return;
      scheduledAttempt = setTimeout(function () {
        scheduledAttempt = null;
        if (!isBillRoute()) return;
        tryInject('mutation:' + reason);
      }, 150);
    }

    /** Observadores + hooks en iframes nuevos + poll (sin tope fijo: hasta inyectar o teardown). */
    function startAsyncWatch() {
      if (!isBillRoute() || hasInjected) return;
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
      if (!isBillRoute()) {
        teardown();
        return;
      }
      log('Vista bill (hash), buscando tabla. accountId:', !!YNAB_ACCOUNT_ID);
      (async function () {
        if (!isBillRoute()) return;
        var match = await waitForMovimientosTable();
        if (!isBillRoute()) return;
        if (match) {
          injectButtons(match.table, match.doc);
          stopWatching('inyección tras espera inicial');
          return;
        }
        warn('Tabla no encontrada al inicio; reintentos y observer.');
        if (document.readyState !== 'complete') {
          window.addEventListener(
            'load',
            function () {
              if (isBillRoute()) tryInject('window.load');
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

  root.SantanderTarjetaCredito = { init: init };
})(window);
