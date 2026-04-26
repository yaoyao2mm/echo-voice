import { spawn } from "node:child_process";

const port = process.env.ECHO_PORT || "3888";
const child = spawn("adb", ["reverse", `tcp:${port}`, `tcp:${port}`], {
  stdio: "inherit"
});

child.on("error", (error) => {
  console.error(`Failed to run adb: ${error.message}`);
  process.exit(1);
});

child.on("close", (code) => {
  if (code === 0) {
    console.log(`Android USB forwarding ready: phone localhost:${port} -> desktop localhost:${port}`);
  }
  process.exit(code || 0);
});
