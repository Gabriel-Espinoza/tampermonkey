// ==UserScript==
// @name         YNAB Bank Sync - Loader unificado
// @namespace    https://banco.itau.cl/
// @version      1.1
// @description  Loader privado unificado: un solo script con todas las credenciales YNAB. Carga lógica pública desde GitHub Pages.
// @match        https://banco.itau.cl/wps/myportal/newolb/web/cuentas/cuenta-corriente/saldos/*
// @match        https://banco.itau.cl/wps/myportal/newolb/web/tarjeta-credito/resumen/compras-pesos*
// @include      /^https:\/\/banco\.itau\.cl\/wps\/myportal\/newolb\/web\/tarjeta-credito\/resumen\/deuda\//
// @match        https://banco.itau.cl/wps/myportal/newolb/web/tarjeta-credito/resumen/compras-en-dolares*
// @match        https://banco.itau.cl/wps/myportal/newolb/web/tarjeta-credito/resumen/cuenta-nacional*
// @match        https://www.bci.cl/cl/bci/aplicaciones/contenido.jsf*
// @match        https://www.bci.cl/svcRest/infraestructura/seguridad/servlet/TokenAutorizacion*
// @match        https://personas.bci.cl/nuevaWeb/fe-saldosultimosmovpersonas/*
// @match        https://mibanco.santander.cl/UI.Web.HB/Private_new/frame/*
// @grant        GM_xmlhttpRequest
// @connect      api.ynab.com
// @require      https://gabriel-espinoza.github.io/tampermonkey/shared/lib.js
// @require      https://gabriel-espinoza.github.io/tampermonkey/shared/category-rules.js
// @require      https://gabriel-espinoza.github.io/tampermonkey/scripts/itau/cuenta-corriente.js
// @require      https://gabriel-espinoza.github.io/tampermonkey/scripts/itau/tarjeta-nacional.js
// @require      https://gabriel-espinoza.github.io/tampermonkey/scripts/itau/tarjeta-nacional-facturado.js
// @require      https://gabriel-espinoza.github.io/tampermonkey/scripts/itau/tarjeta-internacional.js
// @require      https://gabriel-espinoza.github.io/tampermonkey/scripts/bci/cuenta-corriente.js
// @require      https://gabriel-espinoza.github.io/tampermonkey/scripts/santander/tarjeta-credito-movimientos.js
// @require      https://gabriel-espinoza.github.io/tampermonkey/scripts/santander/cuenta-corriente-movimientos.js
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
      },
      bci: {
        bci_caro: '<insert account id here>'
      },
      santander: {
        nacional: '<insert santander nacional YNAB account id>',
        cc:       '<insert santander cuenta corriente YNAB account id>'
      }
    }
  };

  const ROUTES = [
    { pattern: /cuenta-corriente\/saldos/, module: 'ItauCuentaCorriente',           bank: 'itau', account: 'cc' },
    { pattern: /cuenta-nacional/,          module: 'ItauTarjetaNacionalFacturado',  bank: 'itau', account: 'nacional' },
    { pattern: /tarjeta-credito\/resumen\/deuda/, module: 'ItauTarjetaNacional', bank: 'itau', account: 'nacional' },
    { pattern: /compras-pesos/,            module: 'ItauTarjetaNacional',           bank: 'itau', account: 'nacional' },
    { pattern: /compras-en-dolares/,       module: 'ItauTarjetaInternacional',      bank: 'itau', account: 'internacional' },
    { pattern: /bci\.cl\/cl\/bci\/aplicaciones\/contenido\.jsf/, module: 'BciCuentaCorriente', bank: 'bci', account: 'bci_caro' },
    { pattern: /bci\.cl\/svcRest\/infraestructura\/seguridad\/servlet\/TokenAutorizacion/, module: 'BciCuentaCorriente', bank: 'bci', account: 'bci_caro' },
    { pattern: /personas\.bci\.cl\/nuevaWeb\/fe-saldosultimosmovpersonas\//, module: 'BciCuentaCorriente', bank: 'bci', account: 'bci_caro' }
  ];

  var SANTANDER_FRAME_RE = /mibanco\.santander\.cl\/UI\.Web\.HB\/Private_new\/frame\//;
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

  if (SANTANDER_FRAME_RE.test(url)) {
    var base = {
      accessToken: CONFIG.accessToken,
      budgetId:    CONFIG.budgetId
    };
    if (window.SantanderTarjetaCredito) {
      window.SantanderTarjetaCredito.init(
        Object.assign({}, base, { accountId: CONFIG.accounts.santander.nacional })
      );
    }
    if (window.SantanderCuentaCorrienteMovimientos) {
      window.SantanderCuentaCorrienteMovimientos.init(
        Object.assign({}, base, { accountId: CONFIG.accounts.santander.cc })
      );
    }
  }
})();
