import { ALL, parseSlots } from "./slots.js";

export const normalizeFacultyIdentity = (value) => String(value || "")
  .normalize("NFKC")
  .trim()
  .replace(/\s+/g, " ")
  .toLocaleLowerCase();

/**
 * Toggle one exact faculty-period offering in a subject's preference list.
 * Morning and afternoon options for the same person are alternatives: choosing
 * one replaces that faculty's other period variant, retaining its priority.
 * The five-option cap therefore still counts distinct people, not rows.
 */
export function toggleRecommendationVariantPreference(currentPreferences, variant, maxDistinctFaculties = 5) {
  const current = Array.isArray(currentPreferences) ? currentPreferences : [];
  const variantId = String(variant?.variantId || "").trim();
  const faculty = String(variant?.faculty || "").trim().replace(/\s+/g, " ");
  const facultyKey = normalizeFacultyIdentity(variant?.facultyKey || variant?.key || faculty);
  if (!variantId || !facultyKey || !faculty) {
    return { preferences: current, changed: false, limitReached: false };
  }

  const selected = current.find((item) => String(item?.variantId || item?.key || "") === variantId
    || (Array.isArray(item?.variantIds) && item.variantIds.map(String).includes(variantId)));
  if (selected) {
    const next = current.filter((item) => item !== selected)
      .sort((a, b) => Number(a.rank) - Number(b.rank) || String(a.faculty || "").localeCompare(String(b.faculty || "")))
      .map((item, index) => ({ ...item, rank: index + 1 }));
    return { preferences: next, changed: true, limitReached: false, action: "removed" };
  }

  const currentForFaculty = current.find((item) => normalizeFacultyIdentity(item?.facultyKey || item?.faculty || item?.name) === facultyKey);
  if (!currentForFaculty && current.length >= maxDistinctFaculties) {
    return { preferences: current, changed: false, limitReached: true };
  }

  const rank = currentForFaculty ? Number(currentForFaculty.rank) : current.length + 1;
  const withoutThisFaculty = current.filter((item) => normalizeFacultyIdentity(item?.facultyKey || item?.faculty || item?.name) !== facultyKey);
  const next = [...withoutThisFaculty, {
    key: variantId,
    variantId,
    variantIds: [variantId],
    faculty,
    facultyKey,
    rank: Number.isInteger(rank) && rank >= 1 ? rank : withoutThisFaculty.length + 1,
  }].sort((a, b) => Number(a.rank) - Number(b.rank) || String(a.faculty || "").localeCompare(String(b.faculty || "")));
  return {
    preferences: next,
    changed: true,
    limitReached: false,
    action: currentForFaculty ? "replaced-period" : "added",
  };
}

function componentGroup(typeValue) {
  const type = String(typeValue || "").trim().toUpperCase();
  if (["ETH", "TH", "THEORY"].includes(type) || type.includes("THEORY")) return "THEORY";
  if (["ELA", "LA", "LAB"].includes(type) || type.includes("LAB")) return "LAB";
  return type ? `OTHER:${type}` : "";
}

function validSlots(offering) {
  return [...new Set(parseSlots(String(offering?.slot || "")).filter((slot) => ALL.has(slot)))];
}

/**
 * Determine the requested theory session from the actual slot tokens.
 * Every token must end with the same supported suffix: 1 or 2. Combined
 * strings such as E1+TE1 and G2+TG2 are parsed token by token.
 */
export function theorySessionSuffix(slotDetail) {
  const tokens = parseSlots(String(slotDetail || ""));
  if (!tokens.length) return null;
  if (tokens.every((token) => /1$/.test(token))) return "1";
  if (tokens.every((token) => /2$/.test(token))) return "2";
  return null;
}

/**
 * Filter lab tokens to the range required by a theory session.
 * Theory ending in 1 maps only to L numbers > 30; ending in 2 maps to L1-L30.
 */
