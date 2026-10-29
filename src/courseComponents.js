import { offeringKind } from "./addTogether.js";

export function componentCreditValue(creditsByType, offering) {
  const kind = offeringKind(offering);
  const key = kind === "lab" ? "ELA" : "ETH";
  const raw = creditsByType?.[key] ?? "";
  return String(raw).trim() === "" ? 0 : Number(raw);
}

function buildComponentEntry(baseCourse, offering, slots, credit, idFactory) {
  const normalizedSlots = [...new Set(slots || [])];
  const faculty = String(offering?.faculty || baseCourse.faculty || "").trim();
  const venue = String(offering?.venue || "").trim();
  const type = String(offering?.type || baseCourse.componentType || "").trim().toUpperCase();
  return {
    ...baseCourse,
    id: idFactory(),
    componentType: type,
    credits: credit,
    faculty,
    venue,
    slots: normalizedSlots,
    slotVenues: Object.fromEntries(normalizedSlots.map((slot) => [slot, venue])),
    slotFaculties: Object.fromEntries(normalizedSlots.map((slot) => [slot, faculty])),
  };
}

/** Split a validated Add Together pairing into two independent, editable rows. */
export function splitPairedCourseEntries({
  baseCourse,
  selectedOffering,
  counterpartOffering,
  selectedSlots,
  counterpartSlots,
  creditsByType = {},
  idFactory = () => `${Date.now()}-${Math.random()}`,
}) {
  const selectedEntry = buildComponentEntry(
    baseCourse,
    selectedOffering,
    selectedSlots,
    componentCreditValue(creditsByType, selectedOffering),
    idFactory,
  );
  const counterpartEntry = buildComponentEntry(
    baseCourse,
    counterpartOffering,
    counterpartSlots,
    componentCreditValue(creditsByType, counterpartOffering),
    idFactory,
  );
  // Always show ETH/theory before ELA/lab, even when the user selected the lab first.
  return [selectedEntry, counterpartEntry].sort((a, b) => {
    const aLab = offeringKind({ type: a.componentType }) === "lab";
    const bLab = offeringKind({ type: b.componentType }) === "lab";
    return Number(aLab) - Number(bLab);
  });
}

/** Convert one recommendation's paired offerings into separate timetable rows. */
export function recommendationComponentEntries(course, creditsByType, color) {
  return (course?.selectedOfferings || []).map((offering) => {
    const slots = [...new Set(offering.slots || [])];
    return {
      code: course.subjectCode,
      title: course.subjectTitle,
      credits: componentCreditValue(creditsByType, offering),
      slots,
      faculty: offering.faculty,
      venue: offering.venue,
      slotVenues: Object.fromEntries(slots.map((slot) => [slot, offering.venue || ""])),
      slotFaculties: Object.fromEntries(slots.map((slot) => [slot, offering.faculty || ""])),
      componentType: offering.type,
      color,
    };
  });
}
