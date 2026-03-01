#!/usr/bin/env python3
"""
Build/update tools/category-rules-editor.html with YNAB categories preloaded.

The script:
1) Reads loader config (accessToken + budgetId) from a local loader file.
2) Calls YNAB API /budgets/{budgetId}/categories.
3) Injects category names ("Group: Category") into the editor HTML file.

Usage:
  python3 tools/build_category_rules_editor.py
  python3 tools/build_category_rules_editor.py --loader loaders/unified.loader.gabo.js
"""

from __future__ import annotations

import argparse
import json
import re
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path


CATEGORIES_START = "/*__YNAB_CATEGORIES_START__*/"
CATEGORIES_END = "/*__YNAB_CATEGORIES_END__*/"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch categories from YNAB and inject them into the HTML editor."
    )
    parser.add_argument(
        "--loader",
        default="loaders/unified.loader.gabo.js",
        help="Path to loader script that contains CONFIG.accessToken and CONFIG.budgetId",
    )
    parser.add_argument(
        "--editor",
        default="tools/category-rules-editor.html",
        help="Path to HTML editor file to update in-place",
    )
    return parser.parse_args()


def read_text(path: Path) -> str:
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")
    return path.read_text(encoding="utf-8")


def extract_loader_values(loader_text: str) -> tuple[str, str]:
    token_match = re.search(r"accessToken\s*:\s*'([^']+)'", loader_text)
    budget_match = re.search(r"budgetId\s*:\s*'([^']+)'", loader_text)

    if not token_match:
        raise ValueError("Could not find CONFIG.accessToken in loader.")
    if not budget_match:
        raise ValueError("Could not find CONFIG.budgetId in loader.")

    return token_match.group(1), budget_match.group(1)


def fetch_ynab_categories(access_token: str, budget_id: str) -> list[str]:
    url = f"https://api.ynab.com/v1/budgets/{budget_id}/categories"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
        method="GET",
    )

    secure_context = ssl.create_default_context()

    try:
        with urllib.request.urlopen(req, timeout=20, context=secure_context) as res:
            payload = json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"YNAB API error {err.code}: {body}") from err
    except urllib.error.URLError as err:
        reason = str(getattr(err, "reason", err))
        if "CERTIFICATE_VERIFY_FAILED" not in reason:
            raise RuntimeError(f"Network error calling YNAB API: {err}") from err
        # Some macOS Python installs ship without the system CA bundle wired up.
        # Guide the user to fix this properly rather than silently downgrading security.
        raise RuntimeError(
            "SSL certificate verification failed. "
            "On macOS, run: /Applications/Python*/Install\\ Certificates.command  "
            "or: pip install certifi && REQUESTS_CA_BUNDLE=$(python3 -c 'import certifi; print(certifi.where())') "
            "python3 tools/build_category_rules_editor.py"
        ) from err

    groups = payload.get("data", {}).get("category_groups", [])
    categories: list[str] = []
    for group in groups:
        if not group or group.get("deleted"):
            continue
        group_name = group.get("name")
        if not group_name:
            continue
        for category in group.get("categories", []):
            if not category or category.get("deleted"):
                continue
            category_name = category.get("name")
            if not category_name:
                continue
            categories.append(f"{group_name}: {category_name}")

    # Stable deterministic order and dedupe.
    return sorted(set(categories), key=lambda x: x.casefold())


def inject_categories(editor_html: str, categories: list[str]) -> str:
    start = re.escape(CATEGORIES_START)
    end = re.escape(CATEGORIES_END)
    pattern = re.compile(rf"{start}[\s\S]*?{end}", re.MULTILINE)

    replacement = (
        f"{CATEGORIES_START}"
        + json.dumps(categories, ensure_ascii=False, indent=2)
        + f"{CATEGORIES_END}"
    )

    if not pattern.search(editor_html):
        raise ValueError(
            "Could not find category markers in editor HTML. "
            f"Expected markers: {CATEGORIES_START} ... {CATEGORIES_END}"
        )

    return pattern.sub(replacement, editor_html, count=1)


def main() -> int:
    args = parse_args()
    root = Path.cwd()
    loader_path = (root / args.loader).resolve()
    editor_path = (root / args.editor).resolve()

    try:
        loader_text = read_text(loader_path)
        editor_html = read_text(editor_path)
        access_token, budget_id = extract_loader_values(loader_text)
        categories = fetch_ynab_categories(access_token, budget_id)
        new_html = inject_categories(editor_html, categories)
        editor_path.write_text(new_html, encoding="utf-8")
    except Exception as exc:  # pylint: disable=broad-except
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1

    print(
        f"[OK] Injected {len(categories)} categories into {editor_path.relative_to(root)} "
        f"(budgetId={budget_id})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
