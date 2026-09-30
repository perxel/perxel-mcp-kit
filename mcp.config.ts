import { defineConfig } from "./kit/core/config.js";
import { getTimeTool } from "./src/tools/get-time.js";
import { whoamiTool } from "./src/tools/whoami.js";

export default defineConfig({
  slug: "example",
  name: "Example MCP",
  version: "0.1.0",
  description: "Example MCP built from the MCP Kit: one public and one private tool.",
  scopes: { "private:read": "Read private example data" },
  tools: [getTimeTool, whoamiTool],
  docs: { contact: "hello@example.com" },
});
