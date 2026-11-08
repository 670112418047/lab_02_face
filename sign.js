/**
 * SignSpeak AI - ระบบตรวจจับและแปลภาษามืออัจฉริยะแบบเรียลไทม์
 * Powered by Google MediaPipe Hands & Web Audio / Speech Synthesis
 */

// --- Global States ---
let videoElement = null;
let canvasElement = null;
let canvasCtx = null;
let handsDetector = null;
let cameraManager = null;

let isCameraActive = false;
let currentFacingMode = 'user'; // 'user' (กล้องหน้า) or 'environment' (กล้องหลัง)
let wakeLock = null;

// Gestures Catalog
const GESTURES = [
  { id: 'HELLO', emoji: '✋', th: 'สวัสดี', desc: 'แบมือ 5 นิ้ว (ทักทาย)' },
  { id: 'ILOVEYOU', emoji: '🤟', th: 'ฉันรักคุณ', desc: 'ชูนิ้วโป้ง ชี้ ก้อย (รัก/ขอบคุณ)' },
  { id: 'VICTORY', emoji: '✌️', th: 'สู้ๆ', desc: 'ชู 2 นิ้ว ชี้กับกลาง (ให้กำลังใจ)' },
  { id: 'THUMBS_UP', emoji: '👍', th: 'ตกลง', desc: 'ยกนิ้วโป้งขึ้น (ใช่/ยอดเยี่ยม)' },
  { id: 'THUMBS_DOWN', emoji: '👎', th: 'ไม่ใช่', desc: 'คว่ำนิ้วโป้งลง (ปฏิเสธ/ไม่ตกลง)' },
  { id: 'OK', emoji: '👌', th: 'โอเค', desc: 'โป้งแตะชี้ กาง 3 นิ้ว (เรียบร้อย)' },
  { id: 'HELP', emoji: '☝️', th: 'ขอความช่วยเหลือ', desc: 'ชี้นิ้วชี้ขึ้น (เรียก/ข้อ 1)' },
  { id: 'STOP', emoji: '✊', th: 'หยุด', desc: 'กำมือทั้งหมด (หยุด/รอสักครู่)' },
  { id: 'MINI_HEART', emoji: '🫰', th: 'น่ารัก', desc: 'จีบนิ้วโป้งกับชี้ (มินิฮาร์ท)' }
];

// Hold-to-Confirm States
let currentCandidate = null;
let candidateStartTime = 0;
const REQUIRED_HOLD_MS = 750; // ต้องทำท่าค้าง 0.75 วินาทีเพื่อยืนยัน
let lastConfirmedId = null;
let lastConfirmedTime = 0;

// Sentence Builder List
let sentenceWords = [];

// Practice Mode States
let isPracticeMode = false;
let practiceTarget = null;
let practiceScore = 0;
let practiceStreak = 0;

// --- Initialize App ---
window.addEventListener('DOMContentLoaded', () => {
  videoElement = document.getElementById('webcam-video');
  canvasElement = document.getElementById('canvas-overlay');
  canvasCtx = canvasElement.getContext('2d');

  renderGestureCheatSheet();
  initMediaPipeHands();
  startCamera();
  requestScreenWakeLock();

  // Mode Switching
  document.getElementById('btn-mode-detect').addEventListener('click', () => setMode(false));
  document.getElementById('btn-mode-practice').addEventListener('click', () => setMode(true));
});

// --- MediaPipe Hands Setup ---
function initMediaPipeHands() {
  const statusEl = document.getElementById('badge-status');
  statusEl.innerHTML = `<span class="badge-dot"></span> <span>กำลังโหลด AI Hands...</span>`;

  handsDetector = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
  });

  handsDetector.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.5
  });

  handsDetector.onResults(onHandResults);

  statusEl.innerHTML = `<span class="badge-dot"></span> <span>AI พร้อมแปลภาษามือ</span>`;
  statusEl.style.color = '#34d399';
}

