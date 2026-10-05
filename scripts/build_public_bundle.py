#!/usr/bin/env python3
"""Build a compact, static PrefScope bundle for the public viewer.

The research export intentionally retains more transcripts than a public web
deployment should ship.  This script keeps all aggregate analysis artifacts,
caps per-feature evidence, retains only joint evidence referenced by exported
elicitation/significant conditional results, and omits the monolithic
``examples_by_model.json`` file (the viewer falls back to report_battles.json).
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SHARDED = {"examples/", "joint_examples/", "prompt_examples/"}

PROFILES: dict[str, dict[str, Any]] = {
    # Public keeps the aggregate analysis and enough stratified evidence to inspect
    # every exported language/source without publishing the complete transcript bank.
    "public": {
        "feature_examples": 3,
        "feature_examples_per_group": 1,
        "feature_examples_per_mode": 1,
        "joint_examples": 1,
        "joint_examples_per_group": 1,
        "coactivation_examples": 1,
        "coactivation_examples_per_group": 1,
        "omit": {"examples_by_model.json", "examples.json"},
    },
    # Collaborator is still compact and redacted, but retains enough evidence to compare
    # languages and inspect random/boundary examples alongside the strongest activators.
    "collaborator": {
        "feature_examples": 8,
        "feature_examples_per_group": 2,
        "feature_examples_per_mode": 3,
        "joint_examples": 3,
        "joint_examples_per_group": 1,
        "coactivation_examples": 3,
        "coactivation_examples_per_group": 1,
        "omit": {"examples.json"},
    },
    # Full is a deployment copy of every exported artifact. Text is still redacted: the
    # profile name describes evidence coverage, not a promise that raw secrets are safe.
    "full": {
        "feature_examples": None,
        "feature_examples_per_group": 0,
        "feature_examples_per_mode": 0,
        "joint_examples": None,
        "joint_examples_per_group": 0,
        "coactivation_examples": None,
        "coactivation_examples_per_group": 0,
        "omit": set(),
    },
}

REDACTIONS: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(
            r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?"
            r"-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
            re.IGNORECASE | re.DOTALL,
        ),
        "[REDACTED PRIVATE KEY]",
    ),
    (
        re.compile(
            r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*\Z",
            re.IGNORECASE | re.DOTALL,
        ),
        "[REDACTED PRIVATE KEY]",
    ),
    (re.compile(r"\bsk-or-v1-[A-Za-z0-9_-]{20,}\b"), "[REDACTED API KEY]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"), "[REDACTED API KEY]"),
    (re.compile(r"\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b"), "[REDACTED GITHUB TOKEN]"),
    (re.compile(r"\bhf_[A-Za-z0-9]{20,}\b"), "[REDACTED HUGGING FACE TOKEN]"),
    (re.compile(r"\bAKIA[A-Z0-9]{16}\b"), "[REDACTED AWS ACCESS KEY]"),
    (re.compile(r"\bAIza[A-Za-z0-9_-]{30,}\b"), "[REDACTED GOOGLE API KEY]"),
    (re.compile(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b"), "[REDACTED EMAIL]"),
    (
        re.compile(
            r"/(?:Users|home)/[^/\s\"']+(?:/[^\s\"']*)?"
            r"|/(?:scratch|projappl|flash)/project_465002530(?:/[^\s\"']*)?"
        ),
        "[REDACTED LOCAL PATH]",
    ),
)


def _read(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))


def _sanitize(value: Any, counts: dict[str, int]) -> Any:
    if isinstance(value, str):
        result = value
        for pattern, replacement in REDACTIONS:
            result, n = pattern.subn(replacement, result)
            if n:
                counts[replacement] = counts.get(replacement, 0) + n
        return result
    if isinstance(value, list):
        return [_sanitize(item, counts) for item in value]
    if isinstance(value, dict):
        return {key: _sanitize(item, counts) for key, item in value.items()}
    return value


def _copy_json(source: Path, output: Path, counts: dict[str, int]) -> None:
    _write(output, _sanitize(_read(source), counts))


def _balanced_indices(
    rows: list[dict[str, Any]],
    first: int | None,
    per_group: int = 0,
    per_mode: int = 0,
) -> list[int]:
    """Select ranked rows plus coverage across exported group and evidence-mode fields."""
    if first is None:
        return list(range(len(rows)))
    selected = list(range(min(max(first, 0), len(rows))))
    seen = set(selected)

    def add_by(field: str, limit: int) -> None:
        if limit <= 0:
            return
        values = sorted({str(row.get(field, "")).strip() for row in rows}
                        - {"", "None", "nan"})
        for value in values:
            added = 0
            for index, row in enumerate(rows):
                if index in seen or str(row.get(field, "")).strip() != value:
                    continue
                selected.append(index)
                seen.add(index)
                added += 1
                if added >= limit:
                    break

    add_by("group", per_group)
    add_by("selection_kind", per_mode)
    return selected


def _balanced_rows(
    rows: list[dict[str, Any]],
    first: int | None,
    per_group: int = 0,
    per_mode: int = 0,
) -> list[dict[str, Any]]:
    return [rows[index] for index in _balanced_indices(rows, first, per_group, per_mode)]


def _copy_coactivation(
    source: Path,
    output: Path,
    counts: dict[str, int],
    examples_per_pair: int | None,
    examples_per_group: int,
) -> dict[str, int]:
    """Keep only the ranked evidence rows the public pair list can display."""
    data = _read(source)
    examples = data.get("examples", {})
    kept_rows: set[str] = set()
    for pair in data.get("pairs", []):
        available = [int(row) for row in pair.get("rows", [])]
        evidence = [examples.get(str(row), {}) for row in available]
        indices = _balanced_indices(evidence, examples_per_pair, examples_per_group)
        rows = [available[index] for index in indices]
        pair["rows"] = rows
        kept_rows.update(str(row) for row in rows)
    data["examples"] = {
        row: examples[row]
        for row in sorted(kept_rows, key=int)
        if row in examples
    }
    _write(output, _sanitize(data, counts))
    return {
        "pairs": len(data.get("pairs", [])),
        "examples": len(data["examples"]),
    }


def _joint_pairs(source: Path) -> set[tuple[int, int]]:
    """Return raw prompt/response pairs that the public UI can display."""
    pairs: set[tuple[int, int]] = set()

    elicitation_path = source / "elicitation.json"
    if elicitation_path.exists():
        for edge in _read(elicitation_path).get("edges", []):
            pairs.add((int(edge["px"]), int(edge["cy"])))

    conditional_path = source / "conditional.json"
    if conditional_path.exists():
        conditional = _read(conditional_path)
        raw = conditional.get("raw", conditional)
        for cell in raw.get("cells", []):
            if cell.get("sig"):
                pairs.add((int(cell["pc"]), int(cell["f"])))

    return pairs


def build(
    source: Path,
    output: Path,
    *,
    profile: str = "public",
    feature_examples: int | None = None,
    feature_examples_per_group: int | None = None,
    feature_examples_per_mode: int | None = None,
    joint_examples: int | None = None,
    joint_examples_per_group: int | None = None,
    coactivation_examples: int | None = None,
    coactivation_examples_per_group: int | None = None,
) -> dict[str, Any]:
    if profile not in PROFILES:
        raise ValueError(f"unknown deployment profile: {profile}")
    defaults = PROFILES[profile]
    feature_examples = defaults["feature_examples"] if feature_examples is None else feature_examples
    feature_examples_per_group = (defaults["feature_examples_per_group"]
                                  if feature_examples_per_group is None else feature_examples_per_group)
    feature_examples_per_mode = (defaults["feature_examples_per_mode"]
                                 if feature_examples_per_mode is None else feature_examples_per_mode)
    joint_examples = defaults["joint_examples"] if joint_examples is None else joint_examples
    joint_examples_per_group = (defaults["joint_examples_per_group"]
                                if joint_examples_per_group is None else joint_examples_per_group)
    coactivation_examples = (defaults["coactivation_examples"]
                             if coactivation_examples is None else coactivation_examples)
    coactivation_examples_per_group = (defaults["coactivation_examples_per_group"]
                                       if coactivation_examples_per_group is None
                                       else coactivation_examples_per_group)
    omitted = defaults["omit"]
    manifest = _read(source / "bundle_manifest.json")
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    redactions: dict[str, int] = {}

    files: list[str] = []
    coactivation_stats = {"pairs": 0, "examples": 0}
    for name in manifest.get("files", []):
        if name in SHARDED or name in omitted or name.endswith("/"):
            continue
        src = source / name
        if src.is_file():
            dst = output / name
            dst.parent.mkdir(parents=True, exist_ok=True)
            if name == "coactivation.json":
                coactivation_stats = _copy_coactivation(
                    src, dst, redactions, coactivation_examples,
                    coactivation_examples_per_group,
                )
            else:
                _copy_json(src, dst, redactions)
            files.append(name)

    datasets = source / "datasets"
    if datasets.is_dir():
        for src in datasets.rglob("*.json"):
            _copy_json(src, output / "datasets" / src.relative_to(datasets), redactions)
    datasets_index = source / "datasets.json"
    if datasets_index.is_file():
        _copy_json(datasets_index, output / "datasets.json", redactions)

    examples_out = output / "examples"
    examples_written = 0
    for src in sorted((source / "examples").glob("*.json")):
        rows = _read(src)
        if not isinstance(rows, list) or not rows:
            continue
        selected = _balanced_rows(rows, feature_examples, feature_examples_per_group,
                                  feature_examples_per_mode)
        _write(examples_out / src.name, _sanitize(selected, redactions))
        examples_written += len(selected)
    if examples_written:
        files.append("examples/")

    prompt_examples_out = output / "prompt_examples"
    prompt_examples_written = 0
    for src in sorted((source / "prompt_examples").glob("*.json")):
        rows = _read(src)
        if not isinstance(rows, list):
            continue
        selected = _balanced_rows(rows, feature_examples, feature_examples_per_group,
                                  feature_examples_per_mode)
        _write(prompt_examples_out / src.name, _sanitize(selected, redactions))
        prompt_examples_written += len(selected)
    if prompt_examples_out.is_dir():
        files.append("prompt_examples/")

    allowed = _joint_pairs(source)
    joint_out = output / "joint_examples"
    joint_pairs_written = 0
    joint_examples_written = 0
    for src in sorted((source / "joint_examples").glob("*.json")):
        shard = _read(src)
        prompt_feature = int(shard.get("prompt_feature", src.stem))
        kept: dict[str, list[dict[str, Any]]] = {}
        for response_feature, rows in shard.get("examples", {}).items():
            pair = (prompt_feature, int(response_feature))
            if pair not in allowed or not rows:
                continue
            selected = _balanced_rows(rows, joint_examples, joint_examples_per_group)
            kept[str(response_feature)] = _sanitize(selected, redactions)
            joint_pairs_written += 1
            joint_examples_written += len(selected)
        if kept:
            _write(
                joint_out / src.name,
                {"prompt_feature": prompt_feature, "examples": kept},
            )
    if joint_pairs_written:
        files.append("joint_examples/")

    compact_manifest = {
        **manifest,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "files": sorted(set(files)),
        "public_profile": {
            "deployment_profile": profile,
            "feature_examples_per_feature": feature_examples,
            "feature_examples_per_group": feature_examples_per_group,
            "feature_examples_per_mode": feature_examples_per_mode,
            "prompt_examples": prompt_examples_written,
            "joint_examples_per_pair": joint_examples,
            "joint_examples_per_group": joint_examples_per_group,
            "joint_pairs": joint_pairs_written,
            "joint_examples": joint_examples_written,
            "coactivation_examples_per_pair": coactivation_examples,
            "coactivation_examples_per_group": coactivation_examples_per_group,
            "coactivation_examples": coactivation_stats["examples"],
            "omitted": sorted(omitted),
            "redactions": redactions,
        },
    }
    _write(output / "bundle_manifest.json", compact_manifest)

    return {
        "source": str(source),
        "output": str(output),
        "profile": profile,
        "artifacts": len(compact_manifest["files"]),
        "feature_examples": examples_written,
        "joint_pairs": joint_pairs_written,
        "joint_examples": joint_examples_written,
        "coactivation_examples": coactivation_stats["examples"],
        "redactions": redactions,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--profile", choices=sorted(PROFILES), default="public")
    parser.add_argument("--feature-examples", type=int)
    parser.add_argument("--feature-examples-per-group", type=int)
    parser.add_argument("--feature-examples-per-mode", type=int)
    parser.add_argument("--joint-examples", type=int)
    parser.add_argument("--joint-examples-per-group", type=int)
    parser.add_argument("--coactivation-examples", type=int)
    parser.add_argument("--coactivation-examples-per-group", type=int)
    args = parser.parse_args()
    for name, value in vars(args).items():
        if name.endswith("examples") and value is not None and value < 1:
            parser.error(f"--{name.replace('_', '-')} must be positive")
        if (name.endswith("per_group") or name.endswith("per_mode")) \
                and value is not None and value < 0:
            parser.error(f"--{name.replace('_', '-')} must be non-negative")
    summary = build(
        args.source.resolve(),
        args.output.resolve(),
        profile=args.profile,
        feature_examples=args.feature_examples,
        feature_examples_per_group=args.feature_examples_per_group,
        feature_examples_per_mode=args.feature_examples_per_mode,
        joint_examples=args.joint_examples,
        joint_examples_per_group=args.joint_examples_per_group,
        coactivation_examples=args.coactivation_examples,
        coactivation_examples_per_group=args.coactivation_examples_per_group,
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
