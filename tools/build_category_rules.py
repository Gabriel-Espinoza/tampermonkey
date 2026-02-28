#!/usr/bin/env python3
"""
Build deterministic YNAB auto-categorization rules from a YNAB TSV export.

Usage:
  python3 tools/build_category_rules.py \
    --input "/path/to/YNAB Export.tsv" \
    --output "shared/category-rules.js"
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path


SKIP_PREFIXES = [
    "transfer itau",
    "starting balance",
    "abono canje compra tc",
    "cashback com",
]

TOKEN_STOPWORDS = {
    "compra",
    "compras",
    "santiago",
    "condes",
    "plaza",
    "tienda",
    "local",
    "web",
}


def normalize_text(value: str) -> str:
    text = (value or "").strip().lower()
    if not text:
        return ""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.replace("\u00a0", " ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build YNAB category rules from TSV export")
    parser.add_argument("--input", required=True, help="Path to YNAB export TSV file")
    parser.add_argument("--output", required=True, help="Path to output JS rules file")
    return parser.parse_args()


def read_rows(tsv_path: Path) -> list[dict[str, str]]:
    with tsv_path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh, delimiter="\t")
        return list(reader)


def should_skip_payee(normalized_payee: str) -> bool:
    if not normalized_payee:
        return True
    return any(
        normalized_payee == prefix or normalized_payee.startswith(prefix + " ")
        for prefix in SKIP_PREFIXES
    )


def build_exact_and_stats(rows: list[dict[str, str]]):
    payee_to_category_counts: dict[str, Counter] = defaultdict(Counter)
    payee_examples: dict[str, Counter] = defaultdict(Counter)

    for row in rows:
        category = (row.get("Category Group/Category") or "").strip()
        if not category or category.startswith("Inflow:"):
            continue

        payee = (row.get("Payee") or "").strip()
        payee_norm = normalize_text(payee)
        if should_skip_payee(payee_norm):
            continue

        payee_to_category_counts[payee_norm][category] += 1
        payee_examples[payee_norm][payee] += 1

    exact: dict[str, str] = {}
    ambiguous: list[dict[str, object]] = []

    for payee_norm, cat_counter in sorted(payee_to_category_counts.items()):
        total = sum(cat_counter.values())
        top_category, top_count = cat_counter.most_common(1)[0]
        confidence = top_count / total if total else 0.0
        exact[payee_norm] = top_category

        if len(cat_counter) > 1:
            ambiguous.append(
                {
                    "payee_norm": payee_norm,
                    "sample_payee": payee_examples[payee_norm].most_common(1)[0][0],
                    "top_category": top_category,
                    "confidence": round(confidence, 4),
                    "distribution": dict(cat_counter),
                }
            )

    return exact, ambiguous


def build_patterns(exact: dict[str, str]) -> list[dict[str, str]]:
    starts_with: list[dict[str, str]] = []
    contains: list[dict[str, str]] = []

    prefix_to_category_counts: dict[str, Counter] = defaultdict(Counter)
    prefix_to_payees: dict[str, set[str]] = defaultdict(set)
    token_to_category_counts: dict[str, Counter] = defaultdict(Counter)

    for payee_norm, category in exact.items():
        parts = payee_norm.split()
        if not parts:
            continue

        prefix = parts[0]
        if len(prefix) >= 4 and prefix not in TOKEN_STOPWORDS and not prefix.isdigit():
            prefix_to_category_counts[prefix][category] += 1
            prefix_to_payees[prefix].add(payee_norm)

        unique_tokens = set(parts)
        for token in unique_tokens:
            if len(token) < 6 or token in TOKEN_STOPWORDS or token.isdigit():
                continue
            token_to_category_counts[token][category] += 1

    for prefix, cat_counter in sorted(prefix_to_category_counts.items()):
        payee_count = len(prefix_to_payees[prefix])
        total = sum(cat_counter.values())
        if payee_count < 3 or total < 3:
            continue
        top_category, top_count = cat_counter.most_common(1)[0]
        if (top_count / total) >= 0.9:
            starts_with.append(
                {
                    "type": "startsWith",
                    "value": prefix,
                    "category": top_category,
                }
            )

    for token, cat_counter in sorted(token_to_category_counts.items()):
        total = sum(cat_counter.values())
        if total < 4:
            continue
        top_category, top_count = cat_counter.most_common(1)[0]
        if (top_count / total) >= 0.95:
            contains.append(
                {
                    "type": "contains",
                    "value": token,
                    "category": top_category,
                }
            )

    existing_prefix_values = {p["value"] for p in starts_with}
    contains = [p for p in contains if p["value"] not in existing_prefix_values]

    return starts_with + contains


def write_rules(output_path: Path, input_path: Path, exact: dict[str, str], patterns: list[dict[str, str]]) -> None:
    payload = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source_file": input_path.name,
        "exact": exact,
        "patterns": patterns,
        "skip": SKIP_PREFIXES,
    }

    body = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
    out = (
        "(function (root) {\n"
        "  'use strict';\n\n"
        f"  root.YNABCategoryRules = {body};\n"
        "})(typeof window !== 'undefined' ? window : this);\n"
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(out, encoding="utf-8")


def main() -> int:
    args = parse_args()
    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()

    rows = read_rows(input_path)
    exact, ambiguous = build_exact_and_stats(rows)
    patterns = build_patterns(exact)
    write_rules(output_path, input_path, exact, patterns)

    print(f"Rows read: {len(rows)}")
    print(f"Exact rules: {len(exact)}")
    print(f"Pattern rules: {len(patterns)}")
    print(f"Ambiguous payees: {len(ambiguous)}")

    if ambiguous:
        print("\nTop ambiguous payees:")
        ambiguous_sorted = sorted(ambiguous, key=lambda x: (x["confidence"], x["payee_norm"]))
        for item in ambiguous_sorted[:20]:
            print(
                f"- {item['payee_norm']} -> {item['top_category']} "
                f"(confidence={item['confidence']}, distribution={item['distribution']})"
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
