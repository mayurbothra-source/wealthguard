/**
 * Shared assertion helper.
 *
 * Every suite used to define `ck = (name, cond) => console.log(PASS|FAIL)` and
 * nothing else, so a failing assertion printed "FAIL" but the process still
 * exited 0 — `npm test` and any CI would report success. This counts failures
 * and sets a non-zero exit code when the process ends.
 */
let passed = 0, failed = 0;
const ck = (name, cond) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
  cond ? passed++ : failed++;
  return !!cond;
};
process.on('exit', () => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
});
module.exports = ck;
