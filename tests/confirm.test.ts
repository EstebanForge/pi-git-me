// Confirm gate matrix. The gate is the heart of pi-git-me: it is the single
// piece of code that decides whether a write (commit, PR description, review
// comment) reaches git or gh, and on what terms. These tests pin the matrix:
//
//                              confirmWrite  allowHeadlessWrite
//                                  ON             ON | OFF
//   hasUI=true,  forced=false    PROCEED       PROCEED       (no prompt when confirmWrite=OFF)
//   hasUI=true,  forced=true     ASK (yes/no)  ASK (yes/no)
//   hasUI=false, forced=false    PROCEED       REFUSED
//   hasUI=false, forced=true     REFUSED       REFUSED
//
// confirmWrite defaults ON, allowHeadlessWrite defaults OFF. Every assertion
// uses a temp PI_CODING_AGENT_DIR so the on-disk settings file does not leak
// between cases (or to the real user state).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIRM_WRITE_FLAG,
  ALLOW_HEADLESS_WRITE_FLAG,
  confirmWrite,
  getAllowHeadlessWriteEnabled,
  getConfirmWriteEnabled,
  setAllowHeadlessWriteEnabled,
  setConfirmWriteEnabled,
} from "../lib/confirm";
import type { ConfirmContext } from "../lib/confirm";
import { makeStubUI } from "./_helpers";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-git-me-test-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

function ctxWith(ui: ReturnType<typeof makeStubUI>): ConfirmContext {
  return { hasUI: ui.hasUI, ui: ui.ui };
}

describe("confirm gate defaults", () => {
  it("confirmWrite defaults to ON", () => {
    expect(getConfirmWriteEnabled()).toBe(true);
  });

  it("allowHeadlessWrite defaults to OFF", () => {
    expect(getAllowHeadlessWriteEnabled()).toBe(false);
  });

  it("flag names match the documented public API", () => {
    expect(CONFIRM_WRITE_FLAG).toBe("git-confirm-write");
    expect(ALLOW_HEADLESS_WRITE_FLAG).toBe("git-allow-headless-write");
  });
});

describe("confirm gate - editable path (UI present, confirmWrite ON)", () => {
  it("returns the (possibly edited) text and records the prompt", async () => {
    const ui = makeStubUI({ editorResponse: "feat: tweaked" });
    const outcome = await confirmWrite(ctxWith(ui), {
      title: "Commit?",
      editableText: "feat: original",
      summary: "(ignored - editor path)",
    });
    expect(outcome.proceed).toBe(true);
    expect(outcome.text).toBe("feat: tweaked");
    expect(ui.prompts).toHaveLength(1);
    expect(ui.prompts[0]).toEqual({
      kind: "editor",
      title: "Commit?",
      body: "feat: original",
    });
  });

  it("editor returning undefined cancels (Esc) -> proceed=false", async () => {
    const ui = makeStubUI({ editorResponse: undefined });
    const outcome = await confirmWrite(ctxWith(ui), {
      title: "Commit?",
      editableText: "feat: original",
      summary: "(ignored)",
    });
    expect(outcome.proceed).toBe(false);
    expect(outcome.text).toBeUndefined();
  });
});

describe("confirm gate - confirmWrite OFF (no prompt)", () => {
  it("skips the prompt and proceeds with the original text", async () => {
    setConfirmWriteEnabled(false);
    const ui = makeStubUI();
    const outcome = await confirmWrite(ctxWith(ui), {
      title: "Commit?",
      editableText: "feat: original",
      summary: "(ignored)",
    });
    expect(outcome.proceed).toBe(true);
    expect(outcome.text).toBe("feat: original");
    expect(ui.prompts).toHaveLength(0);
  });
});

describe("confirm gate - confirm() path (UI present, no editableText)", () => {
  it("yes/no answer drives proceed", async () => {
    const ui = makeStubUI({ confirmResponse: true });
    const ok = await confirmWrite(ctxWith(ui), {
      title: "Apply?",
      summary: "summary here",
    });
    expect(ok.proceed).toBe(true);
    expect(ui.prompts[0]).toEqual({ kind: "confirm", title: "Apply?", body: "summary here" });

    const ui2 = makeStubUI({ confirmResponse: false });
    const no = await confirmWrite(ctxWith(ui2), {
      title: "Apply?",
      summary: "summary here",
    });
    expect(no.proceed).toBe(false);
  });
});

describe("confirm gate - HEADLESS guard", () => {
  it("headless + confirmWrite ON + headless opt-in OFF -> refused", async () => {
    setAllowHeadlessWriteEnabled(false);
    const ui = makeStubUI({ hasUI: false });
    const outcome = await confirmWrite(ctxWith(ui), {
      title: "Commit?",
      editableText: "feat: original",
      summary: "(ignored)",
    });
    expect(outcome.proceed).toBe(false);
    expect(ui.prompts).toHaveLength(0);
  });

  it("headless + headless opt-in ON -> proceeds without prompt", async () => {
    setAllowHeadlessWriteEnabled(true);
    const ui = makeStubUI({ hasUI: false });
    const outcome = await confirmWrite(ctxWith(ui), {
      title: "Commit?",
      editableText: "feat: original",
      summary: "(ignored)",
    });
    expect(outcome.proceed).toBe(true);
    expect(outcome.text).toBe("feat: original");
    expect(ui.prompts).toHaveLength(0);
  });

  it("headless + forced (destructive) -> ALWAYS refused, no opt-in", async () => {
    setAllowHeadlessWriteEnabled(true);
    const ui = makeStubUI({ hasUI: false });
    const outcome = await confirmWrite(ctxWith(ui), {
      title: "Force push?",
      summary: "destructive",
      requireInteractive: true,
    });
    expect(outcome.proceed).toBe(false);
    expect(ui.prompts).toHaveLength(0);
  });
});

describe("confirm gate - forced (requireInteractive) overrides flag", () => {
  it("with UI present, forces a confirm even when confirmWrite is OFF", async () => {
    setConfirmWriteEnabled(false);
    const ui = makeStubUI({ confirmResponse: true });
    const outcome = await confirmWrite(ctxWith(ui), {
      title: "Destructive?",
      summary: "this is irreversible",
      requireInteractive: true,
    });
    expect(outcome.proceed).toBe(true);
    expect(ui.prompts).toHaveLength(1);
    expect(ui.prompts[0].kind).toBe("confirm");
  });

  it("with UI present and user says no -> refused", async () => {
    setConfirmWriteEnabled(false);
    const ui = makeStubUI({ confirmResponse: false });
    const outcome = await confirmWrite(ctxWith(ui), {
      title: "Destructive?",
      summary: "this is irreversible",
      requireInteractive: true,
    });
    expect(outcome.proceed).toBe(false);
  });
});

describe("settings persistence", () => {
  it("setters are read-merge-write (toggling one does not clobber the other)", async () => {
    setConfirmWriteEnabled(false);
    setAllowHeadlessWriteEnabled(true);
    expect(getConfirmWriteEnabled()).toBe(false);
    expect(getAllowHeadlessWriteEnabled()).toBe(true);

    // Toggling confirm back to true must NOT reset the headless flag.
    setConfirmWriteEnabled(true);
    expect(getConfirmWriteEnabled()).toBe(true);
    expect(getAllowHeadlessWriteEnabled()).toBe(true);

    // And vice versa.
    setAllowHeadlessWriteEnabled(false);
    expect(getAllowHeadlessWriteEnabled()).toBe(false);
    expect(getConfirmWriteEnabled()).toBe(true);
  });
});
