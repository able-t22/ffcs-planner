# FFCS Planner

Live site: https://ffcs-planner-timetable.vercel.app/

## Features

- Searchable subject and faculty/class selection, custom offering import, timetable clash checks, credits, and separate theory/lab timetable rows with official slot timings.
- Optional **Add Together** control that attempts to pair theory and lab offerings using the project slot rules, matching subject and faculty, while reporting missing or clashing counterparts.
- **Recommended Timetables** workflow: select subjects, rank up to five distinct faculty members per subject, search for up to three highest-scoring clash-free combinations, preview a weekly schedule, and save a chosen result as a new editable timetable.
- Recommended timetable search uses optimized backtracking, early clash filtering, minimum-remaining-values ordering, forward checking, branch-and-bound scoring, duplicate suppression, and an explicit search budget. A search-limit message does not claim that no solution exists.
- Existing Google/Firebase persistence, local mode, account isolation, and collaboration room behavior are preserved.

## Run locally

```bash
npm install
npm run dev
```

## Validate

```bash
npm test
npm run build
```

The built-in Node test suite checks faculty score deduplication across theory/lab, top-three ranking, slot conflict handling, no-solution versus search-limit handling, timetable preference rules, the bundled course catalogue, and an eight-subject/five-faculty search fixture.

Credits are not included in the course/faculty offering catalogue, so the recommendation workflow asks for each selected subject's credits before saving the generated schedule.

## Theme

The original FFCS neo-brutalist theme is restored. The three tutorial videos and one-time welcome pop-ups remain available.
