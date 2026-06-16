import { rmSync } from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";

function isPortFree(port, host = "0.0.0.0") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

const preferredPort = 5000;
const fallbackPort = 5001;

const preferredFree = await isPortFree(preferredPort);
const port = preferredFree ? preferredPort : fallbackPort;

rmSync(".next", { recursive: true, force: true });

if (!preferredFree) {
  console.warn(`[dev-server] Port ${preferredPort} is in use. Falling back to ${fallbackPort}.`);
}

const child = spawn(
  "next",
  ["dev", "--port", String(port), "--hostname", "0.0.0.0"],
  {
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      NEXT_DISABLE_DEVTOOLS: "1",
    },
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
