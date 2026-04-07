// ============================================================
//  AURA & EARTH — firebase.js
//  Production-ready Firebase initialization for vanilla JS
//  Used across all pages that need Firestore or Auth.
//  Firebase CDN + ES modules (type="module")
// ============================================================

// js/firebase.js - Clean & Production Ready
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyAbYraBGiembP3M7sRqUu_3rrXtADtHLd0",
    authDomain: "aura-and-earth-3c56e.firebaseapp.com",
    projectId: "aura-and-earth-3c56e",
    messagingSenderId: "361283340360",
    appId: "1:361283340360:web:82018780ddfc47f91ff07d"
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);

export function handleFirebaseError(error) {
    console.error("Firebase Error:", error.code, error.message);
    return error.message || "Authentication failed. Please try again.";
}

