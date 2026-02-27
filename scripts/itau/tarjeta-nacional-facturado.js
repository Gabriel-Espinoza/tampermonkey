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

    async function runDownload() {
      var tbody = await waitForMovimientos();
      if (!tbody) {
        console.warn('[Itaú tarjeta nacional facturado] No se encontró la tabla de movimientos.');
        return;
      }
      var datos = extractMovimientos(tbody);
      var headers = ['fecha', 'descripcion', 'ciudad', 'codigoReferencia', 'monto', 'montoTotalPagar', 'cuota', 'valorCuota'];
      var csv = Lib.toCSV(datos, headers);
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
        accountId: YNAB_ACCOUNT_ID
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
