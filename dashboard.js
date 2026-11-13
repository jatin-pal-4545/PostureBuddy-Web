
import { auth, db } from "./firebase.js";

import {
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";

import {
    collection,
    doc,
    setDoc,
    addDoc,
    serverTimestamp,
    query,
    orderBy,
    limit,
    onSnapshot
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

import {
    FilesetResolver,
    PoseLandmarker
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/vision_bundle.mjs";


// ====================================
// CONFIGURATION
// ====================================

const MODEL_URL =
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const WASM_URL =
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm";

const BAD_THRESHOLD = 12;
const CALIBRATION_TIME = 5000;
const NOTIFICATION_INTERVAL = 10000;
const INFERENCE_INTERVAL = 120;
const SAVE_INTERVAL = 5000;


// ====================================
// HTML ELEMENTS
// ====================================

const video = document.getElementById("cameraVideo");
const placeholder = document.getElementById("cameraPlaceholder");

const startButton = document.getElementById("startMonitoringBtn");
const stopButton = document.getElementById("stopMonitoringBtn");
const logoutButton = document.getElementById("logoutBtn");

const postureStatus = document.getElementById("postureStatus");
const postureIndicator = document.getElementById("postureIndicator");

const monitoringStatus = document.getElementById("monitoringStatus");
const monitoringText = document.getElementById("monitoringText");

const cameraStatus = document.getElementById("cameraStatus");
const cameraStatusText = document.getElementById("cameraStatusText");


// ====================================
// APPLICATION STATE
// ====================================

let currentUser = null;

let cameraStream = null;
let poseLandmarker = null;

let animationId = null;
let saveInterval = null;

let unsubscribeNotifications = null;
let currentSessionRef = null;

let monitoring = false;
let savingSession = false;

let goodSeconds = 0;
let badSeconds = 0;

let baselineAngle = null;
let calibrationSamples = [];
let calibrationStartedAt = 0;

let badStartedAt = null;
let lastBadNotificationAt = null;

let lastInferenceAt = 0;
let lastCountAt = 0;
let lastVideoTime = -1;

let lastDebugLogAt = 0;

let currentStatus = "WAITING";
let statusStartedAt = 0;


// ====================================
// TIME FORMATTING
// ====================================

function formatTime(seconds) {

    seconds = Math.floor(seconds || 0);

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    return (
        String(hours).padStart(2, "0") + ":" +
        String(minutes).padStart(2, "0") + ":" +
        String(secs).padStart(2, "0")
    );
}


// ====================================
// WEBSITE TOAST NOTIFICATIONS
// ====================================

function showToast(title, message) {

    const container = document.getElementById("toastContainer");

    const toast = document.createElement("div");
    toast.className = "toast";

    const icon = document.createElement("div");
    icon.className = "toast-icon";
    icon.textContent = "!";

    const content = document.createElement("div");
    content.className = "toast-content";

    const heading = document.createElement("h4");
    heading.textContent = title;

    const text = document.createElement("p");
    text.textContent = message;

    content.append(heading, text);

    const close = document.createElement("button");
    close.className = "toast-close";
    close.textContent = "×";

    close.onclick = () => removeToast(toast);

    toast.append(icon, content, close);
    container.appendChild(toast);

    setTimeout(() => removeToast(toast), 5000);
}


function removeToast(toast) {

    if (!toast.isConnected) return;

    toast.classList.add("hide");

    setTimeout(() => toast.remove(), 300);
}


// ====================================
// USER PROFILE
// ====================================

function displayUser(user) {

    const name = user.displayName || "Posture Buddy User";

    document.getElementById("userName").textContent = name;

    document.getElementById("userEmail").textContent = user.email || "";

    document.getElementById("userAvatar").textContent =
        name.charAt(0).toUpperCase();

}


// ====================================
// STATUS DISPLAY
// ====================================

function updateStatus(status) {

    if (currentStatus !== status) {
        currentStatus = status;
        statusStartedAt = performance.now();
    }

    postureStatus.textContent = status;

    postureIndicator.classList.remove("good", "bad");

    if (status === "GOOD POSTURE") {
        postureIndicator.classList.add("good");
    }

    if (status === "BAD POSTURE") {
        postureIndicator.classList.add("bad");
    }
}


function updateMonitoringUI(active) {

    monitoringStatus.classList.toggle("inactive", !active);
    cameraStatus.classList.toggle("inactive", !active);

    monitoringText.textContent =
        active ? "Monitoring Active" : "Monitoring Stopped";

    cameraStatusText.textContent =
        active ? "Camera Connected" : "Camera Not Started";
}


// ====================================
// DASHBOARD TIMERS AND ANALYTICS
// ====================================

function updateDashboard() {

    const totalSeconds = goodSeconds + badSeconds;

    document.getElementById("goodTime").textContent =
        formatTime(goodSeconds);

    document.getElementById("badTime").textContent =
        formatTime(badSeconds);

    document.getElementById("totalTime").textContent =
        formatTime(totalSeconds);

    const score = totalSeconds > 0
        ? Math.round((goodSeconds / totalSeconds) * 100)
        : 0;

    document.getElementById("postureScore").textContent =
        score + "%";

    const badPercentage = totalSeconds > 0
        ? Math.round((badSeconds / totalSeconds) * 100)
        : 0;

    const goodPercentage = totalSeconds > 0
        ? 100 - badPercentage
        : 0;

    document.getElementById("goodPercentage").textContent =
        goodPercentage + "%";

    document.getElementById("badPercentage").textContent =
        badPercentage + "%";

    document.getElementById("goodProgress").style.width =
        goodPercentage + "%";

    document.getElementById("badProgress").style.width =
        badPercentage + "%";

    document.getElementById("donutPercentage").textContent =
        goodPercentage + "%";

    document.getElementById("postureDonut").style.background =
        `conic-gradient(#35A66B 0% ${goodPercentage}%, #EF6475 ${goodPercentage}% 100%)`;

    const currentDuration =
        monitoring &&
        (currentStatus === "GOOD POSTURE" ||
         currentStatus === "BAD POSTURE")
            ? (performance.now() - statusStartedAt) / 1000
            : 0;

    document.getElementById("currentDuration").textContent =
        formatTime(currentDuration);
}


// ====================================
// CALCULATE POSTURE ANGLE
// ====================================

function calculateAngle(ear, shoulder, hip) {

    const width = video.videoWidth;
    const height = video.videoHeight;

    const ax = (ear.x - shoulder.x) * width;
    const ay = (ear.y - shoulder.y) * height;

    const bx = (hip.x - shoulder.x) * width;
    const by = (hip.y - shoulder.y) * height;

    const dot = ax * bx + ay * by;

    const magA = Math.hypot(ax, ay);
    const magB = Math.hypot(bx, by);

    if (magA === 0 || magB === 0) return null;

    let cosine = dot / (magA * magB);

    cosine = Math.max(-1, Math.min(1, cosine));

    return Math.acos(cosine) * (180 / Math.PI);
}


// ====================================
// FIND VISIBLE BODY LANDMARKS
// ====================================


function getPostureAngle(landmarks) {

    const sides = [
        [7, 11], // Left ear and shoulder
        [8, 12]  // Right ear and shoulder
    ];

    const candidates = [];

    for (const [earIndex, shoulderIndex] of sides) {

        const ear = landmarks[earIndex];
        const shoulder = landmarks[shoulderIndex];

        if (!ear || !shoulder) continue;

        const earVisibility = ear.visibility ?? 1;
        const shoulderVisibility = shoulder.visibility ?? 1;

        if (
            earVisibility < 0.5 ||
            shoulderVisibility < 0.5
        ) {
            continue;
        }

        const dx = (ear.x - shoulder.x) * video.videoWidth;
        const dy = (shoulder.y - ear.y) * video.videoHeight;

        if (Math.abs(dy) < 1) continue;

        // Angle of ear-to-shoulder line relative to vertical
        const angle = Math.atan2(
            Math.abs(dx),
            Math.abs(dy)
        ) * (180 / Math.PI);

        candidates.push({
            angle: angle,
            visibility: earVisibility + shoulderVisibility
        });
    }

    if (candidates.length === 0) return null;

    candidates.sort(
        (a, b) => b.visibility - a.visibility
    );

    return candidates[0].angle;
}



// ====================================
// MEDIAN CALIBRATION
// ====================================

function getMedian(values) {

    const sorted = [...values].sort((a, b) => a - b);

    const middle = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
        return (sorted[middle - 1] + sorted[middle]) / 2;
    }

    return sorted[middle];
}


// ====================================
// LOAD AI MODEL
// ====================================

async function loadPoseLandmarker() {

    const vision = await FilesetResolver.forVisionTasks(WASM_URL);

    return await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: MODEL_URL
        },

        runningMode: "VIDEO",

        numPoses: 1
    });
}


