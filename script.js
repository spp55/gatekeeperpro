// ======================= CONFIG =======================
const GOOGLE_SCRIPT_URL  = 'https://script.google.com/macros/s/AKfycby3K40tiD3siohaYo1RjOzu_6lVYUyM_c7JRQ7FUyIhKemFH7CSco_-VlTs0H-naGCBWQ/exec';
const WINDOW_SECONDS     = 30;    // QR rotates every 30s
const GRACE_WINDOWS      = 3;     // Accept up to ~90s after scan
const GPS_RADIUS_METERS  = 100;   // Flag if outside this range
const PRESENT_CUTOFF_MIN = 10;    // 0–10 min  → Present
const LATE_CUTOFF_MIN    = 20;    // 10–20 min → Late  |  20+ → Blocked
const USE_COLOR_PIN      = true;  // Set false to disable color check
const MAX_RETRIES        = 3;
const RETRY_DELAY_MS     = 3000;
const SESSION_KEY        = 'sas_session';

const COLORS    = ['Red','Blue','Green','Orange','Purple','Yellow','Pink','Teal'];
const COLOR_HEX = {
    Red:'#ff4d6d', Blue:'#4d9eff', Green:'#00f5a0', Orange:'#ff9a3c',
    Purple:'#b44dff', Yellow:'#ffd60a', Pink:'#ff6eb4', Teal:'#00d4c8'
};


// ======================= HASH UTILS =======================

function hashString(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h) ^ str.charCodeAt(i);
        h = h >>> 0;
    }
    return h;
}

function getDeviceFingerprint() {
    const raw = [
        navigator.userAgent,
        navigator.language || '',
        screen.width + 'x' + screen.height,
        screen.colorDepth || 0,
        new Date().getTimezoneOffset(),
        navigator.hardwareConcurrency || 0,
        navigator.maxTouchPoints || 0,
        navigator.platform || ''
    ].join('|');
    const fp = String(hashString(raw));
    try { localStorage.setItem('sas_fp', fp); } catch(e) {}
    return fp;
}


// ======================= TIME WINDOW =======================

function getWindowNumber() {
    return Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
}

function generatePIN(windowNum, sessionId) {
    const val = (windowNum * 73856093) ^ hashString(sessionId);
    return String(Math.abs(val) % 10000).padStart(4, '0');
}

function isWindowValid(w) {
    const cur = getWindowNumber();
    return w >= cur - GRACE_WINDOWS && w <= cur;
}

function encodeSessionTime(startTime, sessionId) {
    const mins = Math.floor(startTime / 60000);
    return (mins ^ (hashString(sessionId) & 0x7FFFFFFF)) >>> 0;
}

function decodeSessionTime(encoded, sessionId) {
    const mins = (encoded ^ (hashString(sessionId) & 0x7FFFFFFF)) >>> 0;
    return mins * 60000;
}


// ======================= COLOR PIN =======================

function getSessionColor(windowNum, sessionId) {
    const idx = Math.abs((windowNum * 31337) ^ hashString(sessionId)) % COLORS.length;
    return COLORS[idx];
}

function getColorOptions(correctColor) {
    const wrong = COLORS.filter(c => c !== correctColor)
                        .sort(() => Math.random() - 0.5)
                        .slice(0, 3);
    return [...wrong, correctColor].sort(() => Math.random() - 0.5);
}


// ======================= TEACHER STATE =======================

let countdownTimer     = null;
let lastWindowUpdated  = null;
let teacherLat         = null;
let teacherLng         = null;
let currentSessionId   = null;
let currentSessionName = null;
let currentClassName   = null;
let sessionStartTime   = null;


// ======================= TEACHER: RESUME =======================

function checkResumeSession() {
    try {
        const stored = localStorage.getItem(SESSION_KEY);
        if (!stored) return;
        const d = JSON.parse(stored);
        if (!d.sessionId) return;
        window._pendingResume = d;
        const info = document.getElementById('resumeInfo');
        if (info) info.textContent = `"${d.sessionName}" — ${d.className}`;
        show('resumeBanner');
    } catch(e) {
        try { localStorage.removeItem(SESSION_KEY); } catch(_) {}
    }
}

