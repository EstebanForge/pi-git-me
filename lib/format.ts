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

/**
 * Repo-context label for a confirm() / editor() dialog title. Returns a short
 * " (repo: <path>)" suffix ONLY when the tool targets a repository other than
 * the session default (ctx.cwd). The whole point of the review gate is that
 * the human knows WHICH repo a write will touch; without this, an agent that
 * passes cwd="/other/repo" could redirect a commit / PR / comment and the
 * dialog would not show it. When cwd === defaultCwd the title is already
 * accurate (it is the session repo), so no suffix is added.
 */
export function repoContextLabel(
  effectiveCwd: string | undefined,
  defaultCwd: string | undefined,
): string {
  if (!effectiveCwd || !defaultCwd || effectiveCwd === defaultCwd) return "";
  return ` (repo: ${effectiveCwd})`;
}

