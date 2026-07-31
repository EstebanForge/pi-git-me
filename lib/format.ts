// Formatting helpers shared across tools. These turn verbose raw outputs
// into the short, readable strings the confirm() / editor() dialogs render.

const PREVIEW_CAP = 240;

/** Collapse whitespace and cap length. Used in confirm() summaries. */
export function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CAP ? `${flat.slice(0, PREVIEW_CAP)}...` : flat;
}

/** Format a commit message as "subject\n\nbody". Empty/missing body -> just the subject. */
export function formatCommitMessage(subject: string, body?: string): string {
  const s = subject.trim();
  const b = (body ?? "").trim();
  if (!b) return s;
  return `${s}\n\n${b}`;
}

/** Render the title + body block the agent and confirm() will show. */
export function describePrPayload(title: string, body: string): string {
  return `title: ${oneLine(title)}\n\nbody:\n${oneLine(body)}`;
}

/** Render the review body the confirm() dialog will show. */
export function describeReviewPayload(body: string): string {
  return oneLine(body);
}

