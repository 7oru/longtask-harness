import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const finishedAt = new Date().toISOString();
mkdirSync("artifacts", { recursive: true });
writeFileSync(
  join("artifacts", "demo-result.txt"),
  [
    "DEMO_SLICE_OK",
    `finishedAt: ${finishedAt}`,
    "next: record review evidence for demo-reviewed"
  ].join("\n") + "\n",
  "utf8"
);

console.log("DEMO_SLICE_OK local bounded slice completed");
console.log("artifact: artifacts/demo-result.txt");
