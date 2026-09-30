import { z } from "zod";
import { defineTool, ToolError } from "../../kit/core/tool.js";

const DEFAULT_TIMEZONE = "Asia/Ho_Chi_Minh";

export const getTimeTool = defineTool({
  name: "get_time",
  title: "Get current time",
  description: "Returns the current time (ISO 8601 plus a human-readable form) in the given IANA timezone. Default: Asia/Ho_Chi_Minh.",
  access: "public",
  inputSchema: z.object({
    timezone: z.string().describe("IANA timezone, e.g. Asia/Ho_Chi_Minh").optional(),
  }),
  example: "What time is it in Ho Chi Minh City?",
  async execute(input) {
    const timezone = input.timezone ?? DEFAULT_TIMEZONE;
    let now: Date;
    try {
      // Throws RangeError for an unknown timezone; the formatted parts prove it parses.
      new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
      now = new Date();
    } catch {
      throw new ToolError("bad_input", `Unknown timezone "${timezone}": use an IANA name like Asia/Ho_Chi_Minh`);
    }
    const human = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(now);
    return { data: { time: now.toISOString(), timezone, human } };
  },
});
