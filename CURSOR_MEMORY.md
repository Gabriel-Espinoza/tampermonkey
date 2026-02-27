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
- `skipReconciled: true` is used for facturado (non-paginated) to avoid flagging already-verified transactions.

## Matching Logic (import_id vs date:amount fallback)

- YNAB transactions created via API or file import have `import_id` (e.g. `YNAB:-50000000:2026-01-23:1`).
- Manually entered YNAB transactions do NOT have `import_id`.
- Both `buildYNABPreviewRows` and `runSyncYNAB` must match by `import_id` first, then fall back to `date:amount` key for YNAB transactions without `import_id`.
- Fallback matching must track occurrence counts to handle duplicate date:amount pairs correctly (e.g. two purchases at the same store on the same day for the same amount).
