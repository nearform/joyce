# Prompt findings

Defects in the system prompt itself, with the evidence that demonstrates them. Distinct from
`docs/corpus-gaps.md`, where the prompt is right and the data is incomplete.

Every entry here should end up as an eval case that is **red before the fix and green after**.

## 1. `CITATION_EXAMPLE` injects citable URLs and fabricated labels

**Status:** confirmed empirically, first generation ever captured by the harness (2026-08-12,
`Llama-3.2-1B-Instruct-q4f16_1-MLC`, temperature 0).

`CITATION_EXAMPLE` in `public/local/data/api/prompts.js` shows a worked example built from two
PUMA links:

```
- [PUMA — scaling across the globe](https://nearform.com/work/puma-scaling-across-the-globe)
- [PUMA e-Commerce Platform](https://nearform.com/work/puma)
```

Two things are wrong with it.

**The labels are fabricated.** Both URLs are real, but neither label is. The actual titles in
`posts.json` are "E-commerce built to scale across the globe" and "Building global scale by
bringing tech under one roof". Meanwhile `CITATION_RULES` orders the model to "Use the exact link
text shown" — so the only worked example in the FULL tier demonstrates precisely the behaviour the
rules forbid.

**The URLs leak into answers as citable sources.** This is the more serious half, and it was not
obvious until measured.

Asked "How did Nearform help PUMA scale their platform globally?", the model emitted:

```
[PUMA e-Commerce Platform](https://nearform.com/work/puma)
```

`https://nearform.com/work/puma` **was not in the allowed-links list for that query.** Retrieval
returned `work/puma-scaling-across-the-globe`, not `work/puma`. The model took the URL _and_ the
label straight out of the few-shot example and cited it as a source.

So the example is not merely teaching bad labels — it is injecting two URLs into every FULL-tier
prompt that the model then treats as legitimately citable, manufacturing exactly the
"real URL, never retrieved for this query" failure. That failure sits in neither the "allowed" nor
the "hallucinated" bucket, which is why citation scoring needs three tiers rather than two.

**Fix (Phase 2.5):** correct the labels to the real titles. Consider whether the example should use
placeholder URLs that can never collide with the corpus, so a copied example URL is unambiguously
detectable rather than plausibly real.

**Watched by:** `citationLabelFidelity` and `citationNotRetrieved`.

## 2. The prompt teaches the word it forbids

`CONTEXT_FORMAT` instructs: _"Refer to them as 'sources' or 'articles' — never say
'chunk'/'context'."_ But `chat.js` injects an assistant message immediately before the corpus
reading:

```
The posts chunk content is as follows:
```

The last thing the model sees before the content is the exact word it is told never to use.

**Fix (Phase 4):** reword that message into the approved register.

**Watched by:** `mechanicsLeak`.

## 3. Forbidding without substituting

`CONTEXT_FORMAT` gives approved wording for _individual items_ ("sources", "articles") but nothing
for **the body of material as a whole** — which is the exact occasion on which an answer reaches
for "the context provided". A negative-only constraint is the classic prompt failure for small
models: told not to say a word and handed no replacement, they use the nearest mechanism word in
the window, which finding 2 helpfully supplies.

**Fix (Phase 4):** a designed vocabulary. "my knowledge" / "my knowledge store" for the whole,
"sources"/"articles" for items, plus an insufficiency register. Everything previously forbidden
stays forbidden, extended to cover possessive mechanism phrases ("my embeddings", "my vector
store") — possessive only, since the corpus has legitimate posts about embeddings and chunking.

**Watched by:** `mechanicsLeak` (negative) and `blessedVocabulary` (positive).

## 4. Operator-supplied facts have no legitimate way to be stated

The prompt asserts facts that no retrievable source can support: the brand rules, the terminology
expansions ("Regional Transportation District" appears **zero** times in the corpus), and the
client list in `ECOMMERCE_GUIDANCE`.

Meanwhile `SOURCE_MANDATE` requires every answer be grounded in retrieved sources, and
`CITATION_RULES` forbids presenting sourced claims without a citation. Asked about one of those
facts, the model can satisfy two of three constraints at most. The observed failure mode is the
worst available option: assert the claim and staple on the nearest plausible citation.

**Fix (Phase 4):** make operator facts explicitly citation-exempt, so stating one is a legitimate
move rather than a rule violation the model has to improvise around.

**Watched by:** the `operator_fact` label in the groundedness rubric; `citationNotRetrieved`.

## 5. Conditional-section regexes are imprecise

`ECOMMERCE_REGEX` matches bare `commerce`, `shop`, and `headless`, so "How do I use a headless
browser for testing?" and "What is the shop floor pattern?" both inject the full e-commerce
section — including its client claims — into unrelated answers.

`AINE_REGEX` similarly matches bare `claude` and `copilot`.

Because the injected sections change per query, `promptSections` is recorded on every turn: which
guidance a given answer received is a variable, not a constant, and any before/after comparison has
to account for it.

**Fix:** tighten the patterns, or require two signals before injecting a section. Lower priority
than 1–4 — measure the cost first.

## Other observations, not yet triaged

From the same first generation:

- The answer ended with _"However, I don't have enough information to provide a detailed
  explanation…"_ immediately after giving a detailed explanation. A self-contradicting hedge.
- It cited "Strategic insights on the new era of digital business transformation: An interview" as
  evidence for PUMA scaling. That link **was** allowed, so no deterministic scorer will catch it —
  it is topically irrelevant, which needs the attribution judge. It is also the top-ranked result
  from the retrieval problem in `docs/retrieval-quality.md`, so the two findings compound: weak
  ranking puts an irrelevant post first, and the model dutifully cites it.
