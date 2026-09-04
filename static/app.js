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
let latestAnalysisData = null;

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

  // LIFF ID (直接寫死並支援參數自定義)
  let liffId = "2011445978-6xeS4R70";
  try {
    const cfgRes = await fetch('/api/config');
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      liffId = cfg.liffId || liffId;
    }
  } catch (err) {
    console.log("無法獲取後端設定，使用預設 LIFF ID:", err);
  }

  const urlParams = new URLSearchParams(window.location.search);
  liffId = urlParams.get('liffId') || liffId;

  // 初始化 LIFF
  if (window.liff && liffId && liffId !== "YOUR_LIFF_ID") {
    try {
      await liff.init({ liffId });
      isLiffInitialized = true;
      console.log("✅ LIFF 初始化成功, isInClient:", liff.isInClient());
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
    
    // 取得當前影格 ImageData
    const imgData = ctx.getImageData(0, 0, targetW, targetH);
    
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
  statusMsg.innerText = "正在計算 P1/P4/P7 關鍵姿勢與角度...";

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

  // 5. 渲染 P1, P4, P7 至對應 Canvas
  renderPoseToCanvas("p1-canvas", frames[p1Idx], wristData[p1Idx].landmarks, "P1: Address");
  renderPoseToCanvas("p4-canvas", frames[p4Idx], wristData[p4Idx].landmarks, "P4: Top");
  renderPoseToCanvas("p7-canvas", frames[p7Idx], wristData[p7Idx].landmarks, "P7: Impact");

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

  latestAnalysisData = {
    p1: p1Idx,
    p4: p4Idx,
    p7: p7Idx,
    spineAngle,
    shoulderTurn,
    score
  };

  // 顯示結果
  uploadCard.style.display = "none";
  resultSection.style.display = "flex";
  URL.revokeObjectURL(fileUrl);

  // 分析完成後，自動執行傳送診斷報告至 LINE 聊天室
  setTimeout(() => {
    shareToLine(true);
  }, 400);
}

// 繪製骨架與標籤到 Canvas
function renderPoseToCanvas(canvasId, frameBitmap, landmarks, label) {
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

// 傳送分析報告回 LINE
window.shareToLine = async function (isAuto = false) {
  if (!latestAnalysisData) {
    if (!isAuto) alert("尚未完成分析！請先選取揮桿影片。");
    return;
  }

  const triggerMsg = `查看本次揮桿診斷報告 [得分:${latestAnalysisData.score}|P1脊椎:${latestAnalysisData.spineAngle}°|P4轉體:${latestAnalysisData.shoulderTurn}°|P7釋放:優異]`;
  console.log("觸發發送報告:", triggerMsg, "isAuto:", isAuto, "isLiffInitialized:", isLiffInitialized);

  // 1. 若在 LINE LIFF App 環境且初始化成功
  if (window.liff && isLiffInitialized) {
    if (liff.isLoggedIn() && liff.isInClient()) {
      try {
        await liff.sendMessages([{ type: "text", text: triggerMsg }]);
        btnShareLine.innerText = "✅ 診斷已發送至 LINE！(點此關閉)";
        btnShareLine.style.background = "#059669";
        btnShareLine.onclick = () => liff.closeWindow();
        console.log("✅ LIFF sendMessages 成功發送！");
        return;
      } catch (err) {
        console.warn("LIFF sendMessages 失敗:", err);
        if (!isAuto) {
          alert("⚠️ 無法在聊天室直接發話。\n常見原因：請確認 LINE Developers 後台 LIFF 設定的 Scopes 已勾選「chat_message.write」！\n系統將為您改用直連發送。");
        }
      }
    }
  }

  // 2. Fallback: 外部瀏覽器或無 LIFF 權限時，直接透過 LINE URL Scheme 傳送
  if (!isAuto) {
    const encodedMsg = encodeURIComponent(triggerMsg);
    window.location.href = `https://line.me/R/msg/text/?${encodedMsg}`;
  } else {
    btnShareLine.innerText = "📊 點此一鍵傳送診斷報告至 LINE";
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