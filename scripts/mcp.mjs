// Stdio bridge to the running desktop app. No credentials are printed to stdout.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
const configRoot = process.env.APPDATA || path.join(os.homedir(), ".config");
const runtime =
  process.env.LOF_RUNTIME ||
  path.join(
    configRoot,
    "Lof Writer",
    "runtime.json",
  );
const lines = readline.createInterface({ input: process.stdin });
let chain = Promise.resolve();
lines.on("line", (line) => {
  chain = chain
    .then(async () => {
      let msg;
      try {
        msg = JSON.parse(line);
        const connection = JSON.parse(await fs.readFile(runtime, "utf8"));
        if (
          !Number.isInteger(connection.port) ||
          connection.port < 1 ||
          connection.port > 65535 ||
          typeof connection.token !== "string"
        )
          throw Error("잘못된 연결 파일");
        const result = await fetch(`http://127.0.0.1:${connection.port}/mcp`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${connection.token}`,
            "Content-Type": "application/json",
          },
          body: line,
          signal: AbortSignal.timeout(30000),
        });
        if (msg.id !== undefined) {
          if (!result.ok) throw Error(`HTTP ${result.status}`);
          process.stdout.write(JSON.stringify(await result.json()) + "\n");
        }
      } catch (e) {
        if (msg?.id !== undefined)
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: {
                code: -32603,
                message: `Lof Writer 앱을 실행해 주세요. ${e.message}`,
              },
            }) + "\n",
          );
        else process.stderr.write("Lof Writer 연결 실패\n");
      }
    })
    .catch((e) => process.stderr.write(e.message + "\n"));
});
