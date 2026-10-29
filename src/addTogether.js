// Pure helpers for the "Add Together" theory/lab pairing feature.
// Kept outside App.jsx so the pairing rules can be unit-tested.
import { DAYS, TH, LB, THEORY_START, THEORY_END, LAB_START, LAB_END, parseSlots } from "./slots.js";

export const normalizedFacultyName = (value) => String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();

export function offeringKind(offering) {
  const type = String(offering?.type || "").trim().toUpperCase();
  if (type === "ELA" || type === "LA" || type === "LAB" || type.includes("LAB")) return "lab";
  if (type === "ETH" || type === "TH" || type === "THEORY" || type.includes("THEORY")) return "theory";
  return null;
}

// Only a trailing numeric slot value of exactly 1 or 2 qualifies. This accepts
// TG1 on its own, but does not misread X11 as a slot ending in the number 1.
export function theorySlotGroup(slotDetail) {
  const tokens = parseSlots(String(slotDetail || ""));
  if (!tokens.length) return null;
  const groups = tokens.map((token) => {
    const match = token.match(/^[A-KM-Z]+([12])$/);
    return match ? match[1] : null;
  });
  return groups.every(Boolean) && groups.every((group) => group === groups[0]) ? groups[0] : null;
}

export function labSlotGroup(slotDetail) {
  const tokens = parseSlots(String(slotDetail || ""));
  if (!tokens.length) return null;
  const numbers = tokens.map((token) => {
    const match = token.match(/^L(\d+)$/);
    return match ? Number(match[1]) : null;
  });
  if (numbers.some((number) => number === null || number < 1)) return null;
  if (numbers.every((number) => number > 30)) return "late";
  if (numbers.every((number) => number <= 30)) return "early";
  return null;
}

