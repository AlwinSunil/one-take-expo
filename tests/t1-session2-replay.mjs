// Developmental output sample and host policy benchmark, never device evidence.
import { writeFileSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { replayDevelopmentFramingFixtures } from '../src/features/vision/framing-fixtures.ts';
import { TIER1_DEVELOPMENT_FIXTURES, replayTier1DevelopmentFixture } from '../src/features/coach/tier1-fixtures.ts';

const framing = replayDevelopmentFramingFixtures();
const coaching = TIER1_DEVELOPMENT_FIXTURES.map(fixture => ({
  id: fixture.id, label: fixture.label, expected: fixture.expected,
  actual: replayTier1DevelopmentFixture(fixture),
}));
for (let index = 0; index < 100; index++) replayDevelopmentFramingFixtures();
const times = Array.from({ length: 500 }, () => {
  const start = performance.now();
  replayDevelopmentFramingFixtures();
  return performance.now() - start;
}).sort((a, b) => a - b);
const report = {
  synthetic: true,
  host: `${platform()} ${arch()} / ${cpus()[0]?.model ?? 'unknown CPU'} / Node ${process.version}`,
  processor: 'host CPU, JavaScript policy only; no model inference',
  benchmark: {
    unit: 'ms per complete fixture catalog', warmups: 100, runs: 500,
    p50: times[250], p95: times[475],
    excludes: 'camera extraction, inference, device, UI, native export, thermal and memory measurements',
  },
  framing,
  coaching,
};
if (!framing.every(row => row.passed) || !coaching.every(row => row.actual.kind === row.expected)) {
  throw new Error('Development replay expectation failed');
}
const output = JSON.stringify(report, null, 2) + '\n';
if (process.argv[2]) writeFileSync(process.argv[2], output);
else process.stdout.write(output);
