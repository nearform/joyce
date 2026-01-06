/**
 * Embedding quantization utilities.
 * Used by both the embeddings generation script and the browser search code.
 */

/**
 * Quantize a float embedding array to uint8 (0-255) for storage efficiency.
 * Reduces storage by ~75% compared to full float representation.
 * @param {number[]} embedding - The embedding vector as an array of floats
 * @returns {{ values: number[], min: number, max: number }} - Quantized embedding with min/max for dequantization
 */
export const quantizeEmbedding = (embedding) => {
  const min = Math.min(...embedding);
  const max = Math.max(...embedding);
  const range = max - min;

  // Handle edge case where all values are the same
  if (range === 0) {
    return {
      values: embedding.map(() => 128),
      min,
      max,
    };
  }

  const scale = 255 / range;
  const values = embedding.map((val) => Math.round((val - min) * scale));

  return { values, min, max };
};

/**
 * Dequantize a uint8 embedding back to float values.
 * Reverses the quantization done during embedding generation.
 * @param {{ values: number[], min: number, max: number }} quantized - The quantized embedding
 * @returns {number[]} - The dequantized embedding as float array
 */
export const dequantizeEmbedding = (quantized) => {
  const { values, min, max } = quantized;
  const range = max - min;

  // Handle edge case where all values were the same
  if (range === 0) {
    return values.map(() => min);
  }

  const scale = range / 255;
  return values.map((val) => val * scale + min);
};
