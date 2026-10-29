import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildRecommendationVariants, filterRecommendationVariants, labSlotsForTheorySession, theorySessionSuffix, toggleRecommendationVariantPreference } from "../src/recommendationOptions.js";
import { generateRecommendations } from "../src/recommendationEngine.js";

const catalogue = JSON.parse(fs.readFileSync(new URL("../src/courseCatalog.json", import.meta.url), "utf8"));

test("combined and standalone theory slot tokens determine the correct session", () => {
  for (const slot of ["TG1", "G1+TG1", "E1+TE1", "A1"]) assert.equal(theorySessionSuffix(slot), "1");
  for (const slot of ["TG2", "G2+TG2", "E2+TE2", "A2"]) assert.equal(theorySessionSuffix(slot), "2");
  assert.equal(theorySessionSuffix("E1+TE2"), null, "mixed suffix tokens are not guessed");
  assert.deepEqual(labSlotsForTheorySession("L3+L4+L33+L34", "1"), ["L33", "L34"]);
  assert.deepEqual(labSlotsForTheorySession("L3+L4+L33+L34", "2"), ["L3", "L4"]);
});

test("BACSE325 gives Arulkumar V separate morning and afternoon faculty variants with mapped labs", () => {
  const subject = catalogue.find((item) => item.code === "BACSE325");
  const variants = buildRecommendationVariants(subject).filter((variant) => variant.faculty === "ARULKUMAR V");
  assert.equal(variants.length, 2);
  const morning = variants.find((variant) => variant.sessionSuffix === "1");
  const afternoon = variants.find((variant) => variant.sessionSuffix === "2");
  assert.ok(morning);
  assert.ok(afternoon);
  assert.deepEqual(morning.offerings.map((item) => [item.type, item.slotDetail, item.venue]), [
    ["ETH", "A1", "PRP318"],
    ["ELA", "L33+L34+L41+L42", "PRP356"],
  ]);
  assert.deepEqual(afternoon.offerings.map((item) => [item.type, item.slotDetail, item.venue]), [
    ["ETH", "A2", "PRP318"],
    ["ELA", "L3+L4+L15+L16", "PRP356"],
  ]);
  for (const variant of variants) assert.equal(new Set(variant.offerings.map((item) => item.faculty.toLowerCase())).size, 1);
});

test("recommendation engine honours selected period variants and never cross-pairs faculty", () => {
  const subject = catalogue.find((item) => item.code === "BACSE325");
  const variants = buildRecommendationVariants(subject).filter((variant) => variant.faculty === "ARULKUMAR V");
  const afternoon = variants.find((variant) => variant.sessionSuffix === "2");
  const result = generateRecommendations({
    selectedSubjects: [subject],
    preferencesByCode: { [subject.code]: [{ key: afternoon.variantId, variantId: afternoon.variantId, facultyKey: afternoon.key, faculty: afternoon.faculty, rank: 1, variantIds: [afternoon.variantId] }] },
  });
  assert.equal(result.status, "complete");
  assert.equal(result.results.length, 1);
  const selectedOfferings = result.results[0].courses[0].selectedOfferings;
  assert.deepEqual(selectedOfferings.map((item) => [item.type, item.slotDetail, item.venue]), [
    ["ETH", "A2", "PRP318"],
    ["ELA", "L3+L4+L15+L16", "PRP356"],
  ]);
  assert.equal(new Set(selectedOfferings.map((item) => item.faculty.toLowerCase())).size, 1);
  assert.equal(result.results[0].score, 100, "same faculty is scored once across ETH and ELA");
});

test("a selected faculty cannot be paired with another faculty's lab", () => {
  const subject = {
    code: "PAIR-STRICT",
    title: "Paired course",
    offerings: [
      { slot: "A1", venue: "R1", faculty: "Faculty A", type: "ETH" },
      { slot: "L33+L34", venue: "LAB", faculty: "Faculty B", type: "ELA" },
    ],
  };
  const result = generateRecommendations({
    selectedSubjects: [subject],
    preferencesByCode: { "PAIR-STRICT": [{ faculty: "Faculty A", rank: 1, variantIds: ["nonexistent-variant"] }] },
  });
  assert.notEqual(result.status, "complete");
  assert.equal(result.results.length, 0);
});


