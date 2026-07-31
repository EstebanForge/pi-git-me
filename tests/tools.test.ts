// Gate-wiring + apply-argv tests for the write tools.
//
// `node:child_process` is mocked so NO test shells out to real `git` / `gh`.
// The old suite was environment-dependent (it failed on a machine with an
// open PR for the cwd branch, and ran `gh auth status` ~12 times) and ran in
// the `prepublishOnly` hook. Each test now sets up spawnSync routes for the
// commands the tool will run, and the mock records every call so tests
// assert on the exact argv handed to git / gh (e.g. APPROVE -> `--approve`,
// `gh pr edit <number>` is number-addressed). The gate itself is fully
// tested in confirm.test.ts; these tests pin the per-tool wiring.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- child_process mock -----------------------------------------------------
// vi.hoisted runs before the imports below, so the mock is in place when the
// tool modules import spawnSync. Routes return spawnSync's real shape
// ({ stdout, stderr, status }) because spawnChecked maps status -> exitCode.
const { cpMock } = vi.hoisted(() => {
  type FakeResult = { stdout: string; stderr: string; status: number };
  type Route = {
    match: (cmd: string, args: string[]) => boolean;
    result: () => FakeResult;
  };
  const state: {
    routes: Route[];
    calls: Array<{ cmd: string; args: string[] }>;
  } = { routes: [], calls: [] };
  const spawnSyncMock = (cmd: string, args: string[]): FakeResult => {
    state.calls.push({ cmd, args: [...args] });
    for (const route of state.routes) {
      if (route.match(cmd, args)) return route.result();
    }
    return { stdout: "", stderr: "", status: 0 };
  };
  // `spawn` (async, used only by the commit apply path) is stubbed to throw
  // so a test that forgets to cancel at the gate fails loudly instead of
  // hanging on a real process.
  const spawnStub = (): never => {
    throw new Error("tests: async spawn is not mocked (commit apply path is not covered here)");
  };
  return { cpMock: { state, spawnSyncMock, spawnStub } };
});

vi.mock("node:child_process", () => ({
  spawnSync: cpMock.spawnSyncMock,
  spawn: cpMock.spawnStub,
}));

import { _resetAuthCache } from "../lib/auth";
import { commitTool } from "../lib/tools/commit";
import { prUpsertTool } from "../lib/tools/pr-upsert";
import { prCommentTool } from "../lib/tools/pr-comment";
import { issueCommentTool } from "../lib/tools/issue-comment";
import { prReviewTool } from "../lib/tools/pr-review";
import {
  setConfirmWriteEnabled,
  setAllowHeadlessWriteEnabled,
} from "../lib/confirm";
import { invokeWithCtx, makeCtx, makeStubUI, firstText } from "./_helpers";

type FakeResult = { stdout: string; stderr: string; status: number };
type Route = { match: (c: string, a: string[]) => boolean; result: () => FakeResult };

// Default routes: a repo is present, gh is installed and authed, something is
// staged (so non-amend commits reach the gate), and the current branch has no
// PR. Tests override or extend these per case.
const DEFAULT_ROUTES: Route[] = [
  { match: (c, a) => c === "git" && a[0] === "rev-parse", result: () => ({ stdout: "true", stderr: "", status: 0 }) },
  { match: (c, a) => c === "gh" && a[0] === "--version", result: () => ({ stdout: "gh version 2.40.0", stderr: "", status: 0 }) },
  { match: (c, a) => c === "gh" && a[0] === "auth" && a[1] === "status", result: () => ({ stdout: "", stderr: "", status: 0 }) },
  { match: (c, a) => c === "git" && a[0] === "diff" && a.includes("--cached") && a.includes("--quiet"), result: () => ({ stdout: "", stderr: "", status: 1 }) },
  { match: (c, a) => c === "gh" && a[0] === "pr" && a[1] === "view", result: () => ({ stdout: "", stderr: "no pull requests found", status: 1 }) },
];

