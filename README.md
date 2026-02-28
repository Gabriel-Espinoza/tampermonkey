# YNAB Syncer with Tampermonkey

Este proyecto separa:

- **Lógica pública** en GitHub Pages (`shared/`, `scripts/`): extracción DOM, CSV, sync YNAB, utilidades.
- **Configuración privada** en Tampermonkey (`loaders/` local): token y IDs de YNAB.

Así puedes versionar toda la lógica en git sin subir secretos.

## Estructura del proyecto

```text
tampermonkey/
├── README.md
├── .gitignore
├── shared/
│   ├── lib.js                         # Librería compartida (GitHub Pages)
│   └── category-rules.js              # Reglas de auto-categorización por payee (generadas)
├── scripts/
│   └── itau/
│       ├── cuenta-corriente.js        # Módulo público (GitHub Pages)
│       ├── tarjeta-nacional.js
│       ├── tarjeta-nacional-facturado.js   # Estado de cuenta facturado (cuenta nacional)
│       └── tarjeta-internacional.js
├── loaders/                           # Privado/local (ignorado por git)
│   └── unified.loader.user.js        # Loader unificado (template)
└── dom examples/                      # Ignorado por git (ver abajo)
    ├── itau_dom.html
    ├── itau_creditcard_nacional_dom.html
    └── itau_creditcard_inter_dom.html
```

## Cómo funciona

Un único loader de Tampermonkey cubre todas las cuentas de un banco. El flujo es:

1. Tampermonkey detecta que estás en una URL de Itaú y ejecuta el **loader unificado**.
2. El loader carga con `@require` la librería compartida y los 3 módulos de Itaú desde GitHub Pages.
3. Según la URL actual, el loader determina qué módulo inicializar y le pasa las credenciales correspondientes desde un bloque `CONFIG` centralizado.
4. El módulo público extrae movimientos del DOM, ofrece descarga CSV de diagnóstico (comparando contra YNAB) y sincroniza con YNAB.

```text
┌─────────────────────────────────────────────────────┐
│  Tampermonkey (local, nunca se publica)              │
│                                                      │
│  unified.loader.user.js                              │
│  ┌────────────────────────────────────────────────┐  │
│  │ CONFIG = {                                     │  │
│  │   accessToken, budgetId,                       │  │
│  │   accounts: { itau: { cc, nacional, inter } }  │  │
│  │ }                                              │  │
│  └──────────────────┬─────────────────────────────┘  │
│                     │ según URL                      │
│         ┌───────────┼───────────┐                    │
│         ▼           ▼           ▼                    │
│     cuenta-    tarjeta-    tarjeta-                   │
│     corriente  nacional    internacional             │
│         │           │           │                    │
└─────────┼───────────┼───────────┼────────────────────┘
          │  @require │           │
          ▼           ▼           ▼
    ┌─────────────────────────────────┐
    │  GitHub Pages (público)         │
    │  shared/lib.js                  │
    │  scripts/itau/*.js              │
    └─────────────────────────────────┘
```

## Instalación

### 1. Obtener los tokens de YNAB

Necesitas 3 datos de tu cuenta YNAB:


| Variable      | Descripción               | Dónde obtenerla                                                       |
| ------------- | ------------------------- | --------------------------------------------------------------------- |
| `accessToken` | Token de API (Bearer)     | YNAB > Account Settings > Developer Settings > Personal Access Tokens |
| `budgetId`    | UUID del presupuesto      | `GET https://api.ynab.com/v1/budgets`                                 |
| `accountId`   | UUID de la cuenta destino | `GET https://api.ynab.com/v1/budgets/{budget_id}/accounts`            |


Necesitas un `accountId` por cada tipo de cuenta (cuenta corriente, tarjeta nacional, tarjeta internacional).

### 2. Configurar el loader

1. Abre `loaders/unified.loader.user.js`.
2. Reemplaza los valores en el bloque `CONFIG` con tus datos:

```javascript
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
```

Las URLs `@require` ya apuntan a GitHub Pages y no necesitan cambios.

### 3. Instalar en Tampermonkey

1. Abre Tampermonkey en tu navegador.
2. Crea un nuevo script (pestaña "+").
3. Borra el contenido por defecto y pega todo el contenido de `unified.loader.user.js` (ya con tus tokens).
4. Guarda (Ctrl+S / Cmd+S).

