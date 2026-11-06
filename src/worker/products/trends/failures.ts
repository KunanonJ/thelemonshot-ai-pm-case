// ② Trend Monitoring: the words a signed-in user reads when a search or a brief could not finish (BR-CORE-3).
// Rows store a code. Raw Apify and exception text goes to console.error and to the operator-only apify_runs.error.
// Same pattern as the proposal section failures: one fixed plain sentence per code.

export const TERM_FAILURE_CODES = ["start_failed", "poll_failed", "run_ended", "poll_timeout", "no_dataset", "pull_timeout", "search_failed", "quota_reached", "unexpected"] as const;
export type TermFailureCode = (typeof TERM_FAILURE_CODES)[number];

const TERM_FAILURE_TEXT: Record<TermFailureCode, string> = {
  start_failed: "This search could not be started on Apify.",
  poll_failed: "Apify stopped answering while this search ran.",
  run_ended: "Apify ended this search before it finished.",
  poll_timeout: "Apify did not finish this search in time.",
  no_dataset: "Apify finished this search without saving any results.",
  pull_timeout: "This search was still open when the pull ran out of time.",
  search_failed: "YouTube did not answer this search.",
  quota_reached: "Today's YouTube search allowance is used up. It resets tomorrow.",
  unexpected: "Something went wrong while this search was collected.",
};

const isTermFailureCode = (code: string): code is TermFailureCode => Object.prototype.hasOwnProperty.call(TERM_FAILURE_TEXT, code);

// The sentence for a failed term. An unknown value (an old row, a raw message) gets the generic sentence, never the raw text
export function failedTermText(code: string | null | undefined): string {
  return code && isTermFailureCode(code) ? TERM_FAILURE_TEXT[code] : TERM_FAILURE_TEXT.unexpected;
}

// Actor error items do not fail a search. The note says so in plain words; the item codes stay with the operator
export const ACTOR_ERRORS_NOTE = "Apify reported an error for part of this search.";

export function actorNote(errorCodes: string[]): string | null {
  return errorCodes.length ? ACTOR_ERRORS_NOTE : null;
}

// Why a trend run ends without a brief. The dead-letter list shows the same sentence.
export const RUN_FAILURE_TEXT = {
  brief: "The brief could not be written for this pull.",
  stopped: "The pull stopped before a brief was written.",
} as const;
