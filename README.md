# Itaú Chile + YNAB (Tampermonkey con lógica pública en GitHub Pages)

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
│   └── lib.js                     # Librería compartida (GitHub Pages)
├── scripts/
│   └── itau/
│       ├── cuenta-corriente.js    # Módulo público (GitHub Pages)
│       ├── tarjeta-nacional.js
│       └── tarjeta-internacional.js
├── loaders/                       # Privado/local (ignorado por git)
│   ├── itau-cuenta-corriente.loader.user.js
│   ├── itau-tarjeta-nacional.loader.user.js
│   └── itau-tarjeta-internacional.loader.user.js
└── dom examples/                  # Ignorado por git (ver abajo)
    ├── itau_dom.html
    ├── itau_creditcard_nacional_dom.html
    └── itau_creditcard_inter_dom.html
```

## Cómo funciona ahora

1. Tampermonkey ejecuta un **loader privado**.
2. El loader carga con `@require` la librería y el módulo desde GitHub Pages.
3. El loader llama `init({ accessToken, budgetId, accountId })`.
4. Toda la lógica se ejecuta en el módulo público, pero las credenciales nunca quedan en git.

## Publicar en GitHub Pages

1. Crea un repositorio remoto y sube este proyecto.
2. En GitHub, ve a **Settings > Pages**.
3. En *Build and deployment*, selecciona:
  - **Source:** Deploy from a branch
  - **Branch:** `main` (o la rama principal) y carpeta `/ (root)`
4. Guarda y espera la URL final:
  - `https://<usuario>.github.io/<repo>/`

Con eso quedarán disponibles:

- `https://<usuario>.github.io/<repo>/shared/lib.js`
- `https://<usuario>.github.io/<repo>/scripts/itau/cuenta-corriente.js`
- `https://<usuario>.github.io/<repo>/scripts/itau/tarjeta-nacional.js`
- `https://<usuario>.github.io/<repo>/scripts/itau/tarjeta-internacional.js`

## Instalar loaders privados (Tampermonkey)

Edita cada archivo en `loaders/` y reemplaza:

- URL `@require` con `<usuario>` y `<repo>`
- `accessToken`, `budgetId`, `accountId` con tus datos de YNAB

Luego instala cada loader en Tampermonkey (copiar/pegar o importar archivo):

- `loaders/itau-cuenta-corriente.loader.user.js`
- `loaders/itau-tarjeta-nacional.loader.user.js`
- `loaders/itau-tarjeta-internacional.loader.user.js`

## Configuración YNAB


| Variable      | Descripción               | Dónde obtenerla                                                       |
| ------------- | ------------------------- | --------------------------------------------------------------------- |
| `accessToken` | Token de API (Bearer)     | YNAB > Account Settings > Developer Settings > Personal Access Tokens |
| `budgetId`    | UUID del presupuesto      | `GET https://api.ynab.com/v1/budgets`                                 |
| `accountId`   | UUID de la cuenta destino | `GET https://api.ynab.com/v1/budgets/{budget_id}/accounts`            |


Puedes usar un `accountId` distinto para cada loader.

## Actualizar lógica pública

1. Cambia archivos en `shared/` o `scripts/itau/`.
2. Commit y push.
3. GitHub Pages publica automáticamente la nueva versión.
4. Tampermonkey actualizará los `@require` según su intervalo de actualización.

## Cache de Tampermonkey

- `@require` usa cache.
- Si necesitas forzar actualización inmediata:
  - Reinstala/actualiza el script, o
  - Añade query string en `@require` (por ejemplo `...?v=2`).

## Carpeta `dom examples/` (ignorada por git)

Esta carpeta contiene capturas HTML de las páginas de Itaú Chile y se usa como referencia para mantener los selectores DOM cuando el banco cambia su interfaz. Está ignorada por git porque contiene estructura propietaria del sitio del banco.

Si necesitas crearla para mantenimiento de selectores:

1. Crea la carpeta:
   ```bash
   mkdir -p "dom examples"
   ```
2. Navega a cada página de Itaú en el navegador, abre DevTools (F12), copia el HTML del contenedor de la tabla de movimientos y guárdalo:
   - **Cuenta corriente** (saldos) → `dom examples/itau_dom.html`
   - **Tarjeta crédito - compras pesos** → `dom examples/itau_creditcard_nacional_dom.html`
   - **Tarjeta crédito - compras dólares** → `dom examples/itau_creditcard_inter_dom.html`

Estos archivos nunca se suben al repo.

## Notas de mantenimiento

- Si Itaú cambia el DOM, actualiza selectores en los módulos de `scripts/itau/`.
- Usa `dom examples/` como referencia para ajustar selectores.

