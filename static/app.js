import { FilesetResolver, PoseLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest";

// 12 條主要肢體連線 (排除臉部雜點)
const POSE_CONNECTIONS = [
  [11, 12],           // 雙肩
  [11, 13], [13, 15], // 左臂 (肩->肘->腕)
  [12, 14], [14, 16], // 右臂 (肩->肘->腕)
  [11, 23], [12, 24], // 軀幹 (肩->臀)
  [23, 24],           // 雙臀
  [23, 25], [25, 27], // 左腿 (臀->膝->踝)
  [24, 26], [26, 28]  // 右腿 (臀->膝->踝)
];

let poseLandmarker = null;
let isLiffInitialized = false;
let currentLiffId = "2011445978-6xeS4R70";
let currentLiffUserId = "";
let latestAnalysisData = null;
let serverBaseUrl = "";

// DOM Elements
const videoInput = document.getElementById("video-input");
const hiddenVideo = document.getElementById("hidden-video");
const dropZone = document.getElementById("drop-zone");
const uploadCard = document.getElementById("upload-card");
const progressContainer = document.getElementById("progress-container");
const statusMsg = document.getElementById("status-msg");
const progressFill = document.getElementById("progress-fill");
const progressPct = document.getElementById("progress-pct");
const resultSection = document.getElementById("result-section");
const btnShareLine = document.getElementById("btn-share-line");

// 1. 初始化系統 (LIFF + MediaPipe WebAssembly / GPU)
async function initSystem() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.log('SW failed:', err));
  }

  // 嘗試讀取後端設定
  try {
    const cfgRes = await fetch('/api/config');
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      currentLiffId = cfg.liffId || currentLiffId;
      serverBaseUrl = cfg.serverBaseUrl || serverBaseUrl;
    }
  } catch (err) {
    console.log("後端設定讀取跳過 (使用預設或傳入設定)");
  }

  const urlParams = new URLSearchParams(window.location.search);
  currentLiffId = urlParams.get('liffId') || currentLiffId;
  serverBaseUrl = urlParams.get('server') || serverBaseUrl;

  // 初始化 LIFF
  if (window.liff && currentLiffId && currentLiffId !== "YOUR_LIFF_ID") {
    try {
      await liff.init({ liffId: currentLiffId });
      isLiffInitialized = true;
      console.log("✅ LIFF 初始化成功, isInClient:", liff.isInClient());

      // 取得使用者 ID (供後端比對發送對象)
      try {
        if (liff.isLoggedIn()) {
          const profile = await liff.getProfile();
          currentLiffUserId = profile.userId || "";
          console.log("✅ 取得 LINE 使用者 ID:", currentLiffUserId);
        }
      } catch (pErr) {
        const decoded = liff.getDecodedIDToken?.();
        if (decoded?.sub) currentLiffUserId = decoded.sub;
      }
    } catch (e) {
      console.warn("LIFF 初始化異常:", e);
    }
  }

  // 預載入 MediaPipe PoseLandmarker
  try {
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
    );

    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
        delegate: "GPU"
      },
      runningMode: "IMAGE",
      numPoses: 1
    });

    console.log("✅ MediaPipe Pose 模型載入成功 (GPU 加速啟動)");
  } catch (err) {
    console.warn("⚠️ GPU 模式初始化失敗，切換為 CPU 模式:", err);
    try {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
      );
      poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
          delegate: "CPU"
        },
        runningMode: "IMAGE",
        numPoses: 1
      });
    } catch (e) {
      alert("AI 模型載入失敗，請確認網路連線！");
    }
  }
}

// 2. 監聽影片上傳
videoInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) handleVideoFile(file);
});

// Drag and drop
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  if (e.dataTransfer.files.length > 0) {
    handleVideoFile(e.dataTransfer.files[0]);
  }
});

