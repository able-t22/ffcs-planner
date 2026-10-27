import { Fragment, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { DAYS, TH, LB, TM, THEORY_START, THEORY_END, LAB_START, LAB_END, COL, ALL, parseSlots, ruleCols, ruleHits, clashes } from "./slots";
import courseCatalog from "./courseCatalog.json";
import { onAuthStateChanged, GoogleAuthProvider, signInAnonymously, signInWithPopup, signOut as firebaseSignOut } from "firebase/auth";
import { arrayUnion, collection, deleteDoc, doc, getDoc, onSnapshot, runTransaction, serverTimestamp, setDoc, updateDoc, writeBatch } from "firebase/firestore";
import { auth, db, FIREBASE_CONFIGURED } from "./firebase";

const KEY = "ffcs-v1";
const COLLAB_KEY = "ffcs-collab-room-v1";
const TUTORIAL_GUEST_SEEN_KEY = "ffcs-tutorial-seen-local-v1";
const TUTORIAL_YOUTUBE_URL = (import.meta.env.VITE_TUTORIAL_YOUTUBE_URL || "https://youtu.be/0gD5SaLifac").trim();

function getYouTubeEmbedUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    let videoId = "";
    if (hostname === "youtu.be") {
      videoId = parsed.pathname.split("/").filter(Boolean)[0] || "";
    } else if (["youtube.com", "m.youtube.com", "youtube-nocookie.com"].includes(hostname)) {
      if (parsed.pathname === "/watch") videoId = parsed.searchParams.get("v") || "";
      else {
        const match = parsed.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]+)/);
        videoId = match?.[1] || "";
      }
    }
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return "";
    return `https://www.youtube-nocookie.com/embed/${videoId}?rel=0&playsinline=1&modestbranding=1`;
  } catch {
    // Do not embed arbitrary URLs or HTML supplied through environment config.
    return "";
  }
}

const TUTORIAL_YOUTUBE_EMBED_URL = getYouTubeEmbedUrl(TUTORIAL_YOUTUBE_URL);
const uid = () => Math.random().toString(36).slice(2, 9);
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };

function profileFromAuth(authUser) {
  return {
    n: authUser?.displayName || authUser?.email?.split("@")[0] || "Student",
    r: "",
    email: authUser?.email || "",
  };
}

