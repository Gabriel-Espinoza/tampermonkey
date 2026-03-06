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

    function ensureActionsContainer(table) {
      var existing = document.getElementById(ACTIONS_ID);
      if (existing) return existing;

      var wrapper = document.createElement('div');
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

    async function waitForMovimientosTable() {
      var table = await Lib.waitForElement(TABLE_SELECTOR, 40);
      if (!table) return null;
      if (!hasExpectedHeaders(table)) return null;
      return table;
    }

    async function runDownload() {
      var table = await waitForMovimientosTable();
      if (!table) {
        console.warn('[BCI cuenta corriente] No se encontro la tabla de movimientos.');
        return;
      }
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
      var table = await waitForMovimientosTable();
      if (!table) {
        alert('No se encontro la tabla de movimientos.');
        return;
      }
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

    function injectButtons(table) {
      var actions = ensureActionsContainer(table);
      if (!actions) return;
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
    }

    (async function boot() {
      var table = await waitForMovimientosTable();
      if (!table) {
        console.warn('[BCI cuenta corriente] DOM no compatible, no se inyectan botones.');
        return;
      }
      injectButtons(table);
    })();
  }

  root.BciCuentaCorriente = { init: init };
})(window);