function resumeSession() {
    const d = window._pendingResume;
    if (!d) return;
    currentSessionId   = d.sessionId;
    currentSessionName = d.sessionName;
    currentClassName   = d.className;
    sessionStartTime   = d.sessionStartTime;
    teacherLat         = d.teacherLat;
    teacherLng         = d.teacherLng;
    hide('resumeBanner');
    hide('resultsCard');
    show('qrCard');
    renderQR();
    startCountdown();
    showMsg('teacherMsg', '✅ Session resumed.', 'success');
}

function discardSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch(e) {}
    hide('resumeBanner');
    window._pendingResume = null;
    showMsg('teacherMsg', '🗑️ Previous session discarded.', 'info');
}

function saveSessionToStorage() {
    try {
        localStorage.setItem(SESSION_KEY, JSON.stringify({
            sessionId:        currentSessionId,
            sessionName:      currentSessionName,
            className:        currentClassName,
            sessionStartTime: sessionStartTime,
            teacherLat:       teacherLat,
            teacherLng:       teacherLng
        }));
    } catch(e) {}
}


// ======================= TEACHER: CREATE SESSION =======================

async function createSession() {
    const sessionName = document.getElementById('sessionName').value.trim();
    const className   = document.getElementById('className').value.trim();

    if (!sessionName || !className) {
        showMsg('teacherMsg', '⚠️ Please fill in both fields.', 'error');
        return;
    }

    showMsg('teacherMsg', '📍 Getting your location...', 'info');

    try {
        const pos  = await getLocation();
        teacherLat = pos.coords.latitude;
        teacherLng = pos.coords.longitude;
        showMsg('teacherMsg', '✅ Location captured.', 'success');
    } catch(e) {
        teacherLat = null;
        teacherLng = null;
        showMsg('teacherMsg', '⚠️ Location denied — GPS check will be skipped.', 'warning');
    }

    currentSessionId   = 'SES-' + Date.now();
    currentSessionName = sessionName;
    currentClassName   = className;
    sessionStartTime   = Date.now();

    saveSessionToStorage();
    hide('resumeBanner');
    hide('resultsCard');
    show('qrCard');
    renderQR();
    startCountdown();
}


// ======================= TEACHER: RENDER QR =======================

function renderQR() {
    const win         = getWindowNumber();
    const pin         = generatePIN(win, currentSessionId);
    const color       = getSessionColor(win, currentSessionId);
    const encodedTime = encodeSessionTime(sessionStartTime, currentSessionId);

    const payload = JSON.stringify({
        sessionId:        currentSessionId,
        sessionName:      currentSessionName,
        className:        currentClassName,
        window:           win,
        teacherLat:       teacherLat,
        teacherLng:       teacherLng,
        encodedStartTime: encodedTime
    });

    document.getElementById('qrcode').innerHTML = '';
    new QRCode(document.getElementById('qrcode'), {
        text: payload, width: 200, height: 200,
        colorDark: '#000000', colorLight: '#ffffff'
    });

    document.getElementById('pinDisplay').textContent = pin;

    if (USE_COLOR_PIN) {
        const colorEl = document.getElementById('colorDisplay');
        if (colorEl) {
            colorEl.textContent = color;
            colorEl.style.color = COLOR_HEX[color] || '#fff';
        }
    }

    document.getElementById('sessionMeta').innerHTML =
        `<strong>${escHtml(currentSessionName)}</strong> &nbsp;·&nbsp; ${escHtml(currentClassName)}<br>
         <small>ID: ${escHtml(currentSessionId)}</small>`;

    lastWindowUpdated = win;
}


// ======================= TEACHER: COUNTDOWN =======================

function startCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
        const elapsed    = (Date.now() / 1000) % WINDOW_SECONDS;
        const remaining  = WINDOW_SECONDS - Math.floor(elapsed);
        const pct        = ((remaining / WINDOW_SECONDS) * 100).toFixed(1);
        const currentWin = getWindowNumber();
        const el  = document.getElementById('countdown');
        const bar = document.getElementById('countdownBar');
        if (el)  el.textContent  = `Refreshing in ${remaining}s`;
        if (bar) bar.style.width = pct + '%';
        if (currentWin !== lastWindowUpdated) renderQR();
    }, 1000);
}


// ======================= TEACHER: STOP SESSION =======================

function stopSession() {
    if (countdownTimer) clearInterval(countdownTimer);
    try { localStorage.removeItem(SESSION_KEY); } catch(e) {}
    hide('qrCard');
    const endedId = currentSessionId;
    currentSessionId = null;
    showMsg('teacherMsg', '🛑 Session ended. Loading results...', 'info');
    show('resultsCard');
    loadSessionResults(endedId);
}


// ======================= TEACHER: NEW SESSION =======================

function newSession() {
    hide('resultsCard');
    document.getElementById('sessionName').value = '';
    document.getElementById('className').value   = '';
    showMsg('teacherMsg', '', 'info');
    document.getElementById('sessionName').focus();
}


// ======================= TEACHER: LOAD SESSION RESULTS =======================

async function loadSessionResults(sessionId) {
    const tbody = document.getElementById('resultsBody');
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:20px;">⏳ Loading...</td></tr>';
    hide('selfieSection');

    window._lastSessionId = sessionId;
    const corrEl = document.getElementById('correctionSessionId');
    if (corrEl) corrEl.value = sessionId;

    try {
        const res  = await fetch(`${GOOGLE_SCRIPT_URL}?action=session&sessionId=${encodeURIComponent(sessionId)}`);
        const data = await res.json();
        const rows = data.rows || [];

        if (rows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:20px;">No submissions in this session.</td></tr>';
            document.getElementById('resultsCount').textContent = '0 records';
            return;
        }

        const presentCount = rows.filter(r => r.status && r.status.includes('Present')).length;
        const lateCount    = rows.filter(r => r.status && r.status.includes('Late')).length;
        const absentCount  = rows.length - presentCount - lateCount;

        document.getElementById('resultsCount').textContent =
            `${presentCount} Present · ${lateCount} Late · ${absentCount} Other · ${rows.length} Total`;

        tbody.innerHTML = rows.map(r => `
            <tr>
                <td>${escHtml(r.name)}</td>
                <td>${escHtml(r.id)}</td>
                <td><span class="status-badge ${badgeClass(r.status)}">${escHtml(r.status)}</span></td>
                <td>${escHtml(r.time)}</td>
            </tr>
        `).join('');

        // Selfie grid
        const withSelfies = rows.filter(r => r.selfie);
        if (withSelfies.length > 0) {
            const grid = document.getElementById('selfieGrid');
            if (grid) {
                grid.innerHTML = withSelfies.map(r => `
                    <div class="selfie-item">
                        <img src="${escHtml(r.selfie)}" alt="${escHtml(r.name)}"
                             onerror="this.parentElement.style.display='none'">
                        <span>${escHtml(r.name)}</span>
                        <small class="status-badge ${badgeClass(r.status)}">${escHtml(r.status)}</small>
                    </div>
                `).join('');
            }
            show('selfieSection');
        }

        showMsg('teacherMsg', '✅ Results loaded.', 'success');

    } catch(e) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--red);padding:20px;">❌ Could not load. Check your Apps Script.</td></tr>';
    }
}


// ======================= TEACHER: CORRECTION =======================

