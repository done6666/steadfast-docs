import assert from "node:assert/strict";
import test from "node:test";
import { addMinor, formatMinor, minorUnits } from "../packages/ledger/money.js";

test("minor units reject fractions", () => {
  assert.throws(() => minorUnits(10.5));
});

test("minor units reject negatives", () => {
  assert.throws(() => minorUnits(-1));
});

test("addMinor adds integer amounts", () => {
  assert.equal(addMinor(100, 250), 350);
});

test("formatMinor renders cents", () => {
  assert.equal(formatMinor(1234, "USD"), "$12.34");
});
