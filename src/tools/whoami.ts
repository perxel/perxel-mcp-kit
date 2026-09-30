import { z } from "zod";
import { defineTool, ToolError } from "../../kit/core/tool.js";

export const whoamiTool = defineTool({
  name: "whoami",
  title: "Who am I",
  description: "Returns the signed-in user's id and email. Requires sign-in (private).",
  access: "private",
  scope: "private:read",
  inputSchema: z.object({}),
  example: "Who am I signed in as?",
  async execute(_input, ctx) {
    // In production the gate answers 401 before this runs; this is only reachable directly.
    if (!ctx.auth) throw new ToolError("bad_input", "Not signed in");
    return { data: { userId: ctx.auth.userId, email: ctx.auth.email ?? null } };
  },
});
