const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const chains = path.join(__dirname, "..", "chains");
const stage1 = readFileSync(path.join(chains, "council-review-stage1.js"), "utf8");
const stage2 = readFileSync(path.join(chains, "council-review-stage2.js"), "utf8");

function run(script, retryAll) {
  return runInNewContext(`(async () => { ${script} })()`, { retryAll });
}

function review(findings) {
  return run(stage1, async (jobs) =>
    jobs.map((_, i) => ({ ok: true, output: i === 0 ? JSON.stringify(findings) : "[]" })),
  );
}

test("council output keeps IDs internal and displays all three tags", async () => {
  const finding = {
    file: "models/Ride.ts",
    lines: "12-16",
    claim: "[P2] [in-scope] unpaid rides lose tips",
    severity: "P2",
    classification: "[in-scope]",
    kind: "bug",
  };
  const first = await review([finding]);
  assert.equal(first.parseFailures.length, 0);
  assert.equal(first.findings[0].kind, "bug");
  assert.match(first.findings[0].id, /^R1-/);

  const embedded = stage2.replace(
    'const stage2Payload = "__STAGE1_OUTPUT__";',
    `const stage2Payload = ${JSON.stringify(first.stage2Payload)};`,
  );
  const second = await run(embedded, async (jobs) =>
    jobs.map(() => ({
      ok: true,
      output: JSON.stringify({ verdict: "UPHELD", reason: "confirmed", evidence: "models/Ride.ts:12" }),
    })),
  );
  assert.equal(second.results[0].finding.id, first.findings[0].id);
  assert.match(
    second.chairmanTask,
    /^\[P2\] \[in-scope\] \[bug\] models\/Ride\.ts 12-16 — unpaid rides lose tips \(new\)$/m,
  );
  assert.doesNotMatch(second.chairmanTask, /R1-r1-/);
  assert.equal(JSON.parse(first.stage2Payload).findings[0].kind, "bug");

  const invalid = await review([{ ...finding, kind: undefined }]);
  assert.equal(invalid.parseFailures.length, 1);
});