async function submitCorrection() {
    const studentId = document.getElementById('correctionStudentId').value.trim();
    const newStatus = document.getElementById('correctionStatus').value;
    const sessionId = document.getElementById('correctionSessionId').value.trim();

    if (!studentId || !sessionId) {
        showMsg('correctionMsg', '⚠️ Fill in all fields.', 'error');
        return;
    }

    showMsg('correctionMsg', '⏳ Updating...', 'info');

    try {
        const res  = await fetch(
            `${GOOGLE_SCRIPT_URL}?action=correct` +
            `&sessionId=${encodeURIComponent(sessionId)}` +
            `&studentId=${encodeURIComponent(studentId)}` +
            `&newStatus=${encodeURIComponent(newStatus)}`
        );
        const data = await res.json();

        if (data.success) {
            showMsg('correctionMsg', '✅ Record updated.', 'success');
            document.getElementById('correctionStudentId').value = '';
            loadSessionResults(sessionId);
        } else {
            showMsg('correctionMsg', `❌ ${escHtml(data.error || 'Record not found.')}`, 'error');
        }
    } catch(e) {
        showMsg('correctionMsg', '❌ Request failed.', 'error');
    }
}


// ======================= TEACHER: MANUAL ENTRY =======================

async function submitManualEntry() {
    const name      = document.getElementById('manualName').value.trim();
    const id        = document.getElementById('manualId').value.trim();
    const sessionId = window._lastSessionId || currentSessionId || 'Manual';

    if (!name || !id) {
        showMsg('manualMsg', '⚠️ Enter both name and student ID.', 'error');
        return;
    }

    showMsg('manualMsg', '📤 Adding...', 'info');

    const payload = {
        name:        name,
        id:          id,
        sessionId:   sessionId,
        sessionName: currentSessionName || 'Manual',
        className:   currentClassName   || 'Manual',
        status:      'Present',
        timestamp:   new Date().toISOString(),
        selfie:      ''
    };

    try {
        await fetchWithRetry(payload);
        showMsg('manualMsg', `✅ ${escHtml(name)} added as Present.`, 'success');
        document.getElementById('manualName').value = '';
        document.getElementById('manualId').value   = '';
        if (window._lastSessionId) loadSessionResults(window._lastSessionId);
    } catch(e) {
        showMsg('manualMsg', '❌ Submission failed.', 'error');
    }
}


// ======================= STUDENT STATE =======================

let videoStream        = null;
let selfieStream       = null;
let isScanning         = false;
let videoElement       = null;
let selfieVideoElement = null;
let scannedData        = null;
let selectedColor      = null;
const submittedIds     = {};


// ======================= STUDENT: START SCAN =======================

async function startScan() {
    const name = document.getElementById('studentName').value.trim();
    const id   = document.getElementById('studentId').value.trim();

    if (!name || !id) {
        showMsg('studentMsg', '⚠️ Enter your name and student ID first.', 'error');
        return;
    }

    try {
        videoStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' }, audio: false
        });

        videoElement = document.createElement('video');
        videoElement.srcObject = videoStream;
        videoElement.setAttribute('playsinline', true);
        videoElement.autoplay = true;

        const container = document.getElementById('cameraContainer');
        container.innerHTML = '';
        container.appendChild(videoElement);

        show('scanCard');
        isScanning = true;
        requestAnimationFrame(scanFrame);

    } catch(err) {
        showMsg('studentMsg', '❌ Camera error. Please allow camera access.', 'error');
    }
}


// ======================= STUDENT: SCAN FRAME =======================

function scanFrame() {
    if (!isScanning) return;
    const canvas = document.getElementById('canvas');
    const ctx    = canvas.getContext('2d');

    if (videoElement && videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
        canvas.width  = videoElement.videoWidth;
        canvas.height = videoElement.videoHeight;
        ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
        const code = jsQR(
            ctx.getImageData(0, 0, canvas.width, canvas.height).data,
            canvas.width, canvas.height
        );
        if (code) { stopScan(); handleScan(code.data); return; }
    }
    requestAnimationFrame(scanFrame);
}


// ======================= STUDENT: STOP SCAN =======================

function stopScan() {
    isScanning = false;
    if (videoStream) { videoStream.getTracks().forEach(t => t.stop()); videoStream = null; }
    hide('scanCard');
}


// ======================= STUDENT: HANDLE SCANNED DATA =======================

