(function (root) {
  'use strict';

  function init(config) {
    var Lib = root.BankYNABLib;
    if (!Lib) {
      console.error('[Itaú tarjeta nacional] No se cargó BankYNABLib.');
      return;
    }

    config = config || {};
    var YNAB_ACCESS_TOKEN = config.accessToken || '<insert ynab token here>';
    var YNAB_BUDGET_ID = config.budgetId || '<insert budget id here>';
    var YNAB_ACCOUNT_ID = config.accountId || '<insert account id here>';

    // ── Accumulator state ──────────────────────────────────────────────────
    var accumulatedRows = [];
    var seenPageFingerprints = {};
    var INDICATOR_ID = 'itau-tn-acum-indicator';

    // ── Table helpers ──────────────────────────────────────────────────────

    function getCellText(row, tdName, innerSelector) {
      var td = row.querySelector('td[name="' + tdName + '"]');
      if (!td) return '';
      var el = innerSelector ? td.querySelector(innerSelector) : td;
      return (el && el.textContent) ? el.textContent.trim() : '';
    }

    function extractMovimientos(tbody) {
      var rows = tbody.querySelectorAll('tr[name="DataContainer"]');
      var datos = [];
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var fecha = getCellText(row, 'FECHA_TRANSACCION_iso8601_ColumnData', 'span[name="FECHA_TRANSACCION_iso8601"]');
        var fechaPosteo = getCellText(row, 'FECHA_POSTEO_iso8601_ColumnData', 'span[name="FECHA_POSTEO_iso8601"]');
        var descripcion = getCellText(row, 'GLOSA_TRANSACCION_ColumnData', 'span[name="GLOSA_TRANSACCION"]');
        var ciudad = getCellText(row, 'CIUDA_COMUNA_ColumnData', 'span[name="CIUDA_COMUNA"]');
        var monto = getCellText(row, 'MONTO_TRANSACCION__ColumnData', 'span[name="MONTO_TRANSACCION_"]');
        datos.push({
          fecha: fecha,
          fechaPosteo: fechaPosteo,
          descripcion: descripcion,
          ciudad: ciudad,
          monto: monto
        });
      }
      return datos;
    }

    function toNormalizedMovimientos(datos) {
      var out = [];
      for (var i = 0; i < datos.length; i++) {
        var d = datos[i];
        out.push({
          fecha: d.fecha,
          movimientos: d.descripcion,
          amountMilli: Lib.parseMilliunits(d.monto, true)
        });
      }
      return out;
    }

    // ── Accumulator helpers ────────────────────────────────────────────────

    function rowFingerprint(d) {
      return [d.fecha, d.fechaPosteo, d.descripcion, d.ciudad, d.monto].join('|');
    }

    function captureCurrentPage() {
      var table = document.querySelector('table.gridTable tbody')
                || document.querySelector('table[name="record_Table"] tbody');
      if (!table) return 0;
      var datos = extractMovimientos(table);
      if (datos.length === 0) return 0;

      var fp = datos.map(rowFingerprint).join('\n');
      if (seenPageFingerprints[fp]) return 0;

      seenPageFingerprints[fp] = true;
      accumulatedRows = accumulatedRows.concat(datos);
      return datos.length;
    }

    // ── Indicator helpers ──────────────────────────────────────────────────

    function ensureIndicator() {
      if (document.getElementById(INDICATOR_ID)) return;
      var footer = document.querySelector('#divBotones');
      if (!footer) return;
      var div = document.createElement('div');
      div.id = INDICATOR_ID;
      div.style.cssText = 'padding:6px 12px; font-size:13px; color:#555; font-weight:bold;';
      div.textContent = '0 mov. capturados';
      footer.insertBefore(div, footer.firstChild);
    }

    function updateIndicator() {
      var el = document.getElementById(INDICATOR_ID);
      if (!el) return;
      el.textContent = accumulatedRows.length + ' mov. capturados';
    }

    // ── Actions ────────────────────────────────────────────────────────────

    async function runDownload() {
      captureCurrentPage();
      updateIndicator();
      if (accumulatedRows.length === 0) {
        alert('No hay movimientos capturados. Navega por las páginas de la tabla.');
        return;
      }
      var normalized = toNormalizedMovimientos(accumulatedRows);
      var movimientos = Lib.buildMovimientosWithImportIds(normalized);
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
      Lib.downloadCSV(csv, 'movimientos-itau-tarjeta-pesos-' + dateStr + '.csv');
    }

    async function runSyncYNAB() {
      captureCurrentPage();
      updateIndicator();
      if (accumulatedRows.length === 0) {
        alert('No hay movimientos capturados. Navega por las páginas de la tabla.');
        return;
      }
      var normalized = toNormalizedMovimientos(accumulatedRows);
      var movimientos = Lib.buildMovimientosWithImportIds(normalized);
      await Lib.runSyncYNAB(movimientos, {
        accessToken: YNAB_ACCESS_TOKEN,
        budgetId: YNAB_BUDGET_ID,
        accountId: YNAB_ACCOUNT_ID,
        skipMarkNotInBank: true
      });
    }

    // ── Button containers ──────────────────────────────────────────────────

    var csvContainers = [
      {
        selector: '#divBotones #desktop-botones .d-flex.flex-row',
        dataId: 'itau-tn-csv',
        wrapName: 'contenedorCSV',
        linkName: 'botonCSV',
        linkClass: 'boton-item',
        linkHtml: '<i class="icon-itaufonts_full_excel sizeXS"></i><p class="ml-3 ml-sm-0">Descargar CSV</p>'
      },
      {
        selector: '#divBotones .dropdown-menu',
        dataId: 'itau-tn-csv',
        wrapName: 'contenedorCSV',
        linkName: 'botonCSV',
        linkClass: 'dropdown-item',
        linkHtml: '<div class="boton-tabla d-flex flex-row justify-content-between"><i class="icon-itaufonts_full_excel sizeXS"></i><p>Descargar CSV</p></div>'
      },
      {
        selector: '#contenedorULBotones',
        dataId: 'itau-tn-csv',
        wrapTag: 'li',
        wrapName: 'contenedorCSV',
        linkName: 'botonCSV',
        linkClass: 'boton-barra wpfBlueButton',
        linkHtml: 'Descargar CSV'
      }
    ];
    var ynabContainers = [
      {
        selector: '#divBotones #desktop-botones .d-flex.flex-row',
        dataId: 'itau-tn-ynab',
        wrapName: 'contenedorYNAB',
        linkName: 'botonYNAB',
        linkClass: 'boton-item',
        linkHtml: '<i class="icon-itaufonts_full_excel sizeXS"></i><p class="ml-3 ml-sm-0">Sincronizar con YNAB</p>'
      },
      {
        selector: '#divBotones .dropdown-menu',
        dataId: 'itau-tn-ynab',
        wrapName: 'contenedorYNAB',
        linkName: 'botonYNAB',
        linkClass: 'dropdown-item',
        linkHtml: '<div class="boton-tabla d-flex flex-row justify-content-between"><i class="icon-itaufonts_full_excel sizeXS"></i><p>Sincronizar con YNAB</p></div>'
      },
      {
        selector: '#contenedorULBotones',
        dataId: 'itau-tn-ynab',
        wrapTag: 'li',
        wrapName: 'contenedorYNAB',
        linkName: 'botonYNAB',
        linkClass: 'boton-barra wpfBlueButton',
        linkHtml: 'Sincronizar con YNAB'
      }
    ];

    // ── Boot ───────────────────────────────────────────────────────────────

    (async function boot() {
      var footer = await Lib.waitForElement('#divBotones');
      if (!footer) return;

      function injectAll() {
        Lib.injectButton(csvContainers, runDownload);
        Lib.injectButton(ynabContainers, runSyncYNAB);
        ensureIndicator();
        updateIndicator();
      }

      injectAll();
      captureCurrentPage();
      updateIndicator();

      var scheduled = null;
      var observer = new MutationObserver(function () {
        if (scheduled) return;
        scheduled = setTimeout(function () {
          scheduled = null;
          injectAll();
          var added = captureCurrentPage();
          if (added > 0) updateIndicator();
        }, 300);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    })();
  }

  root.ItauTarjetaNacional = { init: init };
})(window);
