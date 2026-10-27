# FFCS Planner — VIT Vellore

A React + Vite FFCS timetable planner with course/faculty catalogue selection, slot clash checks, credit totals, custom class-time rules, print-friendly timetable output, and optional Google sign-in with cloud sync.

## Run locally

Install a current Node.js LTS release, then run:

```bash
npm install
npm run dev
```

Guest mode works without Firebase configuration and stores progress in the current browser. To sign in with Google and sync timetables across devices, complete the one-time Firebase setup below.

## Firebase + Google sign-in setup (no custom backend)

The app uses **Firebase Authentication** for Google sign-in and **Cloud Firestore** to save each user's planner. It talks to Firebase directly from the browser, so you do not need to build or deploy a separate API server. You must create a Firebase project and configure its security rules once.

### 1. Create a Firebase project and web app

1. Open the [Firebase Console](https://console.firebase.google.com/) and create a project (or choose an existing one).
2. Open **Project settings → General → Your apps** and add a **Web app** (`</>`).
3. Copy the web app configuration values into `.env.local` using the template below. You can copy `.env.example` to `.env.local` first.

```env
VITE_FIREBASE_API_KEY=your-firebase-web-api-key
VITE_FIREBASE_AUTH_DOMAIN=your-project-id.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project-id.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=your-messaging-sender-id
VITE_FIREBASE_APP_ID=your-firebase-web-app-id
```

Use the exact values shown for your Firebase web app. The storage bucket value is included in the config template but this planner does not use Firebase Storage.

### 2. Enable Google sign-in

1. In the Firebase Console, open **Authentication → Sign-in method** (or **Sign-in providers**).
2. Enable **Google**, choose a project support email, and save.
3. In **Authentication → Settings → Authorized domains**, make sure `localhost` and your deployed Vercel domain are listed. Add your `YOUR-PROJECT.vercel.app` domain if it is not already present.

The app opens Google's account chooser. Firebase maintains the login session across reloads; users do not need to enter a magic-link email each time.

### 3. Create Firestore and apply security rules

1. Open **Firestore Database → Create database** and create the database.
2. Open the **Rules** tab and replace its contents with the rules from the included `firestore.rules` file, then publish.

The rules allow each signed-in Google user to read and write only `users/{their-own-uid}`. Do not replace them with public rules such as `allow read, write: if true`.

### 4. Test locally

Restart the dev server after changing `.env.local`:

```bash
npm run dev
```

Click **Continue with Google**, pick your account, and create a timetable. The cloud indicator should change to **All changes saved** shortly after edits. Sign out and sign in again to check that the timetable returns.

### 5. Configure Vercel

In **Vercel → Project → Settings → Environment Variables**, add all six `VITE_FIREBASE_*` values from `.env.local` for the environments you use. Then redeploy, because Vite injects these values during the build.

In Firebase Authentication's Authorized domains, add the exact production domain and any custom domain. No Firebase Admin SDK key, service-account JSON, or custom backend server should be placed in Vercel frontend variables.

### Data and privacy notes

- Google sign-in authenticates the user; Firestore stores their profile, timetable list, courses, and preferences in a document under their Firebase UID.
- Autosave runs shortly after changes. On first Google sign-in, existing browser-local progress is imported if that account has no Firestore document yet.
- Guest/local mode still works without Firebase config, but its data stays in that browser and does not sync between devices.
- Firebase web config values are used in the browser. Protect user data with the Firestore security rules; never rely on hiding the client config as access control.
- If sign-in says the domain is unauthorized, add it under Firebase Authentication → Settings → Authorized domains. If data fails to load or save, check Firestore was created and `firestore.rules` was published.

## Deploy to Vercel

1. Push this project folder to a GitHub repository.
2. In Vercel choose **Add New → Project** and import the repository.
3. Build command: `npm run build`; output directory: `dist`.
4. Add the Firebase environment variables, then deploy.

## Subject and faculty catalogue

The course builder includes a subject selector populated from `BACSE204-SOFTWARE ENGINEERING.txt`. Choose a subject, then choose an available faculty/class option. The selected offering fills the course code, title, faculty, venue, and slot. Credits remain a manual entry because the source document does not specify them.

## Notes

- Course slot validation is based on the slot chart in `src/slots.js`.
- Use **Export / Print** to print the weekly timetable.
- The timetable grid is sized to fit common laptop widths without horizontal scrolling; narrow mobile screens use a horizontally scrollable grid for legibility.


### Personal subject faculty imports

Inside a timetable, enter a subject name and paste the copied faculty table (Markdown-style pipe table with Slot Detail, Venue, Faculty and Course Type columns). Choose **Parse and save subject**. Valid slot rows become offerings in the subject dropdown. With Google sign-in enabled, custom subjects are stored in that account's private `users/{uid}` Firestore document alongside its timetables; the existing Firestore rules allow each signed-in user to access only their own document. Without Google sign-in, imports are stored only in the current browser's local storage.