// --- Camera Management ---
function startCamera() {
  if (cameraManager) {
    cameraManager.stop();
  }

  // ปรับการ Mirror กล้อง
  if (currentFacingMode === 'user') {
    videoElement.classList.remove('rear');
  } else {
    videoElement.classList.add('rear');
  }

  cameraManager = new Camera(videoElement, {
    onFrame: async () => {
      if (handsDetector) {
        await handsDetector.send({ image: videoElement });
      }
    },
    facingMode: currentFacingMode,
    width: 640,
    height: 480
  });

  cameraManager.start()
    .then(() => { isCameraActive = true; })
    .catch((err) => {
      console.error('Camera error:', err);
      alert('ไม่สามารถเปิดกล้องได้: โปรดตรวจสอบสิทธิ์กล้องหรือเปิดผ่าน HTTPS/localhost');
    });
}

function toggleCameraFacing() {
  currentFacingMode = (currentFacingMode === 'user') ? 'environment' : 'user';
  startCamera();
}

// --- MediaPipe Results Callback ---
function onHandResults(results) {
  // Sync canvas dimensions
  if (canvasElement.width !== videoElement.videoWidth || canvasElement.height !== videoElement.videoHeight) {
    canvasElement.width = videoElement.videoWidth || 640;
    canvasElement.height = videoElement.videoHeight || 480;
  }

  canvasCtx.save();
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

  let detectedGesture = null;

  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    // วาดโครงกระดูกมือสำหรับทุกมือที่ตรวจพบ
    for (const landmarks of results.multiHandLandmarks) {
      drawNeonHandSkeleton(landmarks, canvasCtx, canvasElement.width, canvasElement.height);

      // วิเคราะห์ท่าทางของมือแรกที่เห็นชัด
      if (!detectedGesture) {
        detectedGesture = classifyHandGesture(landmarks);
      }
    }
  }

  canvasCtx.restore();

  // จัดการกระบวนการ Hold-to-Confirm
  handleGestureHoldConfirmation(detectedGesture);
}

// --- Draw Neon Glowing Hand Skeleton ---
function drawNeonHandSkeleton(landmarks, ctx, width, height) {
  const isMirrored = currentFacingMode === 'user';
  const getX = (val) => isMirrored ? (1 - val) * width : val * width;
  const getY = (val) => val * height;

  // MediaPipe Hand Connections
  const connections = [
    [0, 1], [1, 2], [2, 3], [3, 4],       // Thumb
    [0, 5], [5, 6], [6, 7], [7, 8],       // Index
    [5, 9], [9, 10], [10, 11], [11, 12],  // Middle
    [9, 13], [13, 14], [14, 15], [15, 16],// Ring
    [13, 17], [17, 18], [18, 19], [19, 20],// Pinky
    [0, 17]                               // Palm base
  ];

  // วาดเส้นเชื่อมต่อนีออนเรืองแสง
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 3;
  ctx.shadowColor = '#0284c7';
  ctx.shadowBlur = 10;
  ctx.beginPath();
  for (const [start, end] of connections) {
    const p1 = landmarks[start];
    const p2 = landmarks[end];
    ctx.moveTo(getX(p1.x), getY(p1.y));
    ctx.lineTo(getX(p2.x), getY(p2.y));
  }
  ctx.stroke();

  // วาดจุดข้อต่อนิ้วมือ
  ctx.shadowBlur = 0;
  for (let i = 0; i < landmarks.length; i++) {
    const p = landmarks[i];
    const px = getX(p.x);
    const py = getY(p.y);

    ctx.beginPath();
    // ปลายนิ้ว 4, 8, 12, 16, 20 ให้เป็นจุดสีเขียวเด่น
    if ([4, 8, 12, 16, 20].includes(i)) {
      ctx.fillStyle = '#10b981';
      ctx.arc(px, py, 6, 0, 2 * Math.PI);
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.arc(px, py, 4, 0, 2 * Math.PI);
    }
    ctx.fill();
  }
}