test("faculty search matches names, theory slots, lab slots, venues, and combined terms", () => {
  const subject = catalogue.find((item) => item.code === "BACSE325");
  const variants = buildRecommendationVariants(subject);
  const byFaculty = filterRecommendationVariants(variants, "arulkumar v");
  assert.equal(byFaculty.length, 2, "both period choices for the faculty are visible");
  assert.ok(byFaculty.every((variant) => variant.faculty === "ARULKUMAR V"));

  const afternoonByTheorySlot = filterRecommendationVariants(variants, "A2");
  assert.ok(afternoonByTheorySlot.length > 0);
  assert.ok(afternoonByTheorySlot.every((variant) => variant.offerings.some((offering) => offering.slotDetail.split("+").includes("A2"))));

  const labSearch = filterRecommendationVariants(variants, "L33");
  assert.ok(labSearch.length > 0);
  assert.ok(labSearch.every((variant) => variant.offerings.some((offering) => offering.slotDetail.includes("L33"))));

  const combinedSearch = filterRecommendationVariants(variants, "arulkumar A2");
  assert.equal(combinedSearch.length, 1);
  assert.equal(combinedSearch[0].sessionSuffix, "2");

  assert.equal(filterRecommendationVariants(variants, "definitely-not-a-faculty-or-slot").length, 0);
  assert.equal(filterRecommendationVariants(variants, "").length, variants.length);
});


test("choosing a different period for the same faculty replaces the old variant instead of sharing its priority", () => {
  const subject = catalogue.find((item) => item.code === "BACSE325");
  const variants = buildRecommendationVariants(subject).filter((variant) => variant.faculty === "ARULKUMAR V");
  const morning = variants.find((variant) => variant.sessionSuffix === "1");
  const afternoon = variants.find((variant) => variant.sessionSuffix === "2");

  const morningChoice = toggleRecommendationVariantPreference([], morning);
  assert.equal(morningChoice.preferences.length, 1);
  assert.equal(morningChoice.preferences[0].variantId, morning.variantId);
  assert.equal(morningChoice.preferences[0].rank, 1);

  const afternoonChoice = toggleRecommendationVariantPreference(morningChoice.preferences, afternoon);
  assert.equal(afternoonChoice.preferences.length, 1, "one person can have only one selected period option");
  assert.equal(afternoonChoice.preferences[0].variantId, afternoon.variantId);
  assert.equal(afternoonChoice.preferences[0].rank, 1, "switching period retains that person's rank but assigns it only to the chosen period");
  assert.notEqual(afternoonChoice.preferences[0].variantId, morning.variantId);

  const result = generateRecommendations({
    selectedSubjects: [subject],
    preferencesByCode: { [subject.code]: afternoonChoice.preferences },
  });
  assert.equal(result.status, "complete");
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0].courses[0].selectedOfferings.map((item) => item.slotDetail), ["A2", "L3+L4+L15+L16"]);
});

test("five-faculty limit is based on distinct people, while period variants replace each other", () => {
  const subject = catalogue.find((item) => item.code === "BACSE325");
  const variants = buildRecommendationVariants(subject);
  const choices = [];
  for (const name of ["ARULKUMAR V", "ARUN KUMAR G", "BALASUBRAMANIAN C", "LYDIA JANE G", "MEENAKSHI S P"]) {
    const variant = variants.find((item) => item.faculty === name && item.sessionSuffix === "1")
      || variants.find((item) => item.faculty === name);
    assert.ok(variant, `expected catalogue variant for ${name}`);
    const result = toggleRecommendationVariantPreference(choices, variant);
    assert.equal(result.limitReached, false);
    choices.splice(0, choices.length, ...result.preferences);
  }
  assert.equal(choices.length, 5);
  const sameFacultyAlt = variants.find((item) => item.faculty === "ARULKUMAR V" && item.sessionSuffix === "2");
  const switched = toggleRecommendationVariantPreference(choices, sameFacultyAlt);
  assert.equal(switched.limitReached, false);
  assert.equal(switched.preferences.length, 5);
  assert.equal(switched.preferences.filter((item) => item.faculty === "ARULKUMAR V").length, 1);
  assert.equal(switched.preferences.find((item) => item.faculty === "ARULKUMAR V").variantId, sameFacultyAlt.variantId);
});
