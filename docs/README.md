# Pathayam documentation

Reference documentation for the current build. Describes what the application
does, not how it came to do it.

| Document | Contents |
|---|---|
| [architecture.md](architecture.md) | Process model, module layout, request lifecycle, storage, caching. |
| [data-model.md](data-model.md) | Every table, its columns, and the relationships between them. |
| [budgeting.md](budgeting.md) | The envelope engine: definitions, rules, formulas, the accounting identity. |
| [accounts.md](accounts.md) | Account kinds and subtypes, transactions, transfers, splits, reconciliation. |
| [money-in.md](money-in.md) | CSV import, PDF statements, Gmail, duplicate detection, rules, learning. |
| [loans-and-assets.md](loans-and-assets.md) | Loans, amortisation, EMI conversion, portfolio, net worth, financial independence. |
| [privacy.md](privacy.md) | Budgets, visibility, and how access is enforced. |
| [security.md](security.md) | Authentication, authorisation, transport, input handling. |
| [screens.md](screens.md) | Every route the application serves. |
| [operations.md](operations.md) | Deployment, configuration, backup, restore, health. |
| [testing.md](testing.md) | Running the suite; what is covered and what is not. |
| [limitations.md](limitations.md) | Known constraints and unsupported cases. |
| [API.md](API.md) | HTTP API and personal access tokens. |
| [dev/01-engine-derivation.md](dev/01-engine-derivation.md) | Derivation of the accounting identity. Cited from the engine source. |
| [dev/02-proposed-features.md](dev/02-proposed-features.md) | Seven requested features, sized against the code. Assessment only — nothing here is built. |

## Conventions

- **Money** is integer paise throughout. `Paise` is a branded type; no floating
  point value touches a balance.
- **Dates** are ISO `YYYY-MM-DD` strings in IST. Months are `YYYY-MM`.
- **Ids** are UUIDs unless stated otherwise.
- Code references in this documentation use paths relative to the repository
  root.

## Archive

[`archive/`](archive/) contains the design specification the application was
built from: twenty numbered documents and three verification scripts. Source
comments cite it by requirement identifier (`R6`, `F3.6`, `B124`, `H2.2`); 323
such identifiers appear across `src/`. The numbering is fixed for that reason.

The archive is historical. Where it disagrees with this documentation or with
the code, it is out of date.
