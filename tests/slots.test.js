import test from "node:test";
import assert from "node:assert/strict";
import { DAYS, TH, LB } from "../src/slots.js";

test("timetable contains Monday through Friday only", () => {
  assert.deepEqual(DAYS, ["MON", "TUE", "WED", "THU", "FRI"]);
  assert.equal(Object.hasOwn(TH, "SAT"), false);
  assert.equal(Object.hasOwn(TH, "SUN"), false);
  assert.equal(Object.hasOwn(LB, "SAT"), false);
  assert.equal(Object.hasOwn(LB, "SUN"), false);
});
