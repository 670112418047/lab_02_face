/**
 * FaceCheck - ระบบเช็คชื่อด้วยใบหน้าอัจฉริยะ (โหมดเดินผ่าน / Walk-by Kiosk)
 * Powered by @vladmandic/face-api & TensorFlow.js
 */

// --- Global States ---
let isModelLoaded = false;
let isCameraRunning = false;
let faceMatcher = null;
let registeredUsers = [];
let attendanceLogs = [];
let cooldownMap = new Map(); // Key: userName -> Date.now()
let currentFacingMode = 'user'; // 'user' (กล้องหน้า) or 'environment' (กล้องหลัง)
let wakeLock = null;
let detectionInterval = null;

// --- Configs (สามารถปรับในเมนูตั้งค่าได้) ---
let config = {
  lateTime: "08:30",            // เวลาเริ่มนับว่าสาย
  cooldownMinutes: 10,          // พักไม่นับซ้ำ (นาที)
  distanceThreshold: 0.55,      // ความแม่นยำในการเทียบหน้า (ค่ายิ่งต่ำยิ่งเข้มงวด)
  minFaceSize: 80,              // ขนาดหน้าขั้นต่ำในจอ (พิกเซล)
  processIntervalMs: 300,       // จังหวะประมวลผล (มิลลิวินาที) เพื่อประหยัดแบตเตอรี่
  soundEnabled: true,           // เปิดเสียงแจ้งเตือน ติ๊ง
  ttsEnabled: true              // เปิดเสียงพูดสังเคราะห์ชื่อภาษาไทย
};

// --- DOM Elements ---
const video = document.getElementById('webcam-video');
const canvas = document.getElementById('overlay-canvas');
const statusBadge = document.getElementById('badge-model-status');
const registeredCountBadge = document.getElementById('badge-user-count');
const toastBanner = document.getElementById('checkin-toast');
const recentList = document.getElementById('recent-list');

// --- Initialization ---
window.addEventListener('DOMContentLoaded', async () => {
  loadConfig();
  loadStoredData();
  setupNavigation();
  setupSettingsUI();
  updateStatsDisplay();
  
  // โหลด AI Models
  await loadFaceApiModels();
  
  // เริ่มเปิดกล้องอัตโนมัติ
  startCamera();
  
  // ขอสิทธิ์ไม่ให้จอดับ
  requestScreenWakeLock();
});

// --- LocalStorage Helpers ---
function loadConfig() {
  const saved = localStorage.getItem('facecheck_config');
  if (saved) {
    try { config = { ...config, ...JSON.parse(saved) }; } catch (e) {}
  }
}

function saveConfig() {
  localStorage.setItem('facecheck_config', JSON.stringify(config));
}

function loadStoredData() {
  try {
    const users = localStorage.getItem('facecheck_users');
    registeredUsers = users ? JSON.parse(users) : [];
  } catch (e) { registeredUsers = []; }

  try {
    const logs = localStorage.getItem('facecheck_logs');
    attendanceLogs = logs ? JSON.parse(logs) : [];
  } catch (e) { attendanceLogs = []; }

  updateUserCountBadge();
  renderUserGrid();
  renderAttendanceTable();
  buildFaceMatcher();
}

function saveUsers() {
  localStorage.setItem('facecheck_users', JSON.stringify(registeredUsers));
  updateUserCountBadge();
  renderUserGrid();
  buildFaceMatcher();
}

function saveLogs() {
  localStorage.setItem('facecheck_logs', JSON.stringify(attendanceLogs));
  renderAttendanceTable();
  updateStatsDisplay();
}

// --- Face-API Model Loading ---
async function loadFaceApiModels() {
  updateStatus(false, 'กำลังโหลด AI Models...');
  
  // พยายามโหลดจากโฟลเดอร์ models/ ในเครื่องก่อน หากไม่สำเร็จจะดึงจาก CDN
  const modelPaths = ['./models', 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/'];
  
  for (const path of modelPaths) {
    try {
      console.log(`Loading face models from ${path}...`);
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(path),
        faceapi.nets.faceLandmark68Net.loadFromUri(path),
        faceapi.nets.faceRecognitionNet.loadFromUri(path)
      ]);
      isModelLoaded = true;
      console.log('Face models loaded successfully!');
      updateStatus(true, 'AI พร้อมสแกนเดินผ่าน');
      return;
    } catch (err) {
      console.warn(`Failed loading models from ${path}:`, err);
    }
  }

  updateStatus(false, 'โหลดโมเดลไม่สำเร็จ ตรวจสอบการเชื่อมต่อ');
}

