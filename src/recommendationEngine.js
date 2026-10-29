import { DAYS, TH, LB, THEORY_START, THEORY_END, LAB_START, LAB_END, ruleHits } from "./slots.js";
import { buildRecommendationVariants, normalizeFacultyIdentity } from "./recommendationOptions.js";
export { normalizeFacultyIdentity };

const FACULTY_SCORES = Object.freeze({ 1: 100, 2: 80, 3: 60, 4: 40, 5: 20 });

function componentGroup(typeValue) {
  const type = String(typeValue || "").trim().toUpperCase();
  if (["ETH", "TH", "THEORY"].includes(type) || type.includes("THEORY")) return "THEORY";
  if (["ELA", "LA", "LAB"].includes(type) || type.includes("LAB")) return "LAB";
  return type ? `OTHER:${type}` : "";
}

const toMinutes = (value) => {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

function intervalsForSlots(slots) {
  const wanted = new Set(slots || []);
  const result = [];
  for (const day of DAYS) {
    TH[day].forEach((slot, index) => {
      const start = toMinutes(THEORY_START[index]);
      const end = toMinutes(THEORY_END[index]);
      if (slot !== "-" && slot !== "|" && wanted.has(slot) && start !== null && end !== null && end > start) {
        result.push({ day, slot, start, end });
      }
    });
    LB[day].forEach((slot, index) => {
      const start = toMinutes(LAB_START[index]);
      const end = toMinutes(LAB_END[index]);
      if (slot !== "-" && slot !== "|" && wanted.has(slot) && start !== null && end !== null && end > start) {
        result.push({ day, slot, start, end });
      }
    });
  }
  return result;
}

function intervalsConflict(left, right) {
  for (const a of left || []) {
    for (const b of right || []) {
      if (a.day === b.day && a.start < b.end && b.start < a.end) return true;
    }
  }
  return false;
}

export function slotsHaveTimeConflict(leftSlots, rightSlots) {
  return intervalsConflict(intervalsForSlots(leftSlots), intervalsForSlots(rightSlots));
}

function normalizePreferences(preferences) {
  const parsed = [];
  for (const item of preferences || []) {
    const faculty = String(item?.faculty || item?.name || "").trim();
    const facultyKey = normalizeFacultyIdentity(item?.facultyKey || faculty);
    const rank = Number(item?.rank);
    if (!facultyKey || !Number.isInteger(rank) || rank < 1 || rank > 5) continue;
    const rawVariants = Array.isArray(item?.variantIds) ? [...new Set(item.variantIds.map(String).filter(Boolean))] : null;
    const explicitVariantId = String(item?.variantId || rawVariants?.[0] || "").trim();
    // A period-specific preference is keyed by its exact variant ID. A legacy
    // preference without variant IDs remains faculty-keyed for compatibility.
    const key = explicitVariantId || facultyKey;
    parsed.push({
      key,
      facultyKey,
      faculty,
      rank,
      variantId: explicitVariantId || null,
      variantIds: explicitVariantId ? [explicitVariantId] : null,
    });
  }

  // The UI lets a student pick only one period-specific option per faculty.
  // Defensively keep the highest-ranked option if malformed input contains two.
  parsed.sort((a, b) => a.rank - b.rank || a.faculty.localeCompare(b.faculty) || a.key.localeCompare(b.key));
  const chosen = [];
  const seenPeople = new Set();
  for (const preference of parsed) {
    if (seenPeople.has(preference.facultyKey)) continue;
    seenPeople.add(preference.facultyKey);
    chosen.push(preference);
    if (chosen.length >= 5) break;
  }
  return new Map(chosen.map((item, index) => [item.key, { ...item, rank: index + 1 }]));
}

function makeSubjectCandidates(subject, preferences, rules, maxCandidates = 30000) {
  const prefs = normalizePreferences(preferences);
  if (!prefs.size) return { candidates: [], error: `Choose at least one faculty preference for ${subject.title || subject.code}.`, errorType: "invalid" };

  const hasTheory = (subject.offerings || []).some((offering) => componentGroup(offering?.type) === "THEORY");
  const hasLab = (subject.offerings || []).some((offering) => componentGroup(offering?.type) === "LAB");
  const variants = buildRecommendationVariants(subject).filter((variant) => {
    const exactPreference = prefs.get(variant.variantId);
    if (exactPreference) return exactPreference.variantId === variant.variantId;
    const legacyPreference = prefs.get(variant.key);
    return Boolean(legacyPreference && legacyPreference.variantIds === null);
  });
  const rawCandidateCount = variants.length;
  const generationLimited = rawCandidateCount > maxCandidates;
  const candidates = [];

  for (const variant of variants.slice(0, maxCandidates)) {
    const exactPreference = prefs.get(variant.variantId);
    const legacyPreference = prefs.get(variant.key);
    const preference = exactPreference || (legacyPreference?.variantIds === null ? legacyPreference : null);
    if (!preference || !variant.offerings?.length) continue;
    const selectedOfferings = variant.offerings.map((item) => ({
      type: item.type,
      group: item.group,
      faculty: item.faculty,
      facultyKey: item.facultyKey,
      rank: preference.rank,
      venue: item.venue,
      slotDetail: item.slotDetail,
      slots: [...item.slots],
      signature: item.signature,
      sessionSuffix: item.sessionSuffix,
    }));
    const allSlots = [...new Set(selectedOfferings.flatMap((item) => item.slots))];
    const componentIntervals = selectedOfferings.map((item) => intervalsForSlots(item.slots));
    let internalClash = false;
    for (let i = 0; i < componentIntervals.length && !internalClash; i += 1) {
      for (let j = i + 1; j < componentIntervals.length; j += 1) {
        if (intervalsConflict(componentIntervals[i], componentIntervals[j])) {
          internalClash = true;
          break;
        }
      }
    }
    if (internalClash) continue;
    if (ruleHits({ slots: allSlots }, rules || {}).length) continue;

    const slots = allSlots;
    const intervals = intervalsForSlots(slots);
    const slotVenues = {};
    const slotFaculties = {};
    for (const offering of selectedOfferings) {
      for (const slot of offering.slots) {
        slotVenues[slot] = offering.venue;
        slotFaculties[slot] = offering.faculty;
      }
    }
    const facultyNames = [...new Set(selectedOfferings.map((item) => item.faculty))];
    const venueNames = [...new Set(selectedOfferings.map((item) => item.venue).filter(Boolean))];
    const score = FACULTY_SCORES[preference.rank] || 0; // Once per subject/faculty, never once per component.
    const signature = `${subject.code}|${variant.variantId}`;
    candidates.push({
      subjectCode: subject.code,
      subjectTitle: subject.title,
      selectedOfferings,
      slots,
      slotVenues,
      slotFaculties,
      faculty: facultyNames.join(" / "),
      venue: venueNames.join(" / "),
      score,
      signature,
      variantId: variant.variantId,
      sessionSuffix: variant.sessionSuffix,
      phaseLabel: variant.phaseLabel,
      intervals,
    });
  }

  const unique = new Map();
  for (const candidate of candidates) unique.set(candidate.signature, candidate);
  const sorted = [...unique.values()].sort((a, b) => b.score - a.score || a.signature.localeCompare(b.signature));
  if (!sorted.length) {
    let message;
    if (generationLimited) {
      message = `The valid offering variants for ${subject.title || subject.code} exceeded the preparation limit. Reduce faculty options and try again.`;
    } else if (hasTheory && hasLab) {
      message = `No valid same-faculty theory/lab pairing was found for ${subject.title || subject.code} under the selected faculty and slot-mapping preferences. Check the morning/afternoon variant selection or add another faculty.`;
    } else {
      message = `No valid offering variant is available for ${subject.title || subject.code} under the selected faculty preferences and timetable rules.`;
    }
    return { candidates: [], error: message, errorType: generationLimited ? "limit" : "no-solution", generationLimited };
  }
  return {
    candidates: sorted,
    maxScore: sorted[0].score,
    generationLimited,
    preparationCombinations: rawCandidateCount,
    rawCandidateCount,
  };
}

/**
 * Generate the best valid unique timetables using constraint-based DFS:
 * MRV ordering, early conflict checks, forward checking, an admissible score
 * bound, deterministic tie-breaking and bounded top-K retention.
 */
export function generateRecommendations({
  selectedSubjects,
  preferencesByCode,
  rules = {},
  limit = 3,
  maxNodes = 120000,
  maxMs = 2500,
  maxCandidatesPerSubject = 30000,
} = {}) {
  const subjects = Array.isArray(selectedSubjects) ? selectedSubjects : [];
  if (!subjects.length) return { status: "invalid", error: "Select at least one subject to generate recommendations.", results: [], nodesExplored: 0 };

  const prepared = [];
  const errors = [];
  const errorTypes = [];
  let preparationLimited = false;
  for (const subject of subjects) {
    const facultyPreferences = preferencesByCode?.[subject.code] || [];
    const preparation = makeSubjectCandidates(subject, facultyPreferences, rules, maxCandidatesPerSubject);
    if (preparation.error) {
      errors.push(preparation.error);
      errorTypes.push(preparation.errorType || "invalid");
    }
    if (preparation.generationLimited) preparationLimited = true;
    if (!preparation.candidates.length) continue;
    prepared.push({
      code: subject.code,
      title: subject.title,
      candidates: preparation.candidates,
      maxScore: preparation.maxScore,
      rawCandidateCount: preparation.rawCandidateCount ?? preparation.candidates.length,
      originalIndex: subjects.findIndex((item) => item.code === subject.code),
    });
  }
  if (errors.length) {
    const status = errorTypes.includes("invalid") ? (preparationLimited ? "limit" : "invalid") : errorTypes.includes("limit") ? "limit" : "no-solution";
    return {
      status,
      errors,
      error: errors[0],
      results: [],
      nodesExplored: 0,
      elapsedMs: 0,
      candidateCounts: prepared.map((subject) => ({ code: subject.code, before: subject.rawCandidateCount, after: subject.candidates.length })),
    };
  }
  if (prepared.length !== subjects.length) return { status: "invalid", errors: ["One or more selected subjects do not have usable offerings."], results: [], nodesExplored: 0, elapsedMs: 0, candidateCounts: [] };

  const startedAt = Date.now();
  const resultLimit = Math.min(3, Math.max(1, Number(limit) || 3));
  const topResults = [];
  const assigned = new Map();
  let nodesExplored = 0;
  let limited = false;

  const resultSignature = () => subjects.map((subject) => assigned.get(subject.code)?.signature || "").join("###");
  const recordResult = (score) => {
    const signature = resultSignature();
    // Per-subject offering candidates are deduplicated during preprocessing,
    // so only check the bounded top-K buffer for a duplicate complete result.
    if (topResults.some((result) => result.signature === signature)) return;
    const courses = subjects.map((subject) => assigned.get(subject.code));
    topResults.push({
      signature,
      score,
      maximumScore: prepared.reduce((sum, subject) => sum + subject.maxScore, 0),
      courses,
    });
    topResults.sort((a, b) => b.score - a.score || a.signature.localeCompare(b.signature));
    if (topResults.length > resultLimit) topResults.pop();
  };

  const search = (remaining, score) => {
    if (limited) return;
    nodesExplored += 1;
    if (nodesExplored > maxNodes || Date.now() - startedAt > maxMs) {
      limited = true;
      return;
    }
    if (!remaining.length) {
      recordResult(score);
      return;
    }

    // Forward checking also provides the current most-constrained subject.
    let nextSubject = null;
    let nextCandidates = null;
    let scoreUpperBound = score;
    for (const subject of remaining) {
      const compatible = subject.candidates.filter((candidate) => {
        for (const existing of assigned.values()) {
          if (intervalsConflict(candidate.intervals, existing.intervals)) return false;
        }
        return true;
      });
      if (!compatible.length) return;
      scoreUpperBound += compatible.reduce((best, candidate) => Math.max(best, candidate.score), 0);
      if (!nextCandidates || compatible.length < nextCandidates.length || (compatible.length === nextCandidates.length && subject.originalIndex < nextSubject.originalIndex)) {
        nextSubject = subject;
        nextCandidates = compatible;
      }
    }

    if (topResults.length >= resultLimit && scoreUpperBound < topResults[topResults.length - 1].score) return;

    const nextRemaining = remaining.filter((subject) => subject.code !== nextSubject.code);
    nextCandidates.sort((a, b) => b.score - a.score || a.signature.localeCompare(b.signature));
    for (const candidate of nextCandidates) {
      if (limited) return;
      assigned.set(nextSubject.code, candidate);
      search(nextRemaining, score + candidate.score);
      assigned.delete(nextSubject.code);
    }
  };

  search(prepared, 0);
  const bestResults = topResults.map((result, index) => ({ ...result, rank: index + 1 }));
  let status = limited || preparationLimited ? "limit" : bestResults.length ? "complete" : "no-solution";
  if (limited && !bestResults.length) {
    return {
      status,
      error: "The search limit was reached before a valid recommendation could be verified. This does not mean no timetable exists. Try fewer subjects or faculty options, or run the search again.",
      results: [],
      nodesExplored,
      elapsedMs: Date.now() - startedAt,
      candidateCounts: prepared.map((subject) => ({ code: subject.code, before: subject.rawCandidateCount, after: subject.candidates.length })),
    };
  }
  if (!bestResults.length) {
    return {
      status,
      error: "No valid timetable found. The selected subjects, faculty preferences and mandatory slot constraints do not have a clash-free combination.",
      results: [],
      nodesExplored,
      elapsedMs: Date.now() - startedAt,
      candidateCounts: prepared.map((subject) => ({ code: subject.code, before: subject.rawCandidateCount, after: subject.candidates.length })),
    };
  }
  return {
    status,
    results: bestResults,
    nodesExplored,
    elapsedMs: Date.now() - startedAt,
    candidateCounts: prepared.map((subject) => ({ code: subject.code, before: subject.rawCandidateCount, after: subject.candidates.length })),
    error: status === "limit" ? "Search limit reached. These are the best valid results found so far; they are not guaranteed to be globally optimal." : "",
  };
}

export const recommendationScoreForRank = (rank) => FACULTY_SCORES[Number(rank)] || 0;
