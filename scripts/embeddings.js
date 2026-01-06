/* global console:false,process:false */
/**
 * Generate embeddings for all posts from posts.json.
 *
 * Usage:
 *   node scripts/embeddings.js [--output-dir=DIR]
 *
 * Options:
 *   --output-dir=DIR   Output directory (defaults to public/data/)
 *
 * Reads posts from public/data/posts.json and generates embeddings files for
 * each configured chunk size in config.embeddings.dataChunkSizes.
 * Output files are named posts-embeddings-{size}.json (e.g., posts-embeddings-256.json).
 *
 * Example:
 * ```
 * $ node scripts/embeddings.js
 * $ node scripts/embeddings.js --output-dir=public/data/
 * ```
 *
 * Token notes:
 * The `gte-small` tokenizer has a max token limit of 512, but ignores tokens over the limit.
 * We use the `llm-splitter` library to split the text into chunks, and then generate tokens
 * for each chunk. We've got some debugging stats that show for the following configuration
 * we only have a handful of chunks over the limit, and most not by much. This means that
 * the chunks should be good enough for our purposes.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { pipeline, AutoTokenizer } from "@xenova/transformers";
import { split } from "llm-splitter";
import config, { TOKEN_CUSHION_EMBEDDINGS } from "../public/shared-config.js";
import { quantizeEmbedding } from "../public/local/data/embeddings.js";

const { dirname } = import.meta;

const TOKEN_CHUNK_OVERLAP = 10;
const DEBUG_TOKENS = true;

const EMBEDDINGS_MODEL = config.embeddings.model;
const EMBEDDINGS_DATA_CHUNK_SIZES = config.embeddings.dataChunkSizes;

const tokenizer = await AutoTokenizer.from_pretrained(EMBEDDINGS_MODEL);

// Specifically normalize the tokens for the gte-small tokenizer.
const normalizeTokenGteSmall = (token, i, tokens) => {
  if (i === 0 && token === "[CLS]") {
    return "";
  } else if (token === "[UNK]") {
    return "";
  } else if (i === tokens.length - 1 && token === "[SEP]") {
    return "";
  } else if (token.startsWith("##")) {
    return token.slice(2);
  }

  return token;
};

const splitter = (text) => {
  const tokenInts = tokenizer.encode(text);
  const tokens = tokenInts
    .map((id) => tokenizer.decode([id]))
    .map(normalizeTokenGteSmall);

  return tokens;
};

const generateTokens = (lines) => lines.flatMap((line) => splitter(line));

const logTokenStats = (tokenCounts, chunkSize, maxTokens) => {
  const totalChunks = tokenCounts.length;
  const minTokens = Math.min(...tokenCounts);
  const maxTokensFound = Math.max(...tokenCounts);
  const avgTokens = (
    tokenCounts.reduce((a, b) => a + b, 0) / totalChunks
  ).toFixed(2);
  const overMax = tokenCounts.filter((count) => count > maxTokens);
  const overMaxCount = overMax.length;
  const overMaxPct = ((overMaxCount / totalChunks) * 100).toFixed(2);

  console.log(`\n## Token Debug Stats (chunkSize=${chunkSize})`);
  console.log(
    `Config: maxTokens=${maxTokens}, cushion=${TOKEN_CUSHION_EMBEDDINGS}, overlap=${TOKEN_CHUNK_OVERLAP}, chunkSize=${chunkSize}`,
  );
  console.log(
    `Token counts - min: ${minTokens}, max: ${maxTokensFound}, avg: ${avgTokens}`,
  );
  console.log(`Total chunks: ${totalChunks}`);
  console.log(`Chunks over maxTokens (${maxTokens}): ${overMaxCount}`);
  if (overMaxCount > 0) {
    console.log(`  Counts: ${overMax.join(", ")}`);
  }
  console.log(`Percentage over maxTokens: ${overMaxPct}%`);
};

const getChunks = (lines, chunkSize, tokenCounts) => {
  // Note: We lower case the lines to match the tokenizer, but our `getChunk` calls
  // have normal, cased text.
  const chunks = split(
    lines.map((line) => line.toLocaleLowerCase()),
    {
      chunkSize,
      chunkOverlap: TOKEN_CHUNK_OVERLAP,
      splitter,
    },
  );

  // Add numTokens to each chunk.
  chunks.forEach((chunk) => {
    const numTokens = generateTokens(chunk.text).length;
    chunk.embeddingNumTokens = numTokens;
    if (DEBUG_TOKENS) {
      tokenCounts.push(numTokens);
    }
  });

  return chunks;
};

/**
 * Generate embeddings for a given text using the extractor
 * @param {any} extractor - The feature extraction pipeline
 * @param {string[]} lines - The lines to generate embeddings for
 * @returns {Promise<number[]>} - The embedding vector as an array
 */
const generateEmbeddings = async (extractor, lines) => {
  const output = await extractor(lines.join("\n"), {
    pooling: "mean",
    normalize: true,
  });
  return Array.from(output.data);
};

