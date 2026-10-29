import test from "node:test";
import assert from "node:assert/strict";
import { splitPairedCourseEntries, recommendationComponentEntries } from "../src/courseComponents.js";

const ids = (() => { let n = 0; return () => `component-${++n}`; })();

test("Add Together creates separate ETH and ELA rows with independent credits and venues", () => {
  const rows = splitPairedCourseEntries({
    baseCourse: { code: "C1", title: "Course One", faculty: "Alpha", venue: "ROOM-A", credits: 3, slots: ["L45", "L46"], color: "#fff" },
    selectedOffering: { type: "ELA", slot: "L45+L46", faculty: "Alpha", venue: "LAB-A" },
    counterpartOffering: { type: "ETH", slot: "E1+TE1", faculty: " alpha ", venue: "ROOM-A" },
    selectedSlots: ["L45", "L46"],
    counterpartSlots: ["E1", "TE1"],
    creditsByType: { ETH: "3", ELA: "1.5" },
    idFactory: ids,
  });
  assert.deepEqual(rows.map((row) => row.componentType), ["ETH", "ELA"]);
  assert.deepEqual(rows.map((row) => row.credits), [3, 1.5]);
  assert.deepEqual(rows.map((row) => row.slots), [["E1", "TE1"], ["L45", "L46"]]);
  assert.equal(rows[0].venue, "ROOM-A");
  assert.equal(rows[1].venue, "LAB-A");
  assert.notEqual(rows[0].id, rows[1].id);
});

test("blank ETH or ELA credits are accepted as zero rather than blocking a pair", () => {
  const rows = splitPairedCourseEntries({
    baseCourse: { code: "C2", title: "Course Two", slots: ["E2", "TE2"], color: "#eee" },
    selectedOffering: { type: "ETH", slot: "E2+TE2", faculty: "Beta", venue: "ROOM-B" },
    counterpartOffering: { type: "ELA", slot: "L15+L16", faculty: "Beta", venue: "LAB-B" },
    selectedSlots: ["E2", "TE2"],
    counterpartSlots: ["L15", "L16"],
    creditsByType: { ETH: "", ELA: "2" },
    idFactory: ids,
  });
  assert.deepEqual(rows.map((row) => row.credits), [0, 2]);
});

test("recommendation offerings become separate editable entries with component-specific credits", () => {
  const rows = recommendationComponentEntries({
    subjectCode: "C3",
    subjectTitle: "Course Three",
    selectedOfferings: [
      { type: "ETH", faculty: "Gamma", venue: "ROOM-C", slots: ["G1", "TG1"] },
      { type: "ELA", faculty: "Gamma", venue: "LAB-C", slots: ["L45", "L46"] },
    ],
  }, { ETH: "2", ELA: "1" }, "#abcdef");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.componentType), ["ETH", "ELA"]);
  assert.deepEqual(rows.map((row) => row.credits), [2, 1]);
  assert.deepEqual(rows.map((row) => row.slots), [["G1", "TG1"], ["L45", "L46"]]);
  assert.ok(rows.every((row) => row.code === "C3"));
});
