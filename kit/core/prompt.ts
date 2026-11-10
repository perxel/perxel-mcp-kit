import type { z } from "zod";

/**
 * A prompt template the server offers (`prompts/list`, `prompts/get`): the user picks it in the
 * client (a slash command or the "+" menu), fills its arguments, and the client sends the text to
 * the model. Public, no I/O: `render` only builds the text, the model then calls the tools.
 */
export interface PromptDef<A extends z.ZodObject = z.ZodObject> {
  name: string; // kebab-case or snake_case, unique among prompts
  title: string;
  description: string; // what the answer will look like, which tools it uses
  /** String arguments only (MCP prompt arguments are strings); `.describe()` each one. */
  argsSchema?: A;
  render(args: z.infer<A>): string; // the user message sent to the model
}

export function definePrompt<A extends z.ZodObject>(def: PromptDef<A>): PromptDef<A> {
  return def;
}
