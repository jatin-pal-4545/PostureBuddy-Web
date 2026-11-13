
import { auth, db } from "./firebase.js";

import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    updateProfile,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";

import {
    doc,
    setDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";


// Get HTML elements
const loginForm = document.getElementById("loginForm");
const signupForm = document.getElementById("signupForm");

const showSignup = document.getElementById("showSignup");
const showLogin = document.getElementById("showLogin");

const loginMessage = document.getElementById("loginMessage");
const signupMessage = document.getElementById("signupMessage");

let submitting = false;


// Display messages
function showMessage(element, message, success = false) {
    element.textContent = message;
    element.classList.toggle("success", success);
}


// Switch between login and signup
showSignup.addEventListener("click", () => {
    loginForm.classList.add("hidden");
    signupForm.classList.remove("hidden");

    showMessage(loginMessage, "");
    showMessage(signupMessage, "");
});

showLogin.addEventListener("click", () => {
    signupForm.classList.add("hidden");
    loginForm.classList.remove("hidden");

    showMessage(loginMessage, "");
    showMessage(signupMessage, "");
});


// Firebase authentication error messages
function getErrorMessage(error) {
    switch (error.code) {
        case "auth/email-already-in-use":
            return "This email is already registered.";

        case "auth/invalid-email":
            return "Please enter a valid email address.";

        case "auth/weak-password":
            return "Password must contain at least 6 characters.";

        case "auth/invalid-credential":
            return "Incorrect email or password.";

        case "auth/user-not-found":
            return "No account found with this email.";

        case "auth/wrong-password":
            return "Incorrect password.";

        case "auth/too-many-requests":
            return "Too many attempts. Please try again later.";

        default:
            return "Something went wrong. Please try again.";
    }
}


// LOGIN
loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;

    const button = loginForm.querySelector(".auth-button");

    submitting = true;
    button.disabled = true;
    button.textContent = "Logging in...";

    showMessage(loginMessage, "");

    try {
        await signInWithEmailAndPassword(auth, email, password);

        window.location.replace("dashboard.html");

    } catch (error) {
        console.error("Login error:", error);

        showMessage(loginMessage, getErrorMessage(error));

        submitting = false;
        button.disabled = false;
        button.textContent = "Login";
    }
});


// SIGNUP
signupForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const name = document.getElementById("signupName").value.trim();
    const email = document.getElementById("signupEmail").value.trim();

    const password = document.getElementById("signupPassword").value;
    const confirmPassword = document.getElementById("signupConfirmPassword").value;

    const button = signupForm.querySelector(".auth-button");

    showMessage(signupMessage, "");

    // Validate passwords
    if (password !== confirmPassword) {
        showMessage(signupMessage, "Passwords do not match.");
        return;
    }

    if (password.length < 6) {
        showMessage(signupMessage, "Password must contain at least 6 characters.");
        return;
    }

    submitting = true;
    button.disabled = true;
    button.textContent = "Creating account...";

    try {
        // Create Firebase account
        const result = await createUserWithEmailAndPassword(
            auth,
            email,
            password
        );

        const user = result.user;

        // Save user's display name
        await updateProfile(user, {
            displayName: name
        });

        // Save user information in Firestore
        await setDoc(doc(db, "users", user.uid), {
            name: name,
            email: email,
            createdAt: serverTimestamp()
        });

        showMessage(signupMessage, "Account created successfully!", true);

        // Open dashboard
        window.location.replace("dashboard.html");

    } catch (error) {
        console.error("Signup error:", error);

        showMessage(
            signupMessage,
            error.code ? getErrorMessage(error) :
            "Account created, but profile saving failed. Check Firestore rules."
        );

        submitting = false;
        button.disabled = false;
        button.textContent = "Create Account";
    }
});


// Redirect users who are already logged in
onAuthStateChanged(auth, (user) => {
    if (user && !submitting) {
        window.location.replace("dashboard.html");
    }
});

console.log("Posture Buddy authentication loaded!");
