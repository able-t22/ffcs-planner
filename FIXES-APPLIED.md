# FFCS Planner — Faculty Period Priority and Add Together Credit Fix

## Changes

1. **Morning/afternoon choices are independent selections.** Each recommendation row is keyed by its exact faculty-period variant. A faculty member can contribute only one selected variant per subject at a time. Selecting the same faculty's other period replaces the previous period and retains that faculty's rank; the unselected period no longer displays a shared priority.
2. **Five-faculty limit is retained.** The limit counts distinct faculty members, not the number of visible period variants.
3. **Separate credits while Add Together is enabled.** The regular single Credits input is replaced by two rows: ETH (theory) credits and ELA (lab) credits. Either can be left blank; blank component credit is stored as zero.
4. **Paired courses are stored as separate rows.** A successful Add Together pair creates independent ETH and ELA timetable entries, with their own slots, venue, faculty metadata, and credits. The subject code remains the same so the overall subject count stays unique.
5. **Slot and faculty pairing rules remain enforced.** Pairing still requires the same subject and faculty, the right course type, the slot suffix/range mapping, and no clashes.

## Validation performed

- Automated unit tests: **28 passed, 0 failed**.
- JSX syntax parsing/transpilation for `src/App.jsx`: passed using the available TypeScript parser.
- JavaScript syntax checks for helper modules and test modules: passed.
- Full Vite production build: **not verified**. `npm ci` timed out in this execution environment, and `npm run build` reported `vite: not found` because the install did not complete.
- Browser-level and live Firebase tests: not performed.

The existing `firestore.rules`, environment example, package files and unrelated project files were left unchanged.

## Theme restoration

Restored the original neo-brutalist colour theme and styling from the pre-theme-change ZIP. Tutorial and onboarding features remain in place.
