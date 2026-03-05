// React hook wrapping the eval runner async generator into React state

import { useState, useRef, useCallback } from "react";
import { runEval } from "../../local/data/eval/runner.js";

/**
 * Hook for running RAG evals with React state management.
 *
 * @returns {{
 *   status: "idle"|"running"|"done"|"error",
 *   progress: Object|null,
 *   results: Array,
 *   summary: Object|null,
 *   error: string|null,
 *   run: Function,
 *   stop: Function,
 *   lastRun: Object|null,
 * }}
 */
export const useEval = () => {
  const [status, setStatus] = useState("idle");
  const [progress, setProgress] = useState(null);
  const [results, setResults] = useState([]);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [lastRun, setLastRun] = useState(null);
  const generatorRef = useRef(null);

  const run = useCallback(async ({ subject, judge, cases, temperature }) => {
    setStatus("running");
    setProgress(null);
    setResults([]);
    setSummary(null);
    setError(null);
    setLastRun(null);

    const generator = runEval({ subject, judge, cases, temperature });
    generatorRef.current = generator;

    try {
      for await (const event of generator) {
        if (event.type === "progress") {
          setProgress(event);
        } else if (event.type === "case_result") {
          setResults((prev) => [...prev, event.result]);
        } else if (event.type === "done") {
          setSummary(event.summary);
          setLastRun(event.run);
          setStatus("done");
        }
      }
      // Generator may finish without a "done" event if aborted
      setStatus((s) => (s === "running" ? "done" : s));
    } catch (err) {
      setError(err.message);
      setStatus("error");
    } finally {
      generatorRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    if (generatorRef.current) {
      generatorRef.current.return();
      generatorRef.current = null;
      setStatus("done");
    }
  }, []);

  return { status, progress, results, summary, error, run, stop, lastRun };
};
