/* global performance:false */
import { create, insertMultiple, search as oramaSearch } from "@orama/orama";
import { pipeline } from "@xenova/transformers";

import { getAndCache } from "../../../shared-util.js";
import config from "../../../config.js";
import { dequantizeEmbedding } from "../embeddings.js";
import { getPosts, getPostsEmbeddings } from "./posts.js";

const MAX_CHUNKS = 50;
const MIN_SIMILARITY = 0.8;

const dateToNumber = (date) => Date.parse(date);

// Embeddings extractor (feature-extraction pipeline)
export const getExtractor = getAndCache(async () => {
  const { model } = config.embeddings;
  const extractor = await pipeline("feature-extraction", model);
  return extractor;
});

// Posts database (full-text search)
export const getPostsDb = getAndCache(async () => {
  const postsObj = await getPosts();
  const posts = Object.values(postsObj).map((post) => ({
    ...post,
    date: dateToNumber(post.date),
  }));

  const db = await create({
    schema: {
      href: "string",
      postType: "enum",
      slug: "string",
      date: "number",
      title: "string",
      authors: "string[]",
      content: "string[]",
      categories: {
        primary: "string",
        others: "string[]",
      },
    },
  });

  await insertMultiple(db, posts);

  return db;
});

// Chunks database (vector search)
export const getChunksDb = getAndCache(async () => {
  const [embeddingsObj, postsObj] = await Promise.all([
    getPostsEmbeddings(),
    getPosts(),
  ]);

  // Flatten chunks: each chunk becomes a document with slug reference and post metadata
  // Dequantize embeddings from uint8 back to floats for Orama vector search
  const chunks = Object.entries(embeddingsObj).flatMap(([slug, { chunks }]) => {
    const post = postsObj[slug];
    return chunks.map((chunk) => ({
      slug,
      date: dateToNumber(post?.date),
      postType: post?.postType,
      categories: post?.categories,
      ...chunk,
      // Dequantize embeddings: { values, min, max } -> float[]
      embeddings: dequantizeEmbedding(chunk.embeddings),
    }));
  });

  const db = await create({
    schema: {
      // Post.
      slug: "string",
      date: "number",
      postType: "string",
      categories: {
        primary: "string",
        others: "string[]",
      },

      // Chunk.
      start: "number",
      end: "number",
      embeddings: "vector[384]",
    },
  });

  await insertMultiple(db, chunks);

  return db;
});

export const getDb = getAndCache(async () => {
  const [postsDb, chunksDb] = await Promise.all([getPostsDb(), getChunksDb()]);

  const db = {
    posts: postsDb,
    chunks: chunksDb,
  };

  return db;
});

/**
 * Search for posts matching a query.
 * @param {Object} params
 * @param {string} params.query
 * @param {string[]} params.postType
 * @param {string} params.minDate
 * @param {string[]} params.categoryPrimary
 * @param {boolean} params.withContent
 * @returns {Promise<{posts: Object, chunks: Array, metadata: Object}>}
 */
// Unused params: @param {string} params.datastore
export const search = async ({
  query,
  postType,
  minDate,
  categoryPrimary,
  withContent,
}) => {
  const db = await getDb();
  const { chunks: chunksDb } = db;
  const extractor = await getExtractor();
  const postsData = await getPosts();
  const chunksData = await getPostsEmbeddings();

  // Generate query embedding
  const start = performance.now();
  const queryExtracted = await extractor(query, {
    pooling: "mean",
    normalize: true,
  });
  const queryEmbedding = Array.from(queryExtracted.data);
  const embeddingQuery = performance.now() - start;

  // Build where clause for filtering
  const where = {};
  if (postType?.length) {
    where.postType = postType;
  }
  if (categoryPrimary?.length) {
    where["categories.primary"] = categoryPrimary;
  }
  if (minDate) {
    where.date = { gte: dateToNumber(minDate) };
  }

  // Vector search on chunks DB
  const results = await oramaSearch(chunksDb, {
    mode: "vector",
    vector: { value: queryEmbedding, property: "embeddings" },
    limit: MAX_CHUNKS,
    similarity: MIN_SIMILARITY,
    where: Object.keys(where).length > 0 ? where : undefined,
  });
  const databaseQuery = performance.now() - start;

  // Build posts map and chunks array
  const postsMap = {};
  const chunksArray = [];
  const similarities = [];

  for (const hit of results.hits) {
    const { document, score: similarity } = hit;
    const { slug, start, end } = document;
    const slugChunks = chunksData[slug]?.chunks;
    if (!slugChunks) {
      throw new Error(`No chunks found for slug: ${slug}`);
    }
    const { embeddingNumTokens } = slugChunks.find(
      (chunk) => chunk.start === start && chunk.end === end,
    );
    similarities.push(similarity);

    // Add chunk to array
    chunksArray.push({ slug, start, end, embeddingNumTokens, similarity });

    // Build/update post entry
    if (!postsMap[slug]) {
      const post = postsData[slug];
      if (post) {
        postsMap[slug] = {
          title: post.title,
          href: post.href,
          date: post.date,
          postType: post.postType,
          categories: post.categories,
          ...(withContent ? { content: post.content } : {}),
          similarityMax: similarity,
        };
      }
    } else if (similarity > postsMap[slug].similarityMax) {
      postsMap[slug].similarityMax = similarity;
    }
  }

  // Sort posts by similarityMax descending
  const sortedEntries = Object.entries(postsMap).sort(
    ([, a], [, b]) => b.similarityMax - a.similarityMax,
  );
  const posts = Object.fromEntries(sortedEntries);

  // Compute similarity stats
  const similarityStats =
    similarities.length > 0
      ? {
          min: Math.min(...similarities),
          max: Math.max(...similarities),
          avg: similarities.reduce((a, b) => a + b, 0) / similarities.length,
        }
      : { min: 0, max: 0, avg: 0 };

  return {
    metadata: {
      elapsed: {
        embeddingQuery,
        databaseQuery,
      },
      chunks: {
        similarity: similarityStats,
      },
    },
    posts,
    chunks: chunksArray,
  };
};