Eso es todo. El script se activará automáticamente al visitar cualquiera de las 3 páginas de Itaú.

### Cambiar entre test y prod

Solo necesitas actualizar `budgetId` y los `accountId` en el bloque `CONFIG` con los valores del entorno que quieras usar.

## Agregar un nuevo banco

El loader está diseñado para ser extensible. Para agregar soporte a otro banco:

1. Agrega los `accountId` del nuevo banco en `CONFIG.accounts`:

```javascript
accounts: {
  itau: { /* ... */ },
  brou: {
    cc:     '<account id>',
    ahorro: '<account id>'
  }
}
```

1. Agrega las reglas de routing en el array `ROUTES`:

```javascript
{ pattern: /brou\.com.*cuenta-corriente/, module: 'BrouCuentaCorriente', bank: 'brou', account: 'cc' }
```

1. Agrega las directivas `@match` y `@require` en el header del script para las URLs y módulos del nuevo banco.

## Publicar en GitHub Pages

Si haces un fork o creas tu propio repo:

1. En GitHub, ve a **Settings > Pages**.
2. En *Build and deployment*, selecciona:
  - **Source:** Deploy from a branch
  - **Branch:** `main` y carpeta `/ (root)`
3. Guarda y espera la URL final: `https://<usuario>.github.io/<repo>/`

Con eso quedarán disponibles:

- `https://<usuario>.github.io/<repo>/shared/lib.js`
- `https://<usuario>.github.io/<repo>/shared/category-rules.js`
- `https://<usuario>.github.io/<repo>/scripts/itau/cuenta-corriente.js`
- `https://<usuario>.github.io/<repo>/scripts/itau/tarjeta-nacional.js`
- `https://<usuario>.github.io/<repo>/scripts/itau/tarjeta-nacional-facturado.js`
- `https://<usuario>.github.io/<repo>/scripts/itau/tarjeta-internacional.js`

Si usas tu propio fork, actualiza las URLs `@require` en el loader.

## Actualizar lógica pública

1. Cambia archivos en `shared/` o `scripts/itau/`.
2. Commit y push.
3. GitHub Pages publica automáticamente la nueva versión.
4. Tampermonkey actualizará los `@require` según su intervalo de actualización.

### Cache de Tampermonkey

`@require` usa cache. Si necesitas forzar actualización inmediata:

- Reinstala/actualiza el script, o
- Añade query string en `@require` (por ejemplo `...?v=2`).

## Carpeta `dom examples/` (ignorada por git)

Contiene capturas HTML de las páginas de Itaú Chile, usadas como referencia para mantener los selectores DOM cuando el banco cambia su interfaz. Está ignorada por git porque contiene estructura propietaria del sitio del banco.

Si necesitas crearla para mantenimiento de selectores:

1. Crea la carpeta:
  ```bash
   mkdir -p "dom examples"
  ```
2. Navega a cada página de Itaú en el navegador, abre DevTools (F12), copia el HTML del contenedor de la tabla de movimientos y guárdalo:
  - **Cuenta corriente** (saldos) → `dom examples/itau_dom.html`
  - **Tarjeta crédito - compras pesos** → `dom examples/itau_creditcard_nacional_dom.html`
  - **Tarjeta crédito - compras dólares** → `dom examples/itau_creditcard_inter_dom.html`
  - **Tarjeta crédito - estado de cuenta facturado (cuenta nacional)** → `dom examples/itau_creditcard_facturado_nacional.html`

## CSV de diagnóstico

El botón "Descargar CSV" genera un archivo orientado a diagnosticar la sincronización con YNAB. En lugar de replicar las columnas crudas del DOM, el CSV refleja exactamente lo que el sync enviaría/haría en YNAB.

**Columnas:**

