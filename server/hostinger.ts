import { run } from './main.js';

// Hostinger imports the configured entry file instead of executing it as the
// process main module, so this dedicated entry must start unconditionally.
run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
