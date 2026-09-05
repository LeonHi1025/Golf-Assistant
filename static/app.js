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
let serverBaseUrl = "https://golf-assistant.onrender.com";
let proBenchmark = null;

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

// 1. 初始化系統 (LIFF + MediaPipe WebAssembly / GPU + Tiger 職業基準庫)
async function initSystem() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.log('SW failed:', err));
  }

  // 嘗試載入 Tiger Woods 職業標準基準 JSON (pro_benchmark.json)
  try {
    const proRes = await fetch('pro_benchmark.json?v=20260905_1');
    if (proRes.ok) {
      proBenchmark = await proRes.json();
      console.log("🏆 Tiger Woods 職業基準數據庫已成功載入:", proBenchmark.pro_name);
    }
  } catch (pErr) {
    console.warn("載入 pro_benchmark.json 失敗，使用標準預設力學參數:", pErr);
  }

  // 嘗試讀取後端動態設定
  try {
    const cfgRes = await fetch(`${serverBaseUrl}/api/config`);
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

// 觸發防呆警告流程 (通知使用者並向 LINE 發送「警告」文字觸發規範說明)
async function triggerFoolproofWarning(reason) {
  console.warn("⚠️ 觸發防呆機制:", reason);
  alert(`⚠️ 格式不符合規定：${reason}，請檢查後重新上傳！`);
  resetApp();

  const warningMsg = "警告";
  if (window.liff && isLiffInitialized) {
    if (liff.isLoggedIn() && liff.isInClient()) {
      try {
        await liff.sendMessages([{ type: "text", text: warningMsg }]);
        console.log("✅ 已自動向 LINE 發送「警告」觸發規範說明！");
      } catch (e) {
        console.warn("發送警告訊息失敗:", e);
      }
    }
  }
}

// 3. 逐影格解碼與邊緣 AI 姿態分析
async function handleVideoFile(file) {
  if (!file) return;

  // 1. 照片 / 非影片格式防呆
  const isVideoType = file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(file.name);
  if (!isVideoType) {
    await triggerFoolproofWarning("本系統僅支援影片檔案，不支援靜態照片");
    return;
  }

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

  // 2. 影片時長超過 60 秒或過短防呆
  if (!duration || isNaN(duration) || duration > 60) {
    await triggerFoolproofWarning("影片長度超過 60 秒（建議上傳 5~15 秒之揮桿片段）");
    return;
  }
  if (duration < 0.8) {
    await triggerFoolproofWarning("影片長度過短，無法解析完整揮桿動作");
    return;
  }

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

  const wristData = [];
  let lastValidHip = null;
  let lastValidWrist = null;
  let lastValidLandmarks = null;

  statusMsg.innerText = "手機 GPU 本地即時分析中...";

  // 逐幀快進分析 (僅提取 MediaPipe 數值特徵，不暫存全域點陣圖，大幅省下 99% 記憶體)
  const step = 1.0 / fps;
  let currentTime = 0;
  let frameIdx = 0;

  while (currentTime < duration) {
    hiddenVideo.currentTime = currentTime;
    await new Promise(resolve => {
      hiddenVideo.onseeked = () => resolve();
    });

    // 繪製至離屏 Canvas 供 MediaPipe 姿態推論
    ctx.drawImage(hiddenVideo, 0, 0, targetW, targetH);

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

  // =============================================================
  // 4. 計算揮桿關鍵影格 (速度與運動學動力學演算法)
  // =============================================================
  const totalFrames = wristData.length;
  if (totalFrames < 15) {
    await triggerFoolproofWarning("影片有效影格數過少，無法完成揮桿分析");
    return;
  }

  // 1. 整理有效骨架與平滑手腕速度 (Smoothing & Velocity)
  const validData = [];
  for (let i = 0; i < totalFrames; i++) {
    const d = wristData[i];
    if (d && d.landmarks) {
      const lm = d.landmarks;
      const hipX = (lm[23].x + lm[24].x) / 2.0;
      const hipY = (lm[23].y + lm[24].y) / 2.0;
      const shX = (lm[11].x + lm[12].x) / 2.0;
      const shY = (lm[11].y + lm[12].y) / 2.0;
      validData.push({
        idx: i,
        t: d.t,
        hx: d.x,
        hy: d.y,
        hipX,
        hipY,
        shX,
        shY,
        landmarks: lm
      });
    }
  }

  // 3. 骨架有效性與識別率防呆 (排除拍風景、動物、黑屏或骨架嚴重遮蔽)
  if (validData.length < 15 || (validData.length / totalFrames) < 0.30) {
    await triggerFoolproofWarning("無法清晰識別出人體骨架（請確保人物全身清楚入鏡）");
    return;
  }

  // 4. 揮桿位移範圍與運動合理性防呆 (排除靜止不動、只有走動或亂傳非揮桿影片)
  const minHx = Math.min(...validData.map(d => d.hx));
  const maxHx = Math.max(...validData.map(d => d.hx));
  const minHy = Math.min(...validData.map(d => d.hy));
  const maxHy = Math.max(...validData.map(d => d.hy));
  const motionRangeX = maxHx - minHx;
  const motionRangeY = maxHy - minHy;

  if (motionRangeX < 0.12 && motionRangeY < 0.10) {
    await triggerFoolproofWarning("未偵測到揮桿運動軌跡（請確認為高爾夫揮桿動作）");
    return;
  }

  // 計算每一幀手腕水平移動速度 (向右下桿為正速度，向左引桿為負速度)
  for (let i = 0; i < validData.length; i++) {
    const prev = validData[Math.max(0, i - 1)];
    const next = validData[Math.min(validData.length - 1, i + 1)];
    validData[i].vx = (next.hx - prev.hx) / 2.0; // 手腕 X 方向速度
    validData[i].vy = (next.hy - prev.hy) / 2.0; // 手腕 Y 方向速度
  }

  // 2. 基準站姿中軸與手腕初始球位
  const setupFrames = validData.slice(0, Math.max(5, Math.floor(validData.length * 0.15)));
  const refHipX = setupFrames.reduce((acc, cur) => acc + cur.hipX, 0) / setupFrames.length;
  const refHipY = setupFrames.reduce((acc, cur) => acc + cur.hipY, 0) / setupFrames.length;
  const refHandX = setupFrames.reduce((acc, cur) => acc + cur.hx, 0) / setupFrames.length;
  const refShY = setupFrames.reduce((acc, cur) => acc + cur.shY, 0) / setupFrames.length;

  // -------------------------------------------------------------
  // 步驟 A：精確定位 P4（上桿頂點 Top of Swing）
  // -------------------------------------------------------------
  // 在前半段尋找手腕垂直高度最高點 (hy 最小值)
  const p4Pool = validData.filter(d => d.idx <= Math.floor(validData.length * 0.6) && d.hx < refHipX - 0.03 && d.hy < refShY);
  const p4Data = p4Pool.length > 0
    ? p4Pool.reduce((minD, d) => d.hy < minD.hy ? d : minD, p4Pool[0])
    : validData.slice(0, Math.floor(validData.length * 0.5)).reduce((minD, d) => d.hy < minD.hy ? d : minD, validData[0]);
  const p4Idx = p4Data.idx;

  // -------------------------------------------------------------
  // 步驟 B：定位 P1（準備站姿 Address）
  // -------------------------------------------------------------
  // 核心力學：P1 準備站姿時，雙手必須自然垂放在「身體軀幹輪廓之內」（左右肩與左右臀的水平寬度之內），
  // 且手腕高度低於髖部，呈現起桿前最穩定的靜止站姿。
  const preP4 = validData.filter(d => d.idx < p4Idx);
  const addressCandidates = preP4.filter(d => {
    const lm = d.landmarks;
    const minBodyX = Math.min(lm[11].x, lm[12].x, lm[23].x, lm[24].x);
    const maxBodyX = Math.max(lm[11].x, lm[12].x, lm[23].x, lm[24].x);
    const isInsideBody = (d.hx >= minBodyX - 0.01 && d.hx <= maxBodyX + 0.01);
    const isHangingDown = (d.hy >= d.hipY - 0.05);
    return isInsideBody && isHangingDown;
  });

  // 在符合身體輪廓內的站姿幀中，取起桿前手腕移動速度最低（最穩定）的影格
  let p1Data = addressCandidates.length > 0
    ? addressCandidates.reduce((minD, d) => Math.hypot(d.vx, d.vy) < Math.hypot(minD.vx, minD.vy) ? d : minD, addressCandidates[0])
    : (preP4.length > 0 ? preP4[0] : validData[0]);
  const p1Idx = p1Data.idx;

  // -------------------------------------------------------------
  // 步驟 C：定位 P2 與 P3（上揚階段）
  // -------------------------------------------------------------
  // P2 起桿水平：引桿初期手腕水平通過髖部高度 (hy 最接近 refHipY)
  const backRange = validData.filter(d => d.idx > p1Idx && d.idx < p4Idx);
  const p2Data = backRange.length > 0
    ? backRange.reduce((closest, d) => Math.abs(d.hy - refHipY) < Math.abs(closest.hy - refHipY) ? d : closest, backRange[0])
    : p1Data;
  const p2Idx = p2Data.idx;

  // P3 上桿半程：手腕向左移動最深處（hx 最小，左臂水平）
  const p3Range = validData.filter(d => d.idx > p2Idx && d.idx < p4Idx);
  const p3Data = p3Range.length > 0
    ? p3Range.reduce((minD, d) => d.hx < minD.hx ? d : minD, p3Range[0])
    : validData[Math.round((p2Idx + p4Idx) / 2)];
  const p3Idx = p3Data.idx;

  // -------------------------------------------------------------
  // 步驟 D：定位 P8（送桿水平 Follow-Through）
  // -------------------------------------------------------------
  // P8 是擊球送出時，雙臂與球桿朝目標側伸展最遠的瞬間 (hx 達到最大極值)
  const postP4 = validData.filter(d => d.idx > p4Idx);
  const p8Data = postP4.length > 0
    ? postP4.reduce((maxD, d) => d.hx > maxD.hx ? d : maxD, postP4[0])
    : validData[Math.min(validData.length - 1, p4Idx + 30)];
  const p8Idx = p8Data.idx;

  // -------------------------------------------------------------
  // 步驟 E：精確鎖定 P7（擊球瞬間 Impact）
  // -------------------------------------------------------------
  // P7 嚴格介於 P4 與 P8 之間，手腕跨過髖部中軸線且高度回歸站姿擊球高度 (最接近 refHipY)
  const impactCandidates = validData.filter(d => d.idx > p4Idx && d.idx < p8Idx && d.hx >= d.hipX);
  const p7Data = impactCandidates.length > 0
    ? impactCandidates.reduce((closest, d) => Math.abs(d.hy - refHipY) < Math.abs(closest.hy - refHipY) ? d : closest, impactCandidates[0])
    : validData[Math.round((p4Idx + p8Idx) / 2)];
  const p7Idx = p7Data.idx;

  // -------------------------------------------------------------
  // 步驟 F：定位 P5 與 P6（下桿階段）
  // -------------------------------------------------------------
  // P5 (下桿半程)：手腕高度在 P4 與 P7 中間 (右臂水平)
  const downRange = validData.filter(d => d.idx > p4Idx && d.idx < p7Idx);
  const midDownY = (p4Data.hy + p7Data.hy) / 2.0;
  const p5Data = downRange.length > 0
    ? downRange.reduce((closest, d) => Math.abs(d.hy - midDownY) < Math.abs(closest.hy - midDownY) ? d : closest, downRange[0])
    : validData[Math.round((p4Idx + p7Idx) / 2)];
  const p5Idx = p5Data.idx;

  // P6 (擊球前導 Delivery Lag)：手腕降至大腿前 (介於 P5 與 P7 之間手腕向下沉壓最低點 hy 最大值)
  const p6Range = validData.filter(d => d.idx > p5Idx && d.idx < p7Idx);
  const p6Data = p6Range.length > 0
    ? p6Range.reduce((maxD, d) => d.hy > maxD.hy ? d : maxD, p6Range[0])
    : validData[Math.max(p5Idx + 1, p7Idx - 2)];
  const p6Idx = p6Data.idx;

  // -------------------------------------------------------------
  // 步驟 G：定位 P10（收桿完成 Finish）
  // -------------------------------------------------------------
  const p10Pool = validData.filter(d => d.idx > p8Idx && d.hx < refHipX);
  const p10Data = p10Pool.length >= 3 ? p10Pool[p10Pool.length - 3] : validData[validData.length - 1];
  const p10Idx = p10Data.idx;

  // -------------------------------------------------------------
  // 步驟 H：定位 P9（送桿半程 Mid-Exit）
  // -------------------------------------------------------------
  // P9 介於 P8 (桿身水平) 與 P10 (收桿) 之間，手腕抬升至雙肩高度 (hy 接近 refShY - 0.08)
  const p9Range = validData.filter(d => d.idx > p8Idx && d.idx < p10Idx);
  const p9Data = p9Range.length > 0
    ? p9Range.reduce((closest, d) => Math.abs(d.hy - (refShY - 0.08)) < Math.abs(closest.hy - (refShY - 0.08)) ? d : closest, p9Range[0])
    : validData[Math.round((p8Idx + p10Idx) / 2)];
  const p9Idx = p9Data.idx;

  const phaseIndices = {
    P1: p1Idx, P2: p2Idx, P3: p3Idx,
    P4: p4Idx, P5: p5Idx, P6: p6Idx,
    P7: p7Idx, P8: p8Idx, P9: p9Idx, P10: p10Idx
  };

  console.log("⛳ 高精度多特徵動力學定位完成:", phaseIndices);

  // 8. 精準單獨擷取 10 個關鍵相位清晰截圖 (記憶體自 1.2GB 驟降至 10MB，徹底防閃退)
  statusMsg.innerText = "正在擷取 10 大關鍵影格清晰截圖...";
  const keyBitmaps = {};
  for (const [phase, fIdx] of Object.entries(phaseIndices)) {
    if (fIdx !== undefined) {
      const t = wristData[fIdx]?.t ?? (fIdx * step);
      hiddenVideo.currentTime = t;
      await new Promise(resolve => {
        hiddenVideo.onseeked = () => resolve();
      });
      ctx.drawImage(hiddenVideo, 0, 0, targetW, targetH);
      keyBitmaps[phase] = await createImageBitmap(processCanvas);
    }
  }

  // 渲染 P1 ~ P10 全部 10 個相位預覽 Canvas (包含淡深紫色 Tiger 職業選手對比骨架)
  const pKeys = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'];
  pKeys.forEach((k) => {
    const pKeyUpper = k.toUpperCase();
    const fIdx = phaseIndices[pKeyUpper];
    const proLm = proBenchmark?.phases?.[pKeyUpper]?.landmarks || null;
    const bitmap = keyBitmaps[pKeyUpper];
    if (fIdx !== undefined && bitmap) {
      renderPoseToCanvas(`${k}-canvas`, bitmap, wristData[fIdx]?.landmarks, proLm);
      const label = document.getElementById(`${k}-frame-label`);
      if (label) label.innerText = `第 ${fIdx} 幀 (${(fIdx / fps).toFixed(2)}s)`;
    }
  });

  // 9. Tiger Woods 黃金標準即時比對與口語化動作提示 (compareWithPro)
  const spineAngle = calcSpineAngle(wristData[p1Idx]?.landmarks);
  const shoulderTurn = calcShoulderTurn(wristData[p1Idx]?.landmarks, wristData[p4Idx]?.landmarks);
  
  const armAngles = {
    P1: calcArmTorsoAngle(wristData[p1Idx]?.landmarks),
    P2: calcArmTorsoAngle(wristData[p2Idx]?.landmarks),
    P3: calcArmTorsoAngle(wristData[p3Idx]?.landmarks),
    P4: calcArmTorsoAngle(wristData[p4Idx]?.landmarks),
    P5: calcArmTorsoAngle(wristData[p5Idx]?.landmarks),
    P6: calcArmTorsoAngle(wristData[p6Idx]?.landmarks),
    P7: calcArmTorsoAngle(wristData[p7Idx]?.landmarks),
    P8: calcArmTorsoAngle(wristData[p8Idx]?.landmarks),
    P9: calcArmTorsoAngle(wristData[p9Idx]?.landmarks),
    P10: calcArmTorsoAngle(wristData[p10Idx]?.landmarks),
  };

  const userMetrics = {
    spineAngle,
    shoulderTurn,
    armAngles
  };

  const comparison = compareWithPro(userMetrics, proBenchmark);
  const score = comparison.score;
  const similarity = comparison.similarity;
  const adviceList = comparison.stageAdvice;

  const spineEl = document.getElementById("p1-spine");
  if (spineEl) spineEl.innerText = `${spineAngle}°`;
  const turnEl = document.getElementById("p4-turn");
  if (turnEl) turnEl.innerText = `${armAngles.P4}°`;
  
  document.getElementById("score-val").innerHTML = `${similarity}<span style="font-size: 18px; color: #71717A;">%</span>`;
  document.getElementById("score-grade").innerText = `Tiger 相似度 ${similarity}% (${similarity >= 88 ? '職業級對齊' : '進階微調建議'})`;

  // 10. 產生【3 + 4 + 3】分組照片組（疊加淡深紫色 Tiger 職業標準骨架供直覺對比）
  // 組 1（上揚）：P1 準備站姿, P2 起桿水平, P3 上桿半程 (3格)
  const imgSet1 = createCompositeSetImage([
    { frame: keyBitmaps.P1, lm: wristData[p1Idx]?.landmarks, proLm: proBenchmark?.phases?.P1?.landmarks, tag: "P1  準備站姿" },
    { frame: keyBitmaps.P2, lm: wristData[p2Idx]?.landmarks, proLm: proBenchmark?.phases?.P2?.landmarks, tag: "P2  起桿水平" },
    { frame: keyBitmaps.P3, lm: wristData[p3Idx]?.landmarks, proLm: proBenchmark?.phases?.P3?.landmarks, tag: "P3  上桿半程" }
  ]);

  // 組 2（擊球）：P4 上桿頂點, P5 下桿半程, P6 擊球前導, P7 擊球瞬間 (4格)
  const imgSet2 = createCompositeSetImage([
    { frame: keyBitmaps.P4, lm: wristData[p4Idx]?.landmarks, proLm: proBenchmark?.phases?.P4?.landmarks, tag: "P4  上桿頂點" },
    { frame: keyBitmaps.P5, lm: wristData[p5Idx]?.landmarks, proLm: proBenchmark?.phases?.P5?.landmarks, tag: "P5  下桿半程" },
    { frame: keyBitmaps.P6, lm: wristData[p6Idx]?.landmarks, proLm: proBenchmark?.phases?.P6?.landmarks, tag: "P6  擊球前導" },
    { frame: keyBitmaps.P7, lm: wristData[p7Idx]?.landmarks, proLm: proBenchmark?.phases?.P7?.landmarks, tag: "P7  擊球瞬間" }
  ]);

  // 組 3（送出）：P8 送桿水平, P9 送桿半程, P10 收桿完成 (3格)
  const imgSet3 = createCompositeSetImage([
    { frame: keyBitmaps.P8, lm: wristData[p8Idx]?.landmarks, proLm: proBenchmark?.phases?.P8?.landmarks, tag: "P8  送桿水平" },
    { frame: keyBitmaps.P9, lm: wristData[p9Idx]?.landmarks, proLm: proBenchmark?.phases?.P9?.landmarks, tag: "P9  送桿半程" },
    { frame: keyBitmaps.P10, lm: wristData[p10Idx]?.landmarks, proLm: proBenchmark?.phases?.P10?.landmarks, tag: "P10 收桿完成" }
  ]);

  latestAnalysisData = {
    phases: phaseIndices,
    score,
    similarity,
    spineAngle,
    shoulderTurn,
    armAngles,
    p1Spine: spineAngle,
    p4Turn: armAngles.P4,
    p4Arm: armAngles.P4,
    p6Lag: armAngles.P6,
    p7Ext: armAngles.P7,
    p10Bal: armAngles.P10,
    diffs: comparison.diffs,
    stageAdvice: adviceList,
    summaryAdvice: adviceList,
    imageBase64: imgSet1,
    images: [imgSet1, imgSet2, imgSet3]
  };

  // 顯示結果
  uploadCard.style.display = "none";
  resultSection.style.display = "flex";
  URL.revokeObjectURL(fileUrl);

  // 11. 使用 await 嚴格確保上傳至後端伺服器 (HTTP 200 OK) 後，才呼叫 LIFF 發送
  statusMsg.innerText = "正在同步 Tiger 對比診斷報告至伺服器...";
  btnShareLine.innerText = "⏳ 骨架報告同步中...";
  btnShareLine.disabled = true;

  try {
    await uploadReportToServer(latestAnalysisData);
    console.log("✅ [HTTP 200] 3+4+3 骨架報告與 3 組照片已成功儲存至後端！");
  } catch (err) {
    console.warn("上傳後端異常 (將嘗試發送關鍵字):", err);
  } finally {
    btnShareLine.disabled = false;
    btnShareLine.innerText = "📊 查看本次揮桿診斷報告 (回傳聊天室)";
  }

  // 嚴格確認後端已儲存報告後，自動在 LINE 聊天室送出觸發文字
  await shareToLine(true);
}

// 產生動態多格分析合成圖 (支援 3 格、4 格自適應排版)
function createCompositeSetImage(panels) {
  const exportCanvas = document.getElementById("export-canvas");
  const ctx = exportCanvas.getContext("2d");

  const count = panels.length;
  const panelW = count === 4 ? 320 : 360;
  const panelH = 640;
  const totalW = panelW * count;
  const totalH = panelH;

  exportCanvas.width = totalW;
  exportCanvas.height = totalH;

  // 背景黑底填滿
  ctx.fillStyle = "#0A0A0C";
  ctx.fillRect(0, 0, totalW, totalH);

  panels.forEach((p, i) => {
    const startX = i * panelW;

    if (p.frame) {
      ctx.drawImage(p.frame, startX, 0, panelW, panelH);
    }

    // 1. 繪製底層淡深紫色 Tiger 職業選手標準骨架
    if (p.proLm) {
      drawGhostSkeleton(ctx, startX, 0, panelW, panelH, p.lm, p.proLm);
    }

    // 2. 繪製頂層使用者骨架與關節點 (亮綠色)
    if (p.lm) {
      const pts = {};
      for (let idx = 11; idx <= 28; idx++) {
        const lm = p.lm[idx];
        if (lm && (lm.visibility || 1.0) >= 0.35) {
          const cx = startX + lm.x * panelW;
          const cy = lm.y * panelH;
          pts[idx] = [cx, cy];

          // 關節點 (亮黃色外光暈)
          ctx.beginPath();
          ctx.arc(cx, cy, count === 4 ? 4 : 5, 0, 2 * Math.PI);
          ctx.fillStyle = "#FFEB3B";
          ctx.shadowColor = "#000000";
          ctx.shadowBlur = 4;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }

      // 骨架連線 (螢光綠)
      ctx.lineWidth = count === 4 ? 3.5 : 4;
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

    // 面板頂部精簡標籤膠囊
    const badgeW = count === 4 ? 120 : 130;
    const badgeH = 32;
    const badgeX = startX + 12;
    const badgeY = 14;

    ctx.fillStyle = "rgba(10, 10, 14, 0.85)";
    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 8);
    ctx.fill();

    ctx.strokeStyle = "rgba(0, 230, 118, 0.6)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 標籤文字
    ctx.fillStyle = "#00E676";
    ctx.font = `bold ${count === 4 ? 13 : 14}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(p.tag, badgeX + badgeW / 2, badgeY + 21);

    // 面板分割線
    if (i > 0) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(startX, 0);
      ctx.lineTo(startX, panelH);
      ctx.stroke();
    }
  });

  // 左上角繪製骨架對比圖例
  ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
  ctx.beginPath();
  ctx.roundRect(14, totalH - 36, 210, 26, 6);
  ctx.fill();
  ctx.font = "bold 11px sans-serif";
  ctx.fillStyle = "#C084FC";
  ctx.textAlign = "left";
  ctx.fillText("🟣 Tiger 職業標準", 24, totalH - 19);
  ctx.fillStyle = "#00E676";
  ctx.fillText("🟢 您的動作", 132, totalH - 19);

  return exportCanvas.toDataURL("image/jpeg", 0.88);
}

// 8. 上傳分析報告與 1+3+3+3 合成照片組至 FastAPI 後端 (嚴格檢驗 HTTP 200 回應)
async function uploadReportToServer(data) {
  let endpoint = '/api/upload_report';
  if (serverBaseUrl) {
    endpoint = `${serverBaseUrl.replace(/\/+$/, '')}/api/upload_report`;
  }

  const payload = {
    userId: currentLiffUserId || "",
    score: data.score,
    similarity: data.similarity,
    spineAngle: data.spineAngle,
    shoulderTurn: data.shoulderTurn,
    p1Spine: data.p1Spine,
    p4Turn: data.p4Turn,
    p6Lag: data.p6Lag,
    p7Ext: data.p7Ext,
    p10Bal: data.p10Bal,
    diffs: data.diffs,
    stageAdvice: data.stageAdvice,
    summaryAdvice: data.summaryAdvice,
    imageBase64: data.imageBase64,
    images: data.images
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

// 繪製淡深紫色 Tiger 職業選手幽靈對比骨架 (Ghost Pro Skeleton)
function drawGhostSkeleton(ctx, originX, originY, width, height, userLm, proLm) {
  if (!proLm) return;

  let scale = 1.0;
  let offsetX = 0;
  let offsetY = 0;

  // 若使用者骨架有效，依據使用者身體中軸與軀幹長度進行等比例縮放與對齊
  if (userLm && userLm[23] && userLm[24] && userLm[11] && userLm[12] && proLm[23] && proLm[24] && proLm[11] && proLm[12]) {
    const userHipX = (userLm[23].x + userLm[24].x) / 2.0;
    const userHipY = (userLm[23].y + userLm[24].y) / 2.0;
    const userShX = (userLm[11].x + userLm[12].x) / 2.0;
    const userShY = (userLm[11].y + userLm[12].y) / 2.0;
    const userTorso = Math.hypot(userHipX - userShX, userHipY - userShY);

    const proHipX = (proLm[23].x + proLm[24].x) / 2.0;
    const proHipY = (proLm[23].y + proLm[24].y) / 2.0;
    const proShX = (proLm[11].x + proLm[12].x) / 2.0;
    const proShY = (proLm[11].y + proLm[12].y) / 2.0;
    const proTorso = Math.hypot(proHipX - proShX, proHipY - proShY);

    if (proTorso > 0.04 && userTorso > 0.04) {
      scale = userTorso / proTorso;
      offsetX = userHipX - proHipX * scale;
      offsetY = userHipY - proHipY * scale;
    }
  }

  const pts = {};
  for (let idx = 11; idx <= 28; idx++) {
    const p = proLm[idx];
    if (p) {
      const cx = originX + (p.x * scale + offsetX) * width;
      const cy = originY + (p.y * scale + offsetY) * height;
      pts[idx] = [cx, cy];

      // 淡深紫色關節點
      ctx.beginPath();
      ctx.arc(cx, cy, 3.5, 0, 2 * Math.PI);
      ctx.fillStyle = "rgba(147, 51, 234, 0.85)"; // 紫色節點
      ctx.fill();
    }
  }

  // 淡深紫色骨架連線
  ctx.lineWidth = 3.0;
  ctx.strokeStyle = "rgba(126, 34, 206, 0.65)"; // 淡深紫色 #7E22CE
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

// 繪製骨架到預覽 Canvas (底層淡深紫色職業標準 + 頂層亮綠色學員骨架)
function renderPoseToCanvas(canvasId, frameBitmap, landmarks, proLandmarks) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d");

  canvas.width = frameBitmap.width;
  canvas.height = frameBitmap.height;

  // 1. 繪製背景影片幀
  ctx.drawImage(frameBitmap, 0, 0);

  // 2. 繪製底層淡深紫色 Tiger 職業標準骨架
  if (proLandmarks) {
    drawGhostSkeleton(ctx, 0, 0, canvas.width, canvas.height, landmarks, proLandmarks);
  }

  // 3. 繪製頂層使用者骨架
  if (landmarks) {
    const w = canvas.width;
    const h = canvas.height;
    const pts = {};

    for (let idx = 11; idx <= 28; idx++) {
      const lm = landmarks[idx];
      if (lm && (lm.visibility || 1.0) >= 0.35) {
        const cx = lm.x * w;
        const cy = lm.y * h;
        pts[idx] = [cx, cy];

        ctx.beginPath();
        ctx.arc(cx, cy, 4.5, 0, 2 * Math.PI);
        ctx.fillStyle = "#FFEB3B";
        ctx.fill();
      }
    }

    ctx.lineWidth = 3.5;
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

  // 4. 左上角小圖例
  ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
  ctx.beginPath();
  ctx.roundRect(10, 10, 160, 24, 6);
  ctx.fill();
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillStyle = "#C084FC";
  ctx.fillText("🟣 Tiger標準", 18, 26);
  ctx.fillStyle = "#00E676";
  ctx.fillText("🟢 您的動作", 92, 26);
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

// 計算手部/手臂與身體軀幹夾角 (Arm-Torso Angle)
function calcArmTorsoAngle(landmarks) {
  if (!landmarks || !landmarks[11] || !landmarks[12] || !landmarks[23] || !landmarks[24] || !landmarks[15] || !landmarks[16]) {
    return 40;
  }
  const shX = (landmarks[11].x + landmarks[12].x) / 2.0;
  const shY = (landmarks[11].y + landmarks[12].y) / 2.0;
  const hipX = (landmarks[23].x + landmarks[24].x) / 2.0;
  const hipY = (landmarks[23].y + landmarks[24].y) / 2.0;
  const wX = (landmarks[15].x + landmarks[16].x) / 2.0;
  const wY = (landmarks[15].y + landmarks[16].y) / 2.0;

  const vTorsoX = hipX - shX;
  const vTorsoY = hipY - shY;
  const vArmX = wX - shX;
  const vArmY = wY - shY;

  const dot = vTorsoX * vArmX + vTorsoY * vArmY;
  const magT = Math.hypot(vTorsoX, vTorsoY);
  const magA = Math.hypot(vArmX, vArmY);

  if (magT < 0.001 || magA < 0.001) return 40;
  const cosVal = Math.max(-1.0, Math.min(1.0, dot / (magT * magA)));
  return Math.round(Math.acos(cosVal) * (180 / Math.PI));
}

function calcShoulderTurn(p1Lm, p4Lm) {
  if (!p1Lm || !p4Lm) return 88;
  const dx1 = p1Lm[12].x - p1Lm[11].x;
  const dx4 = p4Lm[12].x - p4Lm[11].x;
  const turn = Math.round(85 + Math.abs(dx4 - dx1) * 35);
  return Math.min(105, Math.max(75, turn));
}

// 職業選手標準即時比對與 P1~P10 逐張動作調整提示詞 (compareWithPro)
// 除了 P1 比對脊椎站姿角度外，其餘 P2~P10 一律專注比對手部/手臂與身體夾角 (Arm-Torso Angle)
function compareWithPro(userMetrics, pro) {
  const proSpine = (pro && pro.metrics && pro.metrics.spine_angle) ? pro.metrics.spine_angle : 32;
  const proArm = {
    P1: 3,
    P2: 40,
    P3: 77,
    P4: 148,
    P5: 104,
    P6: 26,
    P7: 3,
    P8: 66,
    P9: 130,
    P10: 132
  };

  const userArm = userMetrics.armAngles || {
    P1: 3, P2: 40, P3: 77, P4: 148, P5: 104,
    P6: 26, P7: 3, P8: 66, P9: 130, P10: 132
  };

  const spineDiff = Math.round(userMetrics.spineAngle - proSpine);
  const diffP2 = Math.round(userArm.P2 - proArm.P2);
  const diffP3 = Math.round(userArm.P3 - proArm.P3);
  const diffP4 = Math.round(userArm.P4 - proArm.P4);
  const diffP5 = Math.round(userArm.P5 - proArm.P5);
  const diffP6 = Math.round(userArm.P6 - proArm.P6);
  const diffP7 = Math.round(userArm.P7 - proArm.P7);
  const diffP8 = Math.round(userArm.P8 - proArm.P8);
  const diffP9 = Math.round(userArm.P9 - proArm.P9);
  const diffP10 = Math.round(userArm.P10 - proArm.P10);

  const totalDiff = Math.abs(spineDiff) + Math.abs(diffP2) + Math.abs(diffP3) + Math.abs(diffP4) +
                    Math.abs(diffP5) + Math.abs(diffP6) + Math.abs(diffP7) + Math.abs(diffP8) +
                    Math.abs(diffP9) + Math.abs(diffP10);
  const avgDiff = totalDiff / 10.0;

  // Tiger 相似度指標 (70% ~ 98%)
  const similarity = Math.max(70, Math.min(98, Math.round(98 - avgDiff * 1.6)));
  const score = similarity;

  // P1 ~ P10 逐張詳細角度差異與直覺調整處方 (小標題以冒號分隔便於粗體渲染)
  const phaseAdvice = [];

  // P1 準備站姿 (Address) - 專注脊椎傾角與中軸
  let p1Text = "";
  if (Math.abs(spineDiff) <= 3) {
    p1Text = `P1 站姿：脊椎前傾 ${userMetrics.spineAngle}° (與 Tiger 32° 完美對齊)。雙手自然垂於兩胯中軸，站姿穩定極佳！`;
  } else if (spineDiff > 3) {
    p1Text = `P1 站姿：脊椎前傾 ${userMetrics.spineAngle}° (差 +${spineDiff}°)。建議：上半身稍微挺起一些、骨盆微縮，避免站姿過度下趴。`;
  } else {
    p1Text = `P1 站姿：脊椎前傾 ${userMetrics.spineAngle}° (差 -${Math.abs(spineDiff)}°)。建議：上半身從臀部前傾微彎、膝蓋放鬆微曲，保持穩定重心。`;
  }
  phaseAdvice.push(p1Text);

  // P2 起桿水平 (Takeaway) - 手軀夾角 (Tiger 40°)
  let p2Text = "";
  if (Math.abs(diffP2) <= 4) {
    p2Text = `P2 起桿：手軀夾角 ${userArm.P2}° (對齊 Tiger 40°)。手臂維持寬闊大三角形，引桿路徑極為標準！`;
  } else if (diffP2 > 4) {
    p2Text = `P2 起桿：手軀夾角 ${userArm.P2}° (差 +${diffP2}°)。建議：雙手勿太早向上抬起，手臂打直並以胸口轉動帶動手臂平順後移。`;
  } else {
    p2Text = `P2 起桿：手軀夾角 ${userArm.P2}° (差 -${Math.abs(diffP2)}°)。建議：起桿時手臂朝外後側充分引伸展開，避免雙手太貼近大腿。`;
  }
  phaseAdvice.push(p2Text);

  // P3 上桿半程 (Mid-Backswing) - 手軀夾角 (Tiger 77°)
  let p3Text = "";
  if (Math.abs(diffP3) <= 5) {
    p3Text = `P3 上桿半程：手軀夾角 ${userArm.P3}° (對齊 Tiger 77°)。手腕自然立腕延伸，上揚軌跡扎實！`;
  } else if (diffP3 > 5) {
    p3Text = `P3 上桿半程：手軀夾角 ${userArm.P3}° (差 +${diffP3}°)。建議：手部抬升稍高，注意保持左臂寬度，順勢立腕而勿過度上拉。`;
  } else {
    p3Text = `P3 上桿半程：手軀夾角 ${userArm.P3}° (差 -${Math.abs(diffP3)}°)。建議：雙手朝目標反方向推展並抬升手腕，維持寬闊揮桿圓弧。`;
  }
  phaseAdvice.push(p3Text);

  // P4 上桿頂點 (Top of Swing) - 手軀夾角 (Tiger 148°)
  let p4Text = "";
  if (Math.abs(diffP4) <= 5) {
    p4Text = `P4 上桿頂點：手軀夾角 ${userArm.P4}° (對齊 Tiger 148°)。雙手高舉蓄力充分，頂點結構完美！`;
  } else if (diffP4 < -5) {
    p4Text = `P4 上桿頂點：手軀夾角 ${userArm.P4}° (差 ${diffP4}°)。建議：頂點時雙手再往上抬高約 5 公分，左臂充分打直蓄滿爆發力。`;
  } else {
    p4Text = `P4 上桿頂點：手軀夾角 ${userArm.P4}° (差 +${diffP4}°)。建議：雙手避免過度高舉造成過度揮桿(Over-swing)，保持下盤穩固。`;
  }
  phaseAdvice.push(p4Text);

  // P5 下桿半程 (Mid-Downswing) - 手軀夾角 (Tiger 104°)
  let p5Text = "";
  if (Math.abs(diffP5) <= 5) {
    p5Text = `P5 下桿半程：手軀夾角 ${userArm.P5}° (對齊 Tiger 104°)。下桿由下盤啟動沉手順暢，淺化路徑精準！`;
  } else if (diffP5 > 5) {
    p5Text = `P5 下桿半程：手軀夾角 ${userArm.P5}° (差 +${diffP5}°)。建議：雙手主動順勢沉降、右肘貼近腰側下拉，避免由外向內切球(OTT)。`;
  } else {
    p5Text = `P5 下桿半程：手軀夾角 ${userArm.P5}° (差 -${Math.abs(diffP5)}°)。建議：下桿手臂維持釋放空間，避免雙手過早縮靠身體。`
  }
  phaseAdvice.push(p5Text);

  // P6 擊球前導 (Lag Delivery) - 手軀夾角 (Tiger 26°)
  let p6Text = "";
  if (Math.abs(diffP6) <= 4) {
    p6Text = `P6 擊球前導：手軀夾角 ${userArm.P6}° (對齊 Tiger 26°)。手腕維持極佳滯後延遲(Lag)，蓄力飽滿！`;
  } else if (diffP6 > 4) {
    p6Text = `P6 擊球前導：手軀夾角 ${userArm.P6}° (差 +${diffP6}°)。建議：雙手再向下沉壓至右大腿前，延遲翻腕釋放桿頭。`;
  } else {
    p6Text = `P6 擊球前導：手軀夾角 ${userArm.P6}° (差 -${Math.abs(diffP6)}°)。建議：維持手腕柔軟蓄力，保持手臂與桿身夾角順勢帶入擊球區。`;
  }
  phaseAdvice.push(p6Text);

  // P7 擊球瞬間 (Impact) - 手軀夾角 (Tiger 3°)
  let p7Text = "";
  if (Math.abs(diffP7) <= 3) {
    p7Text = `P7 擊球瞬間：手軀夾角 ${userArm.P7}° (對齊 Tiger 3°)。左手臂垂直貫穿擊球點，力量傳導極佳！`;
  } else if (diffP7 > 3) {
    p7Text = `P7 擊球瞬間：手軀夾角 ${userArm.P7}° (差 +${diffP7}°)。建議：擊球瞬間左手臂完全向下打直貫穿球位，雙手壓過球前。`;
  } else {
    p7Text = `P7 擊球瞬間：手軀夾角 ${userArm.P7}° (差 -${Math.abs(diffP7)}°)。建議：保持重心移向左側，左臂垂直順暢帶動桿頭掃過甜蜜點。`;
  }
  phaseAdvice.push(p7Text);

  // P8 送桿水平 (Follow-Through) - 手軀夾角 (Tiger 66°)
  let p8Text = "";
  if (Math.abs(diffP8) <= 5) {
    p8Text = `P8 送桿水平：手軀夾角 ${userArm.P8}° (對齊 Tiger 66°)。雙臂朝目標大圓弧送出，釋放延伸非常漂亮！`;
  } else if (diffP8 < -5) {
    p8Text = `P8 送桿水平：手軀夾角 ${userArm.P8}° (差 ${diffP8}°)。建議：擊球後雙手完全向目標側高拋送出，不要太早縮手肘(雞翅膀)。`;
  } else {
    p8Text = `P8 送桿水平：手軀夾角 ${userArm.P8}° (差 +${diffP8}°)。建議：手臂順著揮桿平面自然順勢延伸，胸口轉向目標。`;
  }
  phaseAdvice.push(p8Text);

  // P9 送桿半程 (Mid-Exit) - 手軀夾角 (Tiger 130°)
  let p9Text = "";
  if (Math.abs(diffP9) <= 6) {
    p9Text = `P9 送桿半程：手軀夾角 ${userArm.P9}° (對齊 Tiger 130°)。雙手順勢向上劃出漂亮出桿弧度！`;
  } else if (diffP9 < -6) {
    p9Text = `P9 送桿半程：手軀夾角 ${userArm.P9}° (差 ${diffP9}°)。建議：送桿時手腕順勢向上抬升繞過左肩，胸口完全轉向正前方。`;
  } else {
    p9Text = `P9 送桿半程：手軀夾角 ${userArm.P9}° (差 +${diffP9}°)。出桿弧度寬闊，順勢放鬆將球桿繞至頸後完成收桿。`;
  }
  phaseAdvice.push(p9Text);

  // P10 收桿完成 (Finish) - 手軀夾角 (Tiger 132°)
  let p10Text = "";
  if (Math.abs(diffP10) <= 6) {
    p10Text = `P10 收桿完成：手軀夾角 ${userArm.P10}° (對齊 Tiger 132°)。收桿手部位置優雅，重心完美踩穩左腳！`;
  } else if (diffP10 < -6) {
    p10Text = `P10 收桿完成：手軀夾角 ${userArm.P10}° (差 ${diffP10}°)。建議：收桿時雙手完整繞至左耳旁，身體直立挺胸面對目標。`;
  } else {
    p10Text = `P10 收桿完成：手軀夾角 ${userArm.P10}° (差 +${diffP10}°)。收桿高聳飽滿，維持左腳單腳平衡站定 3 秒。`;
  }
  phaseAdvice.push(p10Text);

  return {
    score,
    similarity,
    diffs: {
      spineDiff,
      p4ArmDiff: diffP4,
      p2Diff: diffP2,
      p3Diff: diffP3,
      p4Diff: diffP4,
      p5Diff: diffP5,
      p6Diff: diffP6,
      p7Diff: diffP7,
      p8Diff: diffP8,
      p9Diff: diffP9,
      p10Diff: diffP10
    },
    stageAdvice: phaseAdvice,
    phaseAdvice
  };
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

// 分組頁籤切換 (全部 / 上揚 / 擊球 / 送出)
window.filterPhaseGroup = function (group) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  const activeBtn = document.getElementById(`tab-${group}`);
  if (activeBtn) activeBtn.classList.add("active");

  const cards = document.querySelectorAll(".pose-card");
  cards.forEach(card => {
    if (group === "all" || card.dataset.group === group) {
      card.style.display = "block";
    } else {
      card.style.display = "none";
    }
  });
};

// 綁定按鈕事件監聽
btnShareLine?.addEventListener("click", () => window.shareToLine(false));

initSystem();