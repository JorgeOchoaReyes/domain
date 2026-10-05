// A tiny MCP server over stdio for tests: answers initialize and tools/list
// (newline-delimited JSON-RPC), with two tools.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const reply = (m) => process.stdout.write(JSON.stringify(m) + "\n");
process.stderr.write("fake-mcp: ready\n");
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    reply({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0.0" } } });
  } else if (msg.method === "tools/list") {
    reply({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }, { name: "add", inputSchema: { type: "object" } }] } });
  }
});
