import fs from "node:fs";
import vm from "node:vm";
import * as harness from "../../extension/src/background/question_harness.mjs";
import * as courseMemory from "../../extension/src/background/course_memory.mjs";

export function evaluateBackground(context, source = fs.readFileSync(new URL("../../extension/src/background/service_worker.js", import.meta.url), "utf8")) {
  Object.assign(context, harness, courseMemory);
  const script = source.replace(/^import\s+\{[^}]+\}\s+from\s+["']\.\/(?:question_harness|course_memory)\.mjs["'];\r?\n/gm, "");
  return new vm.Script(script, { filename: "service_worker.js" }).runInContext(context);
}
