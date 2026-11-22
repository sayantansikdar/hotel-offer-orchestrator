import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bundleWorkflowCode } from '@temporalio/worker';

// Bundling at build time means the worker skips webpack on startup, which saves
// several seconds and a memory spike on small instances.
export const workflowBundlePath = path.join(__dirname, 'workflow-bundle.js');

async function main(): Promise<void> {
  const { code } = await bundleWorkflowCode({ workflowsPath: require.resolve('./workflows') });
  await writeFile(workflowBundlePath, code);
  console.log(`workflow bundle written to ${workflowBundlePath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
