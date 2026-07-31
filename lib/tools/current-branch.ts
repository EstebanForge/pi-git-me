import { Type } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { gitCurrentBranch } from "../git";
import { toToolResult } from "../result";
import {
  GIT_CURRENT_BRANCH_TITLE,
  GIT_CURRENT_BRANCH_DESCRIPTION,
} from "../prompts";

const Params = Type.Object({});

export const currentBranchTool: ToolDefinition<typeof Params, undefined> = {
  name: "git_current_branch",
  label: GIT_CURRENT_BRANCH_TITLE,
  description: GIT_CURRENT_BRANCH_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId,
    _params,
    _signal,
    _onUpdate,
    _ctx,
  ): Promise<AgentToolResult<undefined>> {
    const branch = gitCurrentBranch();
    return toToolResult(branch || "(not inside a git repository)");
  },
};
