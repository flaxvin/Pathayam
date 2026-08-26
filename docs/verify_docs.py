#!/usr/bin/env python3
"""
verify_docs.py — catch stale normative lines in the design docs.

Proposed in `10-errata-and-addenda.md` §3.4, in the spirit of
verify_amortisation.py and verify_portfolio.py: those pin the rupee figures,
this pins the *rules*.

The errata in `10` §2 are all one shape — a normative sentence still asserting
something a later closure withdrew. `02` F1.8 says the app "MUST function fully
offline"; an agent following it would rebuild the entire subsystem R35 deleted.
That is an executable defect, not a typo, and it is exactly what a short script
can find.

    python3 docs/verify_docs.py           # check
    python3 docs/verify_docs.py --list    # show every allow-listed line

False positives are resolved with an inline marker, the same way the rupee
figures are pinned today:

    <!-- verify_docs: allow offline — quoting the withdrawn F1.8 -->

Exit code 0 when clean, 1 when something needs attention.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

DOCS = Path(__file__).parent

# Tokens that a 26-08-2026 closure withdrew. Seeing one inside a MUST/SHOULD
# sentence means the sentence probably outlived its decision.
WITHDRAWN_TOKENS = {
    "offline": "R35 — the client is server-only; there is no offline mode",
    "service worker": "Q21 / R35.1 — no service worker is registered, without exception",
    "localstorage": "R35 — no client-side storage of user data",
    "sessionstorage": "R35 — no client-side storage of user data",
    "indexeddb": "R35 — no client-side storage of user data",
    "cache api": "R35 — no client-side storage of user data",
    "sync queue": "R35 §3.2 — the write queue is out of scope",
    "push": "Q21 — push notifications are dropped entirely",
}

# Rule ids withdrawn outright. Any reference outside a withdrawal context is
# stale wherever it appears, normative or not.
WITHDRAWN_RULE_IDS = [
    (re.compile(r"\bPWA(?:[1-9]|10)\b"), "PWA1–PWA10 were superseded by `08` §3 / F21"),
    (re.compile(r"\bR35\.6\b"), "R35.6 was withdrawn on 26-08-2026 (Q21)"),
    (re.compile(r"\bF21\.7\b"), "F21.7 was withdrawn on 26-08-2026 (Q21)"),
]

NORMATIVE = re.compile(r"\b(MUST|SHOULD|MAY)\b")

# A sentence that *forbids* the thing is the correction, not the defect.
NEGATED = re.compile(
    r"""(
        MUST\s+NOT | SHOULD\s+NOT | MAY\s+NOT | never | no\s+longer |
        withdraw | supersed | reverses? | reversal | deleted | dropped |
        out\s+of\s+scope | forbid | refus | \bno\s | \bnot\s | without |
        replaced | stale | errat | deprecat | originally
    )""",
    re.IGNORECASE | re.VERBOSE,
)

# A withdrawal is often announced once and then listed as bullets — `08` §3.2
# opens "Every one of these is now out of scope and MUST NOT be built" and then
# names each deleted rule. Line-by-line matching cannot see that, so a few
# lines of preceding context are carried.
CONTEXT_LINES = 8

ALLOW = re.compile(r"<!--\s*verify_docs:\s*allow\s+([^\s>]+)(.*?)-->", re.IGNORECASE)

# `10` is the errata itself: it quotes every stale line on purpose, and `01` is
# a competitor teardown where "offline" describes other products.
EXEMPT_FILES = {"10-errata-and-addenda.md", "01-competitive-analysis.md", "verify_docs.py"}


@dataclass
class Finding:
    file: str
    line_no: int
    token: str
    why: str
    text: str

    def render(self) -> str:
        return (
            f"  {self.file}:{self.line_no}\n"
            f"    token   : {self.token}\n"
            f"    because : {self.why}\n"
            f"    line    : {self.text.strip()[:140]}\n"
        )


def parse_errata(path: Path) -> set[tuple[str, str]]:
    """
    Read `10` §2 for lines already corrected by supersession.

    Returns (doc number, rule id) pairs — ("02", "F1.8") and so on. A finding
    matching one of these is *known*: the errata is the authority for it, and
    re-reporting it is noise rather than signal.
    """
    known: set[tuple[str, str]] = set()
    if not path.exists():
        return known

    row = re.compile(r"^\|\s*E\d+\s*\|\s*`(\d{2})`\s*([^|]*)\|")
    ident = re.compile(r"\b((?:F|R|N|PR|S|J|L|Q)\d+(?:\.\d+)*[a-z]?|§\d+(?:\.\d+)*)")

    for line in path.read_text(encoding="utf-8").splitlines():
        match = row.match(line)
        if not match:
            continue
        doc = match.group(1)
        for rule in ident.findall(match.group(2)):
            known.add((doc, rule))
    return known


def is_known_erratum(
    path: Path, text: str, heading: str, known: set[tuple[str, str]]
) -> bool:
    """
    Several errata rows name a *section* rather than a rule id on the line
    itself — E4 is "`03` S3", and the stale sentence inside it mentions neither.
    So the current heading is matched as well as the line.
    """
    doc = path.name[:2]
    for known_doc, rule in known:
        if known_doc != doc:
            continue
        pattern = rf"(?<![\w.]){re.escape(rule)}(?![\w.])"
        if re.search(pattern, text) or re.search(pattern, heading):
            return True
    return False


def strip_code_blocks(lines: list[str]) -> list[bool]:
    """Mark lines inside fenced code blocks, which are examples not assertions."""
    inside = False
    flags: list[bool] = []
    for line in lines:
        if line.lstrip().startswith("```"):
            inside = not inside
            flags.append(True)
        else:
            flags.append(inside)
    return flags


def check_file(
    path: Path, known: set[tuple[str, str]]
) -> tuple[list[Finding], list[Finding], list[str]]:
    findings: list[Finding] = []
    already_corrected: list[Finding] = []
    allowed_lines: list[str] = []

    lines = path.read_text(encoding="utf-8").splitlines()
    in_code = strip_code_blocks(lines)
    heading = ""

    for i, line in enumerate(lines, start=1):
        if in_code[i - 1]:
            continue
        if line.lstrip().startswith("#"):
            heading = line
            continue

        allow_match = ALLOW.search(line)
        allowed = allow_match.group(1).lower() if allow_match else None
        if allowed:
            allowed_lines.append(f"{path.name}:{i} allow {allowed}")

        lowered = line.lower()
        context = " ".join(lines[max(0, i - 1 - CONTEXT_LINES) : i])
        in_withdrawal_block = bool(NEGATED.search(context))

        for token, why in WITHDRAWN_TOKENS.items():
            if token not in lowered:
                continue
            if allowed in (token, "all"):
                continue
            # Only normative sentences are defects; prose describing history
            # is the doc set's own convention (00 §Reversals).
            if not NORMATIVE.search(line):
                continue
            if NEGATED.search(line) or in_withdrawal_block:
                continue
            finding = Finding(path.name, i, token, why, line)
            bucket = already_corrected if is_known_erratum(path, line, heading, known) else findings
            bucket.append(finding)

        for pattern, why in WITHDRAWN_RULE_IDS:
            match = pattern.search(line)
            if not match:
                continue
            if allowed in (match.group(0).lower(), "all"):
                continue
            if NEGATED.search(line) or in_withdrawal_block:
                continue
            finding = Finding(path.name, i, match.group(0), why, line)
            bucket = already_corrected if is_known_erratum(path, line, heading, known) else findings
            bucket.append(finding)

    return findings, already_corrected, allowed_lines


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="show allow-listed lines")
    args = parser.parse_args()

    targets = sorted(p for p in DOCS.glob("*.md") if p.name not in EXEMPT_FILES)
    known = parse_errata(DOCS / "10-errata-and-addenda.md")

    all_findings: list[Finding] = []
    all_corrected: list[Finding] = []
    all_allowed: list[str] = []
    for path in targets:
        findings, corrected, allowed = check_file(path, known)
        all_findings.extend(findings)
        all_corrected.extend(corrected)
        all_allowed.extend(allowed)

    if args.list:
        print(f"Allow-listed lines ({len(all_allowed)}):")
        for entry in all_allowed:
            print(f"  {entry}")
        print()

    print(f"Checked {len(targets)} documents for lines outlived by the 26-08-2026 closures.")
    print(f"Exempt: {', '.join(sorted(EXEMPT_FILES))}")
    print(f"Known errata in `10` §2: {len(known)} rule references\n")

    if all_corrected:
        # Found, and already corrected by supersession. Reported so the tool is
        # visibly working, but not a failure — `10` is the authority for these.
        print(f"{len(all_corrected)} stale line(s), already superseded by `10` §2:")
        for finding in all_corrected:
            print(f"  {finding.file}:{finding.line_no}  {finding.token}  — {finding.text.strip()[:80]}")
        print()

    if not all_findings:
        print("Clean — every stale normative line is already corrected by the errata.")
        return 0

    print(f"{len(all_findings)} stale normative line(s):\n")
    for finding in all_findings:
        print(finding.render())

    print(
        "Each of these is a line a reader — or an agent — would follow.\n"
        "Correct it by adding a row to `10-errata-and-addenda.md` §2 rather than\n"
        "editing history, then mark the line:\n"
        "    <!-- verify_docs: allow <token> — reason -->"
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