// ====================================
// FIREBASE SESSION STORAGE
// ====================================

async function createSession() {

    if (!currentUser) return;

    const sessionsRef = collection(
        db,
        "users",
        currentUser.uid,
        "sessions"
    );

    currentSessionRef = doc(sessionsRef);

    await setDoc(currentSessionRef, {

        startedAt: serverTimestamp(),

        updatedAt: serverTimestamp(),

        goodSeconds: 0,
        badSeconds: 0,
        totalSeconds: 0,

        postureScore: 0,

        status: "CALIBRATING"

    });
}


async function saveSession(ended = false) {

    if (!currentSessionRef || savingSession) return;

    savingSession = true;

    const totalSeconds = goodSeconds + badSeconds;

    const score = totalSeconds > 0
        ? Math.round((goodSeconds / totalSeconds) * 100)
        : 0;

    const data = {

        goodSeconds: Math.floor(goodSeconds),
        badSeconds: Math.floor(badSeconds),
        totalSeconds: Math.floor(totalSeconds),

        postureScore: score,

        status: ended ? "STOPPED" : currentStatus,

        baselineAngle: baselineAngle,

        updatedAt: serverTimestamp()

    };

    if (ended) {
        data.endedAt = serverTimestamp();
    }

    try {

        await setDoc(currentSessionRef, data, { merge: true });

    } catch (error) {

        console.error("Session saving error:", error);

        showToast(
            "Database error",
            "Your posture session could not be saved."
        );

    } finally {

        savingSession = false;

    }
}


