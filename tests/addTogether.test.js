import test from "node:test";
import assert from "node:assert/strict";
import { resolvePairing, theorySlotGroup, labSlotGroup, offeringKind, buildPairedComponentRows } from "../src/addTogether.js";

const offerings = [
  { type: "ETH", slot: "G1+TG1", faculty: "Dr  Rao", venue: "AB1-101" },
  { type: "ELA", slot: "L45+L46", faculty: "dr rao", venue: "LAB-1" },
  { type: "ELA", slot: "L15+L16", faculty: "Dr Rao", venue: "LAB-2" },
  { type: "ELA", slot: "L47+L48", faculty: "Dr Someone Else", venue: "LAB-3" },
  { type: "ETH", slot: "E2+TE2", faculty: "Dr Rao", venue: "AB1-102" },
];
const base = (i) => {
  const o = offerings[i]; const slots = o.slot.split("+");
  return { id: "x", code: "CSE1", title: "DBMS", credits: 4, slots, faculty: o.faculty, venue: o.venue, slotVenues: Object.fromEntries(slots.map((s) => [s, o.venue])) };
};
const run = (i, over = {}) => resolvePairing({ addTogether: true, selectedOffering: offerings[i], selectedOfferingMatchesInput: true, selectedIndex: i, offerings, baseCourse: base(i), existingCourses: [], ...over });

test("slot group mapping", () => {
  for (const s of ["TG1", "G1+TG1", "E1+TE1"]) assert.equal(theorySlotGroup(s), "1");
  for (const s of ["TG2", "G2+TG2", "E2+TE2"]) assert.equal(theorySlotGroup(s), "2");
  assert.equal(labSlotGroup("L45+L46"), "late");
  assert.equal(labSlotGroup("L15+L16"), "early");
  assert.equal(labSlotGroup("L30+L31"), null);
  assert.equal(offeringKind({ type: "SS" }), null);
});
test("theory-first pairs same faculty lab in the right range; wrong faculty ignored", () => {
  const r = run(0);
  assert.ok(r.pairedCourse);
  assert.deepEqual(new Set(r.pairedCourse.slots), new Set(["G1", "TG1", "L45", "L46"]));
  assert.equal(r.pairedCourse.slotVenues.L45, "LAB-1");
  assert.equal(r.pairedCourse.slotVenues.G1, "AB1-101");
  assert.equal(r.pairedCourse.credits, 4, "credits not doubled");
});
test("lab-first reverse pairing (late lab -> theory ending in 1; early lab -> theory ending in 2)", () => {
  assert.deepEqual(new Set(run(1).pairedCourse.slots), new Set(["L45", "L46", "G1", "TG1"]));
  assert.deepEqual(new Set(run(2).pairedCourse.slots), new Set(["L15", "L16", "E2", "TE2"]));
});
test("no counterpart -> notice, original only", () => {
  const r = run(4, { offerings: [offerings[4]], selectedIndex: 0 });
  assert.equal(r.pairedCourse, null);
  assert.match(r.feedback, /Lab not detected\. Adding only theory component\./);
  const l = run(3);
  assert.equal(l.pairedCourse, null);
  assert.match(l.feedback, /Theory not detected\. Adding only lab component\./);
});
test("different faculty / wrong type never pair", () => {
  const only = [offerings[0], offerings[3]];
  const r = run(0, { offerings: only, selectedIndex: 0 });
  assert.equal(r.pairedCourse, null);
  assert.match(r.feedback, /Lab not detected/);
});
test("counterpart clash keeps original and names the conflicting subject", () => {
  const existing = [{ code: "MAT1", title: "Maths", slots: ["L45"], faculty: "Z" }];
  const r = run(0, { existingCourses: existing });
  assert.equal(r.pairedCourse, null);
  assert.match(r.feedback, /Lab slot clash detected.*MAT1/);
});
test("multiple distinct counterparts -> no arbitrary pick", () => {
  const many = [...offerings, { type: "ELA", slot: "L49+L50", faculty: "Dr Rao", venue: "LAB-9" }];
  const r = run(0, { offerings: many });
  assert.equal(r.pairedCourse, null);
  assert.match(r.feedback, /Multiple matching lab offerings/);
});
test("duplicate copied rows are not ambiguity", () => {
  const dup = [...offerings, { ...offerings[1] }];
  assert.ok(run(0, { offerings: dup }).pairedCourse);
});
test("toggle off or hand-edited slots -> manual, no pairing, no notice", () => {
  assert.deepEqual(run(0, { addTogether: false }), { pairedCourse: null, feedback: "", feedbackType: "success" });
  assert.equal(run(0, { selectedOfferingMatchesInput: false }).pairedCourse, null);
});


test("paired Add Together components become separate ETH and ELA rows with independent credits", () => {
  const r = run(0);
  const rows = buildPairedComponentRows({
    baseCourse: base(0),
    selectedOffering: offerings[0],
    counterpartOffering: r.counterpartOffering,
    counterpartSlots: r.counterpartSlots,
    componentCredits: { eth: "3", ela: "1.5" },
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((course) => [course.componentType, course.slots.join("+"), course.credits, course.venue]), [
    ["ETH", "G1+TG1", 3, "AB1-101"],
    ["ELA", "L45+L46", 1.5, "LAB-1"],
  ]);
  assert.equal(rows[0].code, rows[1].code);
  assert.equal(rows[0].faculty.toLowerCase(), rows[1].faculty.toLowerCase());
});

test("blank component credit contributes zero without rejecting the other component", () => {
  const r = run(0);
  const rows = buildPairedComponentRows({
    baseCourse: base(0),
    selectedOffering: offerings[0],
    counterpartOffering: r.counterpartOffering,
    counterpartSlots: r.counterpartSlots,
    componentCredits: { eth: "3", ela: "" },
  });
  assert.deepEqual(rows.map((course) => course.credits), [3, 0]);
});
