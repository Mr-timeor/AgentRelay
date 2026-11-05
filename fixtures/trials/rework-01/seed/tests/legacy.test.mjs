import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLabels } from "./implementation.mjs";

test("trims surrounding whitespace", () => {
  assert.deepEqual(normalizeLabels(["  first ", "\tsecond\n"]), ["first", "second"]);
});

test("drops blank labels", () => {
  assert.deepEqual(normalizeLabels(["", "  ", "first", "\t\n"]), ["first"]);
});

test("preserves the original order of distinct labels", () => {
  assert.deepEqual(normalizeLabels(["second", "first", "third"]), ["second", "first", "third"]);
});

test("deduplicates matching trimmed labels", () => {
  assert.deepEqual(normalizeLabels(["first", "second", " first "]), ["first", "second"]);
});

test("returns an empty array for empty input", () => {
  assert.deepEqual(normalizeLabels([]), []);
});
