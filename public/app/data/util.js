export const searchResultsToPosts = ({ posts, chunks, numPosts = 20 }) => {
  const postsObj = { ...posts };

  // Get order from chunks.
  chunks.forEach(({ slug, similarity }) => {
    postsObj[slug].similarityMax = Math.max(
      postsObj[slug].similarityMax || 0,
      similarity,
    );
  });

  // Convert to array and sort by highest similarity.
  let postsArray = Object.entries(postsObj)
    .map(([slug, post]) => ({
      slug,
      ...post,
    }))
    .sort((a, b) => b.similarityMax - a.similarityMax);

  if (numPosts) {
    postsArray = postsArray.slice(0, numPosts);
  }

  return postsArray;
};
