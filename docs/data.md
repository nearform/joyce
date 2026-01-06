# Data

## Data Files

| File                                    | Description                                         |
| --------------------------------------- | --------------------------------------------------- |
| `public/data/posts.json`                | Source blog post data                               |
| `public/data/posts-embeddings-256.json` | Pre-computed embeddings (256 token chunks, default) |
| `public/data/posts-embeddings-512.json` | Pre-computed embeddings (512 token chunks)          |

_Note_: The source blog post data comes from a separate process -- scraping the public website, converting to JSON, and adding the category labels.

## Orama Databases

At runtime, two [Orama](https://docs.oramasearch.com/docs/orama-js) databases are created in-browser:

- **postsDb** — Full-text search on post metadata (title, authors, categories, etc.)
- **chunksDb** — Vector search using 384-dimension embeddings from `gte-small`

See `public/local/data/api/search.js` for the schema and initialization.

## NPM Commands

Regenerate embeddings files from posts.json. (Should be run whenever `posts.json` is updated). We presently use the `Xenova/gte-small` embeddings model. This generates multiple files based on chunk sizes configured in `shared-config.js`.

```sh
$ npm run data:embeddings
```
