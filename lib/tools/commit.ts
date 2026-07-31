import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { runGit, requireGitRepo, GitMeEnvError } from "../auth";
import { confirmWrite } from "../confirm";
import { formatCommitMessage, oneLine } from "../format";
import { toToolResult, errorText, type GitDetails } from "../result";
import {
  COMMIT_TITLE,
  COMMIT_DESCRIPTION,
  COMMIT_SUBJECT_DESCRIPTION,
  COMMIT_BODY_DESCRIPTION,
  COMMIT_AMEND_DESCRIPTION,
} from "../prompts";

// Commit the staged changes with the agent's suggested message. The agent
// supplies subject and (optional) body; this tool runs the two-stage human
// gate (headless guard + editable preview) and then applies via
// `git commit -F -` so the message is read from stdin (avoids quoting/escape
// issues for any character, including newlines, quotes, or NULs).
//
// Pre-flight: at least one staged change is required, otherwise git commit
// fails with "nothing to commit". We surface a readable message instead of
// letting the agent chase the error.

const Params = Type.Object({
  subject: Type.String({ description: COMMIT_SUBJECT_DESCRIPTION, minLength: 1 }),
  body: Type.Optional(Type.String({ description: COMMIT_BODY_DESCRIPTION })),
  amend: Type.Optional(
    Type.Boolean({ description: COMMIT_AMEND_DESCRIPTION }),
  ),
});

export const commitTool: ToolDefinition<typeof Params, GitDetails> = {
  name: "git_commit",
  label: COMMIT_TITLE,
  description: COMMIT_DESCRIPTION,
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
    } catch (err) {
      if (err instanceof GitMeEnvError) return toToolResult(err.message);
      throw err;
    }

    // Pre-flight BEFORE the gate: `git diff --cached --quiet` exits 0 when
    // nothing is staged. Check first so we do not open the editor, let the
    // user edit a message, and only then report there is nothing to commit.
    // --amend rewrites the last commit's message even with no staged changes,
    // so the check is skipped when amending.
    if (!params.amend) {
      const staged = runGit(["diff", "--cached", "--quiet"]);
      if (staged.exitCode === 0) {
        return toToolResult(
          "git-me: nothing staged to commit. Stage your changes first (e.g. `git add`) and try again. Use git_diff target=staged to inspect.",
        );
      }
    }

    const prefill = formatCommitMessage(params.subject, params.body);
    const summary = `commit message:\n${oneLine(prefill)}`;

    const decision = await confirmWrite(ctx, {
      title: params.amend
        ? "Amend last commit with this message?"
        : "Commit staged changes with this message?",
      editableText: prefill,
      summary,
    });
    if (!decision.proceed) {
      return toToolResult(
        ctx.hasUI
          ? "git-me: commit cancelled by user. Nothing was committed."
          : "git-me: commit not applied (headless mode; no UI to review). Use /git headless on to allow unsupervised commits.",
      );
    }

    const message = (decision.text ?? prefill).trimEnd() + "\n";
    if (!message.trim()) {
      return toToolResult(
        "git-me: commit message is empty after edit; nothing committed.",
      );
    }

    // Apply. `git commit -F -` reads the message from stdin; we spawn
    // asynchronously because we need to write to stdin.
    try {
      const result = await commitWithMessage(params.amend === true, message);
      if (result.exitCode !== 0) {
        return toToolResult(
          result.stderr.trim() ||
            `git-me: \`git commit\` exited ${result.exitCode} with no stderr.`,
        );
      }
      const verb = params.amend ? "Amended last commit with" : "Committed staged changes with";
      return toToolResult(`${verb} message:\n${message}`);
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};

// Async spawn so we can write the message to stdin. Mirrors the sync wrapper
// in lib/auth.ts but is the one place that needs write access. A 30s timeout
// (matching spawnChecked) prevents a hung pre-commit hook or a GPG/SSH
// signing TTY prompt from locking the agent turn forever.
async function commitWithMessage(amend: boolean, message: string) {
  return await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve) => {
      const args = ["commit", "-F", "-"];
      if (amend) args.push("--amend");
      const child = spawn("git", args, {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (
        result: { stdout: string; stderr: string; exitCode: number },
      ) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish({
          stdout,
          stderr:
            "git-me: `git commit` timed out after 30s (killed by SIGTERM). A pre-commit hook or a commit-signing prompt may be waiting on the TTY.",
          exitCode: 124,
        });
      }, 30_000);
      child.stdout.on("data", (b: Buffer) => {
        stdout += b.toString("utf8");
      });
      child.stderr.on("data", (b: Buffer) => {
        stderr += b.toString("utf8");
      });
      child.on("error", (err) => {
        finish({ stdout, stderr: stderr || err.message, exitCode: 1 });
      });
      child.on("close", (code) => {
        finish({ stdout, stderr, exitCode: code ?? 1 });
      });
      child.stdin.on("error", () => {
        // EPIPE when git closes stdin early (e.g. nothing to commit). The
        // close handler will fire and we will read the error from stderr.
      });
      child.stdin.end(message);
    },
  );
}