// --- Gesture Classification Algorithm ---
function dist(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

function classifyHandGesture(landmarks) {
  const wrist = landmarks[0];

  // วิเคราะห์การยืด/งอ ของแต่ละนิ้ว (4 นิ้วหลัก)
  // วัดอัตราส่วนระยะจากข้อมือถึงปลายนิ้ว เทียบกับข้อต่อ PIP
  const isIndexExt = dist(landmarks[8], wrist) > dist(landmarks[6], wrist) * 1.18;
  const isMiddleExt = dist(landmarks[12], wrist) > dist(landmarks[10], wrist) * 1.18;
  const isRingExt = dist(landmarks[16], wrist) > dist(landmarks[14], wrist) * 1.18;
  const isPinkyExt = dist(landmarks[20], wrist) > dist(landmarks[18], wrist) * 1.18;

  // วิเคราะห์นิ้วโป้ง
  const thumbTip = landmarks[4];
  const thumbIP = landmarks[3];
  const thumbMCP = landmarks[2];
  const indexMCP = landmarks[5];
  const pinkyMCP = landmarks[17];

  const isThumbExt = dist(thumbTip, pinkyMCP) > dist(thumbIP, pinkyMCP) * 1.15;
  const distThumbIndexTip = dist(thumbTip, landmarks[8]);

  // 1. ท่า MINI HEART 🫰 (จีบนิ้วโป้งกับชี้ + 3 นิ้วที่เหลืองอ)
  if (distThumbIndexTip < 0.08 && !isMiddleExt && !isRingExt && !isPinkyExt) {
    return GESTURES.find(g => g.id === 'MINI_HEART');
  }

  // 2. ท่า OK 👌 (ปลายนิ้วโป้งแตะนิ้วชี้ + 3 นิ้วกลาง/นาง/ก้อยกาง)
  if (distThumbIndexTip < 0.075 && isMiddleExt && isRingExt && isPinkyExt) {
    return GESTURES.find(g => g.id === 'OK');
  }

  // 3. ท่า I LOVE YOU 🤟 (โป้งกาง + ชี้ชู + ก้อยชู + กลางและนางพับ)
  if (isThumbExt && isIndexExt && isPinkyExt && !isMiddleExt && !isRingExt) {
    return GESTURES.find(g => g.id === 'ILOVEYOU');
  }

  // 4. ท่า VICTORY / 2 นิ้ว ✌️ (ชี้ + กลางชู, นาง + ก้อยพับ)
  if (isIndexExt && isMiddleExt && !isRingExt && !isPinkyExt) {
    return GESTURES.find(g => g.id === 'VICTORY');
  }

  // 5. ท่า ชี้ขึ้น / ขอความช่วยเหลือ ☝️ (ชี้ชูเดี่ยวๆ)
  if (isIndexExt && !isMiddleExt && !isRingExt && !isPinkyExt && !isThumbExt) {
    return GESTURES.find(g => g.id === 'HELP');
  }

  // 6. ท่า THUMBS UP 👍 (4 นิ้วพับ + โป้งชี้ขึ้นบน)
  if (!isIndexExt && !isMiddleExt && !isRingExt && !isPinkyExt) {
    // ปลายนิ้วโป้งต้องอยู่สูงกว่าข้อมือและโคนนิ้วชี้
    if (thumbTip.y < thumbIP.y - 0.03 && thumbTip.y < indexMCP.y) {
      return GESTURES.find(g => g.id === 'THUMBS_UP');
    }
  }

  // 7. ท่า THUMBS DOWN 👎 (4 นิ้วพับ + โป้งชี้ลงล่าง)
  if (!isIndexExt && !isMiddleExt && !isRingExt && !isPinkyExt) {
    if (thumbTip.y > thumbIP.y + 0.03 && thumbTip.y > wrist.y) {
      return GESTURES.find(g => g.id === 'THUMBS_DOWN');
    }
  }

  // 8. ท่า แบมือ / สวัสดี ✋ (5 นิ้วชูทั้งหมด)
  if (isThumbExt && isIndexExt && isMiddleExt && isRingExt && isPinkyExt) {
    return GESTURES.find(g => g.id === 'HELLO');
  }

  // 9. ท่า กำมือ / หยุด ✊ (5 นิ้วพับทั้งหมด)
  if (!isThumbExt && !isIndexExt && !isMiddleExt && !isRingExt && !isPinkyExt) {
    return GESTURES.find(g => g.id === 'STOP');
  }

  return null;
}

// --- Hold-to-Confirm & Feedback ---
function handleGestureHoldConfirmation(gesture) {
  const hud = document.getElementById('live-gesture-hud');
  const hudEmoji = document.getElementById('hud-emoji');
  const hudName = document.getElementById('hud-name');
  const progressMeter = document.getElementById('hud-progress-bar');

  if (!gesture) {
    currentCandidate = null;
    candidateStartTime = 0;
    hud.classList.remove('show');
    progressMeter.style.strokeDashoffset = 100;
    highlightActiveGestureCard(null);
    return;
  }

  // ไฮไลต์การ์ดทางขวา
  highlightActiveGestureCard(gesture.id);

  // อัปเดตข้อมูลบน HUD
  hudEmoji.textContent = gesture.emoji;
  hudName.textContent = gesture.th;
  hud.classList.add('show');

  const now = Date.now();

  if (currentCandidate !== gesture.id) {
    currentCandidate = gesture.id;
    candidateStartTime = now;
    progressMeter.style.strokeDashoffset = 100;
  } else {
    // กำลังทำท่าเดิมค้างไว้
    const elapsed = now - candidateStartTime;
    const progress = Math.min(100, (elapsed / REQUIRED_HOLD_MS) * 100);
    progressMeter.style.strokeDashoffset = 100 - progress;

    // ครบกำหนดเวลา Hold -> ยืนยันคำศัพท์!
    if (progress >= 100) {
      const cooldownPassed = (now - lastConfirmedTime > 1400) || (lastConfirmedId !== gesture.id);

      if (cooldownPassed) {
        lastConfirmedId = gesture.id;
        lastConfirmedTime = now;

        // สั่นมือถือสั้นๆ (ถ้าเบราว์เซอร์รองรับ)
        if ('vibrate' in navigator) navigator.vibrate(50);

        confirmGestureAction(gesture);
      }
    }
  }
}

function confirmGestureAction(gesture) {
  // เล่นเสียงติ๊ง
  playConfirmationChime();

  // อ่านออกเสียงภาษาไทย
  speakThai(gesture.th);

  // เช็คว่าอยู่ในโหมดไหน
  if (isPracticeMode) {
    checkPracticeAnswer(gesture);
  } else {
    // เพิ่มคำลงในกล่องสะสมประโยค
    addWordToSentence(gesture);
  }

  showToastNotice(`✓ แปลแล้ว: ${gesture.emoji} ${gesture.th}`);
}

// --- Sentence Builder ---
function addWordToSentence(gesture) {
  sentenceWords.push(gesture);
  renderSentenceChips();
}

function renderSentenceChips() {
  const container = document.getElementById('sentence-chips-box');
  if (sentenceWords.length === 0) {
    container.innerHTML = `<span class="empty-chips-hint">ทำท่าภาษามือค้างไว้ 1 วินาที เพื่อบันทึกคำลงในประโยค</span>`;
    return;
  }

  container.innerHTML = sentenceWords.map((item, idx) => `
    <span class="word-chip">
      <span>${item.emoji}</span>
      <span>${item.th}</span>
      <button onclick="removeWordAt(${idx})" style="background:none;border:none;color:#94a3b8;cursor:pointer;margin-left:4px;">✕</button>
    </span>
  `).join('');
}

function removeWordAt(idx) {
  sentenceWords.splice(idx, 1);
  renderSentenceChips();
}

function removeLastWord() {
  if (sentenceWords.length > 0) {
    sentenceWords.pop();
    renderSentenceChips();
  }
}

function clearSentence() {
  sentenceWords = [];
  renderSentenceChips();
}

function speakFullSentence() {
  if (sentenceWords.length === 0) {
    speakThai("ยังไม่มีคำในประโยค");
    return;
  }
  const fullText = sentenceWords.map(w => w.th).join(' ');
  speakThai(fullText);
}

function copySentenceText() {
  if (sentenceWords.length === 0) return;
  const fullText = sentenceWords.map(w => w.th).join(' ');
  navigator.clipboard.writeText(fullText).then(() => {
    showToastNotice('📋 คัดลอกประโยคเรียบร้อยแล้ว!');
  });
}

// --- Practice Mode (โหมดฝึกทำท่าตาม AI) ---
function setMode(practice) {
  isPracticeMode = practice;
  const detectBtn = document.getElementById('btn-mode-detect');
  const practiceBtn = document.getElementById('btn-mode-practice');
  const practiceCard = document.getElementById('practice-card');

  if (isPracticeMode) {
    detectBtn.classList.remove('active');
    practiceBtn.classList.add('active');
    practiceCard.classList.add('show');
    startNewPracticeTarget();
  } else {
    practiceBtn.classList.remove('active');
    detectBtn.classList.add('active');
    practiceCard.classList.remove('show');
  }
}

function startNewPracticeTarget() {
  // สุ่มท่าทางที่ไม่ซ้ำกับท่าเดิม
  const available = GESTURES.filter(g => !practiceTarget || g.id !== practiceTarget.id);
  practiceTarget = available[Math.floor(Math.random() * available.length)];

  document.getElementById('target-emoji').textContent = practiceTarget.emoji;
  document.getElementById('target-word').textContent = `ท่า "${practiceTarget.th}"`;
  document.getElementById('target-hint').textContent = practiceTarget.desc;

  document.getElementById('practice-score').textContent = practiceScore;
  document.getElementById('practice-streak').textContent = `${practiceStreak} ครั้ง`;
}

function checkPracticeAnswer(gesture) {
  if (gesture.id === practiceTarget.id) {
    practiceScore += 10;
    practiceStreak += 1;
    showToastNotice(`🎉 ถูกต้อง! +10 คะแนน (ทำติดต่อกัน ${practiceStreak} ครั้ง)`);
    playVictoryChime();
    setTimeout(() => {
      startNewPracticeTarget();
    }, 600);
  }
}

// --- Audio & TTS ---
function playConfirmationChime() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now); // A5 note
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.35);
  } catch (e) {}
}