export function labSlotsForTheorySession(slotDetail, theorySuffix) {
  if (theorySuffix !== "1" && theorySuffix !== "2") return [];
  return [...new Set(parseSlots(String(slotDetail || "")).filter((slot) => {
    if (!ALL.has(slot)) return false;
    const match = slot.match(/^L(\d+)$/i);
    if (!match) return false;
    const number = Number(match[1]);
    return theorySuffix === "1" ? number > 30 : number >= 1 && number <= 30;
  }))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function labSessionSuffixForSlot(slot) {
  const match = String(slot || "").match(/^L(\d+)$/i);
  if (!match) return null;
  const number = Number(match[1]);
  if (number > 30) return "1";
  if (number >= 1 && number <= 30) return "2";
  return null;
}

function normalizedOffering(offering, group, slots, sessionSuffix, sourceIndex) {
  const faculty = String(offering?.faculty || "").trim().replace(/\s+/g, " ");
  const facultyKey = normalizeFacultyIdentity(faculty);
  const venue = String(offering?.venue || "").trim();
  const type = String(offering?.type || "").trim().toUpperCase();
  const originalSlot = String(offering?.slot || "").trim();
  const slotDetail = group === "LAB" && slots.join("+") !== parseSlots(originalSlot).join("+")
    ? slots.join("+")
    : originalSlot;
  const signature = `${group}|${facultyKey}|${sessionSuffix || "-"}|${slots.slice().sort().join("+")}|${venue.toLocaleUpperCase()}`;
  return {
    group,
    type,
    faculty,
    facultyKey,
    venue,
    slotDetail,
    slots,
    sessionSuffix,
    signature,
    sourceIndex,
  };
}

function variantIdentity(parts) {
  return parts.map((part) => encodeURIComponent(String(part ?? ""))).join("::");
}

function labelForSuffix(suffix) {
  if (suffix === "1") return "Morning theory · slot ends in 1 · lab L31+";
  if (suffix === "2") return "Afternoon theory · slot ends in 2 · lab L1–L30";
  return "Course offering";
}

/**
 * Return one selectable recommendation option per real offering pairing.
 * If a subject has both theory and lab components, only same-subject offerings
 * represented in this subject and taught by the same faculty are paired. No
 * cross-faculty combinations are emitted. One option corresponds to a specific
 * theory session (suffix 1 or 2) plus a matching lab offering/range.
 */
export function buildRecommendationVariants(subject) {
  const offerings = (Array.isArray(subject?.offerings) ? subject.offerings : [])
    .map((offering, sourceIndex) => ({ offering, sourceIndex, group: componentGroup(offering?.type), slots: validSlots(offering) }))
    .filter((item) => item.group && item.slots.length && item.slots.every((slot) => ALL.has(slot)) && normalizeFacultyIdentity(item.offering?.faculty));
  const theoryItems = offerings.filter((item) => item.group === "THEORY");
  const labItems = offerings.filter((item) => item.group === "LAB");
  const otherItems = offerings.filter((item) => item.group.startsWith("OTHER:"));
  const variants = [];
  const seen = new Set();
  const add = (variant) => {
    if (!seen.has(variant.variantId)) {
      seen.add(variant.variantId);
      variants.push(variant);
    }
  };

  if (theoryItems.length && labItems.length) {
    for (const theoryItem of theoryItems) {
      const theorySuffix = theorySessionSuffix(theoryItem.offering?.slot);
      if (!theorySuffix) continue;
      const theoryOffering = normalizedOffering(
        theoryItem.offering,
        "THEORY",
        theoryItem.slots,
        theorySuffix,
        theoryItem.sourceIndex,
      );
      const theoryKey = theoryOffering.facultyKey;
      for (const labItem of labItems) {
        const labFacultyKey = normalizeFacultyIdentity(labItem.offering?.faculty);
        if (!labFacultyKey || labFacultyKey !== theoryKey) continue;
        const mappedLabSlots = labSlotsForTheorySession(labItem.offering?.slot, theorySuffix);
        if (!mappedLabSlots.length) continue;
        const labOffering = normalizedOffering(
          labItem.offering,
          "LAB",
          mappedLabSlots,
          theorySuffix,
          labItem.sourceIndex,
        );
        const variantId = variantIdentity([
          "paired",
          theoryKey,
          theorySuffix,
          theoryOffering.signature,
          labOffering.signature,
        ]);
        add({
          variantId,
          key: theoryKey,
          faculty: theoryOffering.faculty,
          sessionSuffix: theorySuffix,
          phaseLabel: labelForSuffix(theorySuffix),
          paired: true,
          offerings: [theoryOffering, labOffering],
        });
      }
    }
  } else if (theoryItems.length) {
    for (const theoryItem of theoryItems) {
      const suffix = theorySessionSuffix(theoryItem.offering?.slot);
      const theoryOffering = normalizedOffering(theoryItem.offering, "THEORY", theoryItem.slots, suffix, theoryItem.sourceIndex);
      const variantId = variantIdentity(["single-theory", theoryOffering.facultyKey, theoryOffering.signature]);
      add({
        variantId,
        key: theoryOffering.facultyKey,
        faculty: theoryOffering.faculty,
        sessionSuffix: suffix,
        phaseLabel: labelForSuffix(suffix),
        paired: false,
        offerings: [theoryOffering],
      });
    }
  } else if (labItems.length) {
    for (const labItem of labItems) {
      const labGroups = new Map();
      for (const slot of labItem.slots) {
        const suffix = labSessionSuffixForSlot(slot);
        if (!suffix) continue;
        if (!labGroups.has(suffix)) labGroups.set(suffix, []);
        labGroups.get(suffix).push(slot);
      }
      for (const [suffix, slots] of labGroups) {
        const labOffering = normalizedOffering(labItem.offering, "LAB", slots, suffix, labItem.sourceIndex);
        const variantId = variantIdentity(["single-lab", labOffering.facultyKey, suffix, labOffering.signature]);
        add({
          variantId,
          key: labOffering.facultyKey,
          faculty: labOffering.faculty,
          sessionSuffix: suffix,
          phaseLabel: suffix === "1" ? "Lab L31+" : "Lab L1–L30",
          paired: false,
          offerings: [labOffering],
        });
      }
    }
  } else {
    for (const item of otherItems) {
      const offering = normalizedOffering(item.offering, item.group, item.slots, null, item.sourceIndex);
      const variantId = variantIdentity(["single-other", offering.facultyKey, offering.signature]);
      add({
        variantId,
        key: offering.facultyKey,
        faculty: offering.faculty,
        sessionSuffix: null,
        phaseLabel: "Course offering",
        paired: false,
        offerings: [offering],
      });
    }
  }

  return variants.sort((a, b) => a.faculty.localeCompare(b.faculty)
    || String(a.sessionSuffix || "").localeCompare(String(b.sessionSuffix || ""))
    || a.offerings.map((item) => item.slotDetail).join("|").localeCompare(b.offerings.map((item) => item.slotDetail).join("|"))
    || a.offerings.map((item) => item.venue).join("|").localeCompare(b.offerings.map((item) => item.venue).join("|")));
}


/**
 * Filter period-specific faculty variants by faculty name, theory/lab slot,
 * course type, phase label, or venue. Matching is case-insensitive and supports
 * multiple terms (for example, "arul A2" or "L45 PRP356"). This only filters
 * visible options; it must not alter saved faculty preferences.
 */
export function filterRecommendationVariants(variants, query) {
  const terms = normalizeFacultyIdentity(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return Array.isArray(variants) ? variants : [];
  return (Array.isArray(variants) ? variants : []).filter((variant) => {
    const offeringText = (variant?.offerings || []).flatMap((offering) => [
      offering?.type, offering?.group, offering?.slotDetail, ...(offering?.slots || []), offering?.venue,
    ]);
    const searchable = normalizeFacultyIdentity([
      variant?.faculty, variant?.phaseLabel, variant?.sessionSuffix, ...offeringText,
    ].filter(Boolean).join(" "));
    return terms.every((term) => searchable.includes(term));
  });
}
