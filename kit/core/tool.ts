import type { z } from "zod";
import type { Env } from "./env.js";

export type Access = "public" | "private";

export interface ToolContext {
  env: Env; // the clone's Env (generic)
  auth: { userId: string; email?: string; scopes: string[] } | null; // null for anonymous
  requestId: string;
  log: (event: string, fields?: Record<string, unknown>) => void; // structured, no PII, no args
}

export interface ToolResult {
  data: unknown; // becomes structuredContent + JSON text content
  count?: number; // items returned, for metrics doubles[1]; omit when not a list
}

export interface ToolDef<I extends z.ZodObject = z.ZodObject> {
  name: string; // snake_case, unique
  title: string;
  description: string; // what it returns, units, freshness, limits
  access: Access;
  scope?: string; // required when access === "private"; checked by the gate
  inputSchema: I;
  outputSchema?: z.ZodType;
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean }; // default readOnlyHint: true
  example?: string; // one-line example question, shown on the docs page
  execute(input: z.infer<I>, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool<I extends z.ZodObject>(def: ToolDef<I>): ToolDef<I> {
  return def;
}

export type ToolErrorCode = "not_found" | "bad_input" | "upstream" | "unavailable";

/** A tool failure with a stable code for metrics. Anything else thrown becomes "internal". */
export class ToolError extends Error {
  readonly code: ToolErrorCode | "internal";
  constructor(code: ToolErrorCode | "internal", message: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}
