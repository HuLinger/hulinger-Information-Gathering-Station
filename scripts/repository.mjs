import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

export function git(args, encoding = 'utf8') {
  return execFileSync('git', args, {
    cwd: root,
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 20 * 1024 * 1024,
  });
}

export function assertRepositoryRoot() {
  const actual = realpathSync(git(['rev-parse', '--show-toplevel']).trim());
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (normalize(actual) !== normalize(root)) {
    throw new Error('Git root must be this project, not a parent repository.');
  }
}

export const branchPattern = /^codex\/(feat|fix|docs|refactor|test|chore|ci|perf|build|hotfix)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const subjectPattern = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9][a-z0-9-]*\))?!?: \S.*$/u;

export function validSubject(subject) {
  return subjectPattern.test(subject) && Array.from(subject).length <= 100 && subject.trim() === subject;
}
