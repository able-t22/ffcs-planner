import test from "node:test";
import assert from "node:assert/strict";
import { generateRecommendations } from "../src/recommendationEngine.js";

const pref = (...faculty) => faculty.map((name, index) => ({ faculty: name, rank: index + 1 }));

test("faculty identity is deduplicated across theory and lab scoring", () => {
  const subject = {
    code: "C1",
    title: "Course One",
    offerings: [
      { slot: "A1", venue: "R1", faculty: "  ALPHA  Faculty ", type: "ETH" },
      { slot: "L43+L44", venue: "LAB1", faculty: "alpha faculty", type: "ELA" },
    ],
  };
  const result = generateRecommendations({
    selectedSubjects: [subject],
    preferencesByCode: { C1: [{ faculty: "Alpha Faculty", rank: 1 }] },
  });
  assert.equal(result.status, "complete");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].score, 100, "same faculty must only score once across ETH/ELA");
  assert.deepEqual(new Set(result.results[0].courses[0].slots), new Set(["A1", "L43", "L44"]));
});

test("returns at most three highest-scoring unique recommendations", () => {
  const subject = {
    code: "C2",
    title: "Course Two",
    offerings: [
      { slot: "A1", venue: "R1", faculty: "Alpha", type: "TH" },
      { slot: "F1", venue: "R2", faculty: "Beta", type: "TH" },
      { slot: "D1", venue: "R3", faculty: "Gamma", type: "TH" },
      { slot: "F2", venue: "R4", faculty: "Delta", type: "TH" },
      { slot: "D2", venue: "R5", faculty: "Epsilon", type: "TH" },
    ],
  };
  const result = generateRecommendations({ selectedSubjects: [subject], preferencesByCode: { C2: pref("Alpha", "Beta", "Gamma", "Delta", "Epsilon") } });
  assert.equal(result.status, "complete");
  assert.equal(result.results.length, 3);
  assert.deepEqual(result.results.map((item) => item.score), [100, 80, 60]);
  assert.equal(new Set(result.results.map((item) => item.signature)).size, result.results.length);
});

test("rejects a clash and selects a compatible alternative", () => {
  const subjects = [
    { code: "C3", title: "First", offerings: [{ slot: "A1", venue: "R1", faculty: "Alpha", type: "TH" }] },
    { code: "C4", title: "Second", offerings: [
      { slot: "A1", venue: "R2", faculty: "Beta", type: "TH" },
      { slot: "F1", venue: "R2", faculty: "Gamma", type: "TH" },
    ] },
  ];
  const result = generateRecommendations({
    selectedSubjects: subjects,
    preferencesByCode: { C3: pref("Alpha"), C4: pref("Beta", "Gamma") },
  });
  assert.ok(result.results.length > 0);
  assert.ok(result.results.every((entry) => !entry.courses[0].slots.some((slot) => entry.courses[1].slots.includes(slot))));
  assert.equal(result.results[0].courses[1].selectedOfferings[0].faculty, "Gamma");
});

test("distinguishes an impossible schedule from a search-limit stop", () => {
  const subjects = [
    { code: "C5", title: "First", offerings: [{ slot: "A1", venue: "R1", faculty: "Alpha", type: "TH" }] },
    { code: "C6", title: "Second", offerings: [{ slot: "A1", venue: "R2", faculty: "Beta", type: "TH" }] },
  ];
  const impossible = generateRecommendations({ selectedSubjects: subjects, preferencesByCode: { C5: pref("Alpha"), C6: pref("Beta") } });
  assert.equal(impossible.status, "no-solution");
  const limited = generateRecommendations({ selectedSubjects: subjects, preferencesByCode: { C5: pref("Alpha"), C6: pref("Beta") }, maxNodes: 0 });
  assert.equal(limited.status, "limit");
  assert.match(limited.error, /search limit/i);
});

test("honors the no-8-AM rule during candidate preparation", () => {
  const subject = { code: "C7", title: "Early class", offerings: [{ slot: "A1", venue: "R1", faculty: "Alpha", type: "TH" }] };
  const result = generateRecommendations({ selectedSubjects: [subject], preferencesByCode: { C7: pref("Alpha") }, rules: { no8: true } });
  assert.equal(result.status, "no-solution");
});

test("generates clash-free ranked recommendations from the bundled real catalogue", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { normalizeFacultyIdentity, slotsHaveTimeConflict } = await import("../src/recommendationEngine.js");
  const root = path.dirname(fileURLToPath(import.meta.url));
  const catalog = JSON.parse(await fs.readFile(path.join(root, "../src/courseCatalog.json"), "utf8"));
  const selectedSubjects = catalog.slice(0, 6);
  const preferencesByCode = {};
  for (const subject of selectedSubjects) {
    const people = new Map();
    for (const offering of subject.offerings || []) {
      const key = normalizeFacultyIdentity(offering.faculty);
      if (key && !people.has(key)) people.set(key, offering.faculty);
    }
    preferencesByCode[subject.code] = [...people.entries()].slice(0, 5).map(([key, faculty], index) => ({ key, faculty, rank: index + 1 }));
  }
  const result = generateRecommendations({ selectedSubjects, preferencesByCode, maxNodes: 50000, maxMs: 1500 });
  assert.equal(result.status, "complete");
  assert.equal(result.results.length, 3);
  for (const recommendation of result.results) {
    assert.equal(recommendation.courses.length, selectedSubjects.length, "all selected subjects must be present");
    assert.deepEqual(recommendation.courses.map((course) => course.subjectCode).sort(), selectedSubjects.map((subject) => subject.code).sort());
    for (let i = 0; i < recommendation.courses.length; i += 1) {
      for (let j = i + 1; j < recommendation.courses.length; j += 1) {
        assert.equal(slotsHaveTimeConflict(recommendation.courses[i].slots, recommendation.courses[j].slots), false, "recommended courses must not overlap in real slot intervals");
      }
    }
  }
  assert.ok(result.results[0].score >= result.results[1].score);
  assert.ok(result.results[1].score >= result.results[2].score);
});

test("handles eight subjects with five faculty choices per subject efficiently", () => {
  const slots = ["A1", "F1", "D1", "TB1", "TG1", "B1", "G1", "E1"];
  const facultyNames = ["Faculty A", "Faculty B", "Faculty C", "Faculty D", "Faculty E"];
  const selectedSubjects = slots.map((slot, subjectIndex) => ({
    code: `BENCH-${subjectIndex + 1}`,
    title: `Benchmark subject ${subjectIndex + 1}`,
    offerings: facultyNames.map((faculty) => ({ slot, venue: `ROOM-${subjectIndex + 1}`, faculty, type: "TH" })),
  }));
  const preferencesByCode = Object.fromEntries(selectedSubjects.map((subject) => [subject.code, pref(...facultyNames)]));
  const result = generateRecommendations({ selectedSubjects, preferencesByCode, maxNodes: 50000, maxMs: 1500 });
  assert.equal(result.status, "complete");
  assert.equal(result.results.length, 3);
  assert.ok(result.nodesExplored < 50000);
  assert.ok(result.elapsedMs < 1500);
  assert.ok(result.results.every((recommendation) => recommendation.courses.length === 8));
  assert.deepEqual(result.results.map((recommendation) => recommendation.score), [800, 780, 780]);
});
