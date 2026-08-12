// Leveled logger with a single-line progress renderer for TTYs.
//
// Eval runs are long (a cold web-llm model download is minutes), so progress has to be visible
// without scrolling a wall of text. On a TTY the status line rewrites in place; in CI it degrades
// to one structured line per milestone.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const DIM = "[2m";
const RED = "[31m";
const YELLOW = "[33m";
const GREEN = "[32m";
const RESET = "[0m";
const CLEAR_LINE = "[2K\r";

/**
 * @param {{level?: string, isTty?: boolean, color?: boolean}} [options]
 */
export const createLogger = ({
  level = "info",
  isTty = Boolean(process.stdout.isTTY),
  color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
} = {}) => {
  const threshold = LEVELS[level] ?? LEVELS.info;
  let statusActive = false;

  const paint = (code, text) => (color ? `${code}${text}${RESET}` : text);

  /** Clear the in-place status line so a normal log line doesn't land on top of it. */
  const clearStatus = () => {
    if (statusActive && isTty) {
      process.stdout.write(CLEAR_LINE);
      statusActive = false;
    }
  };

  const emit = (levelName, prefix, args) => {
    if (LEVELS[levelName] > threshold) return;
    clearStatus();
    const stream =
      levelName === "error" || levelName === "warn"
        ? process.stderr
        : process.stdout;
    stream.write(`${prefix}${args.join(" ")}\n`);
  };

  return {
    error: (...args) => emit("error", paint(RED, "✗ "), args),
    warn: (...args) => emit("warn", paint(YELLOW, "! "), args),
    info: (...args) => emit("info", "", args),
    success: (...args) => emit("info", paint(GREEN, "✓ "), args),
    debug: (...args) => emit("debug", paint(DIM, "· "), args),

    /**
     * Render an in-place status line. No-op below info level. In non-TTY mode this is dropped
     * entirely — CI logs want milestones, not a thousand progress repaints.
     * @param {string} text
     */
    status: (text) => {
      if (LEVELS.info > threshold || !isTty) return;
      process.stdout.write(`${CLEAR_LINE}${paint(DIM, text)}`);
      statusActive = true;
    },

    clearStatus,

    /** Blank line, for separating run phases. */
    blank: () => {
      if (LEVELS.info > threshold) return;
      clearStatus();
      process.stdout.write("\n");
    },
  };
};
