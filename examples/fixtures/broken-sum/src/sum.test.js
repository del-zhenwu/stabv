import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "./sum.js";

test("add returns the sum of two numbers", () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(0, 0), 0);
});
