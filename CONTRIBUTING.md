# Contributing

Thanks for looking. A few things worth knowing before you open a PR.

## The one rule

**Nothing in this library may send the user's document anywhere.** No telemetry,
no error reporting, no "anonymous usage statistics", no phoning home on import.
That is the entire reason this package exists, and a PR that breaks it will be
declined however useful it otherwise is.

Loading *code* is different from sending *data*: fetching pdf.js or a font file
is fine, and is why those are injected by the host rather than fetched by us.

## Running it

```bash
npm install
npm test        # 29 assertions, plain Node, no browser
npm run build   # type-checks and emits dist/
```

Every test builds its own PDF at runtime with pdf-lib. Please don't add binary
fixtures — a reviewer cannot read them, and a test whose input nobody can
inspect is a test nobody can trust.

## What makes a good PR

- **A failing test first.** If you cannot write one, say so in the PR and
  explain how you verified the change instead. "Verified by hand in Chrome" is
  a perfectly good answer for the parts that need a DOM.
- **Explain the why in the code, not the what.** The existing comments spend
  their words on the reasoning and the things that went wrong before — that is
  deliberate, and the most useful thing in the file six months later.
- **Say what you did NOT verify.** An honest gap is far more useful than a
  confident claim that turns out to be untested.

## Things that are known limits, not bugs

- `pdfToWord` and `pdfToExcel` recover text and tables, not layout. Faithful
  layout reconstruction needs analysis this cannot do in a browser tab.
- Some PDFs have words already run together in their own text layer
  (`"theCompanies Act"` as one string). No extractor can recover a space that
  was never written into the file.
- Non-Latin text needs a Unicode font, which is the one place typesetting
  touches the network.

Reports that any of the above should "just work" will be closed with a link
back here — but a PR that genuinely improves one of them is very welcome.

## Licence

MIT. By contributing you agree your work ships under it.