function updateStatus(isReady, text) {
  if (!statusBadge) return;
  statusBadge.className = isReady ? 'badge badge-success' : 'badge badge-warning';
  statusBadge.innerHTML = `<span class="badge-dot"></span> <span>${text}</span>`;
}

function updateUserCountBadge() {
  if (registeredCountBadge) {
    registeredCountBadge.innerHTML = `<span class="badge-dot"></span> <span>ลงทะเบียน ${registeredUsers.length} คน</span>`;
  }
}

// --- Build Face Matcher ---
function buildFaceMatcher() {
  if (registeredUsers.length === 0) {
    faceMatcher = null;
    return;
  }

  const labeledDescriptors = registeredUsers.map(user => {
    const floatDescriptors = user.descriptors.map(d => new Float32Array(d));
    return new faceapi.LabeledFaceDescriptors(user.name, floatDescriptors);
  });

  faceMatcher = new faceapi.FaceMatcher(labeledDescriptors, config.distanceThreshold);
  console.log(`FaceMatcher ready with ${registeredUsers.length} users`);
}

// --- Camera Management ---
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: currentFacingMode,
        width: { ideal: 640 },
        height: { ideal: 480 }
      },
      audio: false
    });

    video.srcObject = stream;
    await video.play();
    isCameraRunning = true;

    // ตั้งค่า Class เพื่อพลิกหน้ากล้อง (เฉพาะกล้องหน้า)
    if (currentFacingMode === 'user') {
      video.classList.remove('rear');
    } else {
      video.classList.add('rear');
    }

    startDetectionLoop();
  } catch (err) {
    console.error('Camera access error:', err);
    alert('ไม่สามารถเข้าถึงกล้องได้: โปรดตรวจสอบว่าอนุญาตสิทธิ์กล้อง หรือรันผ่าน HTTPS');
  }
}

function stopCamera() {
  if (detectionInterval) {
    clearInterval(detectionInterval);
    detectionInterval = null;
  }
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(track => track.stop());
    video.srcObject = null;
  }
  isCameraRunning = false;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function toggleCameraFacing() {
  stopCamera();
  currentFacingMode = (currentFacingMode === 'user') ? 'environment' : 'user';
  startCamera();
}

// --- Real-time Walk-by Detection Loop ---
function startDetectionLoop() {
  if (detectionInterval) clearInterval(detectionInterval);

  detectionInterval = setInterval(async () => {
    if (!isModelLoaded || !isCameraRunning || video.paused || video.ended) return;

    // ปรับขนาด Canvas ให้ตรงกับ Video Frame
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    const displaySize = { width: video.videoWidth, height: video.videoHeight };
    faceapi.matchDimensions(canvas, displaySize);

    try {
      // ใช้ TinyFaceDetector เพื่อความเร็วสูงสุดบนมือถือ
      const detections = await faceapi.detectAllFaces(
        video,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })
      ).withFaceLandmarks().withFaceDescriptors();

      const resizedDetections = faceapi.resizeResults(detections, displaySize);
      drawDetections(resizedDetections);
    } catch (err) {
      // ข้ามกรณี frame ยังไม่พร้อม
    }
  }, config.processIntervalMs);
}

