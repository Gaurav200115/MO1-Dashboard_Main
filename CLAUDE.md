# Working notes for this repo

## Share something worth reading, on every topic

Whenever we work on a new topic, find one genuinely interesting thing related to it — a paper,
an article, a technique, a book — and tell Gaurav at the end of the turn in a line or two: what
it is, and why it's worth his time. It should be something he can read in a free half hour.

Not filler. If there is nothing good for that topic, say so rather than padding the list with
something generic.

Then append it to the knowledge log.

## The knowledge log

`docs/knowledge-log.xlsx`, sheet **Reading log**. Append below the existing rows — never
rewrite the file from scratch, it accumulates.

| Column | Contents |
|---|---|
| Date | `YYYY-MM-DD`, the day we covered it. Keeps sorting honest. |
| Topic | What we were working on, e.g. `Exit & trailing rules` |
| Item | Title, with author and year where it has one |
| Type | `Article` / `Book / method` / `Indicator` / `Idea — untested` / `Internal doc` |
| Why it's worth your time | One or two sentences on what he'd *get* from it, not what it is about |
| Link | Full URL, or a repo-relative path for an internal doc. Blank for an idea with no source. |

Keep the existing formatting: Arial 10, wrapped text in the "Why" column, row height ~58,
banded fill on alternate rows, blue underlined hyperlink styling on real URLs. No formulas —
it is a log, not a model, so there is nothing to recalculate.

Google Sheets is **not reachable** from this environment: the Google Drive connector is not set
up, so no Sheets tool exists here. This file is the canonical copy. Gaurav uploads it to Drive
when he wants a cloud version. If the Drive connector is added later, migrate the rows and
write to the Sheet directly from then on.

## Confirm the deliverable before building it

Ask what form the output should take — PDF, spreadsheet, published page, or just an answer in
chat — and where it goes, *before* making it. Two documents were built in the wrong format by
inferring instead of asking. Keep the question short and recommend a default; he decides fast.

This is about the shape of the output. It does not mean pausing on routine judgment calls, and
it does not apply to changes he has already specified in detail.

## Documents in `docs/`

They are PDFs. Write a print-styled HTML file in the scratchpad, then render it:

```
chrome.exe --headless=new --disable-gpu --no-sandbox --user-data-dir=<temp> \
  --no-pdf-header-footer --virtual-time-budget=10000 \
  --print-to-pdf=<out.pdf> file:///<src.html>
```

Chrome lives at `C:\Program Files\Google\Chrome\Application\chrome.exe`. No pandoc, no
wkhtmltopdf.

Two things that cost a re-render once each:

- **Use system fonts** (Segoe UI / Georgia / Consolas), not Google Fonts. Google's `latin`
  subset omits `U+20B9`, and these documents are full of `₹` — every one falls back to a
  different family mid-sentence. System faces carry it and embed as subsets.
- **Let sections flow.** `break-before: page` on each section left three pages 50–80% empty.
  Keep `break-inside: avoid` on rows and blocks and `thead { display: table-header-group }`.

Verify the result with PyMuPDF (`fitz`, installed under Python 3.8): page count, per-page fill,
embedded fonts, extracted text. `pdftoppm` is not installed, so PDF pages cannot be rasterised
for a visual check.
