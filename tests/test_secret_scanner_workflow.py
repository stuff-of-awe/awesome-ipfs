# SPDX-License-Identifier: MPL-2.0
"""Regression checks for the secret scanner caller, without invoking Actions.

Requires Python 3 and PyYAML. Run from the repository root with:
    python3 -m unittest discover -s tests -p 'test_secret_scanner_workflow.py'
"""

from pathlib import Path
import re
import unittest

import yaml


WORKFLOW_PATH = (
    Path(__file__).resolve().parents[1]
    / ".github"
    / "workflows"
    / "secret-scanner.yml"
)


class SecretScannerWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # BaseLoader preserves GitHub's `on` key rather than interpreting it as
        # a YAML 1.1 boolean. These checks only need mappings and scalar text.
        cls.workflow = yaml.load(
            WORKFLOW_PATH.read_text(encoding="utf-8"), Loader=yaml.BaseLoader
        )

    def test_scanner_does_not_receive_caller_secrets(self):
        scan = self.workflow["jobs"]["scan"]
        # Reject both broad inheritance and individually forwarded secrets,
        # including an empty mapping that could later acquire credentials.
        self.assertNotIn("secrets", scan)

    def test_caller_does_not_reference_secrets_indirectly(self):
        # Catch forwarding via `with` or another expression-bearing field.
        # Inspect parsed values so comments and YAML formatting are irrelevant.
        def check(value):
            if isinstance(value, dict):
                for child in value.values():
                    check(child)
            elif isinstance(value, list):
                for child in value:
                    check(child)
            elif isinstance(value, str):
                for expression in re.findall(r"\$\{\{(.*?)\}\}", value, re.DOTALL):
                    self.assertNotRegex(expression, r"(?i)\bsecrets\s*[.\[]")

        check(self.workflow)

    def test_scanner_keeps_minimum_token_permissions(self):
        expected = {"contents": "read"}
        self.assertEqual(self.workflow["permissions"], expected)
        scan = self.workflow["jobs"]["scan"]
        self.assertEqual(scan.get("permissions", self.workflow["permissions"]), expected)

    def test_scanner_still_calls_the_pinned_shared_workflow(self):
        scan = self.workflow["jobs"]["scan"]
        self.assertRegex(
            scan["uses"],
            r"\Ahyperpolymath/standards/\.github/workflows/"
            r"secret-scanner-reusable\.yml@[0-9a-f]{40}\Z",
        )
        self.assertNotIn("steps", scan)
        self.assertNotIn("runs-on", scan)

    def test_scanning_remains_enabled_for_pull_requests_and_default_branches(self):
        events = self.workflow["on"]
        self.assertEqual(set(events), {"pull_request", "push"})
        self.assertIn(events["pull_request"], ("", {}))
        self.assertEqual(set(events["push"]), {"branches"})
        self.assertCountEqual(events["push"]["branches"], ["main", "master"])

    def test_scanner_cannot_silently_skip_or_ignore_failures(self):
        scan = self.workflow["jobs"]["scan"]
        self.assertNotIn("if", scan)
        self.assertIn(scan.get("continue-on-error", "false"), ("false", "False"))


if __name__ == "__main__":
    unittest.main()
