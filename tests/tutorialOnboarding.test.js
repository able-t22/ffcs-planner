import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

test("tutorial hub includes the Add Together video", () => {
  assert.match(appSource, /https:\/\/youtu\.be\/qQgwxxN7eos/);
  assert.match(appSource, /title="Add Together: theory \+ lab"/);
});

test("tutorial hub includes the recommendation video", () => {
  assert.match(appSource, /https:\/\/youtu\.be\/OQwfCLtp-Rc/);
  assert.match(appSource, /title="Recommended timetables"/);
});

test("the existing VTOP import tutorial remains part of the full onboarding", () => {
  assert.match(appSource, /TUTORIAL_YOUTUBE_EMBED_URL/);
  assert.match(appSource, /title="Import faculty list from VTOP"/);
});

test("returning Google accounts see the two-feature welcome; new accounts see all three", () => {
  assert.match(appSource, /setTutorialMode\(record\.exists\(\) \? "updates" : "all"\)/);
  assert.match(appSource, /FEATURE_WELCOME_VERSION/);
  assert.match(appSource, /tutorial-feature-grid-updates/);
});

test("the Tutorial button can always reopen the full three-video hub", () => {
  assert.match(appSource, /const openTutorial = useCallback\(\(\) => \{\s*setTutorialMode\("all"\);\s*setTutorialOpen\(true\);/);
});
