/* global localStorage:false */
// Eval results storage — localStorage CRUD + export
// Zero DOM/React dependencies

const STORAGE_KEY = "eval_results";
const MAX_RUNS = 20;

/**
 * Get all stored runs (summary only — no case details).
 * @returns {Array<{ id: string, timestamp: number, subject: Object, judge: Object, summary: Object }>}
 */
export const getRuns = () => {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return data.map(({ id, timestamp, subject, judge, summary }) => ({
      id,
      timestamp,
      subject,
      judge,
      summary,
    }));
  } catch {
    return [];
  }
};

/**
 * Get a full run by ID (includes all case details).
 * @param {string} id
 * @returns {Object|null}
 */
export const getRun = (id) => {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return data.find((run) => run.id === id) || null;
  } catch {
    return null;
  }
};

/**
 * Save a run. Appends to storage, capping at MAX_RUNS (oldest removed first).
 * @param {Object} run - Full run object with id, timestamp, subject, judge, summary, cases
 */
export const saveRun = (run) => {
  let data;
  try {
    data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    data = [];
  }

  data.push(run);

  // Cap at MAX_RUNS — remove oldest first
  while (data.length > MAX_RUNS) {
    data.shift();
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
};

/**
 * Delete a run by ID.
 * @param {string} id
 */
export const deleteRun = (id) => {
  try {
    let data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    data = data.filter((run) => run.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // noop
  }
};

/**
 * Export a run as a JSON string for download.
 * @param {Object} run
 * @returns {string}
 */
export const exportRun = (run) => JSON.stringify(run, null, 2);
