import { readFileSync } from 'node:fs';
import { validSubject } from './repository.mjs';

try {
  const input = process.argv[2];
  const message = input === '--pr-title' ? process.env.PR_TITLE : input ? readFileSync(input, 'utf8') : '';
  const subject = (message ?? '').split(/\r?\n/u)[0];
  if (!validSubject(subject)) {
    throw new Error('Use type(scope): description, at most 100 characters; scope is optional.');
  }
  console.log('Commit / PR subject policy passed.');
} catch (error) {
  console.error(`Subject policy failed: ${error.message}`);
  process.exitCode = 1;
}
