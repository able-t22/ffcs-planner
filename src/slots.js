// VIT Vellore FFCS slot chart. "|" marks the lunch column, "-" an empty cell.
const T = {
  MON: "A1 F1 D1 TB1 TG1 - | A2 F2 D2 TB2 TG2 - V3",
  TUE: "B1 G1 E1 TC1 TAA1 - | B2 G2 E2 TC2 TAA2 - V4",
  WED: "C1 A1 F1 V1 V2 - | C2 A2 F2 TD2 TBB2 - V5",
  THU: "D1 B1 G1 TE1 TCC1 - | D2 B2 G2 TE2 TCC2 - V6",
  FRI: "E1 C1 TA1 TF1 TD1 - | E2 C2 TA2 TF2 TDD2 - V7",
};
const L = {
  MON: "L1 L2 L3 L4 L5 L6 | L31 L32 L33 L34 L35 L36 -",
  TUE: "L7 L8 L9 L10 L11 L12 | L37 L38 L39 L40 L41 L42 -",
  WED: "L13 L14 L15 L16 L17 L18 | L43 L44 L45 L46 L47 L48 -",
  THU: "L19 L20 L21 L22 L23 L24 | L49 L50 L51 L52 L53 L54 -",
  FRI: "L25 L26 L27 L28 L29 L30 | L55 L56 L57 L58 L59 L60 -",
};
export const DAYS = Object.keys(T);
export const TH = Object.fromEntries(DAYS.map((d) => [d, T[d].split(" ")]));
export const LB = Object.fromEntries(DAYS.map((d) => [d, L[d].split(" ")]));
export const TM = ["8:00 AM","9:00 AM","10:00 AM","11:00 AM","12:00 PM","1:00 PM","LUNCH","2:00 PM","3:00 PM","4:00 PM","5:00 PM","6:00 PM","6:30 PM","7:00 PM"];
// Official VIT FFCS slot timings. Each array aligns with TM's column indices.
// Theory and laboratory slots run on different start/end times, so they are
// displayed as separate rows above the weekly timetable.
export const THEORY_START = ["08:00", "09:00", "10:00", "11:00", "12:00", "-", "Lunch", "14:00", "15:00", "16:00", "17:00", "18:00", "18:51", "19:01"];
export const THEORY_END = ["08:50", "09:50", "10:50", "11:50", "12:50", "-", "Lunch", "14:50", "15:50", "16:50", "17:50", "18:50", "19:00", "19:50"];
export const LAB_START = ["08:00", "08:51", "09:51", "10:41", "11:40", "12:31", "Lunch", "14:00", "14:51", "15:51", "16:41", "17:40", "18:31", "-"];
export const LAB_END = ["08:50", "09:40", "10:40", "11:30", "12:30", "13:20", "Lunch", "14:50", "15:40", "16:40", "17:30", "18:30", "19:20", "-"];
export const COL = ["#9CEBDC","#FFB5C3","#D8C9FF","#FFE88E","#DDF6EF","#FFDCCB","#E9DFFF","#FFF0B7","#CDEAFF","#FFCFE0"];
export const ALL = new Set(
  DAYS.flatMap((d) => [...TH[d], ...LB[d]]).filter((s) => s !== "-" && s !== "|")
);
export const parseSlots = (s) => s.toUpperCase().split(/[+,\s]+/).filter(Boolean);
export const cellsOf = (c) =>
  new Set(DAYS.flatMap((d) => TH[d].map((t, i) => (c.slots.some((s) => s === t || s === LB[d][i]) ? d + i : null)).filter(Boolean)));
export const owner = (courses, d, i) =>
  courses.find((c) => c.slots.some((s) => s === TH[d][i] || s === LB[d][i]));

// Rule helpers: 8 AM column = 0; "night" = columns ending after 7 PM (6:30 PM lab, 7:00 PM).
export const ruleCols = (r = {}) => [...(r.no8 ? [0] : []), ...(r.noNight ? [12, 13] : [])];
export const slotAt = (c, d, i) => c.slots.filter((s) => s === TH[d][i] || s === LB[d][i]);
export const cellList = (c) =>
  DAYS.flatMap((d) => TH[d].map((_, i) => (slotAt(c, d, i).length ? [d, i] : null)).filter(Boolean));
export const ruleHits = (c, r) => {
  const cols = ruleCols(r);
  return [...new Set(cellList(c).filter(([, i]) => cols.includes(i)).map(([d, i]) => `${d} ${TM[i]}`))];
};
export const clashes = (c, others) => {
  const out = [];
  for (const o of others)
    for (const [d, i] of cellList(c)) {
      const b = slotAt(o, d, i);
      if (b.length) out.push(`${slotAt(c, d, i).join("/")} overlaps ${b.join("/")} of ${o.code || o.title}${o.faculty ? " (" + o.faculty + ")" : ""} on ${d} ${TM[i]}`);
    }
  return [...new Set(out)];
};