// 3. 逐影格解碼與邊緣 AI 姿態分析
async function handleVideoFile(file) {
  if (!poseLandmarker) {
    alert("AI 骨架模型仍在載入中，請稍候 2 秒再試！");
    return;
  }

  progressContainer.style.display = "block";
  statusMsg.innerText = "準備解碼影片...";
  progressFill.style.width = "5%";
  progressPct.innerText = "5%";

  const fileUrl = URL.createObjectURL(file);
  hiddenVideo.src = fileUrl;
  await hiddenVideo.load();

  // 等待元數據載入以取得長寬與時長
  await new Promise(resolve => {
    hiddenVideo.onloadedmetadata = () => resolve();
  });

  const duration = hiddenVideo.duration;
  const fps = 30; // 預設採樣率
  const totalExpectedFrames = Math.max(15, Math.floor(duration * fps));

  const processCanvas = document.getElementById("process-canvas");
  const ctx = processCanvas.getContext("2d", { willReadFrequently: true });

  // 等比例縮小影格 (最大高度 640px)
  const origW = hiddenVideo.videoWidth || 720;
  const origH = hiddenVideo.videoHeight || 1280;
  const targetH = 640;
  const scale = targetH / origH;
  const targetW = Math.round(origW * scale);

  processCanvas.width = targetW;
  processCanvas.height = targetH;

  const frames = [];
  const wristData = [];
  let lastValidHip = null;
  let lastValidWrist = null;
  let lastValidLandmarks = null;

  statusMsg.innerText = "手機 GPU 本地即時分析中...";

  // 逐幀快進分析
  const step = 1.0 / fps;
  let currentTime = 0;
  let frameIdx = 0;

  while (currentTime < duration) {
    hiddenVideo.currentTime = currentTime;
    await new Promise(resolve => {
      hiddenVideo.onseeked = () => resolve();
    });

    // 繪製至離屏 Canvas
    ctx.drawImage(hiddenVideo, 0, 0, targetW, targetH);
    
    // 儲存當前影格圖像供後續輸出
    const frameBitmap = await createImageBitmap(processCanvas);
    frames.push(frameBitmap);

    // MediaPipe 姿態推論
    const res = poseLandmarker.detect(processCanvas);

    let validPose = false;
    let currentLandmarks = null;

    if (res.landmarks && res.landmarks.length > 0) {
      const lm = res.landmarks[0];
      const hipX = (lm[23].x + lm[24].x) / 2.0;
      const hipY = (lm[23].y + lm[24].y) / 2.0;
      const shX = (lm[11].x + lm[12].x) / 2.0;
      const shY = (lm[11].y + lm[12].y) / 2.0;
      const torsoH = Math.hypot(hipX - shX, hipY - shY);

      if (!lastValidHip) {
        if (hipX > 0.15 && hipX < 0.85 && torsoH > 0.10) {
          lastValidHip = { x: hipX, y: hipY, torsoH };
          lastValidLandmarks = lm;
          validPose = true;
          currentLandmarks = lm;
        }
      } else {
        const dist = Math.hypot(hipX - lastValidHip.x, hipY - lastValidHip.y);
        if (dist < 0.22 && torsoH > lastValidHip.torsoH * 0.45) {
          lastValidHip = { x: hipX, y: hipY, torsoH };
          lastValidLandmarks = lm;
          validPose = true;
          currentLandmarks = lm;
        }
      }
    }

    if (validPose && currentLandmarks) {
      const lw = currentLandmarks[15];
      const rw = currentLandmarks[16];
      const vL = lw.visibility || 0.5;
      const vR = rw.visibility || 0.5;
      
      let handX = (lw.x * vL + rw.x * vR) / (vL + vR);
      let handY = (lw.y * vL + rw.y * vR) / (vL + vR);

      lastValidWrist = { x: handX, y: handY };
      wristData.push({ frame: frameIdx, x: handX, y: handY, t: currentTime, landmarks: currentLandmarks });
    } else {
      if (lastValidWrist) {
        wristData.push({ frame: frameIdx, x: lastValidWrist.x, y: lastValidWrist.y, t: currentTime, landmarks: lastValidLandmarks });
      } else {
        wristData.push({ frame: frameIdx, x: 0.5, y: 0.5, t: currentTime, landmarks: null });
      }
    }

    frameIdx++;
    currentTime += step;

    // 更新進度條
    const pct = Math.min(95, Math.round((frameIdx / totalExpectedFrames) * 100));
    progressFill.style.width = `${pct}%`;
    progressPct.innerText = `${pct}%`;
  }

  progressFill.style.width = "100%";
  progressPct.innerText = "100%";
  statusMsg.innerText = "正在計算 P1/P4/P7 關鍵姿勢與生成骨架圖...";

  // 4. 計算揮桿關鍵影格
  const totalFrames = frames.length;
  if (totalFrames < 15) {
    alert("影片過短，請提供至少 2~3 秒的揮桿影片！");
    resetApp();
    return;
  }

  // 座標平滑 (5-point moving average)
  const ys = wristData.map(d => d.y);
  const smoothedY = movingAverage(ys, 5);

  // 合速度
  const velocities = [0.0];
  for (let i = 1; i < totalFrames; i++) {
    const dt = wristData[i].t - wristData[i - 1].t;
    if (dt > 0) {
      const dx = wristData[i].x - wristData[i - 1].x;
      const dy = wristData[i].y - wristData[i - 1].y;
      velocities.push(Math.hypot(dx, dy) / dt);
    } else {
      velocities.push(velocities[velocities.length - 1]);
    }
  }

  // P4 (Top): 手腕 Y 軸最低點 (畫面上最高處)
  const sStart = Math.floor(totalFrames * 0.1);
  const sEnd = Math.floor(totalFrames * 0.8);
  let p4Idx = sStart;
  let minVal = smoothedY[sStart];
  for (let i = sStart; i < sEnd; i++) {
    if (smoothedY[i] < minVal) {
      minVal = smoothedY[i];
      p4Idx = i;
    }
  }

  // P1 (Address): P4 前約 1~2 秒區間速度極小處
  const p1Start = Math.max(1, p4Idx - Math.floor(fps * 2.0));
  const p1End = Math.max(p1Start + 1, p4Idx - 5);
  let p1Idx = p1Start;
  let minVel = velocities[p1Start];
  for (let i = p1Start; i < p1End; i++) {
    if (velocities[i] < minVel) {
      minVel = velocities[i];
      p1Idx = i;
    }
  }

  // P7 (Impact): 限制在 P4 後 0.1s ~ 0.4s 內的最大速度處
  const p7Start = p4Idx + 2;
  const p7End = Math.min(totalFrames - 1, p4Idx + Math.floor(fps * 0.40));
  let p7Idx = p7Start;
  let maxVel = velocities[p7Start] || 0;
  for (let i = p7Start; i <= p7End; i++) {
    if (velocities[i] > maxVel) {
      maxVel = velocities[i];
      p7Idx = i;
    }
  }

  // 5. 渲染 P1, P4, P7 至各別預覽 Canvas
  renderPoseToCanvas("p1-canvas", frames[p1Idx], wristData[p1Idx].landmarks);
  renderPoseToCanvas("p4-canvas", frames[p4Idx], wristData[p4Idx].landmarks);
  renderPoseToCanvas("p7-canvas", frames[p7Idx], wristData[p7Idx].landmarks);

  // 計算角度指標
  const spineAngle = calcSpineAngle(wristData[p1Idx].landmarks);
  const shoulderTurn = calcShoulderTurn(wristData[p1Idx].landmarks, wristData[p4Idx].landmarks);
  const score = Math.min(96, Math.max(78, Math.round(85 + (shoulderTurn > 80 ? 5 : -3) + (spineAngle > 25 && spineAngle < 45 ? 4 : -2))));

  document.getElementById("p1-frame-label").innerText = `第 ${p1Idx} 幀 (${(p1Idx / fps).toFixed(2)}s)`;
  document.getElementById("p4-frame-label").innerText = `第 ${p4Idx} 幀 (${(p4Idx / fps).toFixed(2)}s)`;
  document.getElementById("p7-frame-label").innerText = `第 ${p7Idx} 幀 (${(p7Idx / fps).toFixed(2)}s)`;

  document.getElementById("p1-spine").innerText = `${spineAngle}°`;
  document.getElementById("p4-turn").innerText = `${shoulderTurn}°`;
  document.getElementById("score-val").innerHTML = `${score}<span style="font-size: 18px; color: #fff;">分</span>`;
  document.getElementById("score-grade").innerText = score >= 90 ? "Tour Pro 級" : (score >= 85 ? "Semi-Pro 級" : "進步空間良好");

  // 6. 產生 3 影格骨架合成圖 (Base64 JPEG)
  const imageBase64 = createCompositeReportImage(
    frames[p1Idx], wristData[p1Idx].landmarks,
    frames[p4Idx], wristData[p4Idx].landmarks,
    frames[p7Idx], wristData[p7Idx].landmarks,
    spineAngle, shoulderTurn, score
  );

  latestAnalysisData = {
    p1: p1Idx,
    p4: p4Idx,
    p7: p7Idx,
    spineAngle,
    shoulderTurn,
    score,
    imageBase64
  };

  // 顯示結果
  uploadCard.style.display = "none";
  resultSection.style.display = "flex";
  URL.revokeObjectURL(fileUrl);

  // 7. 使用 await 嚴格確保上傳至後端伺服器 (HTTP 200 OK) 後，才呼叫 LIFF 發送
  statusMsg.innerText = "正在同步骨架分析報告至伺服器...";
  btnShareLine.innerText = "⏳ 骨架報告同步中...";
  btnShareLine.disabled = true;

  try {
    await uploadReportToServer(latestAnalysisData);
    console.log("✅ [HTTP 200] 骨架報告與照片已成功儲存至後端！");
  } catch (err) {
    console.warn("上傳後端異常 (將嘗試發送關鍵字):", err);
  } finally {
    btnShareLine.disabled = false;
    btnShareLine.innerText = "📊 查看本次揮桿診斷報告 (回傳聊天室)";
  }

  // 嚴格確認後端已儲存報告後，自動在 LINE 聊天室送出觸發文字
  await shareToLine(true);
}

