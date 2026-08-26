#!/usr/bin/env python3
"""Verify every portfolio, FX and net-worth figure quoted in 07-assets-networth-currency.md.

Covers unit-based cost basis, FIFO realised gains, XIRR, the asset-gain versus
FX-gain decomposition for foreign holdings, and the net worth roll-up.

    python verify_portfolio.py                 # verify the document
    python verify_portfolio.py xirr            # XIRR of the worked SIP
    python verify_portfolio.py fx 150 180 83 95.51 10

Python 3.9+. Requires `rich` (pip install rich).
"""

from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from typing import List, Optional, Sequence, Tuple

from rich.console import Console
from rich.logging import RichHandler
from rich.table import Table

console = Console()
log = logging.getLogger("portfolio")

DAYS_PER_YEAR = 365.0
XIRR_MAX_ITERATIONS = 200
XIRR_TOLERANCE = 1e-9


def r2(value: float) -> float:
    """Round half-up to two decimals. Display only."""
    return float(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def r3(value: float) -> float:
    """Round half-up to three decimals — the precision mutual fund units carry."""
    return float(Decimal(str(value)).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP))


def rupees(value: float) -> str:
    """Indian digit grouping: 12,34,567.89."""
    negative = value < 0
    whole, frac = f"{abs(r2(value)):.2f}".split(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        parts: List[str] = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        whole = f"{','.join(parts)},{tail}"
    return f"{'-' if negative else ''}₹{whole}.{frac}"


@dataclass(frozen=True)
class Lot:
    """One purchase of an instrument, held for FIFO cost-basis accounting."""

    trade_date: date
    units: float
    price: float

    @property
    def cost(self) -> float:
        return self.units * self.price


@dataclass(frozen=True)
class CashFlow:
    """A dated cash movement. Negative is money out, positive is money in."""

    on: date
    amount: float


class Holding:
    """A unit-based position with FIFO lot accounting.

    Mutual fund units and equity shares behave identically here; only the
    price source differs (07 §6).
    """

    def __init__(self, name: str, lots: Optional[Sequence[Lot]] = None) -> None:
        self.name = name
        self.lots: List[Lot] = list(lots or [])

    def buy(self, trade_date: date, amount: float, price: float) -> Lot:
        """Buy by rupee amount — how SIPs actually work: units fall out of the NAV."""
        if price <= 0:
            raise ValueError("price must be positive")
        lot = Lot(trade_date, amount / price, price)
        self.lots.append(lot)
        return lot

    @property
    def units(self) -> float:
        return sum(lot.units for lot in self.lots)

    @property
    def invested(self) -> float:
        return sum(lot.cost for lot in self.lots)

    @property
    def average_cost(self) -> float:
        return self.invested / self.units if self.units else 0.0

    def value_at(self, price: float) -> float:
        return self.units * price

    def unrealised_gain(self, price: float) -> float:
        return self.value_at(price) - self.invested

    def absolute_return(self, price: float) -> float:
        return self.unrealised_gain(price) / self.invested if self.invested else 0.0

    def sell_fifo(self, units: float, price: float) -> Tuple[float, float, float]:
        """Sell oldest-first. Returns (proceeds, cost_of_units_sold, realised_gain)."""
        if units > self.units + 1e-9:
            raise ValueError(f"cannot sell {units} units, only {self.units} held")
        remaining = units
        cost = 0.0
        while remaining > 1e-9:
            lot = self.lots[0]
            taken = min(lot.units, remaining)
            cost += taken * lot.price
            remaining -= taken
            if taken >= lot.units - 1e-9:
                self.lots.pop(0)
            else:
                self.lots[0] = Lot(lot.trade_date, lot.units - taken, lot.price)
        proceeds = units * price
        return proceeds, cost, proceeds - cost


def xirr(flows: Sequence[CashFlow], guess: float = 0.1) -> float:
    """Annualised money-weighted return. Newton-Raphson, bisection fallback.

    This is the only honest return figure for a SIP, where absolute return
    ignores that later instalments were invested for less time (07 R27).
    """
    if len(flows) < 2:
        raise ValueError("XIRR needs at least two cash flows")
    if not (any(f.amount < 0 for f in flows) and any(f.amount > 0 for f in flows)):
        raise ValueError("XIRR needs at least one inflow and one outflow")

    start = min(f.on for f in flows)
    years = [(f.on - start).days / DAYS_PER_YEAR for f in flows]

    def npv(rate: float) -> float:
        return sum(f.amount / (1 + rate) ** t for f, t in zip(flows, years))

    rate = guess
    for _ in range(XIRR_MAX_ITERATIONS):
        value = npv(rate)
        derivative = sum(
            -t * f.amount / (1 + rate) ** (t + 1) for f, t in zip(flows, years) if t
        )
        if abs(derivative) < 1e-12:
            break
        step = value / derivative
        rate -= step
        if rate <= -0.9999:
            break
        if abs(step) < XIRR_TOLERANCE:
            return rate

    low, high = -0.9999, 100.0
    for _ in range(XIRR_MAX_ITERATIONS):
        mid = (low + high) / 2
        if npv(low) * npv(mid) <= 0:
            high = mid
        else:
            low = mid
    return (low + high) / 2


def decompose_foreign_gain(
    price_start: float,
    price_end: float,
    fx_start: float,
    fx_end: float,
    units: float,
) -> Tuple[float, float, float]:
    """Split the base-currency gain on a foreign holding into asset and FX parts.

    asset gain = (P1 - P0) x units x FX0    -- price move, valued at the old rate
    fx gain    = (FX1 - FX0) x units x P1   -- rate move, valued at the new price

    These sum exactly to the total base-currency gain, which is the property
    that makes the split reportable rather than merely indicative (07 R34).
    """
    asset = (price_end - price_start) * units * fx_start
    currency = (fx_end - fx_start) * units * price_end
    total = price_end * units * fx_end - price_start * units * fx_start
    return asset, currency, total


class DocumentVerifier:
    """Recompute every figure quoted in 07-assets-networth-currency.md."""

    NAV_TODAY = 86.40
    SIP = [
        (date(2026, 1, 5), 25_000.0, 80.00),
        (date(2026, 2, 5), 25_000.0, 82.50),
        (date(2026, 3, 5), 25_000.0, 78.00),
    ]
    VALUATION_DATE = date(2026, 8, 26)

    # Foreign holding: 10 shares bought at USD 150 when USD/INR was 83.00
    US_UNITS, US_P0, US_P1, US_FX0, US_FX1 = 10.0, 150.0, 180.0, 83.00, 95.51

    def __init__(self) -> None:
        self.checks: List[Tuple[str, float, float]] = []

    def expect(self, label: str, actual: float, quoted: float) -> None:
        self.checks.append((label, r2(actual), quoted))

    def run(self) -> bool:
        fund = Holding("Parag Parikh Flexi Cap Direct Growth")
        for on, amount, nav in self.SIP:
            fund.buy(on, amount, nav)

        self.expect("SIP units, instalment 1", r3(fund.lots[0].units), 312.500)
        self.expect("SIP units, instalment 2", r3(fund.lots[1].units), 303.030)
        self.expect("SIP units, instalment 3", r3(fund.lots[2].units), 320.513)
        self.expect("Total units held", r3(fund.units), 936.043)
        self.expect("Total invested", fund.invested, 75_000.00)
        self.expect("Average cost per unit", fund.average_cost, 80.12)
        self.expect("Current value at NAV 86.40", fund.value_at(self.NAV_TODAY), 80_874.13)
        self.expect("Unrealised gain", fund.unrealised_gain(self.NAV_TODAY), 5_874.13)
        self.expect("Absolute return %", fund.absolute_return(self.NAV_TODAY) * 100, 7.83)

        flows = [CashFlow(on, -amount) for on, amount, _ in self.SIP]
        flows.append(CashFlow(self.VALUATION_DATE, fund.value_at(self.NAV_TODAY)))
        self.expect("XIRR %", xirr(flows) * 100, 14.51)

        # FIFO partial sale of 400 units at NAV 86.40
        seller = Holding("same fund, for the sale example")
        for on, amount, nav in self.SIP:
            seller.buy(on, amount, nav)
        proceeds, cost, realised = seller.sell_fifo(400.0, self.NAV_TODAY)
        self.expect("FIFO sale proceeds", proceeds, 34_560.00)
        self.expect("FIFO cost of units sold", cost, 32_218.75)
        self.expect("FIFO realised gain", realised, 2_341.25)
        self.expect("Units remaining after sale", r3(seller.units), 536.043)

        asset, currency, total = decompose_foreign_gain(
            self.US_P0, self.US_P1, self.US_FX0, self.US_FX1, self.US_UNITS
        )
        self.expect("Foreign cost in ₹", self.US_P0 * self.US_UNITS * self.US_FX0, 124_500.00)
        self.expect("Foreign value in ₹", self.US_P1 * self.US_UNITS * self.US_FX1, 171_918.00)
        self.expect("Asset gain in ₹", asset, 24_900.00)
        self.expect("FX gain in ₹", currency, 22_518.00)
        self.expect("Total gain in ₹", total, 47_418.00)
        self.expect("Decomposition residual", (asset + currency) - total, 0.00)
        self.expect("Gain in USD terms only", (self.US_P1 - self.US_P0) * self.US_UNITS, 300.00)

        # Net worth roll-up (07 §5 worked example)
        assets = {
            "Budget accounts (cash)": 342_000.00,
            "Mutual funds": 80_874.13,
            "Foreign equity": 171_918.00,
            "EPF and PPF": 1_450_000.00,
            "Gold": 285_000.00,
            "Property (self-occupied, at cost)": 6_200_000.00,
        }
        liabilities = {
            "Home loan outstanding": 4_792_181.00,
            "Credit cards": 68_400.00,
        }
        total_assets = sum(assets.values())
        total_liabilities = sum(liabilities.values())
        self.expect("Total assets", total_assets, 8_529_792.13)
        self.expect("Total liabilities", total_liabilities, 4_860_581.00)
        self.expect("Net worth", total_assets - total_liabilities, 3_669_211.13)

        return self.report()

    def report(self) -> bool:
        table = Table(
            title="07-assets-networth-currency.md — quoted figures vs recomputed",
            header_style="bold",
        )
        table.add_column("Figure")
        table.add_column("Document", justify="right")
        table.add_column("Computed", justify="right")
        table.add_column("", justify="center")

        failures = 0
        for label, actual, quoted in self.checks:
            ok = abs(actual - quoted) < 0.005
            failures += 0 if ok else 1
            table.add_row(
                label,
                f"{quoted:,.2f}",
                f"{actual:,.2f}",
                "[green]✓[/green]" if ok else "[red]✗[/red]",
                style=None if ok else "red",
            )

        console.print(table)
        if failures:
            console.print(f"[bold red]{failures} figure(s) no longer match.[/bold red]")
        else:
            console.print(
                f"[bold green]All {len(self.checks)} figures verified.[/bold green] "
                "The document's arithmetic is sound."
            )
        return failures == 0


def cmd_verify(_: argparse.Namespace) -> int:
    return 0 if DocumentVerifier().run() else 1


def cmd_xirr(_: argparse.Namespace) -> int:
    verifier = DocumentVerifier()
    fund = Holding("worked SIP")
    for on, amount, nav in verifier.SIP:
        fund.buy(on, amount, nav)
    flows = [CashFlow(on, -amount) for on, amount, _ in verifier.SIP]
    flows.append(CashFlow(verifier.VALUATION_DATE, fund.value_at(verifier.NAV_TODAY)))

    table = Table(title="Worked SIP — money-weighted return")
    table.add_column("Date")
    table.add_column("Flow", justify="right")
    for flow in flows:
        table.add_row(flow.on.strftime("%d-%m-%Y"), rupees(flow.amount))
    console.print(table)
    console.print(
        f"\nAbsolute return [bold]{fund.absolute_return(verifier.NAV_TODAY):.2%}[/bold] · "
        f"XIRR [bold]{xirr(flows):.2%}[/bold] — the gap is why absolute return misleads on a SIP."
    )
    return 0


def cmd_fx(args: argparse.Namespace) -> int:
    asset, currency, total = decompose_foreign_gain(
        args.price_start, args.price_end, args.fx_start, args.fx_end, args.units
    )
    table = Table(title=f"{args.units:g} units: {args.price_start:g} → {args.price_end:g}, "
                        f"FX {args.fx_start:g} → {args.fx_end:g}")
    table.add_column("Component")
    table.add_column("Base currency", justify="right")
    table.add_row("Asset gain (price moved)", rupees(asset))
    table.add_row("FX gain (rate moved)", rupees(currency))
    table.add_row("[bold]Total gain[/bold]", f"[bold]{rupees(total)}[/bold]")
    console.print(table)
    share = currency / total if total else 0.0
    console.print(f"\n{share:.0%} of this gain came from the exchange rate, not the investment.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Portfolio, FX and net-worth verifier for 07-assets-networth-currency.md"
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="enable debug logging")
    sub = parser.add_subparsers(dest="command")

    p_verify = sub.add_parser("verify", help="verify the document's figures (default)")
    p_verify.set_defaults(func=cmd_verify)

    p_xirr = sub.add_parser("xirr", help="show the worked SIP's absolute return against its XIRR")
    p_xirr.set_defaults(func=cmd_xirr)

    p_fx = sub.add_parser("fx", help="split a foreign holding's gain into asset and FX parts")
    p_fx.add_argument("price_start", type=float)
    p_fx.add_argument("price_end", type=float)
    p_fx.add_argument("fx_start", type=float)
    p_fx.add_argument("fx_end", type=float)
    p_fx.add_argument("units", type=float)
    p_fx.set_defaults(func=cmd_fx)

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