function App() {
  const cached = load();
  const [session, setSession] = useState(null);
  const [authInitialized, setAuthInitialized] = useState(!FIREBASE_CONFIGURED);
  const [user, setUser] = useState(cached.user || null);
  const [tts, setTts] = useState(Array.isArray(cached.tts) ? cached.tts : []);
  const [customCatalog, setCustomCatalog] = useState(Array.isArray(cached.customCatalog) ? cached.customCatalog : []);
  const [hiddenCatalogCodes, setHiddenCatalogCodes] = useState(Array.isArray(cached.hiddenCatalogCodes) ? cached.hiddenCatalogCodes : []);
  const [cur, setCur] = useState(null);
  const [dataReady, setDataReady] = useState(!FIREBASE_CONFIGURED);
  const [cloudLoadError, setCloudLoadError] = useState("");
  const [accountDataReview, setAccountDataReview] = useState(null);
  const [accountReviewError, setAccountReviewError] = useState("");
  const [accountReviewBusy, setAccountReviewBusy] = useState(false);
  const [cloudStatus, setCloudStatus] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  // Never attach a room from browser storage before validating that it belongs to
  // the currently authenticated Firebase UID. Old builds stored one global room
  // key, which could accidentally reopen another account's shared timetable.
  const [activeCollab, setActiveCollab] = useState(null);
  const [roomRestoreChecked, setRoomRestoreChecked] = useState(false);
  const [collabOpen, setCollabOpen] = useState(() => Boolean(new URLSearchParams(window.location.search).get("room")));
  const [pendingRoomId, setPendingRoomId] = useState(() => new URLSearchParams(window.location.search).get("room") || "");
  const [collabBusy, setCollabBusy] = useState(false);
  const [collabError, setCollabError] = useState("");
  const [authRevision, setAuthRevision] = useState(0);
  const [tutorialOpen, setTutorialOpen] = useState(false);

  const openTutorial = useCallback(() => setTutorialOpen(true), []);
  const closeTutorial = useCallback(async () => {
    setTutorialOpen(false);
    const uidForTutorial = session?.uid;
    if (uidForTutorial && db) {
      // Store the dismissal on this account, not in a browser-wide flag.
      try {
        await setDoc(doc(db, "users", uidForTutorial), {
          ownerUid: uidForTutorial,
          tutorialSeen: true,
          tutorialSeenAt: serverTimestamp(),
        }, { merge: true });
      } catch (error) {
        console.warn("Could not save tutorial dismissal for this account:", error);
      }
    } else {
      try { localStorage.setItem(TUTORIAL_GUEST_SEEN_KEY, "true"); } catch { /* Tutorial still closes for this session. */ }
    }
  }, [session?.uid]);

  const handleLocalLogin = (profile) => setUser(profile);

  // Local/guest users get the introduction once per browser. Google accounts
  // use the tutorialSeen field in their own Firestore document instead.
  useEffect(() => {
    if (!authInitialized || session || !user) return;
    if (new URLSearchParams(window.location.search).has("room")) return;
    try {
      if (localStorage.getItem(TUTORIAL_GUEST_SEEN_KEY) !== "true") setTutorialOpen(true);
    } catch {
      setTutorialOpen(true);
    }
  }, [authInitialized, session?.uid, user?.email, user?.n]);

  // Firebase restores a signed-in Google account automatically on page reload.
  useEffect(() => {
    if (!FIREBASE_CONFIGURED) {
      setAuthInitialized(true);
      return undefined;
    }
    const unsubscribe = onAuthStateChanged(auth, (authUser) => {
      // Anonymous auth is used only to authorize collaboration rooms. It must not
      // switch the user's personal planner from local storage to a blank cloud profile.
      const accountUser = authUser && !authUser.isAnonymous ? authUser : null;
      setSession(accountUser);
      setAuthInitialized(true);
      setAuthRevision((revision) => revision + 1);
      setTutorialOpen(false);
      setAuthError("");
      if (accountUser) {
        setAccountDataReview(null);
        setAccountReviewError("");
        setDataReady(false);
        setCloudLoadError("");
        setCloudStatus("Loading account…");
      } else {
        setDataReady(true);
        setCloudStatus("");
      }
    }, (error) => {
      setAuthError(error.message || "Could not check your Google sign-in status.");
      setAuthInitialized(true);
      setDataReady(true);
    });
    return unsubscribe;
  }, []);

  // Load only this Google account's private document from Firestore. The legacy
  // browser cache is not a shared fallback: it may be imported only when its saved
  // email explicitly matches this account.
  useEffect(() => {
    if (!FIREBASE_CONFIGURED || !authInitialized || !session?.uid) return undefined;
    let alive = true;
    setDataReady(false);
    setCloudLoadError("");
    setCloudStatus("Loading account…");

    const loadCloudData = async () => {
      try {
        const record = await getDoc(doc(db, "users", session.uid));
        const saved = record.exists() ? record.data() : null;
        if (record.exists() && (!saved?.ownerUid || saved.ownerUid !== session.uid)) {
          // Older versions didn't mark private docs with their owning UID. Some
          // may already contain data accidentally copied from the global browser
          // cache, so require an explicit keep/reset choice before showing it.
          try { localStorage.removeItem(KEY); } catch {}
          if (alive) {
            setAccountDataReview({
              uid: session.uid,
              email: session.email || "",
              saved: saved?.ownerUid ? null : saved,
              ownershipMismatch: Boolean(saved?.ownerUid && saved.ownerUid !== session.uid),
            });
            setAccountReviewError("");
            setCloudLoadError("");
            setCloudStatus("Review saved account data");
            setDataReady(true);
          }
          return;
        }
        const browserData = load();
        const hasBrowserProgress = Boolean(browserData.user || (Array.isArray(browserData.tts) && browserData.tts.length));
        // KEY is a legacy, browser-wide cache. Never import it into a different
        // Google account merely because that account has no Firestore document.
        // A legacy cache can only be migrated when its saved email explicitly
        // matches the account being loaded.
        const cachedEmail = String(browserData.user?.email || "").trim().toLowerCase();
        const accountEmail = String(session.email || "").trim().toLowerCase();
        const mayImportLegacyCache = !record.exists() && Boolean(cachedEmail && accountEmail && cachedEmail === accountEmail);
        const selectedUser = saved?.user
          ? { ...profileFromAuth(session), ...saved.user, email: saved.user.email || session.email || "" }
          : (mayImportLegacyCache && browserData.user
            ? { ...browserData.user, email: session.email || "" }
            : profileFromAuth(session));
        const selectedTimetables = Array.isArray(saved?.tts)
          ? saved.tts
          : (mayImportLegacyCache && Array.isArray(browserData.tts) ? browserData.tts : []);
        const selectedCustomCatalog = Array.isArray(saved?.customCatalog)
          ? saved.customCatalog
          : (mayImportLegacyCache && Array.isArray(browserData.customCatalog) ? browserData.customCatalog : []);
        const selectedHiddenCatalogCodes = Array.isArray(saved?.hiddenCatalogCodes)
          ? saved.hiddenCatalogCodes
          : (mayImportLegacyCache && Array.isArray(browserData.hiddenCatalogCodes) ? browserData.hiddenCatalogCodes : []);

        // Clear the legacy browser-wide cache once it has been safely imported
        // for the same email, or quarantined from this signed-in account. This
        // prevents another account from seeing it on its next login.
        if (record.exists() || !hasBrowserProgress || !mayImportLegacyCache) {
          try { localStorage.removeItem(KEY); } catch {}
        }
        if (alive) {
          setUser(selectedUser);
          setTts(selectedTimetables);
          setCustomCatalog(selectedCustomCatalog);
          setHiddenCatalogCodes(selectedHiddenCatalogCodes);
          setDataReady(true);
          setCloudStatus("Account connected");
          // Every signed-in account is shown the tutorial once, whether it is a
          // new account or an older account that has not dismissed this tutorial.
          setTutorialOpen(saved?.tutorialSeen !== true && !new URLSearchParams(window.location.search).has("room"));
        }
      } catch (error) {
        if (alive) {
          setCloudLoadError(error.message || "Unable to load your cloud timetable. Check Firestore setup and security rules.");
          setCloudStatus("Sync needs attention");
        }
      }
    };
    loadCloudData();
    return () => { alive = false; };
  }, [authInitialized, session?.uid, loadAttempt]);

  // Keep guest progress in this browser only. Signed-in accounts use Firestore.
  useEffect(() => {
    if (!session && user) {
      try { localStorage.setItem(KEY, JSON.stringify({ user, tts, customCatalog, hiddenCatalogCodes })); } catch {}
    }
  }, [session, user, tts, customCatalog, hiddenCatalogCodes]);

  // Debounced cloud autosave; the initial read must finish before writes begin.
  useEffect(() => {
    if (!FIREBASE_CONFIGURED || !session?.uid || !dataReady || !user || accountDataReview) return undefined;
    let alive = true;
    setCloudStatus("Saving changes…");
    const timer = window.setTimeout(async () => {
      try {
        await setDoc(doc(db, "users", session.uid), {
          ownerUid: session.uid,
          user,
          tts,
          customCatalog,
          hiddenCatalogCodes,
          updatedAt: serverTimestamp(),
        }, { merge: true });
        try { localStorage.removeItem(KEY); } catch {}
        if (alive) setCloudStatus("All changes saved");
      } catch (error) {
        if (alive) setCloudStatus(error.message || "Cloud save failed. Check Firestore security rules.");
      }
    }, 650);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [session?.uid, dataReady, user, tts, customCatalog, hiddenCatalogCodes, accountDataReview]);

  // Resume a saved room only when the exact Firebase UID that joined it is still
  // active. Never restore a room merely because another account uses this browser.
  useEffect(() => {
    if (roomRestoreChecked) return undefined;
    if (!authInitialized) return undefined;
    const inviteRoom = new URLSearchParams(window.location.search).get("room");
    if (inviteRoom) {
      // A URL invite opens the join dialog; joining must still be an explicit action.
      setRoomRestoreChecked(true);
      return undefined;
    }
    let savedRoom = null;
    try { savedRoom = JSON.parse(localStorage.getItem(COLLAB_KEY) || "null"); } catch {}
    const currentUid = auth?.currentUser?.uid || "";
    if (FIREBASE_CONFIGURED && savedRoom?.id && savedRoom?.memberUid && currentUid && savedRoom.memberUid === currentUid) {
      setActiveCollab({ ...savedRoom, data: null });
    } else if (savedRoom?.id) {
      // Older builds didn't record the joining UID, so fail closed and require
      // the user to join explicitly again with the room link and code.
      try { localStorage.removeItem(COLLAB_KEY); } catch {}
    }
    setRoomRestoreChecked(true);
    return undefined;
  }, [authInitialized, authRevision, roomRestoreChecked]);

  // If the Firebase account changes while a room is open, detach the old room.
  useEffect(() => {
    if (!authInitialized || !activeCollab?.id) return;
    const currentUid = auth?.currentUser?.uid || "";
    if (!activeCollab.memberUid || !currentUid || activeCollab.memberUid !== currentUid) {
      setActiveCollab(null);
      setCollabOpen(false);
      setCollabError("");
      try { localStorage.removeItem(COLLAB_KEY); } catch {}
    }
  }, [authInitialized, authRevision, activeCollab?.id, activeCollab?.memberUid]);

  // A room snapshot is the source of truth for all collaborators. Every change is
  // broadcast through Firestore's realtime listener.
  useEffect(() => {
    if (!FIREBASE_CONFIGURED || !db || !authInitialized || !activeCollab?.id) return undefined;
    if (!auth?.currentUser) {
      setCollabError("Your collaboration session is no longer signed in. Return to the planner, then rejoin using the room link and code.");
      return undefined;
    }
    const roomId = activeCollab.id;
    const unsubscribe = onSnapshot(doc(db, "collabRooms", roomId), (snapshot) => {
      if (!snapshot.exists()) {
        setCollabError("This collaboration room no longer exists or has been closed.");
        return;
      }
      const data = snapshot.data();
      setCollabError("");
      setActiveCollab((current) => current?.id === roomId ? { ...current, data, ownerUid: data.ownerUid } : current);
    }, (error) => {
      setCollabError(error.message || "Could not sync this room. Check the Firestore collaboration rules.");
    });
    return unsubscribe;
  }, [activeCollab?.id, authInitialized, authRevision]);

  // Remember the active room locally so refreshing the page restores the code,
  // link, and live subscription instead of stranding the room owner.
  useEffect(() => {
    if (!roomRestoreChecked) return;
    try {
      if (!activeCollab?.id) {
        localStorage.removeItem(COLLAB_KEY);
      } else {
        localStorage.setItem(COLLAB_KEY, JSON.stringify({
          id: activeCollab.id,
          code: activeCollab.code,
          link: activeCollab.link,
          ownerUid: activeCollab.ownerUid,
          memberUid: activeCollab.memberUid || auth?.currentUser?.uid || "",
          sourceTimetableId: activeCollab.data?.sourceTimetableId || activeCollab.sourceTimetableId || "",
        }));
      }
    } catch { /* Room state is still available for this page session. */ }
  }, [roomRestoreChecked, activeCollab?.id, activeCollab?.code, activeCollab?.link, activeCollab?.ownerUid, activeCollab?.memberUid, activeCollab?.data?.sourceTimetableId, activeCollab?.sourceTimetableId]);

  const requireCollaborationAuth = async () => {
    if (!FIREBASE_CONFIGURED || !auth || !db) {
      throw new Error("Collaboration requires Firebase. Configure your VITE_FIREBASE_* values, publish firestore.rules, and enable Anonymous sign-in in Firebase Authentication.");
    }
    if (auth.currentUser) return auth.currentUser;
    try {
      const credential = await signInAnonymously(auth);
      return credential.user;
    } catch (error) {
      if (error.code === "auth/operation-not-allowed") {
        throw new Error("Enable Anonymous sign-in in Firebase Console → Authentication → Sign-in method to let people join without a Google account.");
      }
      throw new Error(error.message || "Could not authorize collaboration. Check Firebase Authentication settings.");
    }
  };

  const clearRoomFromAddress = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    setPendingRoomId("");
  };

  const createCollaborationRoom = async (timetable) => {
    setCollabError("");
    setCollabBusy(true);
    try {
      const collabUser = await requireCollaborationAuth();
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const randomBytes = new Uint8Array(8);
      window.crypto.getRandomValues(randomBytes);
      const code = Array.from(randomBytes, (byte) => alphabet[byte % alphabet.length]).join("");
      const roomRef = doc(collection(db, "collabRooms"));
      const inviteRef = doc(db, "collabInvites", code);
      const cleanTimetable = JSON.parse(JSON.stringify(timetable));
      const ownerName = user?.n || collabUser.displayName || "Student";
      const payload = {
        ownerUid: collabUser.uid,
        ownerName,
        participantIds: [collabUser.uid],
        participants: [collabUser.uid],
        sourceTimetableId: timetable.id,
        timetable: cleanTimetable,
      };
      const batch = writeBatch(db);
      batch.set(roomRef, { ...payload, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      batch.set(inviteRef, { roomId: roomRef.id, ownerUid: collabUser.uid, createdAt: serverTimestamp() });
      await batch.commit();
      const link = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomRef.id)}`;
      clearRoomFromAddress();
      setActiveCollab({ id: roomRef.id, code, link, ownerUid: collabUser.uid, memberUid: collabUser.uid, data: payload });
      setCollabOpen(false);
    } catch (error) {
      setCollabError(error.message || "Could not create a collaboration room.");
    } finally {
      setCollabBusy(false);
    }
  };

  const joinCollaborationRoom = async (rawCode) => {
    const code = String(rawCode || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!code) {
      setCollabError("Enter the 8-character room code shared by the timetable owner.");
      return;
    }
    setCollabError("");
    setCollabBusy(true);
    let joinStage = "authentication";
    try {
      const collabUser = await requireCollaborationAuth();
      joinStage = "invite lookup";
      const inviteSnapshot = await getDoc(doc(db, "collabInvites", code));
      if (!inviteSnapshot.exists()) throw new Error("That room code wasn't found. Check the 8-character code and try again.");
      const invite = inviteSnapshot.data();
      if (typeof invite.roomId !== "string" || typeof invite.ownerUid !== "string") {
        throw new Error("This invite is incomplete. Ask the room creator to create a new collaboration link and code.");
      }
      if (pendingRoomId && invite.roomId !== pendingRoomId) {
        throw new Error("That code belongs to a different room. Use the code provided with this link.");
      }
      const roomId = invite.roomId;
      joinStage = "room membership update";
      await updateDoc(doc(db, "collabRooms", roomId), {
        participantIds: arrayUnion(collabUser.uid),
        participants: arrayUnion(collabUser.uid),
        joinCode: code,
        updatedAt: serverTimestamp(),
      });
      const link = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
      clearRoomFromAddress();
      setActiveCollab({ id: roomId, code, link, ownerUid: invite.ownerUid, memberUid: collabUser.uid, data: null });
      setCollabOpen(false);
    } catch (error) {
      if (error.code === "permission-denied") {
        const detail = joinStage === "invite lookup"
          ? "Firestore denied reading the invite code (collabInvites). Publish the included firestore.rules in the Firebase project configured by VITE_FIREBASE_PROJECT_ID."
          : joinStage === "room membership update"
            ? "Firestore denied adding you to the room (collabRooms). Publish the included firestore.rules in the same Firebase project, and confirm Anonymous sign-in is enabled."
            : "Firebase denied collaboration access. Check Authentication settings and the project's Firestore rules.";
        setCollabError(`${detail} If you already published the rules, verify that VITE_FIREBASE_PROJECT_ID matches the Firebase project where you published them.`);
      } else {
        setCollabError(error.message || "Could not join this collaboration room.");
      }
    } finally {
      setCollabBusy(false);
    }
  };

  const updateCollaborationTimetable = (fn) => {
    const room = activeCollab;
    const collabUser = auth?.currentUser;
    if (!room?.id || !room.data?.timetable || !collabUser) return;
    setCollabError("");
    // Optimistic local update makes editing feel immediate; the transaction below
    // reapplies the same change to the latest server version to avoid lost updates.
    setActiveCollab((current) => current?.id === room.id && current.data?.timetable
      ? { ...current, data: { ...current.data, timetable: fn(current.data.timetable) } }
      : current);
    runTransaction(db, async (transaction) => {
      const roomRef = doc(db, "collabRooms", room.id);
      const snapshot = await transaction.get(roomRef);
      if (!snapshot.exists()) throw new Error("This collaboration room no longer exists.");
      const latest = snapshot.data();
      if (!latest.participantIds?.includes(collabUser.uid)) throw new Error("You are no longer a member of this collaboration room.");
      const nextTimetable = fn(latest.timetable);
      transaction.update(roomRef, { timetable: nextTimetable, updatedAt: serverTimestamp() });
      return { nextTimetable, ownerUid: latest.ownerUid, sourceTimetableId: latest.sourceTimetableId };
    }).then((result) => {
      setActiveCollab((current) => current?.id === room.id && current.data
        ? { ...current, data: { ...current.data, timetable: result.nextTimetable } }
        : current);
      // Keep the room creator's original private timetable in step with the room.
      if (result.ownerUid === collabUser.uid && result.sourceTimetableId) {
        setTts((items) => items.map((item) => item.id === result.sourceTimetableId ? result.nextTimetable : item));
      }
    }).catch((error) => {
      setCollabError(error.message || "A change could not be synchronized. Please retry.");
    });
  };

  const reconnectCollaborationRoom = async () => {
    if (!activeCollab?.id || !activeCollab?.code) {
      setCollabError("The saved room code is missing. Open the original invite link and enter the code again.");
      return;
    }
    setCollabBusy(true);
    setCollabError("");
    try {
      const collabUser = await requireCollaborationAuth();
      await updateDoc(doc(db, "collabRooms", activeCollab.id), {
        participantIds: arrayUnion(collabUser.uid),
        participants: arrayUnion(collabUser.uid),
        joinCode: activeCollab.code,
        updatedAt: serverTimestamp(),
      });
      setCollabError("");
      setActiveCollab((current) => current?.id === activeCollab.id ? { ...current, memberUid: collabUser.uid } : current);
      // Force a fresh document listener after a reconnect may have initially
      // been denied before the current UID was added as a room member.
      setAuthRevision((revision) => revision + 1);
    } catch (error) {
      setCollabError(error.message || "Could not reconnect to this room. Check the saved room code.");
    } finally {
      setCollabBusy(false);
    }
  };

  const leaveCollaborationRoom = () => {
    setActiveCollab(null);
    setCollabError("");
    setCollabOpen(false);
    clearRoomFromAddress();
  };

  const keepLegacyAccountData = () => {
    if (!session?.uid || accountDataReview?.uid !== session.uid || accountDataReview.ownershipMismatch || !accountDataReview.saved) return;
    const saved = accountDataReview.saved;
    setUser(saved.user
      ? { ...profileFromAuth(session), ...saved.user, email: saved.user.email || session.email || "" }
      : profileFromAuth(session));
    setTts(Array.isArray(saved.tts) ? saved.tts : []);
    setCustomCatalog(Array.isArray(saved.customCatalog) ? saved.customCatalog : []);
    setHiddenCatalogCodes(Array.isArray(saved.hiddenCatalogCodes) ? saved.hiddenCatalogCodes : []);
    setAccountDataReview(null);
    setAccountReviewError("");
    setDataReady(true);
    setCloudStatus("Verifying account ownership…");
    setTutorialOpen(saved?.tutorialSeen !== true && !new URLSearchParams(window.location.search).has("room"));
  };

  const startFreshAccountData = async () => {
    if (!session?.uid || accountDataReview?.uid !== session.uid) return;
    setAccountReviewBusy(true);
    setAccountReviewError("");
    try {
      await deleteDoc(doc(db, "users", session.uid));
      setUser(profileFromAuth(session));
      setTts([]);
      setCustomCatalog([]);
      setHiddenCatalogCodes([]);
      setCur(null);
      setAccountDataReview(null);
      setDataReady(true);
      setCloudStatus("Starting a private planner…");
      setTutorialOpen(!new URLSearchParams(window.location.search).has("room"));
    } catch (error) {
      setAccountReviewError(error.message || "Could not reset this account's saved planner. Check the Firestore security rules.");
    } finally {
      setAccountReviewBusy(false);
    }
  };

  const handleGoogleLogin = async () => {
    setAuthError("");
    if (!FIREBASE_CONFIGURED) {
      setAuthError("Google sign-in needs your Firebase web-app configuration. Add the VITE_FIREBASE_* values to .env.local and Vercel, then redeploy. See README.md.");
      return;
    }
    setAuthBusy(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(auth, provider);
    } catch (error) {
      const messages = {
        "auth/popup-closed-by-user": "The Google sign-in window was closed before completion.",
        "auth/unauthorized-domain": "This website domain is not authorized in Firebase Authentication. Add localhost or your Vercel domain to Authorized domains.",
        "auth/popup-blocked": "Your browser blocked the Google sign-in popup. Allow popups for this site and try again.",
      };
      const message = messages[error.code] || error.message || "Could not sign in with Google.";
      setAuthError(message);
      if (user) window.alert(message);
    } finally {
      setAuthBusy(false);
    }
  };

  const logout = async () => {
    setActiveCollab(null);
    setCollabOpen(false);
    setAccountDataReview(null);
    setAccountReviewError("");
    if (session) {
      // Clear the signed-in profile before auth state changes, avoiding writing
      // cloud-account data back into guest storage during sign-out.
      setUser(null);
      setTts([]);
      setCustomCatalog([]);
      setHiddenCatalogCodes([]);
      setCur(null);
      try { await firebaseSignOut(auth); } catch (error) { setAuthError(error.message || "Sign-out failed."); }
      setSession(null);
      setDataReady(true);
      setCloudStatus("");
      setCloudLoadError("");
      return;
    }
    setUser(null);
    setCur(null);
    if (auth?.currentUser?.isAnonymous) {
      try { await firebaseSignOut(auth); } catch { /* Local logout should still complete. */ }
    }
  };

  if (session && accountDataReview?.uid === session.uid) {
    return (
      <div className="center">
        <section className="card account-review-card" aria-labelledby="account-review-title">
          <div className="eyebrow">PRIVATE ACCOUNT CHECK</div>
          <h2 id="account-review-title">Verify your saved timetable</h2>
          <p className="mut">
            This account has data saved by an older version of FFCS Planner. That version could copy browser data into a newly signed-in account, so we have not opened the saved timetable yet.
          </p>
          <div className="account-review-email"><span>Signed in as</span><b>{accountDataReview.email || session.email || "Google account"}</b></div>
          {accountDataReview.ownershipMismatch ? (
            <div className="err account-review-error">This Firestore document is explicitly marked as belonging to a different Firebase user. Its contents are hidden for safety. Reset this account to create a clean private planner.</div>
          ) : (
            <p className="account-review-help">Choose <b>Keep my saved timetable</b> only if the saved data belongs to this Google account. If it shows a timetable copied from another account, choose <b>Start this account fresh</b>.</p>
          )}
          {accountReviewError && <div className="err account-review-error">{accountReviewError}</div>}
          <div className="account-review-actions">
            {!accountDataReview.ownershipMismatch && <button className="btn secondary-btn" onClick={keepLegacyAccountData} disabled={accountReviewBusy}>Keep my saved timetable</button>}
            <button className="btn p" onClick={startFreshAccountData} disabled={accountReviewBusy}>{accountReviewBusy ? "Resetting account…" : "Start this account fresh"}</button>
            <button className="btn ghost-btn" onClick={logout} disabled={accountReviewBusy}>Sign out</button>
          </div>
          <p className="fine-print">This choice affects only the signed-in account shown above. Other Google accounts have separate Firestore documents.</p>
        </section>
      </div>
    );
  }

  if (FIREBASE_CONFIGURED && !authInitialized) {
    return <div className="center"><div className="card loading-card"><div className="brand-mark">F</div><h2>Opening your planner</h2><p className="mut">Checking your Google account…</p></div></div>;
  }
  if (session && !dataReady) {
    return <div className="center"><div className="card loading-card"><div className="brand-mark">F</div><h2>Opening your planner</h2><p className="mut">Getting your saved timetable from Firebase…</p>{cloudLoadError && <><div className="err cloud-error">{cloudLoadError}</div><button className="btn p" onClick={() => setLoadAttempt((n) => n + 1)}>Try again</button><button className="text-btn" onClick={logout}>Sign out</button></>}</div></div>;
  }

  if (!user) return <Login onLogin={handleLocalLogin} onGoogleLogin={handleGoogleLogin} authError={authError} authBusy={authBusy} cloudConfigured={FIREBASE_CONFIGURED} />;
  const localTt = tts.find((t) => t.id === cur);
  const tt = activeCollab?.data?.timetable || (!activeCollab ? localTt : null);
  const collaborationProps = {
    activeCollab,
    collabOpen,
    pendingRoomId,
    collabBusy,
    collabError,
    openCollab: () => { setCollabError(""); setCollabOpen(true); },
    closeCollab: () => { setCollabOpen(false); setCollabError(""); },
    createCollab: createCollaborationRoom,
    joinCollab: joinCollaborationRoom,
    leaveCollab: leaveCollaborationRoom,
    clearCollabError: () => setCollabError(""),
    firebaseConfigured: FIREBASE_CONFIGURED,
  };
  if (activeCollab && !activeCollab.data?.timetable) {
    return <div className="center"><div className="card loading-card"><div className="brand-mark">F</div><h2>Joining collaboration room</h2><p className="mut">Connecting to the live timetable…</p>{collabError && <><div className="err cloud-error">{collabError}</div>{activeCollab.code && <p className="mut">Saved room code: <b>{activeCollab.code}</b></p>}<button className="btn p" onClick={reconnectCollaborationRoom} disabled={collabBusy}>{collabBusy ? "Reconnecting…" : "Reconnect room"}</button><button className="btn s ghost-btn" onClick={leaveCollaborationRoom}>Return to planner</button></>}</div></div>;
  }
  if (!tt) {
    return <Dashboard user={user} tts={tts} logout={logout} open={setCur}
      create={() => { const t = { id: uid(), name: "Timetable " + (tts.length + 1), courses: [] }; setTts([...tts, t]); setCur(t.id); }}
      remove={(id) => window.confirm("Delete this timetable?") && setTts(tts.filter((t) => t.id !== id))}
      cloudMode={Boolean(session)} cloudStatus={cloudStatus} onGoogleLogin={handleGoogleLogin}
      openTutorial={openTutorial} tutorialOpen={tutorialOpen} closeTutorial={closeTutorial}
      {...collaborationProps} />;
  }
  return <Planner tt={tt} user={user} back={() => { if (activeCollab) leaveCollaborationRoom(); else setCur(null); }} logout={logout}
    update={activeCollab ? updateCollaborationTimetable : (fn) => setTts((items) => items.map((t) => t.id === tt.id ? fn(t) : t))}
    customCatalog={customCatalog} onCustomCatalogChange={setCustomCatalog} hiddenCatalogCodes={hiddenCatalogCodes}
    onHiddenCatalogCodesChange={setHiddenCatalogCodes} cloudMode={Boolean(session)} cloudStatus={cloudStatus} onGoogleLogin={handleGoogleLogin}
    openTutorial={openTutorial} tutorialOpen={tutorialOpen} closeTutorial={closeTutorial}
    {...collaborationProps} />;
}

function Login({ onLogin, onGoogleLogin, authError, authBusy, cloudConfigured }) {
  const [n, setN] = useState("");
  const [r, setR] = useState("");
  const [e, setE] = useState("");
  const go = (ev) => {
    ev.preventDefault();
    if (!n.trim() || !r.trim()) return setE("Enter both your name and register number.");
    onLogin({ n: n.trim(), r: r.trim().toUpperCase(), email: "" });
  };

  return (
    <div className="auth-page">
      <div className="auth-glow glow-one" /><div className="auth-glow glow-two" />
      <div className="auth-layout">
        <section className="welcome-panel">
          <div className="brand-lockup"><div className="brand-mark">F</div><span>FFCS <b>Planner</b></span></div>
          <div className="eyebrow"><span className="status-dot" /> MADE FOR VIT VELLORE</div>
          <h1>Plan your FFCS<br /><em>semester.</em></h1>
          <p className="welcome-copy">Choose your courses, check for slot clashes, and keep your credits in one place.</p>
          <div className="feature-stack">
            <div className="feature-item"><span className="feature-icon">▦</span><span><b>Your week at a glance</b><small>Every slot in one clear timetable</small></span></div>
            <div className="feature-item"><span className="feature-icon">✳</span><span><b>Catch clashes early</b><small>Slot conflicts and custom rules</small></span></div>
            <div className="feature-item"><span className="feature-icon">↗</span><span><b>Pick up where you left off</b><small>Google sign-in with cloud sync</small></span></div>
          </div>
          <div className="welcome-footer">A simple planner for your semester <span>✦</span></div>
        </section>

        <section className="auth-panel card">
          <div className="auth-panel-top"><span className="mut">STUDENT SIGN-IN</span><span className="secure-label"><span>●</span> PRIVATE ACCOUNT</span></div>
          <h2>Sign in to save your timetable</h2>
          <p className="mut intro">Use Google to keep your timetable backed up and open it on another device, or continue in this browser.</p>

          <div className="google-login-block">
            <button className="btn google-btn full-btn" type="button" onClick={onGoogleLogin} disabled={authBusy || !cloudConfigured}>
              <span className="google-g" aria-hidden="true">G</span>{authBusy ? "Connecting to Google…" : "Continue with Google"}
            </button>
            {!cloudConfigured && <div className="setup-hint">Google sign-in becomes active after adding your Firebase web-app configuration and setting up Firestore. See <b>README.md</b> for the one-time setup.</div>}
            {authError && <div className="err auth-error">{authError}</div>}
            <p className="fine-print">Your timetables are saved to your private Firebase account.</p>
          </div>

          <div className="or-divider"><span /> <small>OR CONTINUE LOCALLY</small> <span /></div>
          <form className="guest-form" onSubmit={go}>
            <div className="row2">
              <label>Full name<input value={n} onChange={(ev) => { setN(ev.target.value); setE(""); }} placeholder="Your name" autoComplete="name" /></label>
              <label>Register number<input value={r} onChange={(ev) => { setR(ev.target.value); setE(""); }} placeholder="25BCE0000" /></label>
            </div>
            <div className="err">{e}</div>
            <button className="btn secondary-btn full-btn" type="submit">Continue on this device</button>
            <p className="fine-print">Local progress stays in this browser. Sign in with Google for cross-device backup.</p>
          </form>
        </section>
      </div>
    </div>
  );
}

function AppHeader({ user, logout, cloudMode, cloudStatus, children, onGoogleLogin, onTutorialClick }) {
  return (
    <header className="app-header">
      <div className="brand-lockup compact"><div className="brand-mark">F</div><span>FFCS <b>Planner</b></span></div>
      {children}
      <span className="header-spacer" />
      {cloudMode && <span className="cloud-indicator" title={cloudStatus}><span className={cloudStatus === "All changes saved" ? "cloud-dot saved" : "cloud-dot"} />{cloudStatus || "Cloud account"}</span>}
      {onTutorialClick && <button className="btn s ghost-btn tutorial-trigger" type="button" onClick={onTutorialClick} title="Watch the custom course and faculty import tutorial"><span aria-hidden="true">▶</span> Tutorial</button>}
      {!cloudMode && onGoogleLogin && <button className="btn s google-connect-btn" onClick={onGoogleLogin}>↗ Connect Google</button>}
      <div className="profile-chip"><span className="avatar">{(user.n || user.email || "S").slice(0, 1).toUpperCase()}</span><span className="profile-text"><b>{user.n || "Student"}</b><small>{user.email || user.r || "Local account"}</small></span></div>
      <button className="btn s ghost-btn" onClick={logout}>Sign out</button>
    </header>
  );
}

function Dashboard({ user, tts, logout, open, create, remove, cloudMode, cloudStatus, onGoogleLogin, activeCollab, collabOpen, pendingRoomId, collabBusy, collabError, openCollab, closeCollab, createCollab, joinCollab, leaveCollab, clearCollabError, firebaseConfigured, openTutorial, tutorialOpen, closeTutorial }) {
  const totalCourses = tts.reduce((sum, t) => sum + t.courses.length, 0);
  const totalCredits = tts.reduce((sum, t) => sum + t.courses.reduce((a, c) => a + c.credits, 0), 0);
  return (
    <>
      <AppHeader user={user} logout={logout} cloudMode={cloudMode} cloudStatus={cloudStatus} onGoogleLogin={onGoogleLogin} onTutorialClick={openTutorial} />
      <div className="wrap dashboard-wrap">
        <div className="dashboard-hero"><div><div className="eyebrow">FFCS PLANNER</div><h1>Let’s plan your semester{user.n ? `, ${user.n.split(" ")[0]}` : ""}.</h1><p className="mut">Keep your courses, slots and credits together.</p></div><div className="dashboard-hero-actions"><button className="btn s ghost-btn" onClick={openCollab}>↗ Join a room</button><button className="btn p create-btn" onClick={create}>＋ Create timetable</button></div></div>
        <div className="stats-row">
          <div className="stat-card"><span className="stat-label">TIMETABLES</span><b>{tts.length.toString().padStart(2, "0")}</b><small>semester plans</small></div>
          <div className="stat-card"><span className="stat-label">COURSES ADDED</span><b>{totalCourses.toString().padStart(2, "0")}</b><small>across all timetables</small></div>
          <div className="stat-card"><span className="stat-label">TOTAL CREDITS</span><b>{totalCredits}</b><small>planned credits</small></div>
        </div>
        <div className="section-heading"><div><h2>Your semester plans</h2><p className="mut">Open a plan to add courses, check clashes or update slots.</p></div><span className="section-count">{tts.length} {tts.length === 1 ? "plan" : "plans"}</span></div>
        <div className="timetable-cards">
          {tts.length === 0 && <div className="empty-state"><div className="empty-icon">▦</div><h3>No timetables yet</h3><p className="mut">Create a plan, then add your courses to see your weekly schedule and total credits.</p><button className="btn p" onClick={create}>＋ Create timetable</button></div>}
          {tts.map((t, index) => (
            <div key={t.id} className="timetable-card" onClick={() => open(t.id)} role="button" tabIndex={0} onKeyDown={(ev) => { if (ev.key === "Enter") open(t.id); }}>
              <div className="timetable-card-top"><span className={`timetable-symbol symbol-${index % 4}`}>▦</span><button className="icon-button delete-button" title="Delete timetable" onClick={(ev) => { ev.stopPropagation(); remove(t.id); }}>✕</button></div>
              <h3>{t.name}</h3><p className="mut">{t.courses.length} courses · {t.courses.reduce((x, c) => x + c.credits, 0)} credits</p>
              <div className="card-footer"><span>{t.courses.length ? `${t.courses.length} courses planned` : "Ready to set up"}</span><span className="arrow-circle">↗</span></div>
            </div>
          ))}
        </div>
      </div>
      <CollaborateModal open={collabOpen} pendingRoomId={pendingRoomId} canCreate={false} busy={collabBusy} error={collabError} firebaseConfigured={firebaseConfigured} onClose={closeCollab} onCreate={createCollab} onJoin={joinCollab} onClearError={clearCollabError} />
      <TutorialModal open={tutorialOpen} onClose={closeTutorial} />
    </>
  );
}

const blank = { code: "", title: "", credits: "", faculty: "", venue: "" };

function SearchableSelect({ label, options, value, onChange, placeholder, searchPlaceholder, disabled = false, emptyMessage = "No matching options found." }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) setQuery(selected?.label || "");
  }, [selected?.label, open]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredOptions = options.filter((option) => {
    if (!normalizedQuery) return true;
    return `${option.label} ${option.searchText || ""} ${option.meta || ""}`.toLocaleLowerCase().includes(normalizedQuery);
  });

  return (
    <div className={`search-select${open ? " is-open" : ""}${disabled ? " is-disabled" : ""}`}>
      <span className="picker-label">{label}</span>
      <div className="search-select-control">
        <input
          type="text"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-autocomplete="list"
          placeholder={searchPlaceholder || placeholder}
          value={query}
          disabled={disabled}
          onFocus={() => { setQuery(""); setOpen(true); }}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onBlur={() => window.setTimeout(() => {
            setOpen(false);
            setQuery(selected?.label || "");
          }, 120)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              setQuery(selected?.label || "");
              event.currentTarget.blur();
            }
            if (event.key === "Enter" && open && filteredOptions.length === 1) {
              event.preventDefault();
              onChange(filteredOptions[0].value);
              setQuery(filteredOptions[0].label);
              setOpen(false);
              event.currentTarget.blur();
            }
          }}
        />
        <span className="search-select-icon" aria-hidden="true">⌕</span>
      </div>
      {open && !disabled && (
        <div className="search-select-menu" role="listbox" aria-label={`${label} options`}>
          <div className="search-select-count">{filteredOptions.length} {filteredOptions.length === 1 ? "option" : "options"}</div>
          {filteredOptions.length ? filteredOptions.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              key={option.value}
              className={`search-select-option${option.value === value ? " selected" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(option.value);
                setQuery(option.label);
                setOpen(false);
              }}
            >
              <span className="option-copy"><b>{option.label}</b>{option.meta && <small>{option.meta}</small>}</span>
              {option.value === value && <span className="option-check" aria-hidden="true">✓</span>}
            </button>
          )) : <div className="search-select-empty">{emptyMessage}</div>}
        </div>
      )}
    </div>
  );
}