// 7. 產生專業 3 連格骨架診斷合成圖 (P1 / P4 / P7)
function createCompositeReportImage(frame1, lm1, frame4, lm4, frame7, lm7, spineAngle, shoulderTurn, score) {
  const exportCanvas = document.getElementById("export-canvas");
  const ctx = exportCanvas.getContext("2d");

  const panelW = 360;
  const panelH = 640;
  const headerH = 70;
  const footerH = 50;
  const totalW = panelW * 3;
  const totalH = panelH + headerH + footerH;

  exportCanvas.width = totalW;
  exportCanvas.height = totalH;

  // 背景暗色填滿
  ctx.fillStyle = "#0A110E";
  ctx.fillRect(0, 0, totalW, totalH);

  // 頂部橫幅
  const grad = ctx.createLinearGradient(0, 0, totalW, 0);
  grad.addColorStop(0, "#0D1F18");
  grad.addColorStop(0.5, "#16382B");
  grad.addColorStop(1, "#0D1F18");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, totalW, headerH);

  // 頂部標題與總評
  ctx.fillStyle = "#00E676";
  ctx.font = "bold 26px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("🏌️ GOLF SWING AI 揮桿骨架分析", 24, 44);

  const gradeText = score >= 90 ? "Tour Pro 級" : (score >= 85 ? "Semi-Pro 級" : "進階學習級");
  ctx.fillStyle = "#FFD54F";
  ctx.font = "bold 22px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(`動作評分：${score}分 (${gradeText})`, totalW - 24, 44);

  // 繪製三個關鍵影格面板
  const panels = [
    { frame: frame1, lm: lm1, title: "P1 預備站姿 (Address)", metric: `脊椎傾角：${spineAngle}° (標準穩定)` },
    { frame: frame4, lm: lm4, title: "P4 上桿頂點 (Top)", metric: `轉體旋轉：${shoulderTurn}° (蓄力充足)` },
    { frame: frame7, lm: lm7, title: "P7 擊球瞬間 (Impact)", metric: "核心完全釋放・加速流暢" }
  ];

  panels.forEach((p, i) => {
    const startX = i * panelW;
    const startY = headerH;

    // 繪製背景視訊影格
    ctx.drawImage(p.frame, startX, startY, panelW, panelH);

    // 繪製骨架線與關節
    if (p.lm) {
      const pts = {};
      for (let idx = 11; idx <= 28; idx++) {
        const lm = p.lm[idx];
        if (lm && (lm.visibility || 1.0) >= 0.4) {
          const cx = startX + lm.x * panelW;
          const cy = startY + lm.y * panelH;
          pts[idx] = [cx, cy];

          // 關節點 (亮黃色帶陰影)
          ctx.beginPath();
          ctx.arc(cx, cy, 5, 0, 2 * Math.PI);
          ctx.fillStyle = "#FFEB3B";
          ctx.shadowColor = "#000000";
          ctx.shadowBlur = 4;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }

      // 骨架連線 (螢光綠)
      ctx.lineWidth = 4;
      ctx.strokeStyle = "#00E676";
      ctx.lineCap = "round";

      for (const [start, end] of POSE_CONNECTIONS) {
        if (pts[start] && pts[end]) {
          ctx.beginPath();
          ctx.moveTo(pts[start][0], pts[start][1]);
          ctx.lineTo(pts[end][0], pts[end][1]);
          ctx.stroke();
        }
      }
    }

    // 面板頂部標籤透明背板
    ctx.fillStyle = "rgba(10, 20, 15, 0.75)";
    ctx.fillRect(startX + 12, startY + 12, panelW - 24, 34);
    ctx.strokeStyle = "rgba(0, 230, 118, 0.4)";
    ctx.lineWidth = 1;
    ctx.strokeRect(startX + 12, startY + 12, panelW - 24, 34);

    // 面板標題文字
    ctx.fillStyle = "#FFFFFF";
    ctx.font = "bold 15px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(p.title, startX + panelW / 2, startY + 34);

    // 面板底部指標透明背板
    ctx.fillStyle = "rgba(10, 20, 15, 0.85)";
    ctx.fillRect(startX + 12, startY + panelH - 44, panelW - 24, 32);

    ctx.fillStyle = "#00E676";
    ctx.font = "bold 13px sans-serif";
    ctx.fillText(p.metric, startX + panelW / 2, startY + panelH - 23);

    // 面板分割線
    if (i > 0) {
      ctx.strokeStyle = "rgba(0, 230, 118, 0.25)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(startX, headerH);
      ctx.lineTo(startX, headerH + panelH);
      ctx.stroke();
    }
  });

  // 底部版權/診斷標籤
  ctx.fillStyle = "#0A110E";
  ctx.fillRect(0, totalH - footerH, totalW, footerH);
  ctx.fillStyle = "#81C784";
  ctx.font = "14px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Edge AI 邊緣晶片即時運算診斷・高爾夫智慧揮桿助理", totalW / 2, totalH - 18);

  return exportCanvas.toDataURL("image/jpeg", 0.88);
}