// ====================================
// FIREBASE NOTIFICATIONS
// ====================================

async function sendBadPostureNotification() {

    if (!currentUser) return;

    const notification = {

        type: "BAD",

        title: "Incorrect posture detected",

        message: "Please straighten your back and sit properly.",

        createdAt: serverTimestamp()

    };

    // Show website alert immediately
    showToast(
        notification.title,
        notification.message
    );

    // Save notification in the user's Firebase account
    try {

        await addDoc(
            collection(
                db,
                "users",
                currentUser.uid,
                "notifications"
            ),

            notification
        );

    } catch (error) {

        console.error("Notification saving error:", error);

    }
}


// ====================================
// RECENT NOTIFICATIONS
// ====================================

function displayNotifications(records) {

    const list = document.getElementById("notificationList");

    list.replaceChildren();

    if (records.length === 0) {

        list.textContent = "No notifications yet.";

        return;
    }

    records.forEach(item => {

        const notification = document.createElement("div");
        notification.className = "notification";

        const icon = document.createElement("div");
        icon.className = "notification-icon";

        const content = document.createElement("div");

        if (item.type === "BAD") {

            icon.classList.add("red");
            icon.textContent = "!";

        } else {

            icon.classList.add("green");
            icon.textContent = "✓";

        }

        const heading = document.createElement("h4");
        heading.textContent = item.title;

        const message = document.createElement("p");
        message.textContent = item.message;

        const time = document.createElement("small");

        if (item.createdAt?.toDate) {

            time.textContent = item.createdAt
                .toDate()
                .toLocaleString("en-IN");

        } else {

            time.textContent = "Just now";

        }

        content.append(heading, message, time);

        notification.append(icon, content);

        list.appendChild(notification);

    });
}


function listenForNotifications() {

    if (unsubscribeNotifications) {
        unsubscribeNotifications();
    }

    const notificationsRef = collection(
        db,
        "users",
        currentUser.uid,
        "notifications"
    );

    const latestQuery = query(
        notificationsRef,
        orderBy("createdAt", "desc"),
        limit(10)
    );

    unsubscribeNotifications = onSnapshot(
        latestQuery,

        snapshot => {

            const records = snapshot.docs.map(
                document => document.data()
            );

            displayNotifications(records);

        },

        error => {

            console.error("Notification listener error:", error);

        }
    );
}


// ====================================
// PROCESS CAMERA FRAMES
// ====================================

