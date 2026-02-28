// ==UserScript==
// @name         YNAB Bank Sync - Loader unificado
// @namespace    https://banco.itau.cl/
// @version      1.0
// @description  Loader privado unificado: un solo script con todas las credenciales YNAB. Carga lógica pública desde GitHub Pages.
// @match        https://banco.itau.cl/wps/myportal/newolb/web/cuentas/cuenta-corriente/saldos/*
// @match        https://banco.itau.cl/wps/myportal/newolb/web/tarjeta-credito/resumen/compras-pesos*
// @match        https://banco.itau.cl/wps/myportal/newolb/web/tarjeta-credito/resumen/compras-en-dolares*
// @match        https://banco.itau.cl/wps/myportal/newolb/web/tarjeta-credito/resumen/cuenta-nacional*
// @grant        none
// @require      https://gabriel-espinoza.github.io/tampermonkey/shared/lib.js
// @require      https://gabriel-espinoza.github.io/tampermonkey/shared/category-rules.js
// @require      https://gabriel-espinoza.github.io/tampermonkey/scripts/itau/cuenta-corriente.js
// @require      https://gabriel-espinoza.github.io/tampermonkey/scripts/itau/tarjeta-nacional.js
// @require      https://gabriel-espinoza.github.io/tampermonkey/scripts/itau/tarjeta-nacional-facturado.js
// @require      https://gabriel-espinoza.github.io/tampermonkey/scripts/itau/tarjeta-internacional.js
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    accessToken: '<insert ynab token here>',
    budgetId:    '<insert budget id here>',
    accounts: {
      itau: {
        cc:            '<insert account id here>',
        nacional:      '<insert account id here>',
        internacional: '<insert account id here>'
      }
    }
  };

  const ROUTES = [
    { pattern: /cuenta-corriente\/saldos/, module: 'ItauCuentaCorriente',           bank: 'itau', account: 'cc' },
    { pattern: /cuenta-nacional/,          module: 'ItauTarjetaNacionalFacturado',  bank: 'itau', account: 'nacional' },
    { pattern: /compras-pesos/,            module: 'ItauTarjetaNacional',           bank: 'itau', account: 'nacional' },
    { pattern: /compras-en-dolares/,       module: 'ItauTarjetaInternacional',      bank: 'itau', account: 'internacional' }
  ];

  var url = window.location.href;
  for (var i = 0; i < ROUTES.length; i++) {
    var route = ROUTES[i];
    if (route.pattern.test(url) && window[route.module]) {
      window[route.module].init({
        accessToken: CONFIG.accessToken,
        budgetId:    CONFIG.budgetId,
        accountId:   CONFIG.accounts[route.bank][route.account]
      });
      break;
    }
  }
})();
