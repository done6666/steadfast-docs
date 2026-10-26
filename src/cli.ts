#!/usr/bin/env node
import { writeError } from "./output.js";
import { run } from "./run.js";

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    writeError(`error: ${message}`);
    process.exitCode = 2;
  });