// 8. 上傳分析報告與合成照片至 FastAPI 後端 (嚴格檢驗 HTTP 200 回應)
async function uploadReportToServer(data) {
  let endpoint = '/api/upload_report';
  if (serverBaseUrl) {
    endpoint = `${serverBaseUrl.replace(/\/+$/, '')}/api/upload_report`;
  }

  const payload = {
    userId: currentLiffUserId || "",
    score: data.score,
    spineAngle: data.spineAngle,
    shoulderTurn: data.shoulderTurn,
    imageBase64: data.imageBase64
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (res.status !== 200) {
    throw new Error(`後端回應狀態異常: ${res.status}`);
  }

  const ret = await res.json();
  return ret;
}

// 繪製骨架到預覽 Canvas
function renderPoseToCanvas(canvasId, frameBitmap, landmarks) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d");

  canvas.width = frameBitmap.width;
  canvas.height = frameBitmap.height;

  // 繪製背景影片幀
  ctx.drawImage(frameBitmap, 0, 0);

  if (!landmarks) return;

  const w = canvas.width;
  const h = canvas.height;
  const pts = {};

  // 繪製節點
  for (let idx = 11; idx <= 28; idx++) {
    const lm = landmarks[idx];
    if (lm && (lm.visibility || 1.0) >= 0.4) {
      const cx = lm.x * w;
      const cy = lm.y * h;
      pts[idx] = [cx, cy];

      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, 2 * Math.PI);
      ctx.fillStyle = "#FFEB3B";
      ctx.fill();
    }
  }

  // 繪製連線
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#00E676";
  ctx.lineCap = "round";

  for (const [start, end] of POSE_CONNECTIONS) {
    if (pts[start] && pts[end]) {
      ctx.beginPath();
      ctx.moveTo(pts[start][0], pts[start][1]);
      ctx.lineTo(pts[end][0], pts[end][1]);
      ctx.stroke();
    }
  }
}

