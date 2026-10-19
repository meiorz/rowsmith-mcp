# rowsmith-lint

A local fixture linter. It scans a repository's test fixtures and seed files for values that look like real
personal or payment data, and suggests the Rowsmith column type that generates a fake replacement.

Runs locally and sends nothing anywhere: no network access, no telemetry, no update check.

A pattern check, not legal or compliance advice.

Checks these formats: email addresses not on reserved test domains, payment card numbers (Luhn-valid, excluding Stripe's published test cards), US Social Security numbers in valid ranges, IBANs with a valid checksum, and phone numbers (North American numbers outside the fictional 555-0100 to 555-0199 range, and international numbers written in E.164 form).

A finding means a value looks like real data, not that it is real.

It is pattern-based: it may miss values that don't match its rules, and it may flag test values it doesn't know.

Dense numeric files, such as CSV columns of short integers, can produce card findings: consecutive digit groups
joined by one separator can form a Luhn-valid window of 13 to 19 digits. The remedy is a glob allowlist entry for
that file (see Allowlist), for example `card test/fixtures/metrics.csv`.

## Install and run

Install and run:

```sh
npx rowsmith-lint            # scan the current directory
npx rowsmith-lint path/to/repo --format json
```

Node.js 20 or later. No dependencies.

```
rowsmith-lint [path] [--include <glob>]... [--exclude <glob>]... [--format text|json|github]
              [--fail-on findings|none] [--allowlist <file>]
```

- `path`: a directory (default `.`) or one file, which is then scanned whatever its name.
- `--include`: replaces the default globs (repeatable). Defaults: `**/fixtures/**`, `**/__fixtures__/**`,
  `**/testdata/**`, `**/seed*/**`, `*.seed.*`, `**/test*/**/*.{json,csv,sql,yaml,yml}`. A glob without a `/` matches
  the file name in any directory.
- `--exclude`: skips matching files (repeatable).
- Always skipped: `node_modules` and `.git` directories, files over 5 MB, and binary files (a NUL byte in the first
  8000 bytes, or a known binary extension).
- `--format`: `text` (default), `json`, or `github` (workflow annotations plus a step summary).
- `--fail-on none`: report without failing.

| Exit code | Meaning |
|---|---|
| `0` | no findings (or `--fail-on none`) |
| `1` | findings |
| `2` | usage or read error |

## How it works

Every matching file is read as UTF-8 text and checked line by line, so CSV, JSON, SQL and YAML all work. A finding
needs a value of the right shape that also passes a validity check (Luhn, mod-97, SSN ranges, phone numbering
rules); a shape alone is never a finding. Each finding shows file, line, column, rule, a masked value and the
Rowsmith column type to use instead, with a one-line example request for `POST /v1/generate`. rowsmith-lint never
sends that request; run it yourself if you want the replacement data.

A matched value is never printed in full, in any output: text, JSON, annotations, the step summary or error
messages. The masks:

| Rule | Shown |
|---|---|
| `ssn` | `***-**-**` and the last 2 digits |
| `phone` | `********` and the last 2 digits |
| `card` | `****` and the last 4 digits |
| `email` | the first character, `***`, then `@` and the domain (`j***@acme-mail.co`) |
| `iban` | the country code, `******`, the last 2 characters |

JSON output (`--format json`) has `"version": 1`, then `tool`, `tool_version`, `files_scanned`, `files_skipped`,
`allowlisted`, `allowlist_unused`, `findings` (each: `file`, `line`, `column`, `rule`, `masked`, `message`,
`suggestion` with `column_type` and `example_request`) and `notes`.

## Rules

Each line is checked in this order: IBAN, SSN, phone, email shapes first, then cards. A span claimed by an earlier
shape (flagged or not) is not read again by a later rule, and is blanked before the card rule reads the line.

**`email`** (Rowsmith column type `email`). Shape: `local@domain`, where `local` starts with a letter or digit and has
up to 64 of `A-Z a-z 0-9 . _ % + -`, and `domain` has at least two labels and ends in a TLD of 2 to 24 letters.
Passes: domains `example.com`, `example.net`, `example.org` and their subdomains; TLDs `.test` (so Rowsmith's
`mail.test`), `.example`, `.invalid`, `.localhost`; and image or code file names such as `icon@2x.png`. Anything else
is flagged.

**`card`** (column type `test_card`). The same logic as the Rowsmith service's card check, proven by a shared test
corpus (`test/card-corpus.json`) that both test suites check with identical verdicts. Format characters (such as a
zero-width space) are removed and Unicode digits folded to ASCII (NFKC, then any decimal digit). Digit groups may
be joined by any separator of 1 or 2 whitespace or punctuation characters, but one number uses one separator
throughout; a run is split where the separator changes. Every run of consecutive whole groups totalling 13 to 19
digits is a candidate, and a single group longer than 19 digits is checked on every 13-19 digit window. A candidate
is flagged when its first digit is 2 to 6, it passes the Luhn check, and it is not one of the card numbers from
Stripe's published testing list held by the Rowsmith service (`lib/cards.js`, list as of 2026-10-17).

**`ssn`** (column type `ssn_invalid`). Shape: `AAA-GG-SSSS` with dashes, not touching other digits, letters or
dashes. Passes when it can never be issued: area `000`, `666` or `900`-`999`, group `00`, or serial `0000`.
Otherwise flagged. Nine digits without dashes are not checked.

**`iban`** (column type `iban_invalid`). Shape: two capital letters for a country in the IBAN registry, two check
digits, then capital letters and digits to exactly that country's IBAN length, plain or in groups of four separated
by single spaces. Flagged when the check digits are 02 to 98 and the ISO 7064 mod-97 checksum is 1. Wrong checksums
(such as Rowsmith's `iban_invalid` values, check digits `00`), wrong lengths and unknown country codes pass.

**`phone`** (column type `phone`). Shapes: `+` and 8 to 15 digits with no separators (E.164); `AAA-EEE-LLLL` or
`AAA.EEE.LLLL` with one separator throughout, optionally after `+1`, `+1 `, `+1-` or `1-`; `(AAA) EEE-LLLL`
optionally after `+1`; `+1 AAA EEE LLLL`. Plain digit runs and other spacings are never read as phones. A `+1` or
North American number is flagged only when it is valid: area code and exchange start with 2 to 9, neither is
`N11`, and the area code's middle digit is not 9. Other country codes are flagged when they have 8 to 15 digits.
Passes: North American 555-0100 to 555-0199, UK 07700 900000 to 900999 and 020 7946 0000 to 0999 (ranges set aside
for fiction), and numbers that fail the validity check.

## Allowlist

To silence a known false positive, add its location to `.rowsmith-lint-allow` in the scanned directory (or pass
`--allowlist <file>`). An entry is a rule and a location, never a value or a hash of one:

```
# rule  location (relative to the scanned directory)
email   test/fixtures/users.csv:12
phone   test/fixtures/legacy/**
```

`path:line` silences that rule on that line; a path glob silences that rule in every matching file. A line that is
not an entry, or that itself looks like a flaggable value, is a usage error (exit 2); the error names the line number,
not its content. An entry that matched nothing (for example after the file moved) is reported as
`allowlist entry matched nothing: <entry>`; that is informational and does not change the exit code.

## GitHub Action

```yaml
permissions:
  contents: read
jobs:
  fixtures:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: meiorz/rowsmith-mcp/rowsmith-lint@rowsmith-lint-v0.1.0
        with:
          path: .
          fail-on: findings
```

The action lives at `rowsmith-lint/` in github.com/meiorz/rowsmith-mcp; release tags have the form
`rowsmith-lint-vX.Y.Z` and we never move a published tag; for a reference that cannot change, pin the commit SHA. A composite action that runs the CLI with the runner's `node` from the action's own directory. It needs only
`contents: read` (to check out your code), uses no token, makes no network request, uploads nothing and creates no
artifacts. Inputs reach the script through environment variables only. `include` and `exclude` take one glob per
line. Findings appear as annotations and in the step summary, masked as above.

## Licence

MIT. See `LICENSE`.