// --- Render Overlay & Logic ---
function drawDetections(detections) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const now = Date.now();
  const isMirrored = currentFacingMode === 'user';

  detections.forEach(detection => {
    const box = detection.detection.box;
    let { x, y, width, height } = box;

    // คำนวณพิกัดถ้ากล้องมีการ Mirror (Flip X)
    let drawX = isMirrored ? (canvas.width - x - width) : x;

    // ตรวจสอบขนาดใบหน้า (ถ้าไกลเกินไปจะแจ้งเตือนให้เข้าใกล้)
    if (width < config.minFaceSize) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 2;
      ctx.strokeRect(drawX, y, width, height);
      ctx.setLineDash([]);
      
      drawLabel(ctx, "กรุณาเข้าใกล้กล้องอีกนิด", drawX, y - 10, "rgba(71, 85, 105, 0.85)", "#ffffff");
      return;
    }

    // ระบุตัวตน
    let label = "บุคคลทั่วไป / ยังไม่ลงทะเบียน";
    let color = "#ef4444"; // สีแดงสำหรับ Unknown
    let isMatched = false;
    let matchedUser = null;

    if (faceMatcher) {
      const match = faceMatcher.findBestMatch(detection.descriptor);
      if (match.label !== 'unknown') {
        isMatched = true;
        matchedUser = registeredUsers.find(u => u.name === match.label);
        const confidence = Math.round((1 - match.distance) * 100);

        // เช็คสถานะ Cooldown
        const lastCheckTime = cooldownMap.get(match.label) || 0;
        const cooldownMs = config.cooldownMinutes * 60 * 1000;
        const isCooldown = (now - lastCheckTime) < cooldownMs;

        if (isCooldown) {
          // เคยเช็คชื่อไปแล้วในรอบนี้
          color = "#0284c7"; // สีฟ้า
          const lastTimeStr = new Date(lastCheckTime).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
          label = `✓ ${match.label} (เช็คชื่อแล้ว ${lastTimeStr})`;
        } else {
          // เช็คชื่อใหม่สำเร็จ!
          color = "#10b981"; // สีเขียว
          label = `✓ ${match.label} (${confidence}%)`;

          // บันทึกการเช็คชื่อ
          triggerCheckIn(matchedUser);
        }
      }
    }

    // วาดกล่อง Bounding Box มน
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    drawRoundedRect(ctx, drawX, y, width, height, 8);
    ctx.stroke();

    // วาดป้ายชื่อ
    drawLabel(ctx, label, drawX, y - 8, color, "#ffffff");
  });
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawLabel(ctx, text, x, y, bgColor, textColor) {
  ctx.font = "bold 13px -apple-system, sans-serif";
  const textWidth = ctx.measureText(text).width;
  const paddingX = 8;
  const paddingY = 4;
  const boxHeight = 22;

  ctx.fillStyle = bgColor;
  ctx.beginPath();
  drawRoundedRect(ctx, x, y - boxHeight, textWidth + paddingX * 2, boxHeight, 4);
  ctx.fill();

  ctx.fillStyle = textColor;
  ctx.fillText(text, x + paddingX, y - 6);
}

// --- Check-in Action ---
function triggerCheckIn(user) {
  const now = new Date();
  cooldownMap.set(user.name, now.getTime());

  // คำนวณสถานะตรงเวลา / มาสาย
  const currentTimeStr = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const [targetH, targetM] = config.lateTime.split(':').map(Number);
  const isLate = (now.getHours() > targetH) || (now.getHours() === targetH && now.getMinutes() > targetM);
  const status = isLate ? 'มาสาย' : 'ตรงเวลา';

  const newLog = {
    id: Date.now(),
    name: user.name,
    studentId: user.studentId || '-',
    department: user.department || '-',
    date: now.toLocaleDateString('th-TH'),
    time: currentTimeStr,
    status: status,
    avatar: user.avatar || ''
  };

  attendanceLogs.unshift(newLog);
  saveLogs();

  // ส่งสัญญาณตอบรับ
  if (config.soundEnabled) playChime();
  if (config.ttsEnabled) speakThai(`เช็คชื่อสำเร็จ คุณ ${user.name}`);

  // แสดง Banner บนหน้าจอ
  showCheckinToast(user.name, currentTimeStr, status, user.avatar);
  addRecentItem(newLog);
}

// --- Audio & TTS ---
function playChime() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const now = ctx.currentTime;

    // โน้ตตัวที่ 1 (E5: 659.25 Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.frequency.setValueAtTime(659.25, now);
    gain1.gain.setValueAtTime(0.15, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.3);

    // โน้ตตัวที่ 2 (B5: 987.77 Hz)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.frequency.setValueAtTime(987.77, now + 0.12);
    gain2.gain.setValueAtTime(0.2, now + 0.12);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.12);
    osc2.stop(now + 0.55);
  } catch (e) {
    console.warn('Audio play error:', e);
  }
}

function speakThai(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'th-TH';
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
  } catch (e) {}
}

// --- UI Toast & Recent Activity ---
let toastTimeout = null;
function showCheckinToast(name, time, status, avatar) {
  if (!toastBanner) return;
  const avatarEl = document.getElementById('toast-avatar');
  const nameEl = document.getElementById('toast-name');
  const timeEl = document.getElementById('toast-time');

  nameEl.textContent = name;
  timeEl.textContent = `${status} • เวลา ${time} น.`;

  if (avatar) {
    avatarEl.innerHTML = `<img src="${avatar}" alt="${name}">`;
  } else {
    avatarEl.textContent = name.charAt(0);
  }

  toastBanner.classList.add('show');
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toastBanner.classList.remove('show');
  }, 3500);
}

