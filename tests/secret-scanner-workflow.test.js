// SPDX-License-Identifier: MPL-2.0
// Run from the repository root: bun test tests/secret-scanner-workflow.test.js

import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const checker = join(import.meta.dir, "secret-scanner-workflow.js");
const reference = "hyperpolymath/standards/.github/workflows/secret-scanner-reusable.yml";
const pin = `${reference}@${"a".repeat(40)}`;

function workflow({
    events = "on:\n  pull_request:\n  push:\n    branches: [main, master]",
    permissions = "permissions: {contents: read}",
    uses = pin,
    job = "",
    extra = "",
} = {}) {
    return [
        events,
        permissions,
        "jobs:",
        "  scan:",
        `    uses: ${uses}`,
        job,
        extra,
        "",
    ].join("\n");
}

function runChecker(yaml) {
    const root = mkdtempSync(join(tmpdir(), "scanner-workflow-test-"));
    try {
        const scriptDir = join(root, "tests");
        const workflowDir = join(root, ".github", "workflows");
        mkdirSync(scriptDir);
        mkdirSync(workflowDir, { recursive: true });
        const script = join(scriptDir, "secret-scanner-workflow.js");
        copyFileSync(checker, script);
        if (yaml !== undefined) {
            writeFileSync(join(workflowDir, "secret-scanner.yml"), yaml);
        }

        // The checker must resolve the workflow relative to its own location.
        const result = Bun.spawnSync([process.execPath, script], {
            cwd: tmpdir(),
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            timeout: 3000,
        });
        return {
            exitCode: result.exitCode,
            stdout: result.stdout.toString(),
            stderr: result.stderr.toString(),
        };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

const checks = {
    secrets: "scanner does not receive caller secrets",
    expressions: "caller does not reference secrets indirectly",
    permissions: "scanner keeps minimum token permissions",
    pin: "scanner still calls the pinned shared workflow",
    triggers: "scanning remains enabled for pull requests and default branches",
    failure: "scanner cannot silently skip or ignore failures",
};

function expectChecks(result, failed = []) {
    expect(result.stderr).toBe("");
    expect(result.stdout.match(/^FAIL  .+$/gm) ?? []).toEqual(
        failed.map((name) => `FAIL  ${name}`),
    );
    expect(result.stdout.match(/^ok    .+$/gm) ?? []).toEqual(
        Object.values(checks).filter((name) => !failed.includes(name)).map((name) => `ok    ${name}`),
    );
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(
        failed.length ? `Ran 6 checks: FAILED (failures=${failed.length})` : "Ran 6 checks: OK",
    );
    expect(result.exitCode).toBe(failed.length ? 1 : 0);
}

test("accepts a pinned caller with an empty pull_request and inherited read permissions", () => {
    expectChecks(runChecker(workflow()));
});

test("accepts reordered triggers and branches, an empty map, and explicit safe job settings", () => {
    expectChecks(runChecker(workflow({
        events: "on: {push: {branches: [master, main]}, pull_request: {}}",
        job: "    permissions: {contents: read}\n    continue-on-error: false",
        extra: [
            '# Example only: ${{ secrets.DUMMY }}',
            'env: {PLAIN_TEXT: "secrets.DUMMY", REF: "${{ github.ref }}"}',
        ].join("\n"),
    })));
});

test("accepts the quoted False spelling allowed by the original checker", () => {
    expectChecks(runChecker(workflow({ job: '    continue-on-error: "False"' })));
});

test.each([
    ["inherited secrets", { job: "    secrets: inherit" }, checks.secrets],
    ["an empty secrets map", { job: "    secrets: {}" }, checks.secrets],
    ["a forwarded literal", { job: "    secrets: {example: placeholder}" }, checks.secrets],
    ["a dotted expression in a job input", { job: '    with: {example: "${{ secrets.DUMMY }}"}' }, checks.expressions],
    ["a mixed case bracket expression in a list", {
        extra: "env:\n  EXAMPLES:\n    - name: dummy\n      value: |-\n        ${{\n        SeCrEtS ['DUMMY']\n        }}",
    }, checks.expressions],
    ["write permissions at workflow level", { permissions: "permissions: {contents: write}" }, checks.permissions],
    ["an extra permission at job level", {
        job: "    permissions: {contents: read, actions: read}",
    }, checks.permissions],
    ["an empty job permission override", { job: "    permissions: {}" }, checks.permissions],
    ["a branch instead of a SHA", { uses: `${reference}@main` }, checks.pin],
    ["a 39-character SHA", { uses: `${reference}@${"a".repeat(39)}` }, checks.pin],
    ["a 41-character SHA", { uses: `${reference}@${"a".repeat(41)}` }, checks.pin],
    ["a SHA containing non-hex text", { uses: `${reference}@${"a".repeat(39)}g` }, checks.pin],
    ["a newline after the SHA", { uses: JSON.stringify(`${pin}\n`) }, checks.pin],
    ["a different workflow owner", { uses: pin.replace("hyperpolymath/", "other-owner/") }, checks.pin],
    ["local steps on a reusable job", { job: "    steps: []" }, checks.pin],
    ["a runner on a reusable job", { job: "    runs-on: ubuntu-latest" }, checks.pin],
    ["an additional trigger", {
        events: "on: {push: {branches: [main, master]}, pull_request: {}, workflow_dispatch: {}}",
    }, checks.triggers],
    ["a missing pull_request trigger", {
        events: "on: {push: {branches: [main, master]}}",
    }, checks.triggers],
    ["a filter on pull requests", {
        events: "on: {push: {branches: [main, master]}, pull_request: {branches: [main]}}",
    }, checks.triggers],
    ["a path filter on pushes", {
        events: 'on: {push: {branches: [main, master], paths: ["README.adoc"]}, pull_request: {}}',
    }, checks.triggers],
    ["a missing default branch", {
        events: "on: {push: {branches: [main]}, pull_request: {}}",
    }, checks.triggers],
    ["a duplicate branch entry", {
        events: "on: {push: {branches: [main, master, main]}, pull_request: {}}",
    }, checks.triggers],
    ["a job condition", { job: "    if: true" }, checks.failure],
    ["boolean continue-on-error", { job: "    continue-on-error: true" }, checks.failure],
    ["empty continue-on-error", { job: "    continue-on-error:" }, checks.failure],
])("rejects %s and reports the specific check", (_name, options, failed) => {
    expectChecks(runChecker(workflow(options)), [failed]);
});

test("reports independent failures and still runs the later checks", () => {
    expectChecks(runChecker(workflow({
        permissions: "permissions: {contents: write}",
        job: "    secrets: inherit\n    continue-on-error: true",
    })), [checks.secrets, checks.permissions, checks.failure]);
});

test.each([
    ["a missing workflow", undefined],
    ["malformed YAML", "on: {push: ]}\n"],
])("reports a load error for %s before running any checks", (_name, yaml) => {
    const result = runChecker(yaml);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^ERROR: cannot load .*secret-scanner\.yml: .+/);
});
