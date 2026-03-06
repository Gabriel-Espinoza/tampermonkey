(function (root) {
  'use strict';

  function init(config) {
    var Lib = root.BankYNABLib;
    if (!Lib) {
      console.error('[BCI cuenta corriente] No se cargo BankYNABLib.');
      return;
    }

    config = config || {};
    var YNAB_ACCESS_TOKEN = config.accessToken || '<insert ynab token here>';
    var YNAB_BUDGET_ID = config.budgetId || '<insert budget id here>';
    var YNAB_ACCOUNT_ID = config.accountId || '<insert account id here>';

    var TABLE_SELECTOR = 'table.table.striped-table.border-table';
    var ACTIONS_ID = 'ynab-bci-actions';
    var LOG_PREFIX = '[BCI cuenta corriente]';
    var observers = [];
    var observerTimer = null;
    var scheduledAttempt = null;
    var hasInjected = false;
    var observedDocuments = [];

    function log() {
      var args = Array.prototype.slice.call(arguments);
      args.unshift(LOG_PREFIX);
      console.log.apply(console, args);
    }

    function warn() {
      var args = Array.prototype.slice.call(arguments);
      args.unshift(LOG_PREFIX);
      console.warn.apply(console, args);
    }

    function normalizeText(value) {
      return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    }

    function hasExpectedHeaders(table) {
      var headerText = normalizeText(table.textContent || '');
      return headerText.indexOf('fecha') !== -1 &&
        headerText.indexOf('descripcion') !== -1 &&
        headerText.indexOf('cargo') !== -1 &&
        headerText.indexOf('abono') !== -1;
    }

    function getHeaderSummary(table) {
      var spans = table.querySelectorAll('thead th span, thead th');
      var out = [];
      for (var i = 0; i < spans.length; i++) {
        var text = normalizeText((spans[i].textContent || '').trim());
        if (!text) continue;
        out.push(text.replace(/\s+/g, ' ').slice(0, 40));
      }
      return out;
    }

    function getDocumentLabel(doc) {
      if (!doc) return 'unknown';
      if (doc === document) return 'top';
      try {
        if (doc.defaultView && doc.defaultView.frameElement) {
          var frame = doc.defaultView.frameElement;
          return 'iframe#' + (frame.id || '(sin-id)') + '.' + (frame.className || '(sin-class)');
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

    function getCellText(row, idx) {
      var cells = row.querySelectorAll('td');
      if (!cells || cells.length <= idx) return '';
      return (cells[idx].textContent || '').trim();
    }

    function isDataRow(row) {
      if (!row) return false;
      if (row.querySelector('app-pagination')) return false;
      if (row.classList && row.classList.contains('not-print')) return false;
      var cells = row.querySelectorAll('td');
      return cells && cells.length >= 4;
    }

    function extractMovimientos(table) {
      var tbody = table.querySelector('tbody');
      if (!tbody) return [];
      var rows = tbody.querySelectorAll('tr');
      var datos = [];
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (!isDataRow(row)) continue;
        var fecha = getCellText(row, 0);
        var movimientos = getCellText(row, 1);
        var cargos = getCellText(row, 2);
        var abonos = getCellText(row, 3);
        if (!fecha || !movimientos) continue;
        datos.push({
          fecha: fecha,
          movimientos: movimientos,
          cargos: cargos || '',
          abonos: abonos || ''
        });
      }
      return datos;
    }

    function getCandidateTables(doc) {
      return doc.querySelectorAll(TABLE_SELECTOR);
    }

    function ensureActionsContainer(table, doc) {
      var existing = doc.getElementById(ACTIONS_ID);
      if (existing) return existing;

      var wrapper = doc.createElement('div');
      wrapper.id = ACTIONS_ID;
      wrapper.style.display = 'flex';
      wrapper.style.gap = '12px';
      wrapper.style.alignItems = 'center';
      wrapper.style.margin = '8px 0 12px';

      var parent = table.parentNode;
      if (!parent) return null;
      if (table.nextSibling) parent.insertBefore(wrapper, table.nextSibling);
      else parent.appendChild(wrapper);

      return wrapper;
    }

    function findMovimientosTable() {
      var docs = getSearchDocuments();
      for (var d = 0; d < docs.length; d++) {
        var doc = docs[d];
        var tables = getCandidateTables(doc);
        for (var i = 0; i < tables.length; i++) {
          var table = tables[i];
          if (!hasExpectedHeaders(table)) continue;
          return { table: table, doc: doc };
        }
      }
      return null;
    }

    async function waitForMovimientosTable() {
      var attempts = 0;
      return new Promise(function (resolve) {
        function tick() {
          var match = findMovimientosTable();
          if (match) {
            resolve(match);
            return;
          }
          attempts += 1;
          if (attempts >= 40) {
            warn('No se encontro tabla BCI en top document ni iframes con selector:', TABLE_SELECTOR);
            resolve(null);
            return;
          }
          setTimeout(tick, 400);
        }
        tick();
      });
    }

    async function getTableOrWarn() {
      var match = await waitForMovimientosTable();
      if (!match) {
        warn('No se encontro la tabla de movimientos.');
        return null;
      }
      return match;
    }

    async function runDownload() {
      var match = await getTableOrWarn();
      if (!match) {
        return;
      }
      var table = match.table;
      var datos = extractMovimientos(table);
      if (datos.length === 0) {
        alert('No hay movimientos en la tabla.');
        return;
      }
      var movimientos = Lib.buildMovimientosWithImportIds(datos);
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
      Lib.downloadCSV(csv, 'movimientos-bci-cc-' + dateStr + '.csv');
    }

    async function runSyncYNAB() {
      var match = await getTableOrWarn();
      if (!match) {
        alert('No se encontro la tabla de movimientos.');
        return;
      }
      var table = match.table;
      var datos = extractMovimientos(table);
      if (datos.length === 0) {
        alert('No hay movimientos en la tabla.');
        return;
      }
      var movimientos = Lib.buildMovimientosWithImportIds(datos);
      await Lib.runSyncYNAB(movimientos, {
        accessToken: YNAB_ACCESS_TOKEN,
        budgetId: YNAB_BUDGET_ID,
        accountId: YNAB_ACCOUNT_ID,
        skipMarkNotInBank: true
      });
    }

    function injectButtons(table, doc) {
      doc = doc || document;
      if (doc.querySelector('#' + ACTIONS_ID + ' [data-bci-csv-injected]') &&
          doc.querySelector('#' + ACTIONS_ID + ' [data-bci-ynab-injected]')) {
        hasInjected = true;
        log('Los botones BCI ya estaban inyectados en', getDocumentLabel(doc));
        return true;
      }
      var actions = ensureActionsContainer(table, doc);
      if (!actions) {
        warn('No fue posible crear/encontrar el contenedor de acciones.');
        return false;
      }
      var selector = '#' + ACTIONS_ID;
      Lib.injectButton([
        {
          selector: selector,
          dataId: 'bci-csv-injected',
          wrapTag: 'span',
          linkClass: 'ynab-bci-action-link',
          linkHtml: 'Descargar CSV'
        }
      ], runDownload);
      Lib.injectButton([
        {
          selector: selector,
          dataId: 'bci-ynab-injected',
          wrapTag: 'span',
          linkClass: 'ynab-bci-action-link',
          linkHtml: 'Sincronizar con YNAB'
        }
      ], runSyncYNAB);
      hasInjected = true;
      log('Botones inyectados correctamente en', getDocumentLabel(doc), 'Filas detectadas:', extractMovimientos(table).length);
      return true;
    }

    function tryInject(source) {
      log('Intentando inyectar desde:', source, 'URL:', window.location.href, 'readyState:', document.readyState);
      var docs = getSearchDocuments();
      log('Documentos inspeccionados:', docs.map(getDocumentLabel), 'iframes detectados:', Math.max(docs.length - 1, 0));
      for (var d = 0; d < docs.length; d++) {
        var doc = docs[d];
        var tables = getCandidateTables(doc);
        log('Tablas candidatas encontradas en', getDocumentLabel(doc) + ':', tables.length);
        if (!tables.length) continue;
        for (var i = 0; i < tables.length; i++) {
          var table = tables[i];
          var headers = getHeaderSummary(table);
          var matches = hasExpectedHeaders(table);
          log('Tabla candidata #' + (i + 1) + ' en ' + getDocumentLabel(doc) + ' headers:', headers, 'matchEsperado:', matches);
          if (!matches) continue;
          return injectButtons(table, doc);
        }
      }
      return false;
    }

    function stopObserver(reason) {
      for (var i = 0; i < observers.length; i++) {
        observers[i].disconnect();
      }
      observers = [];
      if (observerTimer) {
        clearTimeout(observerTimer);
        observerTimer = null;
      }
      if (scheduledAttempt) {
        clearTimeout(scheduledAttempt);
        scheduledAttempt = null;
      }
      if (reason) log('Observer detenido:', reason);
    }

    function scheduleRetry(reason) {
      if (hasInjected || scheduledAttempt) return;
      scheduledAttempt = setTimeout(function () {
        scheduledAttempt = null;
        var injected = tryInject('mutation:' + reason);
        if (injected) stopObserver('inyeccion completada');
      }, 150);
    }

    function startObserver() {
      if (hasInjected) return;
      var docs = getSearchDocuments();
      for (var d = 0; d < docs.length; d++) {
        var doc = docs[d];
        if (observedDocuments.indexOf(doc) !== -1) continue;
        if (!doc.body) {
          warn('No existe body en', getDocumentLabel(doc), 'no se puede iniciar MutationObserver aun.');
          continue;
        }
        var observer = new MutationObserver(function (mutations) {
          for (var i = 0; i < mutations.length; i++) {
            if (mutations[i].addedNodes && mutations[i].addedNodes.length) {
              scheduleRetry('addedNodes');
              return;
            }
          }
        });
        observer.observe(doc.body, { childList: true, subtree: true });
        observers.push(observer);
        observedDocuments.push(doc);
        log('MutationObserver iniciado en', getDocumentLabel(doc), 'para detectar carga asincrona de la tabla.');
      }
      observerTimer = setTimeout(function () {
        stopObserver('timeout 60s');
      }, 60000);
    }

    (async function boot() {
      log('Init BCI. accountId configurado:', !!YNAB_ACCOUNT_ID, 'selector tabla:', TABLE_SELECTOR);
      var match = await waitForMovimientosTable();
      if (!match) {
        warn('DOM no compatible en carga inicial; se activara observacion de mutaciones.');
        if (document.readyState !== 'complete') {
          window.addEventListener('load', function () {
            tryInject('window.load');
          }, { once: true });
        }
        tryInject('boot-fallback');
        startObserver();
        return;
      }
      injectButtons(match.table, match.doc);
    })();
  }

  root.BciCuentaCorriente = { init: init };
})(window);
