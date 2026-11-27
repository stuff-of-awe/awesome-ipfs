// SPDX-License-Identifier: MPL-2.0
// Run from the repository root: bun test ./tests/mise.test.js

import { describe, expect, test } from "bun:test";

const { tools, env, alias } = Bun.TOML.parse(
    await Bun.file(new URL("../mise.toml", import.meta.url)).text(),
);
const commandWords = (name) => alias?.[name]?.trim().split(/[ \t]+/);

describe("mise toolchain policy", () => {
    const removedTools = [
        "node", "python", "go", "java",
        "npm", "yarn", "pip", "make",
        "gofmt", "black", "isort", "ruff", "prettier", "eslint",
        "pytest", "jest", "vitest",
    ];

    test.each(removedTools)("does not declare %s as a tool", (tool) => {
        expect(Object.keys(tools)).not.toContain(tool);
    });

    test("does not export Node or Python runtime settings", () => {
        const removedSettings = Object.keys(env ?? {}).filter(
            (name) => name === "NODE_ENV" || name.startsWith("PYTHON"),
        );
        expect(removedSettings).toEqual([]);
    });

    test.each([
        ["build", ["cargo", "build", "--release"]],
        ["test", ["cargo", "test"]],
    ])("%s uses Cargo alone", (name, command) => {
        expect(commandWords(name)).toEqual(command);
    });

    const prettierPin = /^prettier@\d+\.\d+\.\d+$/;

    test.each([
        ["lint", "--check"],
        ["fmt", "--write"],
    ])("%s runs pinned Prettier through Bun", (name, mode) => {
        expect(commandWords(name)).toEqual([
            "bunx", "--bun", expect.stringMatching(prettierPin), mode, ".",
        ]);
    });

    test("lint and fmt use the same Prettier release", () => {
        expect(commandWords("lint")[2]).toBe(commandWords("fmt")[2]);
    });
});
