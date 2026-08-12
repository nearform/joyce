# Corpus gaps

Cases where the **system prompt is right and the corpus is incomplete**. Recording them because
they look identical to prompt bugs from inside the eval harness, and treating them as prompt bugs
would mean deleting correct instructions.

The distinguishing question: _is the claim wrong, or merely uncitable?_

## `/services/` pages

`URL_NORMALIZATION` in `public/local/data/api/prompts.js` lists `/services/` among the valid path
segments. No post in `posts.json` has one — the real distribution is `/insights/` 573,
`/digital-community/` 340, `/work/` 30.

**These pages are real.** An earlier version of the site was scraped; the current one has not been.
Re-scraping is ticketed.

Consequences for the harness:

- **Do not remove `/services/` from the prompt.** It is correct and forward-looking.
- A cited `/services/` URL is classified **`corpus-gap`**, not `hallucinated`. The model still had
  no source for it, so it remains a citation failure — but a different one, with a different fix.
- **The valid-segment set must be derived from `posts.json` at runtime, not hardcoded.** When
  `/services/` content lands, those citations should become valid with no harness change. Any
  scorer that hardcodes the three current segments will silently start reporting false positives
  the day the scrape ships.

## RBI / Restaurant Brands International

`ECOMMERCE_GUIDANCE` names "RBI/Restaurant Brands International" among Nearform's e-commerce
clients. RBI, "Restaurant Brands", Burger King, Tim Hortons and Popeyes have **zero** occurrences
in any title or body across all 943 posts.

**RBI is a real client.** The corpus simply has no post covering the work.

This produces a genuine bind for the model, and it is worth naming precisely because it is not the
model's fault:

- `SOURCE_MANDATE` says ground every answer in the retrieved sources.
- `CITATION_RULES` says never present sourced claims without a citation.
- `ECOMMERCE_GUIDANCE` asserts a fact that has no retrievable source.

Asked "what did Nearform do for RBI?", the model can only obey two of those three. The observed
failure mode is the worst option: assert the relationship and attach the nearest plausible work
post as a citation.

Consequences:

- **Do not remove RBI from the prompt.** The claim is true.
- The eval case is a **corpus-gap tracker plus a fabrication guard**: the model may acknowledge the
  relationship (a prompt-supplied fact), but must not invent project details and must not attach a
  citation to it.
- This points at a real prompt improvement, tracked in the Phase 4 work: **make operator-supplied
  facts explicitly citation-exempt.** The brand rules, the terminology expansions, and the client
  lists are all facts the operator supplies and the corpus cannot support — "Regional
  Transportation District" likewise appears zero times in the corpus while `TERMINOLOGY` mandates
  it. Today the prompt gives the model no way to state such a fact legitimately, which is exactly
  the pressure that produces a fabricated citation.

## Why this distinction matters to the harness

The LLM judge design already carries an `operator_fact` label for precisely this reason: without
it, a correct RTD expansion or a correct Formidable→Nearform naming would score as an ungrounded
hallucination, and the judge would be measuring the wrong thing.

The same logic applies to deterministic scorers. A citation classifier that only knows
`allowed` / `corpus` / `fake` will mislabel both cases above. Three tiers are not enough; the
fourth is "true, but nothing in the corpus can support it."

## Related

- `docs/retrieval-quality.md` — retrieval ranking and semantic-relevance findings.
- `evals/README.md` — the retrieval / generation / prompt / data triage table.