function processFrame() {

    if (!monitoring) return;

    animationId = requestAnimationFrame(processFrame);

    const now = performance.now();

    if (now - lastInferenceAt < INFERENCE_INTERVAL) return;

    if (
        video.readyState < 2 ||
        video.currentTime === lastVideoTime
    ) {
        return;
    }

    lastInferenceAt = now;
    lastVideoTime = video.currentTime;

    try {

        const result = poseLandmarker.detectForVideo(video, now);

        // TEMPORARY AI DIAGNOSTIC
if (now - lastDebugLogAt > 2000) {

    const landmarks = result.landmarks?.[0];

    console.log("POSTURE AI DIAGNOSTIC:", {
        cameraWidth: video.videoWidth,
        cameraHeight: video.videoHeight,
        poseDetected: !!landmarks,
        landmarkCount: landmarks?.length || 0
    });

    if (landmarks) {

        console.table(
            [7, 8, 11, 12, 23, 24].map(index => ({
                landmarkIndex: index,
                x: landmarks[index].x,
                y: landmarks[index].y,
                visibility: landmarks[index].visibility,
                presence: landmarks[index].presence
            }))
        );

    }

    lastDebugLogAt = now;
}

        const landmarks = result.landmarks?.[0];

        if (!landmarks) {

            updateStatus("BODY NOT DETECTED");

            badStartedAt = null;
            lastBadNotificationAt = null;

            lastCountAt = now;

            return;
        }

        const angle = getPostureAngle(landmarks);

        if (angle === null) {

            updateStatus("BODY NOT DETECTED");

            lastCountAt = now;

            return;
        }


        // CALIBRATION
        if (baselineAngle === null) {

            calibrationSamples.push(angle);

            if (
                now - calibrationStartedAt >= CALIBRATION_TIME &&
                calibrationSamples.length >= 15
            ) {

                baselineAngle = getMedian(calibrationSamples);

                updateStatus("GOOD POSTURE");

                lastCountAt = now;

                showToast(
                    "Calibration complete",
                    "Your normal posture has been recorded."
                );

            } else {

                updateStatus("CALIBRATING");

            }

            return;
        }


        // COMPARE WITH BASELINE
        const difference = Math.abs(angle - baselineAngle);

        const badPosture = difference > BAD_THRESHOLD;

        // Time since previous valid measurement
        const delta = Math.min(
            Math.max((now - lastCountAt) / 1000, 0),
            0.25
        );

        lastCountAt = now;


        if (badPosture) {

            updateStatus("BAD POSTURE");

            badSeconds += delta;

            if (badStartedAt === null) {
                badStartedAt = now;
                lastBadNotificationAt = null;
            }

            // Send an alert every 10 seconds of continuous bad posture
            if (
                now - badStartedAt >= NOTIFICATION_INTERVAL &&
                (
                    lastBadNotificationAt === null ||
                    now - lastBadNotificationAt >= NOTIFICATION_INTERVAL
                )
            ) {

                lastBadNotificationAt = now;

                sendBadPostureNotification();

            }

        } else {

            updateStatus("GOOD POSTURE");

            goodSeconds += delta;

            badStartedAt = null;
            lastBadNotificationAt = null;

        }

        updateDashboard();

    } catch (error) {

        console.error("Pose detection error:", error);

        updateStatus("DETECTION ERROR");

    }
}


// ====================================
// START MONITORING
// ====================================