function addRecentItem(log) {
  if (!recentList) return;
  const empty = recentList.querySelector('.empty-state');
  if (empty) empty.remove();

  const item = document.createElement('li');
  item.className = 'recent-item';
  item.innerHTML = `
    <div class="recent-avatar">
      ${log.avatar ? `<img src="${log.avatar}" alt="${log.name}">` : log.name.charAt(0)}
    </div>
    <div class="recent-info">
      <div class="recent-name">${log.name}</div>
      <div class="recent-time">${log.status} • ${log.time}</div>
    </div>
  `;
  recentList.insertBefore(item, recentList.firstChild);

  // จำกัด 15 รายการล่าสุดในแถบข้าง
  while (recentList.children.length > 15) {
    recentList.removeChild(recentList.lastChild);
  }
}

// --- Screen Wake Lock API ---
async function requestScreenWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('Screen Wake Lock is active!');
      const badge = document.getElementById('badge-wakelock');
      if (badge) badge.style.display = 'inline-flex';
    } catch (err) {
      console.log('Wake Lock request error:', err);
    }
  }
}

document.addEventListener('visibilitychange', async () => {
  if (wakeLock !== null && document.visibilityState === 'visible') {
    requestScreenWakeLock();
  }
});

// --- Enrollment (ลงทะเบียนใบหน้า) ---
let enrollCanvas = null;
let currentCapturedDescriptor = null;
let currentCapturedAvatar = null;

function openEnrollModal() {
  document.getElementById('enroll-modal').classList.add('show');
  document.getElementById('enroll-name').value = '';
  document.getElementById('enroll-id').value = '';
  document.getElementById('enroll-status').textContent = 'พร้อมถ่ายภาพหรืออัปโหลดรูป';
  document.getElementById('enroll-preview').innerHTML = '<span style="color:#94a3b8;font-size:0.8rem">ยังไม่มีภาพ</span>';
  document.getElementById('btn-save-enroll').disabled = true;
  currentCapturedDescriptor = null;
  currentCapturedAvatar = null;
}

function closeEnrollModal() {
  document.getElementById('enroll-modal').classList.remove('show');
}

// ถ่ายภาพจากกล้อง Webcam ปัจจุบัน
async function captureFromCurrentCamera() {
  if (!video || video.paused) {
    alert('กล้องยังไม่พร้อมใช้งาน');
    return;
  }

  const enrollStatus = document.getElementById('enroll-status');
  enrollStatus.innerHTML = '<span class="spinner"></span> กำลังวิเคราะห์ใบหน้า...';

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = video.videoWidth;
  tempCanvas.height = video.videoHeight;
  const ctx = tempCanvas.getContext('2d');

  // Mirror ถ้าเป็นกล้องหน้า
  if (currentFacingMode === 'user') {
    ctx.translate(tempCanvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);

  await processEnrollImage(tempCanvas);
}

// อัปโหลดไฟล์รูปภาพ
async function handleImageUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const enrollStatus = document.getElementById('enroll-status');
  enrollStatus.innerHTML = '<span class="spinner"></span> กำลังประมวลผลรูปภาพ...';

  const img = new Image();
  img.src = URL.createObjectURL(file);
  img.onload = async () => {
    await processEnrollImage(img);
  };
}

// สกัด Face Descriptor
async function processEnrollImage(imageSource) {
  const enrollStatus = document.getElementById('enroll-status');
  const previewBox = document.getElementById('enroll-preview');
  const saveBtn = document.getElementById('btn-save-enroll');

  try {
    const detection = await faceapi.detectSingleFace(
      imageSource,
      new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 })
    ).withFaceLandmarks().withFaceDescriptor();

    if (!detection) {
      enrollStatus.innerHTML = '<span style="color:#ef4444">❌ ตรวจไม่พบใบหน้า กรุณาจัดหน้าตรงและแสงสว่างเพียงพอ</span>';
      saveBtn.disabled = true;
      return;
    }

    // ครอปใบหน้ามาทำเป็นรูป Profile Thumbnail
    const box = detection.detection.box;
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = 150;
    cropCanvas.height = 150;
    const cropCtx = cropCanvas.getContext('2d');

    // ขยายขอบข้างเล็กน้อย
    const pad = box.width * 0.2;
    cropCtx.drawImage(
      imageSource,
      Math.max(0, box.x - pad),
      Math.max(0, box.y - pad),
      box.width + pad * 2,
      box.height + pad * 2,
      0, 0, 150, 150
    );

    currentCapturedAvatar = cropCanvas.toDataURL('image/jpeg', 0.85);
    currentCapturedDescriptor = Array.from(detection.descriptor);

    previewBox.innerHTML = `<img src="${currentCapturedAvatar}" style="width:100%;height:100%;border-radius:12px;object-fit:cover;">`;
    enrollStatus.innerHTML = '<span style="color:#10b981">✓ ตรวจพบใบหน้าเรียบร้อย! พร้อมบันทึก</span>';
    saveBtn.disabled = false;

  } catch (err) {
    console.error('Enroll error:', err);
    enrollStatus.innerHTML = '<span style="color:#ef4444">เกิดข้อผิดพลาดในการตรวจจับ</span>';
  }
}