const minutesOfDay = (value) => {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

export function slotTimeIntervals(slots) {
  const wanted = new Set(slots || []);
  const intervals = [];
  for (const day of DAYS) {
    TH[day].forEach((slot, index) => {
      const start = minutesOfDay(THEORY_START[index]);
      const end = minutesOfDay(THEORY_END[index]);
      if (wanted.has(slot) && start !== null && end !== null && end > start) intervals.push({ day, slot, start, end });
    });
    LB[day].forEach((slot, index) => {
      const start = minutesOfDay(LAB_START[index]);
      const end = minutesOfDay(LAB_END[index]);
      if (wanted.has(slot) && start !== null && end !== null && end > start) intervals.push({ day, slot, start, end });
    });
  }
  return intervals;
}

export function intervalClashes(candidateSlots, existingCourses) {
  const candidateIntervals = slotTimeIntervals(candidateSlots);
  const conflicts = [];
  for (const course of existingCourses || []) {
    const existingIntervals = slotTimeIntervals(course.slots || []);
    for (const candidate of candidateIntervals) {
      for (const existing of existingIntervals) {
        if (candidate.day === existing.day && candidate.start < existing.end && existing.start < candidate.end) {
          const time = `${String(Math.floor(candidate.start / 60)).padStart(2, "0")}:${String(candidate.start % 60).padStart(2, "0")}`;
          conflicts.push(`${candidate.slot} overlaps ${existing.slot} of ${course.code || course.title}${course.faculty ? " (" + course.faculty + ")" : ""} on ${candidate.day} around ${time}`);
        }
      }
    }
  }
  return [...new Set(conflicts)];
}

/**
 * Decide whether a matching counterpart can be added with the selected offering.
 * Never guesses: the counterpart must come from the same subject's offerings
 * (`offerings`), have the same normalized faculty, the opposite ETH/ELA kind,
 * a matching slot group, be unique, and be clash-free.
 * Returns { pairedCourse, feedback, feedbackType }; pairedCourse is null when
 * only the selected component should be added.
 */
export function resolvePairing({ addTogether, selectedOffering, selectedOfferingMatchesInput, selectedIndex, offerings, baseCourse, existingCourses }) {
  const none = { pairedCourse: null, feedback: "", feedbackType: "success" };
  const selectedKind = selectedOfferingMatchesInput ? offeringKind(selectedOffering) : null;
  const facultyKey = normalizedFacultyName(selectedOffering?.faculty || baseCourse.faculty);
  if (!addTogether || !selectedOfferingMatchesInput || !selectedKind || !facultyKey) return none;

  const warn = (feedback) => ({ pairedCourse: null, feedback, feedbackType: "warning" });
  let expectedGroup = null;
  if (selectedKind === "theory") expectedGroup = theorySlotGroup(selectedOffering.slot);
  else {
    const selectedLabGroup = labSlotGroup(selectedOffering.slot);
    expectedGroup = selectedLabGroup === "late" ? "1" : selectedLabGroup === "early" ? "2" : null;
  }
  if (!expectedGroup) return warn(`Could not determine the ${selectedKind === "theory" ? "theory" : "lab"} slot mapping for this offering. Added only the selected component.`);

  const oppositeKind = selectedKind === "theory" ? "lab" : "theory";
  const filteredMatches = (offerings || []).map((offering, index) => ({ offering, index }))
    .filter(({ offering, index }) => index !== Number(selectedIndex)
      && offeringKind(offering) === oppositeKind
      && normalizedFacultyName(offering.faculty) === facultyKey
      && (oppositeKind === "lab"
        ? labSlotGroup(offering.slot) === (expectedGroup === "1" ? "late" : "early")
        : theorySlotGroup(offering.slot) === expectedGroup));
  // Duplicate copied rows are not genuine ambiguity; distinct slots or venues remain separate.
  const matches = [...new Map(filteredMatches.map((item) => [
    `${String(item.offering.type || "").toUpperCase()}|${parseSlots(item.offering.slot).join("+")}|${normalizedFacultyName(item.offering.faculty)}|${String(item.offering.venue || "").trim().toUpperCase()}`,
    item,
  ])).values()];

  const label = baseCourse.title || baseCourse.code;
  if (matches.length === 0) {
    return warn(selectedKind === "theory" ? "Lab not detected. Adding only theory component." : "Theory not detected. Adding only lab component.");
  }
  if (matches.length > 1) {
    return warn(`Multiple matching ${oppositeKind} offerings found for ${selectedOffering.faculty}. Only the selected component was added; choose the corresponding ${oppositeKind} manually.`);
  }
  const counterpart = matches[0].offering;
  const counterpartSlots = [...new Set(parseSlots(counterpart.slot))];
  const counterpartVenue = counterpart.venue || baseCourse.venue;
  if (intervalClashes(baseCourse.slots, [{ ...baseCourse, slots: counterpartSlots }]).length) {
    return warn(selectedKind === "theory"
      ? `Lab slot clash detected. The corresponding lab for ${label} with ${baseCourse.faculty} overlaps the selected theory component. Only the theory component was added.`
      : `Theory slot clash detected. The corresponding theory for ${label} with ${baseCourse.faculty} overlaps the selected lab component. Only the lab component was added.`);
  }
  const counterpartClashes = intervalClashes(counterpartSlots, existingCourses);
  if (counterpartClashes.length) {
    const conflicting = counterpartClashes[0];
    return warn(selectedKind === "theory"
      ? `Lab slot clash detected. The corresponding lab for ${label} with ${baseCourse.faculty} conflicts with ${conflicting}. Only the theory component was added.`
      : `Theory slot clash detected. The corresponding theory for ${label} with ${baseCourse.faculty} conflicts with ${conflicting}. Only the lab component was added.`);
  }
  const slotVenues = { ...(baseCourse.slotVenues || {}) };
  for (const slot of counterpartSlots) slotVenues[slot] = counterpartVenue;
  return {
    pairedCourse: { ...baseCourse, slots: [...new Set([...baseCourse.slots, ...counterpartSlots])], slotVenues },
    selectedKind,
    counterpartKind: oppositeKind,
    counterpartOffering: counterpart,
    counterpartSlots,
    feedback: `Automatically added the matching ${oppositeKind} for ${baseCourse.faculty}.`,
    feedbackType: "success",
  };
}

function componentCreditValue(componentCredits, kind) {
  const raw = componentCredits?.[kind === "lab" ? "ela" : "eth"];
  return String(raw ?? "").trim() === "" ? 0 : Number(raw);
}

/** Build one independent ETH/ELA course row with its own slots, faculty, venue and credits. */
export function buildComponentCourseRow({ baseCourse, offering, kind, slots, componentCredits = {} }) {
  const normalizedKind = kind === "lab" ? "lab" : "theory";
  const type = normalizedKind === "lab" ? "ELA" : "ETH";
  const rowSlots = [...new Set(Array.isArray(slots) ? slots : (baseCourse?.slots || []))];
  const faculty = String(offering?.faculty || baseCourse?.faculty || "").trim().replace(/\s+/g, " ");
  const venue = String(offering?.venue || baseCourse?.venue || "").trim();
  const slotVenues = Object.fromEntries(rowSlots.map((slot) => [slot, venue]));
  const slotFaculties = Object.fromEntries(rowSlots.map((slot) => [slot, faculty]));
  return {
    ...baseCourse,
    id: undefined,
    type,
    componentType: type,
    credits: componentCreditValue(componentCredits, normalizedKind),
    slots: rowSlots,
    faculty,
    venue,
    slotVenues,
    slotFaculties,
    selectedOfferings: [{
      type,
      faculty,
      venue,
      slotDetail: rowSlots.join("+"),
      slots: rowSlots,
    }],
  };
}

/** Split a successfully paired selection into two independent timetable rows. */
export function buildPairedComponentRows({ baseCourse, selectedOffering, counterpartOffering, counterpartSlots, componentCredits = {} }) {
  const selectedKind = offeringKind(selectedOffering);
  const counterpartKind = selectedKind === "theory" ? "lab" : selectedKind === "lab" ? "theory" : null;
  if (!selectedKind || !counterpartKind || !counterpartOffering || !Array.isArray(counterpartSlots)) return [];

  const selected = buildComponentCourseRow({
    baseCourse,
    offering: selectedOffering,
    kind: selectedKind,
    slots: baseCourse?.slots || [],
    componentCredits,
  });
  const selectedFacultyDisplay = String(selectedOffering?.faculty || baseCourse?.faculty || "").trim().replace(/\s+/g, " ");
  const counterpart = buildComponentCourseRow({
    baseCourse,
    offering: { ...counterpartOffering, faculty: selectedFacultyDisplay || counterpartOffering?.faculty },
    kind: counterpartKind,
    slots: counterpartSlots,
    componentCredits,
  });
  return [selected, counterpart].sort((a, b) => (a.componentType === "ETH" ? 0 : 1) - (b.componentType === "ETH" ? 0 : 1));
}
