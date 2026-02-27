// ==UserScript==
// @name         Itaú Chile - Extraer movimientos (tarjeta crédito - compras pesos)
// @namespace    https://banco.itau.cl/
// @version      1.0
// @description  Añade botones para descargar movimientos en CSV y sincronizar con YNAB. Últimas compras en pesos.
// @match        https://banco.itau.cl/wps/myportal/newolb/web/tarjeta-credito/resumen/compras-pesos*
// @grant        none
// @require      https://YOUR_URL_HERE/shared/lib.js
// ==/UserScript==

(function () {
  'use strict';

  var Lib = typeof BankYNABLib !== 'undefined' ? BankYNABLib : null;
  if (!Lib) {
    console.error('[Itaú tarjeta nacional] No se cargó BankYNABLib. Reemplaza la URL de @require por la ubicación de shared/lib.js.');
    return;
  }

  var YNAB_ACCESS_TOKEN = '<insert ynab token here>';
  var YNAB_BUDGET_ID = '<insert budget id here>';
  var YNAB_ACCOUNT_ID = '<insert account id here>';

  var MAX_ATTEMPTS = 25;
  var INTERVAL_MS = 400;

  function waitForMovimientos() {
    var attempts = 0;
    return new Promise(function (resolve) {
      function tick() {
        var table = document.querySelector('table.gridTable tbody') || document.querySelector('table[name="record_Table"] tbody');
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

  async function runDownload() {
    var tbody = await waitForMovimientos();
    if (!tbody) {
      console.warn('[Itaú tarjeta nacional] No se encontró la tabla de movimientos.');
      return;
    }
    var datos = extractMovimientos(tbody);
    var headers = ['fecha', 'fechaPosteo', 'descripcion', 'ciudad', 'monto'];
    var csv = Lib.toCSV(datos, headers);
    var dateStr = new Date().toISOString().slice(0, 10);
    Lib.downloadCSV(csv, 'movimientos-itau-tarjeta-pesos-' + dateStr + '.csv');
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
      dataId: 'itau-tn-csv',
      wrapTag: 'li',
      wrapName: 'contenedorCSV',
      linkClass: 'boton-barra wpfBlueButton',
      linkHtml: 'Descargar CSV'
    }
  ];
  var ynabContainers = [
    {
      selector: '#divBotones #contenedorULBotones',
      dataId: 'itau-tn-ynab',
      wrapTag: 'li',
      wrapName: 'contenedorYNAB',
      linkClass: 'boton-barra wpfBlueButton',
      linkHtml: 'Sincronizar con YNAB'
    }
  ];

  (async function init() {
    var footer = await Lib.waitForElement('#divBotones');
    if (!footer) return;
    Lib.injectButton(csvContainers, runDownload);
    Lib.injectButton(ynabContainers, runSyncYNAB);
  })();
})();
