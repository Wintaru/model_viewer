// Runs the suite and fails if any test was skipped.
//
// Several tests need the NIST corpus, which is not in git. Each one guards
// itself with `it.skipIf(...)` on the fixture it reads, so a fresh clone stays
// green (see CONTRIBUTING.md). That is right for a contributor and wrong for
// continuous integration: the cases that prove the SolidWorks and STEP claims
// would skip after a failed corpus fetch, and the job would still pass.
//
// So CI runs this instead of asserting a list of fixture paths. Asserting the
// paths means keeping a copy of them here, in step with the guards in the test
// files, and a copy that drifts is how the hole reopens. Asking the suite what
// it actually ran needs no copy, and it covers a corpus-gated test added later
// without anyone remembering to update this script.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Written outside the repository on purpose. A report file left inside it by
// an interrupted run would be picked up by `prettier --check .` and fail the
// format gate for a reason that has nothing to do with the change under test.
const REPORT = join(tmpdir(), `vitest-report-${process.pid}.json`);

const run = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "--reporter=json", `--outputFile=${REPORT}`],
  { stdio: "inherit", shell: process.platform === "win32" },
);

if (run.status !== 0) {
  process.exit(run.status ?? 1);
}

let report;
try {
  report = JSON.parse(readFileSync(REPORT, "utf8"));
} finally {
  rmSync(REPORT, { force: true });
}

const skipped = report.numPendingTests + report.numTodoTests;

if (skipped > 0) {
  // The summary counts these as "pending", but each result's own `status` is
  // "skipped". Both spellings are matched so a reporter change cannot turn
  // this list silently empty while the count above still fires.
  const SKIPPED = new Set(["skipped", "pending", "todo"]);
  const names = report.testResults
    .flatMap((file) => file.assertionResults)
    .filter((test) => SKIPPED.has(test.status))
    .map((test) => `  - ${test.fullName}`);

  console.error(
    `${skipped} test(s) were skipped, and this run does not allow that.\n`,
  );
  console.error(names.join("\n"));
  console.error(
    "\nA corpus-backed test skips when its fixture is missing. Run " +
      "`pnpm assets`\nto fetch the test corpus, then run this again.",
  );
  process.exit(1);
}

console.log(`${report.numPassedTests} test(s) ran, none skipped.`);