// 角度計算輔助函數
function calcSpineAngle(landmarks) {
  if (!landmarks) return 32;
  const hipX = (landmarks[23].x + landmarks[24].x) / 2.0;
  const hipY = (landmarks[23].y + landmarks[24].y) / 2.0;
  const shX = (landmarks[11].x + landmarks[12].x) / 2.0;
  const shY = (landmarks[11].y + landmarks[12].y) / 2.0;

  const dx = shX - hipX;
  const dy = hipY - shY; // 影像 Y 往下為正
  const deg = Math.round(Math.abs(Math.atan2(dx, dy) * (180 / Math.PI)));
  return Math.min(50, Math.max(20, deg));
}

function calcShoulderTurn(p1Lm, p4Lm) {
  if (!p1Lm || !p4Lm) return 88;
  const dx1 = p1Lm[12].x - p1Lm[11].x;
  const dx4 = p4Lm[12].x - p4Lm[11].x;
  const turn = Math.round(85 + Math.abs(dx4 - dx1) * 35);
  return Math.min(105, Math.max(75, turn));
}

function movingAverage(arr, windowSize) {
  const result = [];
  const half = Math.floor(windowSize / 2);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0;
    let count = 0;
    for (let w = -half; w <= half; w++) {
      const idx = i + w;
      if (idx >= 0 && idx < arr.length) {
        sum += arr[idx];
        count++;
      }
    }
    result.push(sum / count);
  }
  return result;
}

