# Retrieval quality — findings and future work

Observations from the first eval-harness runs (2026-08-12, Phase 1). Nothing here is fixed yet;
this is a record of what the data shows and which levers look worth pulling.

The through-line: **chunk-level semantic relevance is the weak link**, and it fails in a specific,
reproducible way rather than uniformly.

## Evidence

Cosine similarity of a query embedding against all 9,692 chunks of
`posts-embeddings-256.json` (`Xenova/gte-small`, mean pooling, normalized — the same path
`search.js` uses). "unique posts" counts distinct slugs within the top 50, which is the retrieval
cap (`MAX_CHUNKS`).

| Query                                                       | corpus p50 | top-1 | top-50 spread | unique posts in top 50 | chunks ≥ 0.8 | top-1 correct? |
| ----------------------------------------------------------- | ---------- | ----- | ------------- | ---------------------- | ------------ | -------------- |
| "pitfalls when implementing MCP servers"                    | 0.787      | 0.922 | 0.072         | 17                     | 2,523        | yes            |
| "spec-driven development … CTO"                             | 0.782      | 0.905 | 0.058         | 29                     | 2,518        | yes            |
| "the new React Native architecture"                         | 0.794      | 0.941 | 0.046         | 26                     | 3,924        | yes            |
| "Nearform's role in Ireland's COVID-19 contact tracing app" | 0.771      | 0.953 | 0.072         | 26                     | 1,425        | arguably       |
| "How did Nearform help PUMA scale their platform globally?" | 0.774      | 0.911 | **0.025**     | **44**                 | 1,947        | **no**         |
| "capital of Australia" (out of domain)                      | 0.695      | 0.779 | 0.036         | 35                     | **0**        | n/a            |
| "best recipe for sourdough bread" (out of domain)           | 0.696      | 0.785 | 0.044         | 41                     | **0**        | n/a            |

## Finding 1 — brand and generic-phrasing queries retrieve poorly

Queries carrying a **distinctive technical term** (MCP, spec-driven development, React Native)
retrieve well: the right post is #1, and the top 50 concentrates on 17–29 posts.

Queries about a **client, or phrased in generic consultancy language**, scatter. For the PUMA
query the top 50 contains 44 distinct posts spread over a 0.025 similarity band — effectively a
tie, so the ordering is close to arbitrary. What surfaces instead is homogeneous Nearform
marketing prose:

```
1. Strategic insights on the new era of digital business transformation (0.911)
2. Nearform / Columbia Capital investment                              (0.909)
3. Rust vs Go: which is right for my team                              (0.906)
...
8. work-puma-scaling-across-the-globe                                  (0.895)
18. work-puma
--. work-puma-design-system            not in the top 50 at all
```

"help … scale … platform … globally" matches every case study and announcement Nearform has
published. The token "PUMA" is not doing enough work, partly because the PUMA posts' own titles
don't contain it ("E-commerce built to scale across the globe", "Building global scale by bringing
tech under one roof").

The COVID-tracing query shows a milder version: the top hit is a defensible answer, but
`work-health-service-executive` ranks only #5, behind "November events place a premium on…" and
"Royal visit to Waterford" — both almost certainly irrelevant, both scoring higher.

**"Unique posts in the top 50" is a cheap, useful diagnostic.** Low (≈17) means retrieval
concentrated on a topic; high (≈44) means it degenerated into one-chunk-per-post noise. Worth
promoting to a tracked scorer.

## Finding 2 — the embedding space is compressed, but the similarity floor is not the problem

`gte-small` puts the **entire corpus** in a narrow band: minimum similarity across all 9,692 chunks
never drops below ≈0.62 even for sourdough recipes, and the median in-domain query sits at ≈0.78.
Absolute similarity values therefore carry very little information; only _relative_ ordering does,
and within the top 50 that ordering spans as little as 0.025.

**Correction to an earlier note:** I previously wrote that `MIN_SIMILARITY = 0.8` "filters
nothing". That was wrong — it was inferred from a top-50 sample, which is selection-biased, since
everything that survives the cap is necessarily above the floor. Measured against the full corpus,
the floor removes 60–85% of chunks (1,425–3,924 pass, of 9,692).

