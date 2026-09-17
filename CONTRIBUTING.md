# Contributing

## Licence of the project

Pathayam is released under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md). In short: use it, modify it
and share it for any noncommercial purpose — your own household, study,
research, a hobby project, a charity, a school. Commercial use of any kind is
not permitted, including inside a business. Commercial licences are available
separately: <hello@flaxvin.tech>.

## Licence of your contribution

By opening a pull request you agree to the terms below. There is nothing to
sign; the agreement is the act of contributing.

1. **You grant Flaxvin Technologies a licence to your contribution.** You grant a
   perpetual, worldwide, non-exclusive, royalty-free, irrevocable licence to
   reproduce, modify, publicly display, sublicense and distribute your
   contribution, and to do so **under any licence terms**, including the
   PolyForm Noncommercial License and any commercial licence offered
   separately.

2. **You keep your copyright.** This is a licence, not an assignment. Your name
   stays in the history and you may use your own contribution however you like.

3. **You have the right to grant it.** The contribution is your own work, or
   you have permission to submit it. If your employer has rights to work you
   produce, you have their permission.

4. **Patents.** You grant a patent licence covering any of your patents that
   your contribution would otherwise infringe, on the same terms.

5. **No warranty.** The contribution is provided as-is.

Why this is here: without it, a single outside pull request would make it
impossible to change the licence later, or to sell a commercial licence to
somebody who cannot accept a noncommercial one.

## Before you open a pull request

- `npm test` passes. The suite is the specification; a change in behaviour
  needs a test that fails without it.
- `npm run typecheck` passes.
- No new runtime dependency. The project has none, deliberately.
- Every figure, name and account in tests, fixtures and documentation is
  fictional. Never commit real financial data, a real PAN, a real account
  number or a real statement.

## Reporting a security issue

Do not open a public issue. Write to the address on the repository profile with
what you found and how to reproduce it.