/**
 * Convert result object to JSON string with pretty print, but keep embeddings compact.
 * Handles quantized embeddings format: { values: number[], min: number, max: number }
 * @param {Object} result - The embeddings result object
 * @returns {string} - JSON string
 */
const formatOutput = (result) => {
  const jsonString = JSON.stringify(
    result,
    (key, value) => {
      // Handle quantized embeddings object: { values, min, max }
      if (
        key === "embeddings" &&
        value &&
        typeof value === "object" &&
        "values" in value
      ) {
        return `__EMBEDDINGS_${JSON.stringify(value)}__`;
      }
      return value;
    },
    2,
  );
  // Replace the placeholder with compact JSON (no extra quotes)
  // The inner JSON has escaped quotes from double-stringify, so we match and unescape
  return jsonString.replace(/"__EMBEDDINGS_(.*?)__"/g, (_, inner) => {
    // Unescape the double-stringified JSON
    return inner.replace(/\\"/g, '"');
  });
};

/**
 * Generate embeddings for all posts with a specific chunk size
 * @param {Object} posts - The posts object keyed by slug
 * @param {any} extractor - The feature extraction pipeline
 * @param {number} chunkSize - The chunk size for splitting
 * @param {string} sizeName - The name of the size (for logging)
 * @returns {Promise<{result: Object, tokenCounts: number[]}>}
 */
const generateEmbeddingsForSize = async (
  posts,
  extractor,
  chunkSize,
  sizeName,
) => {
  const tokenCounts = [];
  const slugs = Object.keys(posts);
  const result = {};

  console.log(
    `\nGenerating embeddings for ${slugs.length} posts (${sizeName}: chunkSize=${chunkSize})...`,
  );
  const processStart = performance.now();
  let lastCheckpoint = processStart;

  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    const post = posts[slug];
    let chunks = [];
    try {
      // Just store the start and end indices of the chunks and add the embeddings.
      chunks = getChunks(post.content, chunkSize, tokenCounts);
      for (const chunk of chunks) {
        const embeddings = await generateEmbeddings(extractor, chunk.text);
        delete chunk.text;
        // Quantize embeddings to uint8 for ~75% storage reduction
        chunk.embeddings = quantizeEmbedding(embeddings);
      }
    } catch (error) {
      console.error("(E) getChunks: ", slug);
      throw error;
    }

    result[slug] = { chunks };

    if ((i + 1) % 100 === 0) {
      const now = performance.now();
      const incrementTime = ((now - lastCheckpoint) / 1000).toFixed(2);
      lastCheckpoint = now;
      console.log(
        `Processed ${i + 1}/${slugs.length} posts... (${incrementTime}s)`,
      );
    }
  }

  const totalTime = ((performance.now() - processStart) / 1000).toFixed(2);
  console.log(`Completed processing ${slugs.length} posts. (${totalTime}s)`);

  return { result, tokenCounts };
};

const main = async () => {
  // Parse CLI arguments
  const { values } = parseArgs({
    options: {
      "output-dir": { type: "string", default: "public/data" },
    },
    strict: false,
  });

  const outputDir = values["output-dir"];

  // Read posts.json
  const postsPath = resolve(dirname, "../public/data/posts.json");
  const postsContent = await readFile(postsPath, "utf8");
  const posts = JSON.parse(postsContent);

  console.log("## Generating Embeddings");

  // Initialize the feature-extraction pipeline
  console.log(`Loading model: ${EMBEDDINGS_MODEL}...`);
  const modelLoadStart = performance.now();
  const extractor = await pipeline("feature-extraction", EMBEDDINGS_MODEL);
  const modelLoadTime = ((performance.now() - modelLoadStart) / 1000).toFixed(
    2,
  );
  console.log(`Model loaded. (${modelLoadTime}s)`);

  // Generate embeddings for each configured chunk size
  const chunkSizeEntries = Object.entries(EMBEDDINGS_DATA_CHUNK_SIZES);
  console.log(
    `\nWill generate ${chunkSizeEntries.length} embedding files for chunk sizes: ${chunkSizeEntries.map(([name, size]) => `${name}(${size})`).join(", ")}`,
  );

  for (const [sizeName, maxTokens] of chunkSizeEntries) {
    const chunkSize = maxTokens - TOKEN_CUSHION_EMBEDDINGS;
    const { result, tokenCounts } = await generateEmbeddingsForSize(
      posts,
      extractor,
      chunkSize,
      sizeName,
    );

    // Write to output file
    const outputFileName = `posts-embeddings-${maxTokens}.json`;
    const outputPath = resolve(outputDir, outputFileName);
    const output = formatOutput(result);
    await writeFile(outputPath, output, "utf8");
    console.log(
      `Wrote embeddings for ${Object.keys(result).length} posts to ${outputPath}`,
    );

    if (DEBUG_TOKENS) {
      logTokenStats(tokenCounts, chunkSize, maxTokens);
    }
  }

  console.log("\n## Done!");
};

// Run script
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