async function startMonitoring() {

    if (!currentUser || monitoring) return;

    startButton.disabled = true;

    startButton.textContent = "Starting...";

    try {

        if (!navigator.mediaDevices?.getUserMedia) {

            throw new Error(
                "Camera access requires HTTPS or localhost."
            );

        }

        // Request camera permission
        cameraStream = await navigator.mediaDevices.getUserMedia({

            video: {
                facingMode: { ideal: "user" },
                width: { ideal: 640 },
                height: { ideal: 480 }
            },

            audio: false

        });

        video.srcObject = cameraStream;

        video.style.display = "block";

        await video.play();

        placeholder.classList.add("hidden");

        cameraStatusText.textContent = "Camera Connected";

        showToast(
            "Camera connected",
            "Your camera is ready for posture monitoring."
        );


        // Load MediaPipe AI
        showToast(
            "Loading AI",
            "Preparing the posture detection model."
        );

        poseLandmarker = await loadPoseLandmarker();


        // Reset session values
        goodSeconds = 0;
        badSeconds = 0;

        baselineAngle = null;
        calibrationSamples = [];

        badStartedAt = null;
        lastBadNotificationAt = null;

        lastInferenceAt = 0;
        lastCountAt = performance.now();
        lastVideoTime = -1;

        calibrationStartedAt = performance.now();

        updateStatus("CALIBRATING");

        updateDashboard();

        // Create Firebase session
        try {

            await createSession();

        } catch (error) {

            console.error("Could not create session:", error);

            showToast(
                "Database error",
                "Monitoring can run, but this session may not be saved."
            );

        }

        monitoring = true;

        startButton.disabled = true;
        startButton.textContent = "Monitoring Active";

        stopButton.disabled = false;

        updateMonitoringUI(true);

        // Save session periodically
        saveInterval = setInterval(
            () => saveSession(),
            SAVE_INTERVAL
        );

        // Begin AI detection
        animationId = requestAnimationFrame(processFrame);

        showToast(
            "Monitoring started",
            "Sit sideways to the camera so your ear, shoulder and hip are visible."
        );

    } catch (error) {

        console.error("Monitoring start error:", error);

        showToast(
            "Could not start monitoring",
            error.message || "Please check your camera and try again."
        );

        if (cameraStream) {

            cameraStream.getTracks().forEach(
                track => track.stop()
            );

            cameraStream = null;

        }

        video.srcObject = null;
        video.style.display = "none";

        placeholder.classList.remove("hidden");

        if (poseLandmarker) {

            poseLandmarker.close();
            poseLandmarker = null;

        }

        monitoring = false;

        startButton.disabled = false;
        startButton.textContent = "Start Monitoring";

        stopButton.disabled = true;

        updateMonitoringUI(false);

        updateStatus("WAITING");

    }
}


// ====================================
// STOP MONITORING
// ====================================

async function stopMonitoring() {

    if (saveInterval) {

        clearInterval(saveInterval);

        saveInterval = null;

    }

    monitoring = false;

    if (animationId !== null) {

        cancelAnimationFrame(animationId);

        animationId = null;

    }

    // Stop camera
    if (cameraStream) {

        cameraStream.getTracks().forEach(
            track => track.stop()
        );

        cameraStream = null;

    }

    video.srcObject = null;
    video.style.display = "none";

    placeholder.classList.remove("hidden");

    // Release AI model
    if (poseLandmarker) {

        poseLandmarker.close();

        poseLandmarker = null;

    }

    // Save final session
    if (currentSessionRef) {

        while (savingSession) {

            await new Promise(resolve => setTimeout(resolve, 50));

        }

        await saveSession(true);

        currentSessionRef = null;

    }

    startButton.disabled = false;
    startButton.textContent = "Start Monitoring";

    stopButton.disabled = true;

    updateMonitoringUI(false);

    updateStatus("WAITING");

    goodSeconds = 0;
    badSeconds = 0;

    baselineAngle = null;

    badStartedAt = null;
    lastBadNotificationAt = null;

    updateDashboard();

    showToast(
        "Monitoring stopped",
        "Your camera has been turned off."
    );

}


// ====================================
// EVENT LISTENERS
// ====================================

startButton.addEventListener(
    "click",
    startMonitoring
);

stopButton.addEventListener(
    "click",
    stopMonitoring
);


// Website notification button
document.getElementById("notificationPermissionBtn")
    .addEventListener("click", () => {

        showToast(
            "Website alerts enabled",
            "Bad posture reminders will appear here."
        );

    });


// Logout
logoutButton.addEventListener("click", async () => {

    await stopMonitoring();

    try {

        await signOut(auth);

        window.location.replace("index.html");

    } catch (error) {

        console.error("Logout error:", error);

    }

});


// ====================================
// FIREBASE AUTHENTICATION
// ====================================

onAuthStateChanged(auth, user => {

    if (!user) {

        window.location.replace("index.html");

        return;

    }

    currentUser = user;

    displayUser(user);

    listenForNotifications();

    console.log(
        "Posture Buddy ready for:",
        user.email
    );

});


// ====================================
// INITIALIZE DASHBOARD
// ====================================

const dateElement = document.getElementById("date");

dateElement.textContent = new Date().toLocaleDateString(
    "en-IN",
    {
        day: "numeric",
        month: "short",
        year: "numeric"
    }
);

updateDashboard();

updateMonitoringUI(false);

console.log("Posture Buddy dashboard loaded!");
