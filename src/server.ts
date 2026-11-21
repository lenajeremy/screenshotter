import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BOARD_INSTRUCTIONS, registerBoardTools } from "./board/mcp.js";
import { COLOURED_ART, artNames, stickerNames } from "./render/images.js";
import { useLibrary } from "./util/files.js";
import { studioFolder } from "./util/studio.js";

const VERSION = "0.16.0";

/** The MCP server: designing on boards with agents, live in the app. */
export function createServer(): McpServer {
  const server = new McpServer({ name: "screenshotter", version: VERSION }, {
    instructions: `${BOARD_INSTRUCTIONS}\n\nBuilt-in stickers (src "sticker:<name>"): ${stickerNames().join(", ")}.\nBuilt-in illustrations (src "art:<name>"; the one-ink ones take a colour): ${artNames().join(", ")}; in their own colours: ${COLOURED_ART.join(", ")}.`,
  });
  // Boards live in the app's library: the folder of the app last opened on this Mac.
  useLibrary(studioFolder);
  registerBoardTools(server);
  return server;
}
