(function (root) {
  'use strict';

  function init(config) {
    var Lib = root.BankYNABLib;
    if (!Lib) {
      console.error('[Itaú cuenta corriente] No se cargó BankYNABLib.');
      return;
    }

    config = config || {};
    var YNAB_ACCESS_TOKEN = config.accessToken || '<insert ynab token here>';
    var YNAB_BUDGET_ID = config.budgetId || '<insert budget id here>';
    var YNAB_ACCOUNT_ID = config.accountId || '<insert account id here>';

    var MAX_ATTEMPTS = 25;
    var INTERVAL_MS = 400;

    function waitForMovimientos() {
      var attempts = 0;
      return new Promise(function (resolve) {
        function tick() {
          var tbody = document.querySelector('table.table-striped tbody');
          var rows = tbody ? tbody.querySelectorAll('tr[name="DataContainer"]') : [];
          if (rows.length > 0) {
            resolve(tbody);
            return;
          }
          attempts += 1;
          if (attempts >= MAX_ATTEMPTS) {
            resolve(null);
            return;
          }
          setTimeout(tick, INTERVAL_MS);
        }
        tick();
      });
    }

    function getCellText(row, tdName, innerSelector) {
      var td = row.querySelector('td[name="' + tdName + '"]');
      if (!td) return '';
      var el = td.querySelector(innerSelector);
      return (el && el.textContent) ? el.textContent.trim() : '';
    }

    function extractMovimientos(tbody) {
      var rows = tbody.querySelectorAll('tr[name="DataContainer"]');
      var datos = [];
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        datos.push({
          fecha: getCellText(row, 'FECOPE_iso8601_ColumnData', 'span'),
          movimientos: getCellText(row, 'OBSERVA_ColumnData', 'a[name="OBSERVA"]'),
          cargos: getCellText(row, 'EGRESO_ColumnData', 'span[name="EGRESO"]') || '',
          abonos: getCellText(row, 'INGRESO_ColumnData', 'span[name="INGRESO"]') || '',
          saldo: getCellText(row, 'SALDO_ColumnData', 'span[name="SALDO"]')
        });
      }
      return datos;
    }

    async function runDownload() {
      var tbody = await waitForMovimientos();
      if (!tbody) {
        console.warn('[Itaú extraer movimientos] No se encontró la sección de movimientos.');
        return;
      }
      var datos = extractMovimientos(tbody);
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
      Lib.downloadCSV(csv, 'movimientos-itau-cc-' + dateStr + '.csv');
    }

    async function runSyncYNAB() {
      var tbody = await waitForMovimientos();
      if (!tbody) {
        alert('No se encontró la tabla de movimientos.');
        return;
      }
      var datos = extractMovimientos(tbody);
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

    var csvContainers = [
      {
        selector: '#divBotones #desktop-botones .d-flex.flex-row',
        dataId: 'itau-csv-injected',
        wrapName: 'contenedorCSV',
        linkName: 'botonCSV',
        linkClass: 'boton-item',
        linkHtml: '<i class="icon-itaufonts_full_excel sizeXS"></i><p class="ml-3 ml-sm-0">Descargar CSV</p>'
      },
      {
        selector: '#divBotones .dropdown-menu',
        dataId: 'itau-csv-injected',
        wrapName: 'contenedorCSV',
        linkName: 'botonCSV',
        linkClass: 'dropdown-item',
        linkHtml: '<div class="boton-tabla d-flex flex-row justify-content-between"><i class="icon-itaufonts_full_excel sizeXS"></i><p>Descargar CSV</p></div>'
      }
    ];

    var ynabContainers = [
      {
        selector: '#divBotones #desktop-botones .d-flex.flex-row',
        dataId: 'itau-ynab-injected',
        wrapName: 'contenedorYNAB',
        linkName: 'botonYNAB',
        linkClass: 'boton-item',
        linkHtml: '<i class="icon-itaufonts_full_excel sizeXS"></i><p class="ml-3 ml-sm-0">Sincronizar con YNAB</p>'
      },
      {
        selector: '#divBotones .dropdown-menu',
        dataId: 'itau-ynab-injected',
        wrapName: 'contenedorYNAB',
        linkName: 'botonYNAB',
        linkClass: 'dropdown-item',
        linkHtml: '<div class="boton-tabla d-flex flex-row justify-content-between"><i class="icon-itaufonts_full_excel sizeXS"></i><p>Sincronizar con YNAB</p></div>'
      }
    ];

    (async function boot() {
      var footer = await Lib.waitForElement('.__footer-tabla-itau #divBotones');
      if (!footer) return;
      Lib.injectButton(csvContainers, runDownload);
      Lib.injectButton(ynabContainers, runSyncYNAB);
    })();
  }

  root.ItauCuentaCorriente = { init: init };
})(window);
