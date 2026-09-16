#!/usr/bin/env python3
"""Verify every loan figure quoted in 06-loans.md.

The design document states specific rupee amounts for EMIs, lifetime interest,
interest saved and equivalent rates. This script recomputes all of them from
first principles and asserts they match, so the document cannot silently drift
from the arithmetic it claims.

Run with no arguments to verify the document. Use the sub-commands to model
your own loan.

    python verify_amortisation.py                     # verify doc figures
    python verify_amortisation.py emi 5000000 8.5 240
    python verify_amortisation.py prepay 5000000 8.5 240 500000 24

Python 3.9+. Requires `rich` (pip install rich).
"""

from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP
from typing import Dict, List, Optional, Tuple

from rich.console import Console
from rich.logging import RichHandler
from rich.table import Table

console = Console()
log = logging.getLogger("amort")

# Guard against a runaway loop if an instalment never covers the interest.
MAX_MONTHS = 1200


def rupees(value: float) -> str:
    """Format in the Indian grouping system: 12,34,567."""
    whole = int(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    sign, digits = ("-", str(-whole)) if whole < 0 else ("", str(whole))
    if len(digits) <= 3:
        return f"{sign}₹{digits}"
    head, tail = digits[:-3], digits[-3:]
    parts: List[str] = []
    while len(head) > 2:
        parts.insert(0, head[-2:])
        head = head[:-2]
    if head:
        parts.insert(0, head)
    return f"{sign}₹{','.join(parts)},{tail}"


def r0(value: float) -> int:
    """Round half-up to the rupee. Display only — never used inside the engine."""
    return int(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


@dataclass(frozen=True)
class Instalment:
    """One row of an amortisation schedule."""

    number: int
    opening: float
    payment: float
    interest: float
    principal: float
    closing: float


@dataclass
class Outcome:
    """The result of running a schedule to closure."""

    total_interest: float
    months: int
    final_emi: float
    rows: List[Instalment] = field(default_factory=list, repr=False)


class ReducingBalanceLoan:
    """A loan accruing interest on the outstanding balance at monthly rests.

    This is the correct model for home, education and most car loans in India,
    and the model the design document's engine rules (06-loans.md R16 M1) assume.
    """

    def __init__(self, principal: float, annual_rate_pct: float, months: int) -> None:
        if principal <= 0:
            raise ValueError("principal must be positive")
        if months <= 0:
            raise ValueError("months must be positive")
        self.principal = principal
        self.annual_rate_pct = annual_rate_pct
        self.months = months

    @property
    def monthly_rate(self) -> float:
        return self.annual_rate_pct / 1200.0

    def emi(self, principal: Optional[float] = None, months: Optional[int] = None) -> float:
        """EMI = P.r.(1+r)^n / ((1+r)^n - 1)."""
        p = self.principal if principal is None else principal
        n = self.months if months is None else months
        r = self.monthly_rate
        if r == 0:
            return p / n
        factor = (1 + r) ** n
        return p * r * factor / (factor - 1)

    def run(
        self,
        emi_amount: Optional[float] = None,
        prepayments: Optional[Dict[int, float]] = None,
        extra_monthly: float = 0.0,
        prepay_mode: str = "tenure",
    ) -> Outcome:
        """Amortise to closure.

        prepay_mode 'tenure' keeps the EMI and lets the loan close early.
        prepay_mode 'emi' keeps the original closure month and lowers the EMI.
        """
        if prepay_mode not in {"tenure", "emi"}:
            raise ValueError("prepay_mode must be 'tenure' or 'emi'")

        r = self.monthly_rate
        balance = self.principal
        payment = emi_amount if emi_amount is not None else self.emi()
        prepayments = dict(prepayments or {})
        total_interest = 0.0
        rows: List[Instalment] = []
        month = 0

        while balance > 0.005:
            month += 1
            if month > MAX_MONTHS:
                # Only reachable if the instalment never covers the interest,
                # which 06-loans.md R17.4 requires the app to refuse outright.
                raise RuntimeError(
                    "schedule does not converge - instalment below monthly interest "
                    "(negative amortisation)"
                )
            opening = balance
            interest = balance * r
            total_interest += interest
            due = min(payment + extra_monthly, balance + interest)
            balance = balance + interest - due

            if month in prepayments:
                applied = min(prepayments[month], balance)
                balance -= applied
                if prepay_mode == "emi" and balance > 0:
                    remaining = self.months - month
                    if remaining > 0:
                        payment = self.emi(balance, remaining)

            rows.append(
                Instalment(month, opening, due, interest, due - interest, max(balance, 0.0))
            )

        return Outcome(total_interest, month, payment, rows)


class FlatRateLoan:
    """A loan quoting interest on the ORIGINAL principal for the whole tenure.

    Common on Indian car, personal, gold and consumer-durable loans, and the
    reason 06-loans.md R16 M2 requires the equivalent reducing rate to be shown.
    """

    def __init__(self, principal: float, annual_flat_pct: float, months: int) -> None:
        self.principal = principal
        self.annual_flat_pct = annual_flat_pct
        self.months = months

    @property
    def total_interest(self) -> float:
        return self.principal * self.annual_flat_pct / 100.0 * (self.months / 12.0)

    @property
    def emi(self) -> float:
        return (self.principal + self.total_interest) / self.months

    def equivalent_reducing_rate(self) -> float:
        """Bisect for the reducing-balance rate producing the same EMI."""
        target = self.emi
        low, high = 0.01, 100.0
        for _ in range(200):
            mid = (low + high) / 2
            if ReducingBalanceLoan(self.principal, mid, self.months).emi() < target:
                low = mid
            else:
                high = mid
        return low


class DocumentVerifier:
    """Recompute every figure quoted in 06-loans.md and assert it still holds."""

    HOME_P, HOME_R, HOME_N = 5_000_000.0, 8.5, 240
    PREPAY_AMOUNT, PREPAY_MONTH = 500_000.0, 24
    EXTRA_MONTHLY = 5_000.0

    def __init__(self) -> None:
        self.checks: List[Tuple[str, int, int]] = []

    def expect(self, label: str, actual: float, quoted: int) -> None:
        self.checks.append((label, r0(actual), quoted))

    def run(self) -> bool:
        home = ReducingBalanceLoan(self.HOME_P, self.HOME_R, self.HOME_N)
        base = home.run()
        self.expect("Home loan EMI", home.emi(), 43_391)
        self.expect("Home loan lifetime interest", base.total_interest, 5_413_879)
        self.expect("Home loan total repaid", self.HOME_P + base.total_interest, 10_413_879)

        prepay = {self.PREPAY_MONTH: self.PREPAY_AMOUNT}
        by_tenure = home.run(prepayments=prepay, prepay_mode="tenure")
        by_emi = home.run(prepayments=prepay, prepay_mode="emi")
        self.expect("Prepay/tenure - interest", by_tenure.total_interest, 3_956_578)
        self.expect("Prepay/tenure - saved", base.total_interest - by_tenure.total_interest, 1_457_301)
        self.expect("Prepay/tenure - months", by_tenure.months, 195)
        self.expect("Prepay/EMI - interest", by_emi.total_interest, 4_935_985)
        self.expect("Prepay/EMI - saved", base.total_interest - by_emi.total_interest, 477_894)
        self.expect("Prepay/EMI - new EMI", by_emi.final_emi, 38_864)
        self.expect(
            "Tenure advantage over EMI",
            by_emi.total_interest - by_tenure.total_interest,
            979_407,
        )

        extra = home.run(extra_monthly=self.EXTRA_MONTHLY)
        self.expect("Extra ₹5,000/m - interest", extra.total_interest, 4_024_629)
        self.expect("Extra ₹5,000/m - saved", base.total_interest - extra.total_interest, 1_389_250)
        self.expect("Extra ₹5,000/m - months", extra.months, 187)

        self.expect("Pre-EMI on ₹10,00,000 drawn", 1_000_000 * self.HOME_R / 1200, 7_083)
        self.expect("Pre-EMI on ₹25,00,000 drawn", 2_500_000 * self.HOME_R / 1200, 17_708)

        car = FlatRateLoan(800_000, 9.0, 60)
        self.expect("Car loan flat interest", car.total_interest, 360_000)
        self.expect("Car loan EMI", car.emi, 19_333)
        self.expect(
            "Car loan equivalent reducing rate (x100)",
            car.equivalent_reducing_rate() * 100,
            1_571,
        )

        card = ReducingBalanceLoan(60_000, 15.0, 12)
        card_run = card.run()
        fee_with_gst = 199 * 1.18
        self.expect("Card EMI", card.emi(), 5_415)
        self.expect("Card EMI interest", card_run.total_interest, 4_986)
        self.expect("Card EMI fee + GST", fee_with_gst, 235)
        self.expect("Card EMI total cost", card_run.total_interest + fee_with_gst, 5_221)

        edu_p, edu_r, moratorium, repay_n = 1_500_000.0, 10.5, 48, 120
        capitalised = edu_p * ((1 + edu_r / 1200) ** moratorium) - edu_p
        serviced_emi = ReducingBalanceLoan(edu_p, edu_r, repay_n).emi()
        capital_emi = ReducingBalanceLoan(edu_p + capitalised, edu_r, repay_n).emi()
        self.expect("Education - monthly interest serviced", edu_p * edu_r / 1200, 13_125)
        self.expect("Education - total serviced", edu_p * edu_r / 100 * (moratorium / 12), 630_000)
        self.expect("Education - EMI if serviced", serviced_emi, 20_240)
        self.expect("Education - interest capitalised", capitalised, 778_776)
        self.expect("Education - balance if capitalised", edu_p + capitalised, 2_278_776)
        self.expect("Education - EMI if capitalised", capital_emi, 30_749)
        self.expect("Education - cost of not servicing", capital_emi - serviced_emi, 10_508)

        balance_at_reset = self.HOME_P
        rate = home.monthly_rate
        for _ in range(24):
            balance_at_reset += balance_at_reset * rate - home.emi()
        self.expect("Balance at month 24", balance_at_reset, 4_792_181)

        reset = ReducingBalanceLoan(balance_at_reset, 9.0, 216)
        keep_emi = reset.run(emi_amount=home.emi())
        self.expect("Reset, keep EMI - months", keep_emi.months, 236)
        self.expect("Reset, keep tenure - new EMI", reset.emi(), 44_876)
        self.expect("Reset, keep tenure - increase", reset.emi() - home.emi(), 1_485)

        return self.report()

    def report(self) -> bool:
        table = Table(title="06-loans.md — quoted figures vs recomputed", header_style="bold")
        table.add_column("Figure")
        table.add_column("Document", justify="right")
        table.add_column("Computed", justify="right")
        table.add_column("", justify="center")

        failures = 0
        for label, actual, quoted in self.checks:
            ok = actual == quoted
            failures += 0 if ok else 1
            table.add_row(
                label,
                f"{quoted:,}",
                f"{actual:,}",
                "[green]✓[/green]" if ok else "[red]✗[/red]",
                style=None if ok else "red",
            )

        console.print(table)
        if failures:
            console.print(f"[bold red]{failures} figure(s) in the document no longer match.[/bold red]")
        else:
            console.print(
                f"[bold green]All {len(self.checks)} figures verified.[/bold green] "
                "The document's arithmetic is sound."
            )
        return failures == 0


def cmd_verify(_: argparse.Namespace) -> int:
    return 0 if DocumentVerifier().run() else 1


def cmd_emi(args: argparse.Namespace) -> int:
    loan = ReducingBalanceLoan(args.principal, args.rate, args.months)
    outcome = loan.run()
    table = Table(title=f"{rupees(args.principal)} at {args.rate}% over {args.months} months")
    table.add_column("Measure")
    table.add_column("Value", justify="right")
    table.add_row("EMI", rupees(loan.emi()))
    table.add_row("Lifetime interest", rupees(outcome.total_interest))
    table.add_row("Total repaid", rupees(args.principal + outcome.total_interest))
    table.add_row("Interest as % of principal", f"{outcome.total_interest / args.principal:.1%}")
    console.print(table)
    return 0


def cmd_prepay(args: argparse.Namespace) -> int:
    loan = ReducingBalanceLoan(args.principal, args.rate, args.months)
    base = loan.run()
    prepay = {args.month: args.amount}
    by_tenure = loan.run(prepayments=prepay, prepay_mode="tenure")
    by_emi = loan.run(prepayments=prepay, prepay_mode="emi")

    table = Table(
        title=f"Prepaying {rupees(args.amount)} at month {args.month}",
        header_style="bold",
    )
    table.add_column("")
    table.add_column("Reduce tenure (default)", justify="right", style="green")
    table.add_column("Reduce EMI", justify="right")
    table.add_row("EMI after", rupees(loan.emi()) + " (unchanged)", rupees(by_emi.final_emi))
    table.add_row("Tenure after", f"{by_tenure.months} months", f"{by_emi.months} months")
    table.add_row("Lifetime interest", rupees(by_tenure.total_interest), rupees(by_emi.total_interest))
    table.add_row(
        "Interest saved",
        rupees(base.total_interest - by_tenure.total_interest),
        rupees(base.total_interest - by_emi.total_interest),
    )
    table.add_row("EMIs saved", str(base.months - by_tenure.months), "0")
    console.print(table)

    delta = by_emi.total_interest - by_tenure.total_interest
    better, worse = ("Tenure", "EMI") if delta > 0 else ("EMI", "tenure")
    console.print(
        f"\n[bold]{better} reduction saves {rupees(abs(delta))} more[/bold] than {worse} reduction."
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Amortisation engine and verifier for 06-loans.md",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="enable debug logging")
    sub = parser.add_subparsers(dest="command")

    p_verify = sub.add_parser("verify", help="verify the figures quoted in 06-loans.md (default)")
    p_verify.set_defaults(func=cmd_verify)

    p_emi = sub.add_parser("emi", help="EMI and lifetime interest for a loan")
    p_emi.add_argument("principal", type=float)
    p_emi.add_argument("rate", type=float, help="annual reducing-balance rate, e.g. 8.5")
    p_emi.add_argument("months", type=int)
    p_emi.set_defaults(func=cmd_emi)

    p_pre = sub.add_parser("prepay", help="compare tenure reduction against EMI reduction")
    p_pre.add_argument("principal", type=float)
    p_pre.add_argument("rate", type=float)
    p_pre.add_argument("months", type=int)
    p_pre.add_argument("amount", type=float, help="lump sum prepaid")
    p_pre.add_argument("month", type=int, help="instalment number at which it is prepaid")
    p_pre.set_defaults(func=cmd_prepay)

    parser.set_defaults(func=cmd_verify)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(message)s",
        handlers=[RichHandler(console=console, rich_tracebacks=True, show_path=False)],
    )
    try:
        return int(args.func(args))
    except (ValueError, RuntimeError) as exc:
        log.error("%s", exc)
        return 2


if __name__ == "__main__":
    sys.exit(main())
