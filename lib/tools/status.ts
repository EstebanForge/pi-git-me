import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { gitStatus } from "../git";
import { toToolResult } from "../result";
import {
  GIT_STATUS_TITLE,
  GIT_STATUS_DESCRIPTION,
  GIT_STATUS_MAX_LINES_DESCRIPTION,
} from "../prompts";

const Params = Type.Object({
  max_lines: Type.Optional(
    Type.Integer({
      description: GIT_STATUS_MAX_LINES_DESCRIPTION,
      minimum: 1,
      maximum: 5000,
    }),
  ),
});

export const statusTool: ToolDefinition<typeof Params, undefined> = {
  name: "git_status",
  label: GIT_STATUS_TITLE,
  description: GIT_STATUS_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
    _signal,
    _onUpdate,
    _ctx,
  ): Promise<AgentToolResult<undefined>> {
    const text = gitStatus(process.cwd(), params.max_lines ?? 200);
    return toToolResult(text);
  },
};
