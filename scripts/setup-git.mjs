import { assertRepositoryRoot, git } from './repository.mjs';

try {
  assertRepositoryRoot();
  git(['config', '--local', 'core.hooksPath', '.githooks']);
  git(['config', '--local', 'core.autocrlf', 'false']);
  git(['config', '--local', 'core.safecrlf', 'true']);
  console.log('Configured project-local hooks and LF policy. No global Git settings changed.');
} catch (error) {
  console.error(`Setup failed: ${error.message}`);
  process.exitCode = 1;
}
