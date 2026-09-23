// Where speech can be cut without a listener hearing the seam.
//
// Two callers need this and must agree. The server splits a finished reply
// into utterances before synthesis, and the renderer splits a reply that is
// still streaming so a voice call can start speaking before the model has
// finished. If the two disagreed, the same sentence would be chunked one way
// when streamed and another when synthesized in one go, and the difference is
// audible: each clip carries its own intonation and ends with a small pause.
//
// Keeping the rule here rather than copying it also keeps the awkward cases in
// one place. They are the reason this is not simply "split on a period".

/** Sentences that a period does not actually end. */
const ABBREVIATIONS = ["e\\.g", "i\\.e", "etc", "vs", "Dr", "Mr", "Mrs", "Ms", "No", "approx"];

/**
 * Sentence-ish boundary: `.`, `!` or `?` followed by whitespace, but not
 * inside a decimal, an ellipsis, or a common abbreviation.
 *
 * Built fresh on each call because a global regex carries `lastIndex`, and a
 * shared instance silently resumes mid-string for the next caller.
 */
export function sentenceBoundary(): RegExp {
  return new RegExp(
    `(?<!\\b(?:${ABBREVIATIONS.join("|")}))(?<![.\\d])([.!?])(["')\\]]*)\\s+`,
    "g",
  );
}

/** A softer break, usable once a clause is long enough to stand on its own. */
export function clauseBoundary(): RegExp {
  return /([,;:—])\s+/g;
}
