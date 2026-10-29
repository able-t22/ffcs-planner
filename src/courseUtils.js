// Count distinct subjects rather than individual timetable component rows.
// Theory and lab components for the same subject often share a canonical course code.
const normalizeIdentity = (value) => String(value ?? "")
  .normalize("NFKC")
  .trim()
  .replace(/\s+/g, " ")
  .toLocaleUpperCase();

export function subjectIdentity(course) {
  const canonicalCode = normalizeIdentity(course?.subjectCode || course?.code);
  if (canonicalCode) return `code:${canonicalCode}`;

  const title = normalizeIdentity(course?.title || course?.name);
  if (title) return `title:${title}`;

  // If the row has no subject-identifying information, do not accidentally merge it
  // with another unknown row.
  return course?.id != null ? `row:${String(course.id)}` : null;
}

export function countUniqueSubjects(courses = []) {
  const identities = new Set();
  let anonymousIndex = 0;
  for (const course of courses || []) {
    const identity = subjectIdentity(course);
    identities.add(identity || `anonymous:${anonymousIndex++}`);
  }
  return identities.size;
}
