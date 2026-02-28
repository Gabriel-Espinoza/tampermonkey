(function (root) {
  'use strict';

  /**
   * Estado de cuenta facturado - Tarjeta crédito nacional (resumen/cuenta-nacional).
   * Tabla: operacion_Table / gridTable con columnas:
   * Ciudad, Fecha operación (NumeroReferencia_iso8601), Código referencia, Descripción,
   * Monto Operación, Monto total a pagar, N° cuota, Valor cuota.
   * Se ignoran filas de agrupación (ej. "1.Total operaciones") que tienen solo Descripcion con colspan.
   */
  function init(config) {
    var Lib = root.BankYNABLib;
    if (!Lib) {
      console.error('[Itaú tarjeta nacional facturado] No se cargó BankYNABLib.');
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
          var table = document.querySelector('table.gridTable tbody') || document.querySelector('table[name="operacion_Table"] tbody');
          var rows = table ? table.querySelectorAll('tr[name="DataContainer"]') : [];
          if (rows.length > 0) {
            resolve(table);
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
      var el = innerSelector ? td.querySelector(innerSelector) : td;
      return (el && el.textContent) ? el.textContent.trim() : '';
    }

    function extractMovimientos(tbody) {
      var rows = tbody.querySelectorAll('tr[name="DataContainer"]');
      var datos = [];
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var montoCell = row.querySelector('td[name="MontoTransaccion_iso8601_ColumnData"]');
        if (!montoCell) continue;
        var fecha = getCellText(row, 'NumeroReferencia_iso8601_ColumnData', 'span[name="NumeroReferencia_iso8601"]');
        var descripcion = getCellText(row, 'Descripcion_ColumnData', 'span[name="Descripcion"]');
        var monto = getCellText(row, 'MontoTransaccion_iso8601_ColumnData', 'span[name="MontoTransaccion_iso8601"]');
        datos.push({
          fecha: fecha,
          descripcion: descripcion,
          ciudad: getCellText(row, 'Ciudad_ColumnData', 'span[name="Ciudad"]'),
          codigoReferencia: getCellText(row, 'CodigoReferencia_ColumnData', 'span[name="CodigoReferencia"]'),
          monto: monto,
          montoTotalPagar: getCellText(row, 'fld_31_iso8601_ColumnData', 'span[name="fld_31_iso8601"]'),
          cuota: getCellText(row, 'cuota_ColumnData', 'span[name="cuota"]'),
          valorCuota: getCellText(row, 'operacion_fld_21_iso8601_ColumnData', 'span[name="operacion_fld_21_iso8601"]')
        });
      }
      return datos;
    }

    function formatCuotaDisplay(cuota) {
      return (cuota === '01/1') ? '' : 'cuota ' + cuota;
    }

    function adjustDateToCurrentMonth(fechaStr) {
      var parts = fechaStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!parts) return fechaStr;
      var day = parseInt(parts[1], 10);
      var now = new Date();
      var curMonth = now.getMonth();
      var curYear = now.getFullYear();
      var lastDay = new Date(curYear, curMonth + 1, 0).getDate();
      if (day > lastDay) day = lastDay;
      var dd = String(day).padStart(2, '0');
      var mm = String(curMonth + 1).padStart(2, '0');
      return dd + '/' + mm + '/' + curYear;
    }

    function getMaxNonCuotaDate(movimientos) {
      var maxDate = null;
      for (var i = 0; i < movimientos.length; i++) {
        var m = movimientos[i];
        if (m.memo && m.memo.indexOf('cuota ') === 0) continue;
        if (m.dateNorm && (!maxDate || m.dateNorm > maxDate)) {
          maxDate = m.dateNorm;
        }
      }
      return maxDate;
    }

    function toNormalizedMovimientos(datos) {
      var out = [];
      for (var i = 0; i < datos.length; i++) {
        var d = datos[i];
        var isCuota = d.cuota && d.cuota !== '01/1';
        var item = {
          fecha: isCuota ? adjustDateToCurrentMonth(d.fecha) : d.fecha,
          movimientos: d.descripcion,
          amountMilli: Lib.parseMilliunits(d.monto, true)
        };
        if (isCuota) item.memo = 'cuota ' + d.cuota;
        out.push(item);
      }
      return out;
    }

    async function runDownload() {
      var tbody = await waitForMovimientos();
      if (!tbody) {
        console.warn('[Itaú tarjeta nacional facturado] No se encontró la tabla de movimientos.');
        return;
      }
      var datos = extractMovimientos(tbody);
      if (datos.length === 0) {
        alert('No hay movimientos en la tabla.');
        return;
      }
      var normalized = toNormalizedMovimientos(datos);
      var movimientos = Lib.buildMovimientosWithImportIds(normalized);
      var result = await Lib.buildYNABPreviewRows(movimientos, {
        accessToken: YNAB_ACCESS_TOKEN,
        budgetId: YNAB_BUDGET_ID,
        accountId: YNAB_ACCOUNT_ID,
        skipReconciled: true,
        skipMarkAfterDate: getMaxNonCuotaDate(movimientos)
      });
      if (result.error) {
        alert('Error al obtener datos de YNAB: ' + result.error);
        return;
      }
      var headers = ['fecha', 'payee', 'monto', 'memo', 'import_id', 'accion', 'flag_color', 'marcar'];
      var csv = Lib.toCSV(result.rows, headers);
      var dateStr = new Date().toISOString().slice(0, 10);
      Lib.downloadCSV(csv, 'movimientos-itau-tarjeta-facturado-' + dateStr + '.csv');
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
      var normalized = toNormalizedMovimientos(datos);
      var movimientos = Lib.buildMovimientosWithImportIds(normalized);
      await Lib.runSyncYNAB(movimientos, {
        accessToken: YNAB_ACCESS_TOKEN,
        budgetId: YNAB_BUDGET_ID,
        accountId: YNAB_ACCOUNT_ID,
        skipMarkAfterDate: getMaxNonCuotaDate(movimientos)
      });
    }

    var csvContainers = [
      {
        selector: '#divBotones #contenedorULBotones',
        dataId: 'itau-tn-facturado-csv',
        wrapTag: 'li',
        wrapName: 'contenedorCSV',
        linkClass: 'boton-barra wpfBlueButton',
        linkHtml: 'Descargar CSV'
      }
    ];
    var ynabContainers = [
      {
        selector: '#divBotones #contenedorULBotones',
        dataId: 'itau-tn-facturado-ynab',
        wrapTag: 'li',
        wrapName: 'contenedorYNAB',
        linkClass: 'boton-barra wpfBlueButton',
        linkHtml: 'Sincronizar con YNAB'
      }
    ];

    (async function boot() {
      var footer = await Lib.waitForElement('#divBotones');
      if (!footer) return;
      Lib.injectButton(csvContainers, runDownload);
      Lib.injectButton(ynabContainers, runSyncYNAB);
    })();
  }

  root.ItauTarjetaNacionalFacturado = { init: init };
})(window);