function playVictoryChime() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const now = ctx.currentTime;

    [523.25, 659.25, 783.99, 1046.50].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.setValueAtTime(freq, now + idx * 0.08);
      gain.gain.setValueAtTime(0.15, now + idx * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.08);
      osc.stop(now + idx * 0.08 + 0.25);
    });
  } catch (e) {}
}

function speakThai(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'th-TH';
    utterance.rate = 1.0;
    window.speechSynthesis.speak(utterance);
  } catch (e) {}
}

// --- Gesture Cheat Sheet UI ---
function renderGestureCheatSheet() {
  const container = document.getElementById('gesture-list');
  container.innerHTML = GESTURES.map(g => `
    <div class="gesture-item" id="card-${g.id}">
      <div class="gesture-emoji">${g.emoji}</div>
      <div class="gesture-info">
        <h4>${g.th}</h4>
        <p>${g.desc}</p>
      </div>
    </div>
  `).join('');
}

function highlightActiveGestureCard(gestureId) {
  document.querySelectorAll('.gesture-item').forEach(card => card.classList.remove('active'));
  if (gestureId) {
    const activeCard = document.getElementById(`card-${gestureId}`);
    if (activeCard) activeCard.classList.add('active');
  }
}

// --- Screen Wake Lock ---
async function requestScreenWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {}
  }
}

// --- Toast Notice ---
let toastTimer = null;
function showToastNotice(msg) {
  const el = document.getElementById('toast-notice');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}