function Planner({ tt, user, back, logout, update, customCatalog, onCustomCatalogChange, hiddenCatalogCodes, onHiddenCatalogCodesChange, cloudMode, cloudStatus, onGoogleLogin, activeCollab, collabOpen, pendingRoomId, collabBusy, collabError, openCollab, closeCollab, createCollab, joinCollab, leaveCollab, clearCollabError, firebaseConfigured, openTutorial, tutorialOpen, closeTutorial }) {
  const [f, setF] = useState(blank);
  const [slots, setSlots] = useState("");
  const [catalogCode, setCatalogCode] = useState("");
  const [catalogOffering, setCatalogOffering] = useState("");
  const [manageCatalogCode, setManageCatalogCode] = useState("");
  const [importSubject, setImportSubject] = useState("");
  const [importTable, setImportTable] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const [catalogManageMessage, setCatalogManageMessage] = useState("");
  const [err, setErr] = useState("");
  const [editingCreditsFor, setEditingCreditsFor] = useState(null);
  const [editedCredits, setEditedCredits] = useState("");
  const [editCreditsError, setEditCreditsError] = useState("");
  const [copyFeedback, setCopyFeedback] = useState("");
  const copyRoomValue = async (value, label) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const area = document.createElement("textarea");
        area.value = value;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const copied = document.execCommand("copy");
        area.remove();
        if (!copied) throw new Error("Copy is not supported in this browser.");
      }
      setCopyFeedback(`${label} copied to clipboard.`);
    } catch {
      setCopyFeedback(`Couldn't copy the ${label.toLowerCase()}. Select the text and copy it manually.`);
    }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const availableCatalog = [...courseCatalog.filter((course) => !hiddenCatalogCodes.includes(course.code)), ...customCatalog.filter((course) => !hiddenCatalogCodes.includes(course.code))];
  const selectedCatalogCourse = availableCatalog.find((c) => c.code === catalogCode);
  const catalogOfferings = selectedCatalogCourse?.offerings || [];
  const subjectOptions = availableCatalog.map((course) => ({
    value: course.code,
    label: `${course.code} — ${course.title}`,
    searchText: `${course.code} ${course.title}`,
    meta: customCatalog.some((item) => item.code === course.code) ? "Personal subject" : "Course catalogue",
  }));
  const offeringOptions = catalogOfferings.map((offering, index) => ({
    value: String(index),
    label: `${offering.faculty} — ${offering.slot}`,
    searchText: `${offering.faculty} ${offering.slot} ${offering.venue} ${offering.type}`,
    meta: [offering.venue, offering.type].filter(Boolean).join(" · "),
  }));
  const manageSubjectOptions = availableCatalog.map((course) => ({
    value: course.code,
    label: `${course.code} — ${course.title}`,
    searchText: `${course.code} ${course.title}`,
    meta: `${course.offerings?.length || 0} faculty/class options · ${customCatalog.some((item) => item.code === course.code) ? "Personal subject" : "Default catalogue"}`,
  }));
  const selectCatalogCourse = (code) => {
    setCatalogCode(code);
    setCatalogOffering("");
    const item = availableCatalog.find((c) => c.code === code);
    setF((old) => ({ ...old, code: item?.code || "", title: item?.title || "", faculty: "", venue: "" }));
    setSlots("");
    setErr("");
  };
  const selectCatalogOffering = (index) => {
    setCatalogOffering(index);
    const item = catalogOfferings[Number(index)];
    if (!item) return;
    setF((old) => ({ ...old, code: selectedCatalogCourse.code, title: selectedCatalogCourse.title, faculty: item.faculty, venue: item.venue }));
    setSlots(item.slot);
    setErr("");
  };
  const rules = tt.rules || {}, cols = ruleCols(rules);
  const bad = tt.courses.filter((c) => ruleHits(c, rules).length);
  const setRule = (k) => update((t) => ({ ...t, rules: { ...(t.rules || {}), [k]: !(t.rules || {})[k] } }));
  const credits = Number(tt.courses.reduce((x, c) => x + Number(c.credits || 0), 0).toFixed(2));
  const parsedSlots = parseSlots(slots);
  const toggle = (s) => { const current = parseSlots(slots); setSlots((current.includes(s) ? current.filter((x) => x !== s) : [...current, s]).join("+")); setErr(""); };

  const add = (ev) => {
    ev?.preventDefault();
    const code = f.code.trim().toUpperCase(), cd = parseFloat(f.credits), sl = parseSlots(slots);
    if (!code && !f.title.trim()) return setErr("Enter a course code or title.");
    if (f.credits === "" || Number.isNaN(cd)) return setErr("Enter the credits.");
    if (!sl.length) return setErr("Enter at least one slot.");
    const unk = sl.filter((s) => !ALL.has(s));
    if (unk.length) return setErr("Unknown slot: " + unk.join(", "));
    const c = { id: uid(), code, title: f.title.trim(), credits: cd, slots: [...new Set(sl)], faculty: f.faculty.trim(), venue: f.venue.trim(), color: COL[tt.courses.length % COL.length] };
    const rh = ruleHits(c, rules);
    if (rh.length) return setErr(`Breaks your timetable rule — class at ${rh.slice(0, 3).join(", ")}${rh.length > 3 ? " …" : ""}.`);
    const cl = clashes(c, tt.courses);
    if (cl.length) return setErr("Slot clash:\n" + cl.slice(0, 3).join("\n") + (cl.length > 3 ? `\n+${cl.length - 3} more` : ""));
    update((t) => ({ ...t, courses: [...t.courses, c] }));
    setF(blank); setSlots(""); setErr(""); setCatalogCode(""); setCatalogOffering("");
  };

  const removeCourse = (id) => update((t) => ({ ...t, courses: t.courses.filter((c) => c.id !== id) }));

  const beginEditCredits = (course) => {
    setEditingCreditsFor(course.id);
    setEditedCredits(String(course.credits ?? ""));
    setEditCreditsError("");
  };
  const saveEditedCredits = (event) => {
    event?.preventDefault();
    const value = Number(editedCredits);
    if (editedCredits.trim() === "" || !Number.isFinite(value) || value < 0 || value > 50) {
      setEditCreditsError("Enter a valid credit value between 0 and 50.");
      return;
    }
    update((t) => ({ ...t, courses: t.courses.map((course) => course.id === editingCreditsFor ? { ...course, credits: value } : course) }));
    setEditingCreditsFor(null);
    setEditedCredits("");
    setEditCreditsError("");
  };

  const removeCatalogSubject = () => {
    const subject = availableCatalog.find((course) => course.code === manageCatalogCode);
    if (!subject) return;
    const isCustom = customCatalog.some((course) => course.code === subject.code);
    const confirmed = window.confirm(
      `Remove “${subject.title}” and its ${subject.offerings?.length || 0} faculty/class option(s) from the course dropdown?\n\nThis is separate from removing a class from your timetable. Any class already added to the timetable will stay there. ${isCustom ? "You can import this personal subject again later." : "You can restore hidden default subjects below."}`
    );
    if (!confirmed) return;
    if (isCustom) onCustomCatalogChange((items) => items.filter((course) => course.code !== subject.code));
    else onHiddenCatalogCodesChange((codes) => codes.includes(subject.code) ? codes : [...codes, subject.code]);
    if (catalogCode === subject.code) {
      setCatalogCode("");
      setCatalogOffering("");
      setF((old) => ({ ...old, code: "", title: "", faculty: "", venue: "" }));
      setSlots("");
    }
    setManageCatalogCode("");
    setCatalogManageMessage(`Removed “${subject.title}” and its faculty/class options from the dropdown.`);
  };

  const restoreDefaultSubjects = () => {
    if (!hiddenCatalogCodes.length) return;
    if (window.confirm(`Restore all ${hiddenCatalogCodes.length} hidden default subject(s) to the dropdown?`)) {
      onHiddenCatalogCodesChange([]);
      setCatalogManageMessage("Default subjects restored.");
    }
  };

  return (
    <>
      <AppHeader user={user} logout={logout} cloudMode={cloudMode} cloudStatus={cloudStatus} onGoogleLogin={onGoogleLogin} onTutorialClick={openTutorial}>
        <button className="btn s ghost-btn back-btn" onClick={back}>← All plans</button>
        <input aria-label="Timetable name" className="t timetable-name" value={tt.name} onChange={(ev) => { const value = ev.target.value; update((t) => ({ ...t, name: value })); }} />
        <button className="btn s ghost-btn print-btn" onClick={() => window.print()}>↗ Export / Print</button>
      </AppHeader>
      <div className="wrap planner-wrap">
        <div className="planner-heading"><div><div className="eyebrow">YOUR SEMESTER</div><h1>{activeCollab ? "Plan together, live." : "Build your timetable."}</h1><p className="mut">{activeCollab ? "Everyone in this room sees timetable changes as they happen." : "Add courses below. We’ll flag slot clashes as you go."}</p></div><div className="planner-heading-actions"><div className="heading-metrics"><div><b>{tt.courses.length.toString().padStart(2, "0")}</b><small>COURSES</small></div><div><b>{credits}</b><small>CREDITS</small></div></div><button className={`btn ${activeCollab ? "s ghost-btn" : "p"} collaborate-trigger`} onClick={openCollab} disabled={Boolean(activeCollab)} title={activeCollab ? "Use the room controls below while collaborating" : "Create or join a shared timetable room"}>{activeCollab ? "● Collaboration active" : "↗ Collaborate"}</button></div></div>
        {activeCollab && <section className="collab-room-banner"><div className="collab-room-icon">↗</div><div className="collab-room-main"><div className="collab-room-title"><b>Live collaboration room</b><span className="live-pill"><i /> LIVE</span></div><p>{activeCollab.data?.participants?.length || 1} {((activeCollab.data?.participants?.length || 1) === 1) ? "person has" : "people have"} joined this room. Changes to courses, slots, rules and credits sync automatically.</p><div className="collab-share-details"><span><small>ROOM CODE</small><b>{activeCollab.code}</b></span><button type="button" className="btn s ghost-btn" onClick={() => copyRoomValue(activeCollab.code, "Room code")}>Copy code</button><span className="collab-link-preview" title={activeCollab.link}><small>SHARE LINK</small><b>{activeCollab.link}</b></span><button type="button" className="btn s ghost-btn" onClick={() => copyRoomValue(activeCollab.link, "Share link")}>Copy link</button></div>{copyFeedback && <p className="copy-feedback" role="status">{copyFeedback}</p>}{collabError && <p className="err collab-inline-error" role="alert">{collabError}</p>}</div><button type="button" className="btn s ghost-btn leave-room-btn" onClick={leaveCollab}>Leave room</button></section>}

        <section className="card course-builder">
          <div className="builder-top"><div className="builder-title"><span className="builder-icon">＋</span><div><h2>Add a course</h2><p className="mut">Course details and slot selection</p></div></div><span className="builder-note"><span className="tiny-dot" /> Clash checking is on</span></div>
          <div className="catalog-pickers">
            <SearchableSelect
              label="Choose a subject from your document"
              options={subjectOptions}
              value={catalogCode}
              onChange={selectCatalogCourse}
              placeholder="Select a subject…"
              searchPlaceholder="Search course code or name…"
              emptyMessage="No courses match that search."
            />
            <SearchableSelect
              label="Available faculty / class"
              options={offeringOptions}
              value={catalogOffering}
              onChange={selectCatalogOffering}
              disabled={!selectedCatalogCourse}
              placeholder={selectedCatalogCourse ? "Select faculty, slot and venue…" : "Choose a subject first"}
              searchPlaceholder="Search faculty, slot or venue…"
              emptyMessage="No faculty or classes match that search."
            />
            <p className="catalog-help">Selecting a class fills the course code, title, faculty, venue and slot. Credits aren't listed in the document, so enter them manually.</p>
          </div>
          <div className="custom-import-panel">
            <div className="custom-import-heading"><div><h3>Import your own subject faculty list</h3><p className="mut">Paste the subject name and copied table (including Slot Detail, Venue, Faculty and Course Type). We'll parse the rows into your personal dropdown.</p></div><span className="pill">Private to your account</span></div>
            <div className="custom-import-fields">
              <label>Subject name<input value={importSubject} onChange={(ev) => setImportSubject(ev.target.value)} placeholder="e.g. Engineering Mathematics" /></label>
              <label><span className="import-table-label"><span>Paste faculty table</span><button className="text-clear-btn" type="button" onClick={() => { setImportTable(""); setImportMessage(""); }}>Clear pasted content</button></span><textarea value={importTable} onChange={(ev) => setImportTable(ev.target.value)} rows={5} placeholder={`| Slot Detail | Venue | Faculty | Course Type |\n| B1+TB1 | TT620 | BHUVANESWARI M | TH |\n| B2+TB2 | SMV214 | BHUVANESWARI M | TH |`} /></label>
            </div>
            <div className="builder-actions"><div className="mut import-feedback">{importMessage}</div><button className="btn p add-btn" type="button" onClick={() => {
              const title = importSubject.trim();
              if (!title) { setImportMessage("Enter the subject name first."); return; }
              const rows = importTable.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
              const offerings = [];
              for (const line of rows) {
                // Support Markdown, tab-separated spreadsheet data, and plain-text columns.
                let cells;
                if (line.includes("|")) cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
                else if (line.includes("\t")) cells = line.split("\t").map((cell) => cell.trim());
                else cells = line.split(/\s{2,}/).map((cell) => cell.trim());
                cells = cells.map((cell) => cell.replace(/^\*\*(.*)\*\*$/, "$1"));
                if (cells.length < 4 || cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, "")))) continue;
                const normalized = cells.map((cell) => cell.toLowerCase().replace(/[^a-z ]/g, "").trim());
                if (normalized.some((cell) => cell.includes("slot detail") || cell === "venue" || cell === "faculty" || cell.includes("course type"))) continue;
                if (cells.length > 4) cells = [cells[0], cells[1], cells.slice(2, -1).join(" "), cells[cells.length - 1]];
                const [slot, venue, faculty, type] = cells;
                const parsed = parseSlots((slot || "").replace(/\s+/g, ""));
                if (!slot || !faculty || !parsed.length || parsed.some((value) => !ALL.has(value))) continue;
                offerings.push({ slot: parsed.join("+"), venue: venue || "", faculty: faculty || "", type: type || "TH" });
              }
              if (!offerings.length) { setImportMessage("No valid rows found. Paste the table with Slot Detail, Venue, Faculty and Course Type columns."); return; }
              const code = "CUSTOM-" + title.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
              const subject = { code, title, offerings };
              onCustomCatalogChange((old) => [...old.filter((item) => item.code !== code), subject]);
              setCatalogCode(code); setCatalogOffering("");
              setF((old) => ({ ...old, code: "", title, faculty: "", venue: "" })); setSlots("");
              setImportMessage(`Imported ${offerings.length} faculty/class options for “${title}”. Select one from the subject dropdown.`);
            }}>Parse and save subject</button></div>
          </div>

          <div className="catalog-management-panel">
            <div className="catalog-management-heading">
              <div><h3>Manage course list</h3><p className="mut">Remove a subject and its faculty options from the dropdown. Courses already in this timetable will stay until you remove them separately.</p></div>
              <span className="catalog-count">{availableCatalog.length} subjects</span>
            </div>
            <div className="catalog-management-controls">
              <SearchableSelect
                label="Subject to remove"
                options={manageSubjectOptions}
                value={manageCatalogCode}
                onChange={(code) => { setManageCatalogCode(code); setCatalogManageMessage(""); }}
                placeholder="Choose a subject to manage…"
                searchPlaceholder="Search subject to remove…"
                emptyMessage="No subjects match that search."
              />
              <button className="btn danger-btn remove-catalog-btn" type="button" onClick={removeCatalogSubject} disabled={!manageCatalogCode}>Remove subject and faculty options</button>
            </div>
            <div className="catalog-management-footer">
              <p className="catalog-manage-feedback" role="status">{catalogManageMessage}</p>
              {hiddenCatalogCodes.length > 0 && <button className="text-clear-btn restore-catalog-btn" type="button" onClick={restoreDefaultSubjects}>Restore {hiddenCatalogCodes.length} hidden default subject(s)</button>}
            </div>
          </div>
          <form onSubmit={add}>
            <div className="course-fields">
              <label>Course code<input value={f.code} onChange={set("code")} placeholder="BACSE202" /></label>
              <label>Credits<input type="number" min="0" step="0.5" value={f.credits} onChange={set("credits")} placeholder="3" /></label>
              <label className="title-field">Course title<input value={f.title} onChange={set("title")} placeholder="Data Structures and Algorithms" /></label>
              <label className="slots-field">Slot(s)<input value={slots} onChange={(ev) => { setSlots(ev.target.value); setErr(""); }} placeholder="e.g. A1+TA1 or L3+L4" /></label>
              <label>Faculty<input value={f.faculty} onChange={set("faculty")} placeholder="Faculty name" /></label>
              <label>Venue<input value={f.venue} onChange={set("venue")} placeholder="PRP329" /></label>
            </div>
            <div className="builder-actions"><div className="err builder-error">{err}</div><button className="btn p add-btn" type="submit">＋ Add to timetable</button></div>
          </form>
          {tt.courses.length > 0 && <div className="course-list-wrap"><div className="course-list-heading"><span>ADDED COURSES <b>{tt.courses.length}</b></span><small>Remove a course with ×</small></div><div className="course-list">
            {tt.courses.map((c) => <div className="course-chip" key={c.id}><span className="course-chip-color" style={{ background: c.color }} /><div className="course-chip-text"><b>{c.code || c.title || "Untitled course"}</b><small>{c.title && c.code ? c.title : c.slots.join(" + ")} · {c.credits} cr</small></div><button className="course-edit-btn" type="button" onClick={() => beginEditCredits(c)} title={`Edit credits for ${c.code || c.title}`}>Edit</button><button className="icon-button" onClick={() => removeCourse(c.id)} title={`Remove ${c.code || c.title}`}>×</button></div>)}
          </div></div>}
        </section>

        <section className="schedule-section">
          <div className="schedule-top"><div><div className="eyebrow">WEEKLY VIEW</div><h2>Your timetable</h2><p className="mut">Tap an available slot tag to add it to the course form above.</p></div><div className="schedule-badges"><span className="pill"><span className="pill-dot" /> {tt.courses.length} courses</span><span className="pill">{credits} credits</span></div></div>
          <div className="rule-toolbar">
            <span className="toolbar-label">PREFERENCES</span>
            <label className="sw"><input type="checkbox" checked={!!rules.no8} onChange={() => setRule("no8")} /><i />No 8 AM classes</label>
            <label className="sw"><input type="checkbox" checked={!!rules.noNight} onChange={() => setRule("noNight")} /><i />No night classes (after 7 PM)</label>
            <span className="rule-help">Violations are outlined in red</span>
          </div>
          {bad.length > 0 && <div className="warn">⚠ <b>Rule conflicts:</b> {bad.map((c) => `${c.code || c.title} (${ruleHits(c, rules).join(", ")})`).join("; ")}</div>}
          <div className="tw">
            <table className="timetable timetable-split-view">
              <colgroup>
                <col className="day-col" />
                <col className="class-col" />
                {TM.map((h, i) => <col key={`${h}-${i}`} className={h === "LUNCH" ? "lunch-col" : "time-col"} />)}
              </colgroup>
              <thead>
                <tr className="timing-row theory-timing-row">
                  <th className="timing-category theory-time-category" rowSpan={2}>THEORY</th>
                  <th className="timing-label">Start</th>
                  {THEORY_START.map((time, i) => <th key={`theory-start-${i}`} className={TM[i] === "LUNCH" ? "lun timing-lunch" : "timing-value"}>{time}</th>)}
                </tr>
                <tr className="timing-row theory-timing-row">
                  <th className="timing-label">End</th>
                  {THEORY_END.map((time, i) => <th key={`theory-end-${i}`} className={TM[i] === "LUNCH" ? "lun timing-lunch" : "timing-value"}>{time}</th>)}
                </tr>
                <tr className="timing-row lab-timing-row">
                  <th className="timing-category lab-time-category" rowSpan={2}>LAB</th>
                  <th className="timing-label">Start</th>
                  {LAB_START.map((time, i) => <th key={`lab-start-${i}`} className={TM[i] === "LUNCH" ? "lun timing-lunch" : "timing-value"}>{time}</th>)}
                </tr>
                <tr className="timing-row lab-timing-row">
                  <th className="timing-label">End</th>
                  {LAB_END.map((time, i) => <th key={`lab-end-${i}`} className={TM[i] === "LUNCH" ? "lun timing-lunch" : "timing-value"}>{time}</th>)}
                </tr>
              </thead>
              <tbody>
                {DAYS.map((d) => (
                  <Fragment key={d}>
                    <tr className="theory-schedule-row">
                      <td className="day-name" rowSpan={2}>{d}</td>
                      <td className="class-type theory-type">THEORY</td>
                      {TH[d].map((slot, i) => {
                        if (TM[i] === "LUNCH") return <td key={`theory-lunch-${i}`} className="lun lunch-cell"><span>LUNCH</span></td>;
                        const course = slot !== "-" && slot !== "|" ? tt.courses.find((candidate) => candidate.slots.includes(slot)) : null;
                        const slotTag = slot !== "-" && slot !== "|"
                          ? <button type="button" key={slot} className={`tag${!course && parsedSlots.includes(slot) ? " on" : ""}`} disabled={Boolean(course)} onClick={() => toggle(slot)} title={course ? "This time is occupied" : `Use slot ${slot}`}>{slot}</button>
                          : <span className="slot-dash">-</span>;
                        return <td key={`theory-${i}`}><div className={`cell ${course ? "filled" : "empty"}${course && cols.includes(i) ? " viol" : ""}`} style={course ? { background: course.color } : undefined}><div className="tags">{slotTag}</div>{course && <><b title={course.title || course.code}>{course.title || course.code}</b><i title={course.faculty}>{course.faculty}</i>{course.venue && <i title={course.venue}>{course.venue}</i>}<span className="cell-code">{course.code} · {course.credits} cr</span></>}</div></td>;
                      })}
                    </tr>
                    <tr className="lab-schedule-row">
                      <td className="class-type lab-type">LAB</td>
                      {LB[d].map((slot, i) => {
                        if (TM[i] === "LUNCH") return <td key={`lab-lunch-${i}`} className="lun lunch-cell"><span>LUNCH</span></td>;
                        const course = slot !== "-" && slot !== "|" ? tt.courses.find((candidate) => candidate.slots.includes(slot)) : null;
                        const slotTag = slot !== "-" && slot !== "|"
                          ? <button type="button" key={slot} className={`tag${!course && parsedSlots.includes(slot) ? " on" : ""}`} disabled={Boolean(course)} onClick={() => toggle(slot)} title={course ? "This time is occupied" : `Use slot ${slot}`}>{slot}</button>
                          : <span className="slot-dash">-</span>;
                        return <td key={`lab-${i}`}><div className={`cell ${course ? "filled" : "empty"}${course && cols.includes(i) ? " viol" : ""}`} style={course ? { background: course.color } : undefined}><div className="tags">{slotTag}</div>{course && <><b title={course.title || course.code}>{course.title || course.code}</b><i title={course.faculty}>{course.faculty}</i>{course.venue && <i title={course.venue}>{course.venue}</i>}<span className="cell-code">{course.code} · {course.credits} cr</span></>}</div></td>;
                      })}
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div className="schedule-legend"><span><i className="legend-swatch selected" /> Course added</span><span><i className="legend-swatch available" /> Available slot</span><span><i className="legend-swatch conflict" /> Rule conflict</span><span className="legend-spacer" /><span>Tip: combine slots with <b>+</b> (example: A1+TA1)</span></div>
        </section>
        <section className="credit-summary" aria-live="polite">
          <div className="credit-summary-icon" aria-hidden="true">✦</div>
          <div className="credit-summary-copy"><span className="eyebrow">AT A GLANCE</span><h2>Credits in this timetable</h2><p className="mut">Total credits for the subjects you have added.</p></div>
          <div className="credit-summary-value"><b>{credits}</b><span>{credits === 1 ? "credit" : "credits"}</span></div>
          <div className="credit-summary-divider" />
          <div className="credit-summary-courses"><b>{tt.courses.length}</b><span>{tt.courses.length === 1 ? "subject registered" : "subjects registered"}</span></div>
        </section>
      </div>
      <CollaborateModal open={collabOpen} pendingRoomId={pendingRoomId} canCreate={!activeCollab} busy={collabBusy} error={collabError} firebaseConfigured={firebaseConfigured} timetable={tt} onClose={closeCollab} onCreate={createCollab} onJoin={joinCollab} onClearError={clearCollabError} />
      {editingCreditsFor && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditingCreditsFor(null); }}><section className="app-modal credits-modal" role="dialog" aria-modal="true" aria-labelledby="edit-credits-title"><div className="modal-heading"><div><span className="eyebrow">COURSE DETAILS</span><h2 id="edit-credits-title">Edit course credits</h2><p className="mut">Correct the credit value without removing this subject.</p></div><button type="button" className="icon-button modal-close" onClick={() => setEditingCreditsFor(null)} aria-label="Close edit credits">×</button></div><form onSubmit={saveEditedCredits}><label className="modal-field">Credits<input autoFocus type="number" min="0" max="50" step="0.5" value={editedCredits} onChange={(event) => { setEditedCredits(event.target.value); setEditCreditsError(""); }} /></label>{editCreditsError && <p className="err" role="alert">{editCreditsError}</p>}<div className="modal-actions"><button type="button" className="btn s ghost-btn" onClick={() => setEditingCreditsFor(null)}>Cancel</button><button type="submit" className="btn p" disabled={!editedCredits.trim()}>Save credits</button></div></form><p className="modal-footnote">{activeCollab ? "Saved credits sync to everyone in this room immediately." : "The timetable total updates automatically after saving."}</p></section></div>}
      <TutorialModal open={tutorialOpen} onClose={closeTutorial} />
    </>
  );
}

