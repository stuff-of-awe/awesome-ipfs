#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0
// Configuration checks for the secret scanner caller
// (.github/workflows/secret-scanner.yml). They read the workflow file only;
// they do not invoke GitHub Actions or the remote scanner.
//
// Run from anywhere with:
//     bun tests/secret-scanner-workflow.js
// Exit 0 when every check passes, 1 when any fails.
// Needs only Bun (built-in YAML parser); no packages.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const WORKFLOW_PATH = join(dirname(import.meta.path), "..", ".github", "workflows", "secret-scanner.yml");

// Every scalar becomes text and an empty value becomes "", so the checks
// compare plain strings whatever YAML type a value would otherwise take
// (the GitHub Actions key `on` stays the string "on").
function asText(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(asText);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, asText(v)]));
  }
  return String(value);
}

function isMap(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function equal(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
  }
  if (isMap(a) || isMap(b)) {
    if (!isMap(a) || !isMap(b)) return false;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return equal(ka, kb) && ka.every((k) => equal(a[k], b[k]));
  }
  return a === b;
}

function sameSet(a, b) {
  return equal([...new Set(a)].sort(), [...new Set(b)].sort());
}

const show = (v) => JSON.stringify(v);
function assert(ok, message) {
  if (!ok) throw new Error(message);
}
const assertEqual = (actual, expected) =>
  assert(equal(actual, expected), `${show(actual)} != ${show(expected)}`);
const assertIn = (member, container) =>
  assert(
    Array.isArray(container) ? container.some((x) => equal(x, member))
      : isMap(container) ? Object.hasOwn(container, member)
      : String(container).includes(member),
    `${show(member)} not found in ${show(container)}`,
  );
const assertNotIn = (member, container) =>
  assert(
    !(Array.isArray(container) ? container.some((x) => equal(x, member))
      : isMap(container) ? Object.hasOwn(container, member)
      : String(container).includes(member)),
    `${show(member)} unexpectedly found in ${show(container)}`,
  );
const get = (map, key, fallback) => (isMap(map) && Object.hasOwn(map, key) ? map[key] : fallback);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

let workflow;
try {
  workflow = asText(Bun.YAML.parse(readFileSync(WORKFLOW_PATH, "utf8")));
} catch (e) {
  console.error(`ERROR: cannot load ${WORKFLOW_PATH}: ${e.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
const scan = () => workflow.jobs.scan;

test("scanner does not receive caller secrets", () => {
  // Reject both broad inheritance and individually forwarded secrets,
  // including an empty mapping that could later acquire credentials.
  assertNotIn("secrets", scan());
});

test("caller does not reference secrets indirectly", () => {
  // Catch forwarding via `with` or another expression-bearing field.
  // Inspect parsed values so comments and YAML formatting are irrelevant.
  const check = (value) => {
    if (isMap(value)) Object.values(value).forEach(check);
    else if (Array.isArray(value)) value.forEach(check);
    else if (typeof value === "string") {
      for (const m of value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
        assert(!/\bsecrets\s*[.[]/i.test(m[1]), `secret reference in ${show(m[0])}`);
      }
    }
  };
  check(workflow);
});

test("scanner keeps minimum token permissions", () => {
  const expected = { contents: "read" };
  assertEqual(workflow.permissions, expected);
  assertEqual(get(scan(), "permissions", workflow.permissions), expected);
});

test("scanner still calls the pinned shared workflow", () => {
  const uses = scan().uses;
  assert(
    /^hyperpolymath\/standards\/\.github\/workflows\/secret-scanner-reusable\.yml@[0-9a-f]{40}$/.test(uses) &&
      !uses.endsWith("\n"),
    `${show(uses)} is not hyperpolymath/standards/.github/workflows/secret-scanner-reusable.yml@<40-hex sha>`,
  );
  assertNotIn("steps", scan());
  assertNotIn("runs-on", scan());
});

test("scanning remains enabled for pull requests and default branches", () => {
  const events = workflow.on;
  assert(sameSet(Object.keys(events), ["pull_request", "push"]), `${show(Object.keys(events))} != {pull_request, push}`);
  assertIn(events.pull_request, ["", {}]);
  assert(sameSet(Object.keys(events.push), ["branches"]), `${show(Object.keys(events.push))} != {branches}`);
  const b = [...events.push.branches].sort();
  assertEqual(b, ["main", "master"]);
});

test("scanner cannot silently skip or ignore failures", () => {
  assertNotIn("if", scan());
  assertIn(get(scan(), "continue-on-error", "false"), ["false", "False"]);
});
// ---------------------------------------------------------------------------

let failures = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}
console.log(`\nRan ${tests.length} checks: ${failures === 0 ? "OK" : `FAILED (failures=${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