function handleScan(raw) {
    try {
        const data = JSON.parse(raw);

        if (!data.sessionId || data.window === undefined) {
            showMsg('studentMsg', '❌ Invalid QR code. Ask your teacher to regenerate.', 'error');
            return;
        }

        if (!isWindowValid(data.window)) {
            showMsg('studentMsg', '⏱️ QR expired. Wait for the screen to refresh then scan again.', 'error');
            return;
        }

        // Device fingerprint check
        const fp    = getDeviceFingerprint();
        const fpKey = data.sessionId + '_' + fp;
        try {
            if (localStorage.getItem(fpKey)) {
                showMsg('studentMsg', '⚠️ This device already submitted attendance for this session.', 'error');
                return;
            }
        } catch(e) {}

        // In-memory duplicate check
        const studentId = document.getElementById('studentId').value.trim();
        if (submittedIds[data.sessionId] && submittedIds[data.sessionId].has(studentId)) {
            showMsg('studentMsg', '⚠️ You already submitted attendance for this session.', 'error');
            return;
        }

        // Decode and check timing
        if (data.encodedStartTime !== undefined) {
            const startTime    = decodeSessionTime(data.encodedStartTime, data.sessionId);
            const minsElapsed  = (Date.now() - startTime) / 60000;
            data.decodedStartTime = startTime;

            if (minsElapsed > LATE_CUTOFF_MIN) {
                showMsg('studentMsg',
                    `🚫 Attendance closed. Session started ${Math.floor(minsElapsed)} mins ago (limit: ${LATE_CUTOFF_MIN} mins).`,
                    'error');
                return;
            }
            if (minsElapsed > PRESENT_CUTOFF_MIN) {
                showMsg('studentMsg',
                    `⚠️ ${Math.floor(minsElapsed)} mins late — you will be marked Late. Enter PIN to continue.`,
                    'warning');
            } else {
                showMsg('studentMsg', '✅ QR scanned! Enter the PIN and color shown on the board.', 'success');
            }
        } else {
            showMsg('studentMsg', '✅ QR scanned! Enter the PIN shown on the board.', 'success');
        }

        scannedData   = data;
        selectedColor = null;

        // Build color buttons
        if (USE_COLOR_PIN) {
            const correct = getSessionColor(data.window, data.sessionId);
            const options = getColorOptions(correct);
            const colorBtns = document.getElementById('colorButtons');
            if (colorBtns) {
                colorBtns.innerHTML = options.map(c => `
                    <button class="color-btn"
                        style="border-color:${COLOR_HEX[c]};color:${COLOR_HEX[c]}"
                        onclick="selectColor('${c}', this)">
                        ${c}
                    </button>
                `).join('');
            }
            show('colorSection');
        } else {
            hide('colorSection');
        }

        show('pinCard');
        document.getElementById('pinInput').value = '';
        document.getElementById('pinInput').focus();

    } catch(e) {
        showMsg('studentMsg', '❌ Could not read QR code. Try again.', 'error');
    }
}


// ======================= STUDENT: SELECT COLOR =======================

function selectColor(color, btn) {
    selectedColor = color;
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
}


// ======================= STUDENT: SUBMIT WITH PIN =======================

