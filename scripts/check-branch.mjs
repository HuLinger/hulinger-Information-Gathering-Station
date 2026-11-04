import { assertRepositoryRoot, branchPattern, git } from './repository.mjs';

try {
  assertRepositoryRoot();
  const isPr = process.argv.includes('--pr');
  const branch = isPr ? process.env.PR_BRANCH : git(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
  let initialMain = false;
  if (!isPr && branch === 'main') {
    try {
      git(['rev-parse', '--verify', 'HEAD']);
    } catch {
      initialMain = true;
    }
  }
  if (!initialMain && !branchPattern.test(branch ?? '')) {
    throw new Error('Use codex/<type>/<slug>. Direct commits to main are blocked after initialization.');
  }
  console.log(`Branch policy passed: ${branch}${initialMain ? ' (initial baseline only)' : ''}`);
} catch (error) {
  console.error(`Branch policy failed: ${error.message}`);
  process.exitCode = 1;
}