function saveNewUser() {
  const nameInput = document.getElementById('enroll-name').value.trim();
  const idInput = document.getElementById('enroll-id').value.trim();

  if (!nameInput) {
    alert('กรุณากรอกชื่อ-นามสกุล');
    return;
  }
  if (!currentCapturedDescriptor) {
    alert('กรุณาถ่ายภาพหรืออัปโหลดรูปใบหน้า');
    return;
  }

  // ตรวจสอบชื่อซ้ำ
  const existing = registeredUsers.find(u => u.name.toLowerCase() === nameInput.toLowerCase());
  if (existing) {
    if (confirm(`พบชื่อ "${nameInput}" ในระบบแล้ว ต้องการอัปเดตใบหน้าใหม่ใช่หรือไม่?`)) {
      existing.descriptors = [currentCapturedDescriptor];
      existing.avatar = currentCapturedAvatar;
      existing.studentId = idInput || existing.studentId;
    } else {
      return;
    }
  } else {
    registeredUsers.push({
      id: Date.now(),
      name: nameInput,
      studentId: idInput,
      avatar: currentCapturedAvatar,
      descriptors: [currentCapturedDescriptor],
      registeredAt: new Date().toLocaleDateString('th-TH')
    });
  }

  saveUsers();
  closeEnrollModal();
  alert(`บันทึกใบหน้าคุณ "${nameInput}" เรียบร้อยแล้ว!`);
}

function deleteUser(id) {
  const user = registeredUsers.find(u => u.id === id);
  if (!user) return;
  if (confirm(`คุณต้องการลบข้อมูลของ "${user.name}" ออกจากระบบใช่หรือไม่?`)) {
    registeredUsers = registeredUsers.filter(u => u.id !== id);
    saveUsers();
  }
}

function renderUserGrid() {
  const container = document.getElementById('users-grid');
  if (!container) return;

  if (registeredUsers.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1/-1; text-align:center; padding: 40px; color:#64748b;">
        ยังไม่มีรายชื่อที่ลงทะเบียน กดปุ่ม "ลงทะเบียนใบหน้าใหม่" ด้านบนได้เลย
      </div>
    `;
    return;
  }

  container.innerHTML = registeredUsers.map(user => `
    <div class="user-card">
      <img src="${user.avatar || 'data:image/svg+xml,<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"%2394a3b8\"><circle cx=\"12\" cy=\"8\" r=\"5\"/><path d=\"M20 21a8 8 0 10-16 0\"/></svg>'}" class="user-avatar" alt="${user.name}">
      <div class="user-meta">
        <h4>${user.name}</h4>
        <p>รหัส: ${user.studentId || '-'}</p>
        <p style="font-size:0.7rem; color:#94a3b8;">ลงทะเบียนเมื่อ: ${user.registeredAt || '-'}</p>
      </div>
      <button class="btn-delete-user" onclick="deleteUser(${user.id})" title="ลบรายชื่อ">✕</button>
    </div>
  `).join('');
}

// Backup & Restore
function exportUsersJSON() {
  const blob = new Blob([JSON.stringify(registeredUsers, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `facecheck_backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
}

function importUsersJSON(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (Array.isArray(data)) {
        registeredUsers = data;
        saveUsers();
        alert(`นำเข้าข้อมูลสำเร็จ ${data.length} รายชื่อ!`);
      }
    } catch (err) {
      alert('ไฟล์ JSON ไม่ถูกต้อง');
    }
  };
  reader.readAsText(file);
}

