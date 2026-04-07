/* ============================================================
   AURA & EARTH — admin.js
   Production-ready Admin Login Logic
   ============================================================ */

import { auth } from './firebase.js';
import {
    signInWithEmailAndPassword,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

/* ── Global Auth Guard ─────────────────────────────────────── */
onAuthStateChanged(auth, user => {
    if (user) {
        // Optional: You can check custom claim 'role' later for extra security
        window.location.replace('dashboard.html');
    }
});

/* ── DOM Elements ──────────────────────────────────────────── */
const loginForm = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');
const loginBtn = document.getElementById('loginBtn');
const togglePwdBtn = document.getElementById('togglePwd');

/* ── Login Form Handler ────────────────────────────────────── */
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const email = document.getElementById('adminEmail').value.trim();
    const password = document.getElementById('adminPassword').value;

    // Reset UI
    loginError.hidden = true;
    loginError.textContent = '';

    if (!email || !password) {
        loginError.textContent = "Please enter both email and password.";
        loginError.hidden = false;
        return;
    }

    // Loading state
    const originalBtnText = loginBtn.innerHTML;
    loginBtn.disabled = true;
    loginBtn.innerHTML = '<span>Signing in…</span> <i class="fa-solid fa-spinner fa-spin"></i>';

    try {
        await signInWithEmailAndPassword(auth, email, password);
        // onAuthStateChanged will handle redirect automatically
    } catch (err) {
        console.error("Login Error:", err.code);
        loginError.textContent = getFriendlyAuthError(err.code);
        loginError.hidden = false;
    } finally {
        // Reset button only on error
        if (loginError.hidden === false) {
            loginBtn.disabled = false;
            loginBtn.innerHTML = originalBtnText;
        }
    }
});

/* ── Password Visibility Toggle ────────────────────────────── */
togglePwdBtn.addEventListener('click', function () {
    const passwordInput = document.getElementById('adminPassword');
    const icon = this.querySelector('i');

    if (passwordInput.type === 'password') {
        passwordInput.type = 'text';
        icon.className = 'fa-solid fa-eye-slash';
    } else {
        passwordInput.type = 'password';
        icon.className = 'fa-solid fa-eye';
    }
});

/* ── Friendly Error Messages ───────────────────────────────── */
function getFriendlyAuthError(code) {
    const errorMap = {
        'auth/invalid-email': 'Please enter a valid email address.',
        'auth/user-not-found': 'Invalid email or password.',
        'auth/wrong-password': 'Invalid email or password.',
        'auth/invalid-credential': 'Invalid email or password.',
        'auth/too-many-requests': 'Too many failed attempts. Please wait a few minutes before trying again.',
        'auth/network-request-failed': 'Network error. Please check your internet connection.',
        'auth/user-disabled': 'This account has been disabled. Contact support.',
    };

    return errorMap[code] || `Login failed. Please try again. (${code})`;
}

// Prevent form submission on Enter if fields are empty (extra safety)
loginForm.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const email = document.getElementById('adminEmail').value.trim();
        const password = document.getElementById('adminPassword').value;
        if (!email || !password) {
            e.preventDefault();
        }
    }
});