async function submitWithPIN() {
    const entered = document.getElementById('pinInput').value.trim();
    const btn     = document.getElementById('confirmBtn');

    if (entered.length !== 4 || !/^\d{4}$/.test(entered)) {
        showMsg('studentMsg', '⚠️ Enter the 4-digit PIN from the board.', 'error');
        return;
    }
    if (USE_COLOR_PIN && !selectedColor) {
        showMsg('studentMsg', '⚠️ Select the color shown on the board.', 'error');
        return;
    }
    if (!scannedData) {
        showMsg('studentMsg', '⚠️ Please scan the QR code first.', 'error');
        return;
    }

    if (btn) { btn.disabled = true; btn.textContent = '⏳ Verifying...'; }

    const currentWin = getWindowNumber();

    // Validate PIN
    let pinValid = false;
    for (let w = scannedData.window; w >= currentWin - GRACE_WINDOWS; w--) {
        if (generatePIN(w, scannedData.sessionId) === entered) { pinValid = true; break; }
    }
    if (!pinValid) {
        showMsg('studentMsg', '❌ Wrong PIN. Check the board and try again.', 'error');
        if (btn) { btn.disabled = false; btn.textContent = '✅ Confirm Attendance'; }
        return;
    }

    // Validate color
    if (USE_COLOR_PIN) {
        let colorValid = false;
        for (let w = scannedData.window; w >= currentWin - GRACE_WINDOWS; w--) {
            if (getSessionColor(w, scannedData.sessionId) === selectedColor) { colorValid = true; break; }
        }
        if (!colorValid) {
            showMsg('studentMsg', '❌ Wrong color. Look at the board again.', 'error');
            if (btn) { btn.disabled = false; btn.textContent = '✅ Confirm Attendance'; }
            return;
        }
    }

    // Determine status
    let status = 'Present';
    if (scannedData.decodedStartTime) {
        const minsElapsed = (Date.now() - scannedData.decodedStartTime) / 60000;
        if (minsElapsed > LATE_CUTOFF_MIN) {
            showMsg('studentMsg', '🚫 Attendance window has closed.', 'error');
            if (btn) { btn.disabled = false; btn.textContent = '✅ Confirm Attendance'; }
            return;
        }
        if (minsElapsed > PRESENT_CUTOFF_MIN) status = 'Late';
    }

    // GPS check — flag, don't block
    if (scannedData.teacherLat && scannedData.teacherLng) {
        showMsg('studentMsg', '📍 Checking location...', 'info');
        try {
            const pos  = await getLocation();
            const dist = haversineDistance(
                pos.coords.latitude, pos.coords.longitude,
                parseFloat(scannedData.teacherLat),
                parseFloat(scannedData.teacherLng)
            );
            if (dist > GPS_RADIUS_METERS) {
                status = status === 'Late' ? 'Late (GPS Unverified)' : 'Present (GPS Unverified)';
            }
        } catch(e) {
            status = status === 'Late' ? 'Late (GPS Unverified)' : 'Present (GPS Unverified)';
        }
    }

    if (btn) { btn.disabled = false; btn.textContent = '✅ Confirm Attendance'; }

    window._pendingStatus = status;
    hide('pinCard');
    show('selfieCard');
    await startSelfieCamera();
}


// ======================= STUDENT: SELFIE =======================

async function startSelfieCamera() {
    try {
        selfieStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
            audio: false
        });

        selfieVideoElement = document.createElement('video');
        selfieVideoElement.srcObject = selfieStream;
        selfieVideoElement.setAttribute('playsinline', true);
        selfieVideoElement.autoplay = true;

        const container = document.getElementById('selfieContainer');
        container.innerHTML = '';
        container.appendChild(selfieVideoElement);

    } catch(e) {
        // Camera unavailable — skip and submit
        showMsg('studentMsg', '⚠️ Front camera unavailable — submitting without selfie.', 'warning');
        hide('selfieCard');
        await recordAttendance(window._pendingStatus, null);
    }
}

