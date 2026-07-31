import { Type } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { requireGitRepo, requireGh, GitMeEnvError } from "../auth";
import { ghPrForCurrentBranch } from "../git";
import { toToolResult } from "../result";
import {
  GIT_PR_INFO_TITLE,
  GIT_PR_INFO_DESCRIPTION,
} from "../prompts";

const Params = Type.Object({});

export const prInfoTool: ToolDefinition<typeof Params, undefined> = {
  name: "git_pr_info",
  label: GIT_PR_INFO_TITLE,
  description: GIT_PR_INFO_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId,
    _params,
    _signal,
    _onUpdate,
    _ctx,
  ): Promise<AgentToolResult<undefined>> {
    // Preflight env so a missing repo or missing/unauthed `gh` surfaces one
    // actionable error instead of a generic "no PR" that hides the cause.
    try {
      requireGitRepo();
      requireGh();
    } catch (err) {
      if (err instanceof GitMeEnvError) return toToolResult(err.message);
      throw err;
    }
    const pr = ghPrForCurrentBranch();
    if (!pr) {
      return toToolResult(
        "git-me: no PR found for the current branch. Use git_pr_upsert to open one, or pass a different branch.",
      );
    }
    const lines = [
      `#${pr.number} ${pr.title}`,
      `state: ${pr.state}${pr.isDraft ? " (draft)" : ""}`,
      `branch: ${pr.headRefName} -> ${pr.baseRefName}`,
      `url: ${pr.url}`,
      pr.author ? `author: ${pr.author.login}` : null,
      pr.reviewDecision ? `review: ${pr.reviewDecision}` : null,
      "",
      "body:",
      pr.body || "(empty)",
    ].filter((l): l is string => l !== null);
    return toToolResult(lines.join("\n"));
  },
};