| Columna      | Descripción                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `fecha`      | Fecha normalizada YYYY-MM-DD                                                                        |
| `payee`      | Nombre del beneficiario (lo que se envía como `payee_name` a YNAB)                                  |
| `monto`      | Monto en miliunidades (formato YNAB: entero, negativo para egresos)                                 |
| `memo`       | Memo que se enviaría (ej. `cuota 02/3`, `USD a 950`)                                                |
| `import_id`  | Llave de deduplicación YNAB (ej. `YNAB:-150000:2026-02-15:1`)                                      |
| `categoria_inferida` | Categoría inferida por reglas de payee (vacío si no hay match o la transacción no se categoriza automáticamente) |
| `accion`     | Qué haría el sync: `crear` (nueva), `ya existe` (se saltaría), `marcar` (solo en YNAB, se flaggea) |
| `flag_color` | Color de flag actual en YNAB (vacío si no tiene; ej. `orange` si ya fue marcada)                    |
| `marcar`     | Vacío para transacciones del banco; para las que están solo en YNAB: `[No aparece en extracto Itaú]`|

**Tipos de filas:**

1. **`crear`** — Transacción del banco que no existe en YNAB. Se crearía al sincronizar.
2. **`ya existe`** — Transacción del banco que ya está en YNAB (match por `import_id`, o por `fecha:monto` para transacciones ingresadas manualmente). Se saltaría.
3. **`marcar`** — Transacción que existe en YNAB pero no aparece en el extracto bancario. Se marcaría con flag naranja y memo suffix. Solo aplica en tablas no paginadas (ver sección siguiente).

> La descarga del CSV requiere credenciales YNAB configuradas (llama a la API para comparar). Si la tarjeta internacional está involucrada, también pedirá la tasa de conversión USD → CLP.

## Auto-categorización por payee

El sync ahora puede asignar `category_id` al crear transacciones vía API, usando reglas determinísticas por payee.

### Cómo funciona

1. `shared/category-rules.js` define reglas de inferencia (`exact`, `patterns`, `skip`).
2. `shared/lib.js` infiere la categoría desde el payee (`inferCategory`). El payee se normaliza (minúsculas, sin acentos, puntuación → espacios); si una regla `exact` tiene la clave en formato original, se busca también por comparación normalizada.
3. Antes de crear transacciones, `lib.js` obtiene categorías del presupuesto (`GET /categories`) y resuelve `Group: Category -> category_id`.
4. Si hay match, se envía `category_id` en el `POST /transactions`. Si no hay match, la transacción se crea sin categoría (comportamiento anterior).

### Regenerar reglas desde export de YNAB

Puedes regenerar `shared/category-rules.js` con el historial más reciente:

```bash
python3 "tools/build_category_rules.py" \
  --input "/ruta/a/YNAB Export.tsv" \
  --output "shared/category-rules.js"
```

El script usa solo librerías estándar de Python y reporta en consola payees ambiguos (cuando un mismo payee aparece con múltiples categorías) para revisión manual.

## Tablas paginadas vs. no paginadas

Las tablas del sitio de Itaú tienen distinto comportamiento de paginación:

| Módulo | Página | ¿Paginada? | Marca "no en banco" |
| --- | --- | --- | --- |
| `cuenta-corriente.js` | Saldos cuenta corriente | Sí | No |
| `tarjeta-nacional.js` | Compras en pesos | Sí | No |
| `tarjeta-internacional.js` | Compras en dólares | Sí | No |
| `tarjeta-nacional-facturado.js` | Estado de cuenta facturado | No | Sí |

Cuando una tabla está paginada, el DOM solo muestra una página a la vez. Si se compararan las transacciones de YNAB contra esa vista parcial, las transacciones de otras páginas se marcarían erróneamente como "no aparece en extracto".

Para evitar esto, los módulos con tablas paginadas pasan `skipMarkNotInBank: true` en el config de `runSyncYNAB` y `buildYNABPreviewRows`. Esto desactiva el paso de marcar transacciones que solo están en YNAB, limitando la sincronización a **solo crear** transacciones nuevas.

El módulo `tarjeta-nacional-facturado` no pasa esta opción porque su tabla muestra todas las transacciones sin paginación, por lo que la comparación inversa es confiable. Sin embargo, usa `skipReconciled: true` para excluir de las filas "marcar" las transacciones que ya están conciliadas (*reconciled*) en YNAB, ya que esas transacciones ya fueron verificadas y no necesitan revisión.

## Notas de mantenimiento

- Si Itaú cambia el DOM, actualiza selectores en los módulos de `scripts/itau/`.
- Usa `dom examples/` como referencia para ajustar selectores.