function captureSelfie() {
    if (!selfieVideoElement) {
        skipSelfieAndSubmit();
        return;
    }
    const canvas  = document.getElementById('selfieCanvas');
    canvas.width  = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    // Mirror horizontally so saved photo isn't flipped
    ctx.translate(320, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(selfieVideoElement, 0, 0, 320, 240);

    const selfieBase64 = canvas.toDataURL('image/jpeg', 0.5);

    if (selfieStream) { selfieStream.getTracks().forEach(t => t.stop()); selfieStream = null; }
    selfieVideoElement = null;
    hide('selfieCard');

    recordAttendance(window._pendingStatus, selfieBase64);
}

function skipSelfieAndSubmit() {
    if (selfieStream) { selfieStream.getTracks().forEach(t => t.stop()); selfieStream = null; }
    selfieVideoElement = null;
    hide('selfieCard');
    recordAttendance(window._pendingStatus, null);
}


// ======================= STUDENT: RECORD ATTENDANCE =======================

async function recordAttendance(status, selfieBase64) {
    const studentName = document.getElementById('studentName').value.trim();
    const studentId   = document.getElementById('studentId').value.trim();

    showMsg('studentMsg', '📤 Submitting...', 'info');

    const payload = {
        name:        studentName,
        id:          studentId,
        sessionId:   scannedData.sessionId,
        sessionName: scannedData.sessionName,
        className:   scannedData.className,
        status:      status,
        timestamp:   new Date().toISOString(),
        selfie:      selfieBase64 || ''
    };

    try {
        await fetchWithRetry(payload);

        // Lock device for this session
        const fp = getDeviceFingerprint();
        try { localStorage.setItem(scannedData.sessionId + '_' + fp, '1'); } catch(e) {}

        // Lock student ID in-memory
        if (!submittedIds[scannedData.sessionId]) submittedIds[scannedData.sessionId] = new Set();
        submittedIds[scannedData.sessionId].add(studentId);

        const isLate = status.includes('Late');
        const isGPS  = status.includes('GPS Unverified');

        show('resultCard');
        document.getElementById('result').innerHTML = `
            <div class="result-box ${isLate ? 'late' : 'success'}">
                <span class="result-icon">${isLate ? '🕐' : '✅'}</span>
                <h3>${escHtml(status)}</h3>
                <p>
                    <strong>Name:</strong> ${escHtml(studentName)}<br>
                    <strong>ID:</strong> ${escHtml(studentId)}<br>
                    <strong>Session:</strong> ${escHtml(payload.sessionName)}<br>
                    <strong>Class:</strong> ${escHtml(payload.className)}<br>
                    <strong>Time:</strong> ${new Date().toLocaleTimeString()}
                    ${isGPS ? '<br><small style="color:var(--yellow)">⚠️ Location could not be verified</small>' : ''}
                </p>
            </div>
        `;

        scannedData = null;
        showMsg('studentMsg', '', 'info');

    } catch(err) {
        show('resultCard');
        document.getElementById('result').innerHTML = `
            <div class="result-box error">
                <span class="result-icon">❌</span>
                <h3>Submission Failed</h3>
                <p>Check your internet and try again.<br>
                <small>Ask your teacher to add you manually if this keeps happening.</small></p>
            </div>
        `;
    }
}


// ======================= FETCH WITH RETRY =======================

async function fetchWithRetry(payload, attempt) {
    attempt = attempt || 1;
    try {
        await fetch(GOOGLE_SCRIPT_URL, {
            method:  'POST',
            mode:    'no-cors',
            headers: { 'Content-Type': 'text/plain' },
            body:    JSON.stringify(payload)
        });
    } catch(err) {
        if (attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            return fetchWithRetry(payload, attempt + 1);
        }
        throw err;
    }
}


// ======================= UTILS =======================

function getLocation() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) { reject(new Error('Not supported')); return; }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true, timeout: 10000, maximumAge: 0
        });
    });
}

function haversineDistance(lat1, lon1, lat2, lon2) {
    const R    = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2 +
                 Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                 Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function escHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function badgeClass(status) {
    if (!status) return 'badge-absent';
    if (status.includes('Present')) return 'badge-present';
    if (status.includes('Late'))    return 'badge-late';
    return 'badge-absent';
}

function showMsg(id, text, type) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent   = text;
    el.className     = 'message ' + type;
    el.style.display = text ? 'block' : 'none';
}

function show(id) {
    const el = document.getElementById(id);
    if (el) { el.style.display = 'block'; el.style.animation = 'fadeUp 0.4s ease'; }
}

function hide(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
}

// ======================= PAGE INIT =======================
// Auto-run resume check when on teacher page
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        if (document.getElementById('resumeBanner')) checkResumeSession();
    });
}