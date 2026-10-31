# FFCS Planner Tutorials and One-Time Welcome

The Tutorial button in the app header opens a three-part guide:

1. **Import faculty list from VTOP** — continues to use the existing `VITE_TUTORIAL_YOUTUBE_URL` environment variable, with the previous YouTube URL as its fallback. If that video needs to change later, update the environment variable in local development and Vercel.
2. **Add Together: theory + lab** — https://youtu.be/qQgwxxN7eos
3. **Recommended timetables** — https://youtu.be/OQwfCLtp-Rc

Each item has its own embedded player and a link to open the video directly on YouTube. Opening Tutorial manually always displays all three guides.

## One-time welcome behavior

- A returning Google account that already has a Firestore planner document, but not the current `featureWelcomeVersion`, sees a welcome panel for the two newer workflows: Add Together and Recommended Timetables.
- A Google account without a Firestore planner document sees the full three-guide introduction.
- Once the current welcome is presented, its version is saved to that account's Firestore document, and dismissal saves it again. This prevents the same welcome from repeatedly appearing on later logins or browsers.
- Local-only planner users use a versioned local-storage marker to avoid repeating the same welcome in the same browser.

The current version marker is `2026-10-three-tutorials-v1`. Increment this value if a future release should show another one-time feature welcome.