function setupRoutes(extra: Route[] = []): void {
  // Extra routes take PRECEDENCE over defaults so a test can override e.g. the
  // `gh pr view` (no-PR) default with a real PR envelope.
  cpMock.state.routes = [...extra, ...DEFAULT_ROUTES];
  cpMock.state.calls = [];
}

function findCall(cmd: string, prefix: string[]): { cmd: string; args: string[] } | undefined {
  return cpMock.state.calls.find(
    (c) => c.cmd === cmd && c.args.slice(0, prefix.length).join(" ") === prefix.join(" "),
  );
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-git-me-tools-test-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;
  _resetAuthCache();
  setupRoutes();
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(tempDir, { recursive: true, force: true });
  _resetAuthCache();
});

// -------------------------------------------------- git_commit -------------

describe("git_commit - gate wiring", () => {
  it("user cancels (Esc in editor) -> 'commit cancelled by user' message", async () => {
    const ui = makeStubUI({ editorResponse: undefined });
    const result = await invokeWithCtx(
      commitTool,
      { subject: "feat: x" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("commit cancelled by user");
    expect(firstText(result)).toContain("Nothing was committed");
    expect(ui.prompts).toHaveLength(1);
    expect(ui.prompts[0].kind).toBe("editor");
    expect(ui.prompts[0].title).toMatch(/commit/i);
  });

  it("headless + no opt-in -> headless refused message, no prompt", async () => {
    const ui = makeStubUI({ hasUI: false });
    const result = await invokeWithCtx(
      commitTool,
      { subject: "feat: x" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("headless mode");
    expect(firstText(result)).toContain("/git headless on");
    expect(ui.prompts).toHaveLength(0);
  });

  it("user clears the message in the editor -> 'empty after edit' message", async () => {
    const ui = makeStubUI({ editorResponse: "   \n  " });
    const result = await invokeWithCtx(
      commitTool,
      { subject: "feat: x" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("empty after edit");
    expect(firstText(result)).toContain("nothing committed");
  });

  it("non-amend with nothing staged returns 'nothing staged' BEFORE the gate", async () => {
    // Pre-flight runs before the editor opens: exit 0 means nothing staged.
    setupRoutes([
      { match: (c, a) => c === "git" && a[0] === "diff" && a.includes("--cached") && a.includes("--quiet"), result: () => ({ stdout: "", stderr: "", status: 0 }) },
    ]);
    const ui = makeStubUI({ editorResponse: "feat: x" });
    const result = await invokeWithCtx(
      commitTool,
      { subject: "feat: x" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("nothing staged");
    expect(ui.prompts).toHaveLength(0); // gate never opened
  });
});

// -------------------------------------------------- git_pr_comment ----------

describe("git_pr_comment - gate wiring", () => {
  it("user cancels -> 'PR comment cancelled' message", async () => {
    const ui = makeStubUI({ editorResponse: undefined });
    const result = await invokeWithCtx(
      prCommentTool,
      { body: "lgtm", pr: 42 },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("PR comment cancelled");
    expect(ui.prompts).toHaveLength(1);
    expect(ui.prompts[0].title).toContain("42");
  });

  it("headless + no opt-in -> headless refused message", async () => {
    const ui = makeStubUI({ hasUI: false });
    const result = await invokeWithCtx(
      prCommentTool,
      { body: "lgtm", pr: 42 },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("headless mode");
    expect(firstText(result)).toContain("/git headless on");
  });

  it("default PR number resolution falls back to gh pr view; surfaces 'no PR' when none exists", async () => {
    // `pr` omitted -> the tool calls ghPrForCurrentBranch, which the default
    // route answers with status 1 (no PR). Deterministic: no real gh.
    const ui = makeStubUI({ editorResponse: undefined });
    const result = await invokeWithCtx(
      prCommentTool,
      { body: "lgtm" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("no PR found for the current branch");
    expect(ui.prompts).toHaveLength(0); // gate never fired
  });

  it("title mentions the PR number when one is supplied", async () => {
    const ui = makeStubUI({ editorResponse: undefined });
    await invokeWithCtx(
      prCommentTool,
      { body: "lgtm", pr: 123 },
      makeCtx(ui),
    );
    expect(ui.prompts[0].title).toContain("123");
  });

  it("posts `gh pr comment <number> --body <body>` on accept", async () => {
    const ui = makeStubUI({ editorResponse: "ship it" });
    const result = await invokeWithCtx(
      prCommentTool,
      { body: "ship it", pr: 42 },
      makeCtx(ui),
    );
    const call = findCall("gh", ["pr", "comment"]);
    expect(call).toBeDefined();
    expect(call!.args).toEqual(["pr", "comment", "42", "--body", "ship it"]);
    expect(firstText(result)).toContain("Posted comment on PR #42");
  });
});

// -------------------------------------------------- git_issue_comment ------

describe("git_issue_comment - gate wiring", () => {
  it("user cancels -> 'issue comment cancelled' message", async () => {
    const ui = makeStubUI({ editorResponse: undefined });
    const result = await invokeWithCtx(
      issueCommentTool,
      { number: 7, body: "reproduced" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("issue comment cancelled");
    expect(ui.prompts).toHaveLength(1);
    expect(ui.prompts[0].title).toContain("7");
  });

  it("headless + no opt-in -> headless refused message", async () => {
    const ui = makeStubUI({ hasUI: false });
    const result = await invokeWithCtx(
      issueCommentTool,
      { number: 7, body: "reproduced" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("headless mode");
    expect(ui.prompts).toHaveLength(0);
  });

  it("user clears the body in the editor -> 'empty after edit' message", async () => {
    const ui = makeStubUI({ editorResponse: " \n  " });
    const result = await invokeWithCtx(
      issueCommentTool,
      { number: 7, body: "reproduced" },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("empty after edit");
    expect(firstText(result)).toContain("nothing was posted");
  });

  it("posts `gh issue comment <number> --body <body>` on accept", async () => {
    const ui = makeStubUI({ editorResponse: "triaged" });
    const result = await invokeWithCtx(
      issueCommentTool,
      { number: 7, body: "triaged" },
      makeCtx(ui),
    );
    const call = findCall("gh", ["issue", "comment"]);
    expect(call).toBeDefined();
    expect(call!.args).toEqual(["issue", "comment", "7", "--body", "triaged"]);
    expect(firstText(result)).toContain("Posted comment on issue #7");
  });
});

// -------------------------------------------------- git_pr_review -----

// APPROVE / REQUEST_CHANGES are stateful and hard to reverse, so they are
// forced through the gate (prompted even with git-confirm-write off) and
// blocked unconditionally in headless mode (the headless opt-in does NOT
// apply). COMMENT behaves like the other prose tools.
describe("git_pr_review - APPROVE / REQUEST_CHANGES are forced", () => {
  it("APPROVE opens the editor even when git-confirm-write is off", async () => {
    setConfirmWriteEnabled(false);
    const ui = makeStubUI({ editorResponse: undefined }); // cancel
    const result = await invokeWithCtx(
      prReviewTool,
      { body: "lgtm", pr: 42, event: "APPROVE" },
      makeCtx(ui),
    );
    // Forced: the editor fires despite the review gate being off.
    expect(ui.prompts).toHaveLength(1);
    expect(ui.prompts[0].kind).toBe("editor");
    expect(ui.prompts[0].title).toMatch(/approve/i);
    expect(firstText(result)).toContain("cancelled");
  });

  it("REQUEST_CHANGES is also forced (editor opens with gate off)", async () => {
    setConfirmWriteEnabled(false);
    const ui = makeStubUI({ editorResponse: undefined });
    const result = await invokeWithCtx(
      prReviewTool,
      { body: "please fix x", pr: 42, event: "REQUEST_CHANGES" },
      makeCtx(ui),
    );
    expect(ui.prompts).toHaveLength(1);
    expect(ui.prompts[0].title).toMatch(/request changes/i);
    expect(firstText(result)).toContain("cancelled");
  });

  it("APPROVE is refused in headless even with git-allow-headless-write on", async () => {
    setAllowHeadlessWriteEnabled(true);
    const ui = makeStubUI({ hasUI: false });
    const result = await invokeWithCtx(
      prReviewTool,
      { body: "lgtm", pr: 42, event: "APPROVE" },
      makeCtx(ui),
    );
    // Forced writes block headless unconditionally; the opt-in does not help.
    expect(ui.prompts).toHaveLength(0);
    expect(firstText(result)).toContain("headless");
    expect(firstText(result)).not.toContain("/git headless on");
  });

  it("APPROVE on accept posts `gh pr review <n> --approve --body <body>`", async () => {
    const ui = makeStubUI({ editorResponse: "lgtm" });
    const result = await invokeWithCtx(
      prReviewTool,
      { body: "lgtm", pr: 42, event: "APPROVE" },
      makeCtx(ui),
    );
    const call = findCall("gh", ["pr", "review"]);
    expect(call).toBeDefined();
    expect(call!.args).toEqual(["pr", "review", "42", "--approve", "--body", "lgtm"]);
    expect(firstText(result)).toContain("Approved PR #42");
  });

  it("REQUEST_CHANGES on accept posts `gh pr review <n> --request-changes --body`", async () => {
    const ui = makeStubUI({ editorResponse: "fix the leak" });
    await invokeWithCtx(
      prReviewTool,
      { body: "fix the leak", pr: 8, event: "REQUEST_CHANGES" },
      makeCtx(ui),
    );
    const call = findCall("gh", ["pr", "review"]);
    expect(call!.args).toEqual(["pr", "review", "8", "--request-changes", "--body", "fix the leak"]);
  });

  it("COMMENT (default) on accept posts `gh pr review <n> --comment --body`", async () => {
    const ui = makeStubUI({ editorResponse: "nit: typo" });
    await invokeWithCtx(
      prReviewTool,
      { body: "nit: typo", pr: 3 },
      makeCtx(ui),
    );
    const call = findCall("gh", ["pr", "review"]);
    expect(call!.args).toEqual(["pr", "review", "3", "--comment", "--body", "nit: typo"]);
  });
});

// -------------------------------------------------- git_pr_upsert -----------

describe("git_pr_upsert - create vs edit", () => {
  it("no existing PR -> dialog says 'Open a new PR' and runs `gh pr create`", async () => {
    setupRoutes([
      { match: (c, a) => c === "gh" && a[0] === "pr" && a[1] === "create", result: () => ({ stdout: "https://github.com/o/r/pull/7\n", stderr: "", status: 0 }) },
    ]);
    const ui = makeStubUI({ editorResponse: "T\n\n---\n\nB" });
    const result = await invokeWithCtx(
      prUpsertTool,
      { title: "T", body: "B" },
      makeCtx(ui),
    );
    expect(ui.prompts[0].title).toContain("Open a new PR");
    const call = findCall("gh", ["pr", "create"]);
    expect(call).toBeDefined();
    expect(call!.args).toEqual(["pr", "create", "--title", "T", "--body", "B", "--base", "main"]);
    expect(firstText(result)).toContain("Opened PR");
    expect(firstText(result)).toContain("https://github.com/o/r/pull/7");
  });

  it("existing PR -> dialog says 'Overwrite PR #N' and runs `gh pr edit <number>`", async () => {
    const prJson = JSON.stringify({
      number: 99, title: "old", body: "", state: "OPEN",
      url: "https://github.com/o/r/pull/99", baseRefName: "main",
      headRefName: "feat", isDraft: false,
    });
    setupRoutes([
      { match: (c, a) => c === "gh" && a[0] === "pr" && a[1] === "view", result: () => ({ stdout: prJson, stderr: "", status: 0 }) },
      { match: (c, a) => c === "gh" && a[0] === "pr" && a[1] === "edit", result: () => ({ stdout: "", stderr: "", status: 0 }) },
    ]);
    const ui = makeStubUI({ editorResponse: "T2\n\n---\n\nB2" });
    const result = await invokeWithCtx(
      prUpsertTool,
      { title: "T2", body: "B2" },
      makeCtx(ui),
    );
    expect(ui.prompts[0].title).toContain("Overwrite PR #99");
    const call = findCall("gh", ["pr", "edit"]);
    // Number-addressed, not branch-addressed: a checkout between resolve and
    // apply cannot edit the wrong PR.
    expect(call!.args).toEqual(["pr", "edit", "99", "--title", "T2", "--body", "B2"]);
    expect(firstText(result)).toContain("Updated PR #99");
  });

  it("user deletes the separator -> falls back to the agent title, still applies", async () => {
    setupRoutes([
      { match: (c, a) => c === "gh" && a[0] === "pr" && a[1] === "create", result: () => ({ stdout: "https://github.com/o/r/pull/1\n", stderr: "", status: 0 }) },
    ]);
    // Editor returns body-only (separator deleted). fromPrefill must keep the
    // agent-supplied title instead of hard-failing after acceptance.
    const ui = makeStubUI({ editorResponse: "just a body now" });
    const result = await invokeWithCtx(
      prUpsertTool,
      { title: "AgentTitle", body: "AgentBody" },
      makeCtx(ui),
    );
    const call = findCall("gh", ["pr", "create"]);
    expect(call!.args).toEqual(["pr", "create", "--title", "AgentTitle", "--body", "just a body now", "--base", "main"]);
    expect(firstText(result)).toContain("Opened PR");
  });
});

// -------------------------------------------------- gate wiring -------------

describe("gate wiring - confirm-write off", () => {
  it("a COMMENT review SKIPS the dialog and proceeds when git-confirm-write is off", async () => {
    setConfirmWriteEnabled(false);
    const ui = makeStubUI({ editorResponse: undefined }); // would cancel, but gate is off
    const result = await invokeWithCtx(
      prReviewTool,
      { body: "note", pr: 5 },
      makeCtx(ui),
    );
    expect(ui.prompts).toHaveLength(0); // gate skipped entirely
    const call = findCall("gh", ["pr", "review"]);
    expect(call!.args).toEqual(["pr", "review", "5", "--comment", "--body", "note"]);
    expect(firstText(result)).toContain("Posted review comment on PR #5");
  });

  it("APPROVE still opens the dialog when git-confirm-write is off (forced)", async () => {
    setConfirmWriteEnabled(false);
    const ui = makeStubUI({ editorResponse: undefined }); // cancel
    await invokeWithCtx(
      prReviewTool,
      { body: "lgtm", pr: 5, event: "APPROVE" },
      makeCtx(ui),
    );
    expect(ui.prompts).toHaveLength(1); // forced: still prompts
  });
});

// -------------------------------------------------- amend path -------------

describe("git_commit - amend path skips the staged pre-flight", () => {
  it("amend with nothing staged still gets to the gate (no 'nothing staged' message)", async () => {
    // Default route says nothing staged (status 0) for the cached check, but
    // amend skips the pre-flight, so the gate is the only thing that runs.
    setupRoutes([
      { match: (c, a) => c === "git" && a[0] === "diff" && a.includes("--cached") && a.includes("--quiet"), result: () => ({ stdout: "", stderr: "", status: 0 }) },
    ]);
    const ui = makeStubUI({ editorResponse: undefined });
    const result = await invokeWithCtx(
      commitTool,
      { subject: "fix: tweaked", amend: true },
      makeCtx(ui),
    );
    expect(firstText(result)).toContain("commit cancelled");
    expect(ui.prompts[0].title).toContain("Amend");
  });
});
