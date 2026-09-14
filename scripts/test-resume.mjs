/**
 * The resume rules, exercised against a stubbed local storage.
 *
 * The thresholds are the part most likely to feel wrong in use — resuming two
 * seconds in, or dropping someone on the credits — so they are pinned here.
 * Run with `pnpm run test:resume`; no test framework is needed, which is why
 * this is a script rather than a suite.
 */
const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  },
};

const resume = await import(new URL('../src/lib/resume.ts', import.meta.url).href);

let failures = 0;
function check(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures += 1;
    console.error(`FAIL  ${label}\n      got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  } else {
    console.log(`ok    ${label}`);
  }
}

check('barely started is not remembered', resume.isWorthRemembering(5, 3600), false);
check('mid-video is remembered', resume.isWorthRemembering(1800, 3600), true);
check('near the end is not remembered', resume.isWorthRemembering(3595, 3600), false);
check('a zero-length video is not remembered', resume.isWorthRemembering(100, 0), false);

resume.rememberPosition('v1', 1800, 3600);
check('resumes mid-video', resume.resumePosition('v1', 3600), 1800);

resume.rememberPosition('v1', 3598, 3600);
check('watching to the end forgets the position', resume.resumePosition('v1', 3600), null);

resume.rememberPosition('v2', 1800, 3600);
check('a shorter re-encode discards a stale position', resume.resumePosition('v2', 600), null);

resume.rememberPosition('v3', 1800, 3600, Date.now() - 61 * 24 * 3600 * 1000);
check('a very old position is ignored', resume.resumePosition('v3', 3600), null);

check('an unknown video starts from the beginning', resume.resumePosition('nope', 100), null);

if (failures > 0) {
  console.error(`\n${failures} resume rule(s) failed.`);
  process.exit(1);
}
console.log('\nAll resume rules hold.');
