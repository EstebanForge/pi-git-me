import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runGh, requireGitRepo, requireGh, GitMeEnvError } from "../auth";
import { confirmWrite } from "../confirm";
import { describePrPayload } from "../format";
import { ghPrForCurrentBranch } from "../git";
import { toToolResult, errorText, type GitDetails } from "../result";
import {
  PR_UPSERT_TITLE,
  PR_UPSERT_DESCRIPTION,
  PR_UPSERT_TITLE_DESCRIPTION,
  PR_UPSERT_BODY_DESCRIPTION,
  PR_UPSERT_BASE_DESCRIPTION,
  PR_UPSERT_DRAFT_DESCRIPTION,
} from "../prompts";

// Create or update the PR for the current branch. The agent supplies title
// and body; this tool runs the two-stage human gate (headless guard +
// editable preview) and then applies via `gh pr create` (when no PR exists)
// or `gh pr edit` (when one already exists).
//
// The PR title is prepended to the body in the editor prefill so the user
// edits both in a single dialog. On apply we split them back apart for the
// `gh pr edit` / `gh pr create` flags.

const Params = Type.Object({
  title: Type.String({ description: PR_UPSERT_TITLE_DESCRIPTION, minLength: 1 }),
  body: Type.String({ description: PR_UPSERT_BODY_DESCRIPTION, minLength: 1 }),
  base: Type.Optional(Type.String({ description: PR_UPSERT_BASE_DESCRIPTION })),
  draft: Type.Optional(Type.Boolean({ description: PR_UPSERT_DRAFT_DESCRIPTION })),
});

// Internal separators the editor prefill uses to keep title/body in one
// buffer. ASCII control chars are unlikely in user-typed content; if a user
// pastes them verbatim we accept the ambiguity over adding extra round-trips.
const TITLE_BODY_SEP = "\n\n---\n\n";

function toPrefill(title: string, body: string): string {
  return `${title.trim()}${TITLE_BODY_SEP}${body}`;
}

function fromPrefill(
  text: string,
  fallbackTitle: string,
): { title: string; body: string } {
  const idx = text.indexOf(TITLE_BODY_SEP);
  if (idx === -1) {
    // User removed the separator. Treat the whole buffer as the body and keep
    // the agent-supplied title, so the write does NOT hard-fail after the
    // user already accepted. (If they also blanked the original title param,
    // the !title guard below still catches it.)
    return { title: fallbackTitle.trim(), body: text.trim() };
  }
  return {
    title: text.slice(0, idx).trim(),
    body: text.slice(idx + TITLE_BODY_SEP.length).trim(),
  };
}

export const prUpsertTool: ToolDefinition<typeof Params, GitDetails> = {
  name: "git_pr_upsert",
  label: PR_UPSERT_TITLE,
  description: PR_UPSERT_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
    _signal,
    _onUpdate,
    ctx,
  ): Promise<AgentToolResult<GitDetails>> {
    try {
      requireGitRepo();
      requireGh();
    } catch (err) {
      if (err instanceof GitMeEnvError) return toToolResult(err.message);
      throw err;
    }

    // Resolve existing PR BEFORE the gate (requireGh above ruled out
    // gh-missing / gh-unauthed, so null genuinely means "no PR"). This lets
    // the dialog tell the user whether they are CREATING a new public PR or
    // OVERWRITING an existing one - materially different consequences that
    // used to share one vague prompt.
    const existing = ghPrForCurrentBranch();
    const base = params.base ?? "main";

    const prefill = toPrefill(params.title, params.body);
    const summary = describePrPayload(params.title, params.body);

    const decision = await confirmWrite(ctx, {
      title:
        existing === null
          ? `Open a new PR (${base} <- HEAD) with this title + body?`
          : `Overwrite PR #${existing.number} title + body?`,
      editableText: prefill,
      summary,
    });
    if (!decision.proceed) {
      return toToolResult(
        ctx.hasUI
          ? "git-me: PR description cancelled by user. Nothing was sent to gh."
          : "git-me: PR description not applied (headless mode; no UI to review). Use /git headless on to allow unsupervised PR edits.",
      );
    }

    const { title, body } = fromPrefill(decision.text ?? prefill, params.title);
    if (!title || !body) {
      return toToolResult(
        "git-me: PR title and body are both required. Edit left one empty; nothing was applied.",
      );
    }

    try {
      if (existing === null) {
        // CREATE branch.
        const args = [
          "pr",
          "create",
          "--title",
          title,
          "--body",
          body,
          "--base",
          base,
        ];
        if (params.draft) args.push("--draft");
        const result = runGh(args);
        if (result.exitCode !== 0) {
          const detail = result.stderr.trim() || result.stdout.trim();
          return toToolResult(
            `git-me: \`gh pr create\` failed (exit ${result.exitCode}). ${detail}`,
          );
        }
        // gh pr create prints the new PR URL on stdout.
        return toToolResult(
          `Opened PR ${base} <- HEAD with\n  title: ${title}\n  body: ${body.slice(0, 200)}${body.length > 200 ? "..." : ""}\n  url:   ${result.stdout.trim()}`,
        );
      }

      // EDIT branch. Address the PR by NUMBER (not the current branch) so a
      // branch checkout between resolve and apply cannot edit the wrong PR.
      const result = runGh([
        "pr",
        "edit",
        String(existing.number),
        "--title",
        title,
        "--body",
        body,
      ]);
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();
        return toToolResult(
          `git-me: \`gh pr edit\` failed (exit ${result.exitCode}). ${detail}`,
        );
      }
      return toToolResult(
        `Updated PR #${existing.number} (${existing.headRefName} -> ${existing.baseRefName}) with\n  title: ${title}\n  body: ${body.slice(0, 200)}${body.length > 200 ? "..." : ""}\n  url:   ${existing.url}`,
      );
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
