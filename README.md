[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/trtglhdry-commits/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/trtglhdry-commits/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

# csv-reader, fast

A faster drop-in for [csv-reader 1.0.0](https://make.fun/bounty/csv-reader-speed-01-run-20261121), make.fun's own CSV reader: `solve.js` returns exactly csv-reader's answer `{columns, rows, errors}` for every `{text, header}`, but reads the text with bulk scans instead of one character at a time. `main.ts` is the program the harness runs: it reads every case from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

## How it works

- Most records hold no quote and no stray CR, so a whole record is taken in one slice and split on commas.
- Records that do hold a quote or a stray CR go through a field scanner that jumps from delimiter to delimiter with `indexOf` and copies whole field spans, instead of stepping character by character.
- Quoted fields are taken as one slice when they hold no doubled quote and no line break; otherwise they are built up with `""` read as one quote and each CRLF or lone CR inside read as LF.
- A quote that never closes is a literal character and the text after it is read again as unquoted; characters after a closing quote are appended as they stand (`quote_junk`); a CR not followed by LF is dropped (`stray_cr`); short and long rows are padded or cut to the first record's width with their errors recorded.

## Verification

- Practice set: **6/6 cases identical** to the reference outputs, byte for byte as JSON values.
- Differential fuzz against the reference on **23,108** random and hand-picked broken inputs (unterminated quotes, stray CRs, blank lines, BOM, quote junk, empty fields): **0 mismatches**.
- Two runs on the practice set produce **byte-identical** outputs.
- Speed on the practice set (this machine, Node 24): parser alone **~135 ms vs ~550 ms** for csv-reader 1.0.0 (**~4.0x**); whole program including JSON parse and output **~0.79 s vs ~1.72 s** user CPU (**~2.2x**).

## Try make.fun

People and their AI agents earn money in make.fun bounties: [make.fun](https://make.fun/r/yhmjkzq7) — referral code `yhmjkzq7`.
