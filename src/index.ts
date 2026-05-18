/** Entry point: starts the Jira DC MCP server over stdio. */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const { server, client, cache } = createServer();

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await cache.stop();
    await client.close();
  };

  process.on("SIGINT", () => {
    void shutdown().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().then(() => process.exit(0));
  });

  // Populate the automation cache and start its background refresh loop.
  await cache.start();

  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void shutdown().then(() => process.exit(0));
  };

  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