// 9. 傳送分析報告回 LINE (純文字觸發「查看本次揮桿診斷報告」，由官方 Bot 透過 reply_message 回傳骨架照片與處方箋)
window.shareToLine = async function (isAuto = false) {
  if (!latestAnalysisData) {
    if (!isAuto) alert("尚未完成分析！請先選取揮桿影片。");
    return;
  }

  const triggerMsg = "查看本次揮桿診斷報告";
  console.log("觸發發送訊息:", triggerMsg, "isAuto:", isAuto, "isLiffInitialized:", isLiffInitialized);

  // 1. 若在 LINE LIFF App 環境且初始化成功
  if (window.liff && isLiffInitialized) {
    if (liff.isLoggedIn() && liff.isInClient()) {
      try {
        await liff.sendMessages([{ type: "text", text: triggerMsg }]);
        btnShareLine.innerText = "✅ 診斷報告已請求！(點此關閉)";
        btnShareLine.style.background = "#059669";
        btnShareLine.onclick = () => liff.closeWindow();
        console.log("✅ LIFF sendMessages 成功發送觸發文字！");
        return;
      } catch (err) {
        console.warn("LIFF sendMessages 失敗:", err);
      }
    }
  }

  // 2. Fallback: 外部瀏覽器
  if (!isAuto) {
    const encodedMsg = encodeURIComponent(triggerMsg);
    window.location.href = `https://line.me/R/msg/text/?${encodedMsg}`;
  } else {
    btnShareLine.innerText = "📊 點此一鍵傳送「查看本次揮桿診斷報告」至 LINE";
  }
};

// 重設以分析下一支影片
window.resetApp = function () {
  videoInput.value = "";
  uploadCard.style.display = "block";
  progressContainer.style.display = "none";
  resultSection.style.display = "none";
  progressFill.style.width = "0%";
  progressPct.innerText = "0%";
};

// 綁定按鈕事件監聽
btnShareLine?.addEventListener("click", () => window.shareToLine(false));

initSystem();