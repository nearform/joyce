/**
 * Filter posts.json by author name regex.
 *
 * Usage:
 *   node scripts/filter-by-author.js --author=PATTERN
 *
 * Options:
 *   --author=PATTERN   Regex pattern to match against author names (case-insensitive)
 *
 * Example:
 * ```
 * $ node scripts/filter-by-author.js --author="ALEX.*"
 * $ node scripts/filter-by-author.js --author="^RYAN"
 * ```
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { dirname } = import.meta;

const main = async () => {
  const { values } = parseArgs({
    options: {
      author: { type: "string" },
    },
    strict: false,
  });

  const authorPattern = values.author;
  if (!authorPattern) {
    console.error("Usage: node scripts/filter-by-author.js --author=PATTERN");
    console.error(
      'Example: node scripts/filter-by-author.js --author="ALEX.*"',
    );
    process.exit(1);
  }

  const regex = new RegExp(authorPattern, "i");

  // Read posts.json
  const postsPath = resolve(dirname, "../public/data/posts.json");
  const postsContent = await readFile(postsPath, "utf8");
  const posts = JSON.parse(postsContent);

  // Filter posts by author regex
  const filtered = {};
  for (const [slug, post] of Object.entries(posts)) {
    const authors = post.authors || [];
    if (authors.some((author) => regex.test(author))) {
      filtered[slug] = post;
    }
  }

  // Output to stdout
  console.log(JSON.stringify(filtered, null, 2));
};

// Run script
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
