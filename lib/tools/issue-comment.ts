import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runGh, requireGitRepo, requireGh, GitMeEnvError } from "../auth";
import { confirmWrite } from "../confirm";
import { describeReviewPayload, repoContextLabel } from "../format";
import { toToolResult, errorText, postedContentExtras, type GitDetails } from "../result";
import {
  ISSUE_COMMENT_TITLE,
  ISSUE_COMMENT_DESCRIPTION,
  ISSUE_COMMENT_BODY_DESCRIPTION,
  ISSUE_COMMENT_NUMBER_DESCRIPTION,
  CWD_DESCRIPTION,
} from "../prompts";

// Post a comment on a GitHub issue. The agent supplies the issue number and
// the comment body; this tool runs the two-stage human gate (headless guard
// + editable preview) and then applies via `gh issue comment <number> --body`
// so the comment is read from a flag (no shell quoting issues).
//
// Issues have no equivalent of "current branch" so the issue number is
// required (no default). When the user does not know the number they should
// run `gh issue list` themselves or use a read tool that exposes the search
// surface (not implemented here).

const Params = Type.Object({
  number: Type.Integer({
    description: ISSUE_COMMENT_NUMBER_DESCRIPTION,
    minimum: 1,
  }),
  body: Type.String({ description: ISSUE_COMMENT_BODY_DESCRIPTION, minLength: 1 }),
  cwd: Type.Optional(Type.String({ description: CWD_DESCRIPTION })),
});

export const issueCommentTool: ToolDefinition<typeof Params, GitDetails> = {
  name: "git_issue_comment",
  label: ISSUE_COMMENT_TITLE,
  description: ISSUE_COMMENT_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
    _signal,
    _onUpdate,
    ctx,
  ): Promise<AgentToolResult<GitDetails>> {
    const cwd = params.cwd ?? ctx.cwd;
    try {
      requireGitRepo(cwd);
      requireGh();
    } catch (err) {
      if (err instanceof GitMeEnvError) return toToolResult(err.message);
      throw err;
    }

    const decision = await confirmWrite(ctx, {
      title: `Post this comment on issue #${params.number}?${repoContextLabel(cwd, ctx.cwd)}`,
      editableText: params.body,
      summary: describeReviewPayload(params.body),
      normalize: (s) => s.trimEnd(),
    });
    if (!decision.proceed) {
      return toToolResult(
        ctx.hasUI
          ? `git-me: issue comment cancelled by user. Nothing was sent to gh.`
          : `git-me: issue comment not posted (headless mode; no UI to review). Use /git headless on to allow unsupervised comments.`,
      );
    }

    const body = (decision.text ?? params.body).trimEnd();
    if (!body) {
      return toToolResult(
        "git-me: issue comment body is empty after edit; nothing was posted.",
      );
    }

    try {
      const result = runGh([
        "issue",
        "comment",
        String(params.number),
        "--body",
        body,
      ], cwd);
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();
        return toToolResult(
          `git-me: \`gh issue comment\` failed (exit ${result.exitCode}). ${detail}`,
        );
      }
      const { extraText, details } = postedContentExtras(body, decision.edited ?? false);
      return toToolResult(`Posted comment on issue #${params.number}.${extraText}`, details);
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