function TutorialModal({ open, onClose }) {
  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  const invalidConfiguredUrl = Boolean(TUTORIAL_YOUTUBE_URL && !TUTORIAL_YOUTUBE_EMBED_URL);
  return createPortal(
    <div className="modal-backdrop tutorial-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="app-modal tutorial-modal" role="dialog" aria-modal="true" aria-labelledby="tutorial-modal-title">
        <div className="modal-heading">
          <div><span className="eyebrow">QUICK START GUIDE</span><h2 id="tutorial-modal-title">Add your own course and faculty list</h2><p className="mut">A short walkthrough from VTOP to your searchable FFCS dropdown.</p></div>
          <button type="button" className="icon-button modal-close" onClick={onClose} aria-label="Close tutorial">×</button>
        </div>
        <div className="tutorial-video-frame">
          {TUTORIAL_YOUTUBE_EMBED_URL ? (
            <iframe
              title="FFCS custom course and faculty import tutorial"
              src={TUTORIAL_YOUTUBE_EMBED_URL}
              loading="lazy"
              referrerPolicy="strict-origin-when-cross-origin"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
            />
          ) : (
            <div className="tutorial-video-placeholder">
              <span className="tutorial-play-icon">▶</span>
              <b>{invalidConfiguredUrl ? "Check your YouTube link" : "Course import walkthrough"}</b>
              <span>{invalidConfiguredUrl
                ? "Use a YouTube watch, youtu.be, Shorts, or embed link in VITE_TUTORIAL_YOUTUBE_URL."
                : "The tutorial video is configured. If it does not load, open it directly on YouTube."}</span>
              <code>https://youtu.be/0gD5SaLifac</code>
            </div>
          )}
        </div>
        {invalidConfiguredUrl && <div className="tutorial-storage-note" role="status"><b>Invalid YouTube URL</b><p>Use the full video URL from YouTube. Update VITE_TUTORIAL_YOUTUBE_URL in .env.local, restart Vite, and add the same variable in Vercel before redeploying.</p></div>}
        <div className="tutorial-steps">
          <div className="tutorial-step"><span>1</span><div><b>Sign in to VTOP</b><p>Open VTOP yourself and sign in with your own credentials. Never share your password or OTP.</p></div></div>
          <div className="tutorial-step"><span>2</span><div><b>Open the subject's faculty / class list</b><p>Find the table containing Slot Detail, Venue, Faculty and Course Type.</p></div></div>
          <div className="tutorial-step"><span>3</span><div><b>Copy the table rows</b><p>Include the header row and the available offerings. Copy the table from VTOP.</p></div></div>
          <div className="tutorial-step"><span>4</span><div><b>Paste into FFCS Planner</b><p>Under “Import your own subject faculty list”, enter the subject name and paste the copied table.</p></div></div>
          <div className="tutorial-step"><span>5</span><div><b>Parse and save the subject</b><p>Click “Parse and save subject”. The valid rows become searchable faculty / class options. Select one and enter course credits manually.</p></div></div>
        </div>
        <div className="tutorial-footer"><button type="button" className="btn p" onClick={onClose}>Got it</button></div>
      </section>
    </div>,
    document.body
  );
}

