#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeBrowser } from "./render/browser.js";
import { createServer } from "./server.js";
import { useAppHelpers } from "./util/tools.js";

async function main() {
  useAppHelpers();
  const [command, ...rest] = process.argv.slice(2);

  if (command === "studio") {
    // A local web UI over the same engine, for trying everything by hand.
    const { startStudio } = await import("./studio/server.js");
    const portFlag = rest.indexOf("--port");
    const port = portFlag >= 0 ? Number(rest[portFlag + 1]) : undefined;
    if (portFlag >= 0 && !Number.isInteger(port)) {
      console.error(`Invalid --port value "${rest[portFlag + 1] ?? ""}".`);
      process.exit(1);
    }
    await startStudio(port, !rest.includes("--no-open"));
    const stop = async () => {
      await closeBrowser();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    // The desktop app holds our stdin open; when it quits or crashes the pipe closes and we
    // follow it, instead of lingering as an orphaned server.
    if (rest.includes("--watch-stdin")) {
      process.stdin.on("end", stop);
      process.stdin.on("close", stop);
      process.stdin.resume();
    }
    return;
  }

  if (process.platform !== "darwin") {
    console.error("screenshotter-mcp needs macOS with Xcode for simulator capture; mockup rendering still works.");
  }
  const server = createServer();
  await server.connect(new StdioServerTransport());
  (await import("./native/ocr.js")).warmUpOcr();

  const shutdown = async () => {
    await closeBrowser();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