// --- Attendance Logs & Export ---
function renderAttendanceTable() {
  const tbody = document.getElementById('attendance-tbody');
  if (!tbody) return;

  if (attendanceLogs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 30px; color:#94a3b8;">ยังไม่มีประวัติการเช็คชื่อ</td></tr>`;
    return;
  }

  tbody.innerHTML = attendanceLogs.map((log, index) => `
    <tr>
      <td>${attendanceLogs.length - index}</td>
      <td>
        <div style="display:flex; align-items:center; gap:8px;">
          <img src="${log.avatar || 'data:image/svg+xml,<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"%2394a3b8\"><circle cx=\"12\" cy=\"8\" r=\"5\"/><path d=\"M20 21a8 8 0 10-16 0\"/></svg>'}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;">
          <strong>${log.name}</strong>
        </div>
      </td>
      <td>${log.studentId || '-'}</td>
      <td>${log.date}</td>
      <td>${log.time} น.</td>
      <td>
        <span class="badge ${log.status === 'ตรงเวลา' ? 'badge-success' : 'badge-warning'}">
          ${log.status}
        </span>
      </td>
    </tr>
  `).join('');
}

function updateStatsDisplay() {
  const totalEl = document.getElementById('stat-total');
  const ontimeEl = document.getElementById('stat-ontime');
  const lateEl = document.getElementById('stat-late');

  const todayStr = new Date().toLocaleDateString('th-TH');
  const todayLogs = attendanceLogs.filter(l => l.date === todayStr);

  const total = todayLogs.length;
  const onTime = todayLogs.filter(l => l.status === 'ตรงเวลา').length;
  const late = todayLogs.filter(l => l.status === 'มาสาย').length;

  if (totalEl) totalEl.textContent = total;
  if (ontimeEl) ontimeEl.textContent = onTime;
  if (lateEl) lateEl.textContent = late;
}

// ส่งออกไฟล์ CSV พร้อม UTF-8 BOM รองรับภาษาไทยใน Microsoft Excel
function exportAttendanceCSV() {
  if (attendanceLogs.length === 0) {
    alert('ยังไม่มีข้อมูลการเช็คชื่อให้ดาวน์โหลด');
    return;
  }

  let csvContent = '\uFEFF'; // UTF-8 BOM
  csvContent += 'ลำดับ,ชื่อ-นามสกุล,รหัสนักศึกษา,วันที่,เวลา,สถานะ\n';

  attendanceLogs.forEach((log, i) => {
    csvContent += `"${i + 1}","${log.name}","${log.studentId || ''}","${log.date}","${log.time}","${log.status}"\n`;
  });

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `รายงานเช็คชื่อ_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

function clearAttendanceLogs() {
  if (confirm('คุณต้องการล้างประวัติการเช็คชื่อทั้งหมดใช่หรือไม่?')) {
    attendanceLogs = [];
    cooldownMap.clear();
    saveLogs();
    if (recentList) recentList.innerHTML = '<div class="empty-state">ยังไม่มีใครเดินผ่าน</div>';
  }
}

// --- Navigation Tabs ---
function setupNavigation() {
  const tabs = document.querySelectorAll('.nav-tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const targetId = tab.getAttribute('data-target');
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.classList.add('active');
    });
  });
}

// --- Settings UI ---
function setupSettingsUI() {
  const lateInput = document.getElementById('cfg-late-time');
  const cooldownInput = document.getElementById('cfg-cooldown');
  const thresholdInput = document.getElementById('cfg-threshold');
  const soundToggle = document.getElementById('cfg-sound');
  const ttsToggle = document.getElementById('cfg-tts');

  if (lateInput) lateInput.value = config.lateTime;
  if (cooldownInput) cooldownInput.value = config.cooldownMinutes;
  if (thresholdInput) thresholdInput.value = config.distanceThreshold;
  if (soundToggle) soundToggle.checked = config.soundEnabled;
  if (ttsToggle) ttsToggle.checked = config.ttsEnabled;
}

function applySettings() {
  config.lateTime = document.getElementById('cfg-late-time').value || "08:30";
  config.cooldownMinutes = parseInt(document.getElementById('cfg-cooldown').value) || 10;
  config.distanceThreshold = parseFloat(document.getElementById('cfg-threshold').value) || 0.55;
  config.soundEnabled = document.getElementById('cfg-sound').checked;
  config.ttsEnabled = document.getElementById('cfg-tts').checked;

  saveConfig();
  buildFaceMatcher();
  alert('บันทึกการตั้งค่าเรียบร้อยแล้ว!');
}