function CollaborateModal({ open, pendingRoomId, canCreate, busy, error, firebaseConfigured, timetable, onClose, onCreate, onJoin, onClearError }) {
  const [code, setCode] = useState("");
  useEffect(() => {
    if (open) {
      setCode("");
      onClearError?.();
    }
  }, [open, pendingRoomId]);

  // Mount the collaboration dialog directly under <body>, not inside the
  // planner layout. This keeps it above every page section and avoids parent
  // overflow/stacking contexts making it appear at the bottom of the page.
  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, busy]);

  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop collab-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="app-modal collab-modal" role="dialog" aria-modal="true" aria-labelledby="collab-modal-title">
        <div className="modal-heading">
          <div><span className="eyebrow">WORK ON IT TOGETHER</span><h2 id="collab-modal-title">Collaborate on a timetable</h2><p className="mut">Create a shared room or join one with a link and code. Changes sync live for everyone.</p></div>
          <button type="button" className="icon-button modal-close" onClick={onClose} disabled={busy} aria-label="Close collaboration">×</button>
        </div>
        {!firebaseConfigured && <div className="collab-setup-notice"><b>One-time setup needed</b><p>Live collaboration needs Firebase configured, Firestore rules published, and Anonymous sign-in enabled. Your regular local planner will continue to work without it.</p></div>}
        {pendingRoomId && <div className="join-link-notice"><span>INVITED TO A ROOM</span><b>{pendingRoomId.slice(0, 8)}…</b><small>Enter the 8-character code shared by the room owner.</small></div>}
        {canCreate && timetable && <div className="collab-create-option"><div className="collab-option-icon">✦</div><div><b>Create a room for this timetable</b><p>Generate a private room code and shareable link.</p></div><button type="button" className="btn p" onClick={() => onCreate(timetable)} disabled={busy || !firebaseConfigured}>{busy ? "Creating…" : "Create room"}</button></div>}
        <div className="modal-or"><span /> OR JOIN AN EXISTING ROOM <span /></div>
        <form onSubmit={(event) => { event.preventDefault(); onJoin(code); }}>
          <label className="modal-field">8-character room code<input value={code} onChange={(event) => { setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8)); onClearError?.(); }} placeholder="e.g. 7KPM4XQ9" autoComplete="off" maxLength={8} /></label>
          <button type="submit" className="btn s collab-join-btn" disabled={busy || code.length < 8 || !firebaseConfigured}>{busy ? "Connecting…" : "Join shared timetable"}</button>
        </form>
        {error && <p className="err collab-modal-error" role="alert">{error}</p>}
        <p className="modal-footnote">Anyone with the share link and room code can join. Only share both with people you trust.</p>
      </section>
    </div>,
    document.body
  );
}

export default App;
