# Cursor Memory

## Architecture

- `shared/lib.js` is the shared library used by all bank modules via `@require` from GitHub Pages.
- Each bank module (`scripts/itau/*.js`) extracts DOM data and delegates CSV/YNAB logic to `BankYNABLib`.
- Loaders in `loaders/` are local-only Tampermonkey scripts that hold secrets and route to modules.

## YNAB API

- Transactions have a `cleared` field with values: `cleared`, `uncleared`, or `reconciled`.
- `reconciled` means the user has verified and locked the transaction in YNAB.
- The `buildYNABPreviewRows` function supports `skipReconciled` to exclude reconciled transactions from "marcar" rows.

## Key Patterns

- Config options flow from the module script → `buildYNABPreviewRows` / `runSyncYNAB` in lib.js.
- `skipMarkNotInBank: true` is used for paginated tables (can't reliably detect "not in bank" from partial DOM).
- `skipReconciled: true` is used for facturado (non-paginated) to avoid flagging already-verified transactions. Must be passed in BOTH `buildYNABPreviewRows` AND `runSyncYNAB` calls — the lib's `runSyncYNAB` also checks this flag when building the `soloEnYNAB` list.

## BCI Integration Notes

- BCI currently routes through a generic URL (`/cl/bci/aplicaciones/contenido.jsf`), so module init must verify page-specific DOM signatures before injecting/syncing.
- The BCI movements table is paginated (`app-pagination`), so BCI modules should pass `skipMarkNotInBank: true` in both preview and sync flows.
- The available BCI DOM snapshot does not expose a stable shared action bar; first implementation injects a dedicated local actions container next to the movements table.
- BCI may render content asynchronously under the same URL; the module benefits from diagnostic logs plus a `MutationObserver` fallback to detect the table after initial load.

## Matching Logic (two-pass: exact → fuzzy)

- YNAB transactions created via API or file import have `import_id` (e.g. `YNAB:-50000000:2026-01-23:1`).
- Manually entered YNAB transactions do NOT have `import_id`.
- Both `buildYNABPreviewRows` and `runSyncYNAB` use **two-pass** matching:
  - **Pass 1 (exact):** For ALL bank transactions, try import_id match, then date:amount exact match. This ensures exact matches are never stolen by fuzzy matches processed earlier in DOM order.
  - **Pass 2 (fuzzy):** For remaining unmatched transactions, try fuzzy date:amount (same amount, date within N days). Picks the closest date within the window.
- **Critical lesson:** Single-pass sequential matching (all 3 levels per transaction) causes order-dependent bugs where a fuzzy match can consume a YNAB entry that a later transaction would have matched exactly by date:amount. The two-pass approach prevents this.
- All levels track consumed YNAB transaction IDs (`matchedYnabIds` Set) to prevent double-matching.
- Fuzzy matching only applies to YNAB transactions without `import_id` (manual entries).
- `config.fuzzyDateDays` controls the window (default 7, set to 0 to disable).
- The YNAB API query range is expanded by `fuzzyDateDays` in both directions to fetch potentially shifted transactions.
- In `buildYNABPreviewRows`, fuzzy matches show `accion: 'corregir fecha (YNAB: YYYY-MM-DD)'` so the user can verify.
- In `runSyncYNAB`, fuzzy matches trigger `updateYNABTransaction` to correct the YNAB date to the bank (DOM) date. The bank is the authoritative source for dates.
- `soloEnYNAB` detection uses `matchedYnabIds` instead of key-based checks, which is more accurate for 1-to-1 matching.
- YNAB flag colors: `orange` = fuzzy date correction applied, `red` = transaction in YNAB but not found in bank DOM.
- Flag priority: existing YNAB flags are never overwritten. Orange/red are only applied when the transaction has no flag yet.

## Billing Cutoff Filtering (tarjeta-nacional-facturado)

- `skipMarkAfterDate` prevents flagging YNAB transactions that are after the billing cycle cutoff.
- For facturado, cuota transactions have dates adjusted to the current month, which pushes `untilDate` forward and causes false "marcar" entries for recent YNAB transactions not yet billed.
- `getMaxNonCuotaDate` computes the latest date among non-cuota movimientos, used as `skipMarkAfterDate`.
- Non-cuota items are identified by absence of `memo` starting with `'cuota '`.

## Cuota Date Adjustment (tarjeta-nacional-facturado)

- For installment transactions (cuota != "01/1"), the bank shows the original purchase date, not the billing date.
- `adjustDateToCurrentMonth` always returns the 1st day of the current month/year, regardless of the original purchase day.
- This ensures YNAB reflects the billing cycle month, not when the purchase was made.

## Monto de Transacción (tarjeta-nacional-facturado)

- The DOM table has multiple amount columns: "Monto Operación", "Monto total a pagar", and "Valor Cuota".
- The correct column to use is **"Valor Cuota"** (`operacion_fld_21_iso8601`), which is the amount actually billed in the current cycle.
- "Monto Operación" is the original purchase amount (may differ for installments), "Monto total a pagar" is the total across all installments.

## Auto-categorization by Payee

- `shared/category-rules.js` is loaded via `@require` and exposes `window.YNABCategoryRules`.
- Rules are deterministic and normalized (lowercase, accents removed, punctuation collapsed): `exact` -> `startsWith` -> `contains`.
- `inferCategory` looks up by normalized payee. If an exact rule key is in original form (e.g. "Neat cuentas..." or "Colegio instituto tere tasa int. 0,00%"), a fallback loop normalizes each rule key and matches—so manually edited or inconsistently cased rules still apply.
- `skip` rules prevent auto-categorizing system entries (transfer/starting-balance/cashback-like payees).
- `runSyncYNAB` fetches categories from YNAB (`GET /categories`) and resolves `"Group: Category"` to `category_id`.
- Category assignment is best-effort: if category lookup fails or no rule matches, transaction creation continues uncategorized (no sync regression).
- `buildYNABPreviewRows` now includes `categoria_inferida` so CSV diagnostics show what category would be assigned before syncing.
- Rule generation script: `tools/build_category_rules.py` builds `shared/category-rules.js` from a YNAB TSV export and reports ambiguous payees for manual review.
- Visual editor helper: `tools/build_category_rules_editor.py` reads `loaders/unified.loader.gabo.js`, fetches `GET /budgets/{budgetId}/categories`, and injects a strict category list into `tools/category-rules-editor.html`. The HTML uses marker comments (`/*__YNAB_CATEGORIES_START__*/` ... `/*__YNAB_CATEGORIES_END__*/`) so the list can be regenerated in-place repeatedly.

## YNAB API Batch

- `runSyncYNAB` uses batch endpoints for all write operations to minimize API call count (limit: 200/hour).
- **Create:** `POST /budgets/{id}/transactions` with `{ transactions: [...] }` (body key is `transactions`, not `transaction`). Response: `data.data.transactions` (created), `data.data.duplicate_import_ids` (already existed, NOT under `data.data.bulk`).
- **Update (fuzzy date fix + mark):** `PATCH /budgets/{id}/transactions` (no `/{txId}`) with `{ transactions: [{id, ...fields}, ...] }`. Each object needs `id` plus only the fields to change. Response: `data.data.transactions` (updated), HTTP 209.
- Fuzzy updates and "marcar" entries are combined into a single PATCH payload.
- Payloads are chunked in groups of 50 via `chunkArray(arr, 50)` and processed sequentially (not in parallel) to avoid rate limit spikes.
- `createYNABTransactionsBulk` and `updateYNABTransactionsBulk` are exported in `BankYNABLib`. The singular `createYNABTransaction` and `updateYNABTransaction` are also kept and exported for potential external use.
- YNAB batch API: `POST /budgets/{id}/transactions` accepts `{ transactions: [...] }` for bulk create. `PATCH /budgets/{id}/transactions` (no txId in path) accepts `{ transactions: [{ id, ...fields }] }` for bulk update. `duplicate_import_ids` is at `data.data.duplicate_import_ids`, NOT under `data.data.bulk`. No documented batch size limit; chunk at 50 for safety.
- `createYNABTransaction` and `updateYNABTransaction` are exported in `BankYNABLib` API object (lines 670-671 of shared/lib.js). Even after adding bulk variants, keep the singular functions exported for backward compatibility.
