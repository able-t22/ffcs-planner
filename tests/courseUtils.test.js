import test from "node:test";
import assert from "node:assert/strict";
import { countUniqueSubjects } from "../src/courseUtils.js";

test("counts theory and lab rows for the same subject once", () => {
  const courses = [
    { id: "theory", code: "CSE2001", title: "Data Structures", slots: ["A1"], faculty: "Faculty A" },
    { id: "lab", code: "cse2001", title: "Data Structures", slots: ["L31", "L32"], faculty: "Faculty A" },
    { id: "other", code: "CSE2002", title: "Operating Systems", slots: ["B1"], faculty: "Faculty B" },
  ];
  assert.equal(countUniqueSubjects(courses), 2);
});

test("uses subject code as canonical identity and title only when code is missing", () => {
  assert.equal(countUniqueSubjects([
    { id: "1", code: " ABC 100 ", title: "Subject" },
    { id: "2", code: "abc 100", title: "Subject" },
    { id: "3", title: "Fallback Subject" },
    { id: "4", title: " fallback   subject " },
  ]), 2);
});

test("does not merge rows that have no subject identity", () => {
  assert.equal(countUniqueSubjects([{ id: "1" }, { id: "2" }, {}]), 3);
});
