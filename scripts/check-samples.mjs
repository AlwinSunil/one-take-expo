import { runSampleChecks } from '../src/development/sessions/checks.ts';

const results = runSampleChecks();
for (const result of results) {
  console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.error ? `: ${result.error}` : ''}`);
}
console.log(`${results.filter(result => result.passed).length}/${results.length} checks passed`);
if (results.some(result => !result.passed)) process.exitCode = 1;
