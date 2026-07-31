// Tool result wrapper. Every tool returns plain text via AgentToolResult; this
// helper is the single place that constructs that shape. A `details` slot is
// left open so future tools can attach metadata (e.g. a SHA, PR URL, diff
// stat) without touching every caller.

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

// git-me tools return plain text; structured details are not used today but
// the union is left open so future tools can attach metadata without touching
// every caller.
export type GitDetails = undefined;

export function toToolResult(
  text: string,
  details?: GitDetails,
): AgentToolResult<GitDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

// Single error formatter shared across every tool. All git/gh errors are
// caught at the tool boundary and converted to readable text rather than
// thrown - the agent sees a single, actionable message instead of a stack
// trace.
export function errorText(err: unknown): string {
  if (err instanceof Error) {
    return `git-me error: ${err.message}`;
  }
  return "git-me error: unknown failure.";
}