The real limiter is **`MAX_CHUNKS = 50`**, not `MIN_SIMILARITY`. Between 1,400 and 3,900 chunks
clear the floor on a typical query, so the top-50 cap is what actually decides the context — and
because the band is so tight, that cap is slicing an almost-flat distribution.

## Finding 3 — out-of-domain rejection works, with a thinner margin than it looks

Both out-of-domain queries correctly retrieved **zero** chunks, so the abstention path is sound
and the eval suite's abstention cases rest on something real.

But the margin is ~0.015: the best sourdough match scored 0.785 against a 0.8 floor. An
out-of-domain query with more technical vocabulary ("what is the best database for a recipe app?")
would likely cross it. Before treating abstention as robust, it's worth sweeping a set of
adversarial out-of-domain queries to find where the floor actually breaks.

Note the tension: raising the floor to widen this margin would also discard legitimate in-domain
chunks, since in-domain and out-of-domain distributions nearly touch.

## Future work

### Query understanding — the biggest lever

The failures above are query-side, not corpus-side: the right posts exist and are embedded fine,
but the query embedding lands in a generic region of the space.

- **Query restatement / rewriting.** Expand the user's question into one or more retrieval-oriented
  restatements before embedding. Cheap and promising here because a small local model is already
  loaded for chat.
- **Multi-query retrieval.** Embed several restatements and merge results (reciprocal rank fusion).
  Directly attacks the flat-ordering problem: a post that ranks well for _any_ phrasing surfaces.
- **HyDE.** Generate a hypothetical answer, embed _that_, and retrieve against it. Well suited to a
  corpus of long-form prose.
- **Entity/keyword boosting.** Detect named entities in the query (PUMA, RTD, Kernel) and require
  or boost matches. `postsDb` already exists for full-text search and is currently unused at query
  time — hybrid retrieval is close to free.

### Ranking

- **Hybrid search (BM25 + vector).** Likely the single highest-value change: exact lexical matching
  on "PUMA" is precisely what the dense vector is failing to provide.
- **Reranking.** A cross-encoder over the top 50 would fix an ordering the bi-encoder can only
  produce a near-tie for. Cost is the question in a browser.
- **MMR / diversity.** Would have _hurt_ the PUMA case (already 44 distinct posts) but helps the
  concentrated ones. Should be measured, not assumed.
- **Per-post aggregation.** Rank posts by aggregate chunk evidence rather than best single chunk,
  so one strong chunk can't beat a post that's relevant throughout.

### Embeddings and chunking

- **A stronger embedding model.** `gte-small` (384-dim) is the root cause of the compressed space.
  Any replacement means regenerating all embeddings and re-measuring — the retrieval suite makes
  that comparison a single command.
- **512 vs 256 chunks.** `posts-embeddings-512.json` already exists and is unused by default. Worth
  an A/B: larger chunks may carry more context per vector, at the cost of granularity.
- **Title/heading enrichment.** Prepending the post title to each chunk before embedding would
  likely have fixed the PUMA case directly.

### Tuning

- **`MAX_CHUNKS` and `MIN_SIMILARITY`.** Both were presumably set by intuition. With the retrieval
  suite they can be swept and measured. Note the floor and the cap interact: the cap is doing the
  real work today.
- **Adaptive floor.** Given how corpus-dependent the absolute values are, a relative threshold
  ("within X of the top hit") may behave better than a fixed 0.8.

## How to measure any of this

The retrieval suite runs with **no LLM and no judge**, so iteration is fast and free:

```sh
npm run evals -- --suite retrieval
```

`retrievalRecall` reports `recallTopK`, `recallUsed`, `mrr`, and per-slug ranks, and distinguishes
_never retrieved_ from _retrieved but dropped by the token budget_ — which are different bugs with
different fixes. Any change above should be judged against gold-slug recall and MRR on a case set
that includes both the queries that work today and the ones that don't.

Do not tune the prompt to compensate for a retrieval failure. If the gold post never reaches the
context, no prompt change can help — see `evals/README.md` for the triage table.
