// ==UserScript==
// @name         Itaú Chile - Loader privado (tarjeta internacional)
// @namespace    https://banco.itau.cl/
// @version      1.0
// @description  Loader privado: mantiene credenciales y carga lógica pública desde GitHub Pages.
// @match        https://banco.itau.cl/wps/myportal/newolb/web/tarjeta-credito/resumen/compras-en-dolares*
// @grant        none
// @require      https://<usuario>.github.io/<repo>/shared/lib.js
// @require      https://<usuario>.github.io/<repo>/scripts/itau/tarjeta-internacional.js
// ==/UserScript==

(function () {
  'use strict';

  window.ItauTarjetaInternacional.init({
    accessToken: '<insert ynab token here>',
    budgetId: '<insert budget id here>',
    accountId: '<insert account id here>'
  });
})();
