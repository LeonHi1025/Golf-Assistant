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
let globalMediaPipeTimestampMs = 1000;
let isLiffInitialized = false;
let currentLiffId = "2011445978-6xeS4R70";
let currentLiffUserId = "";
let latestAnalysisData = null;
let serverBaseUrl = "https://golf-assistant.onrender.com";
let proBenchmark = null;
let globalUserSetupRatio = null; // 學員標準站姿全局固定比例 (避免轉身縮放變形)
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

// 1. 初始化系統 (LIFF + MediaPipe WebAssembly / GPU + 國際職業基準庫)
async function initSystem() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.log('SW failed:', err));
  }

  // 嘗試載入國際標準基準 JSON (pro_benchmark.json)
  try {
    const proRes = await fetch('pro_benchmark.json?v=20260914_pro_bench01');
    if (proRes.ok) {
      proBenchmark = await proRes.json();
      console.log("🏆 國際標準基準數據庫已成功載入:", proBenchmark.pro_name);
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
  // 升級：heavy 模型 (model_complexity=2) + VIDEO 模式啟用時序平滑 (smooth_landmarks)
  const HEAVY_MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task";
  const FULL_MODEL  = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";
  const WASM_URL    = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
  const MP_BASE_OPTIONS = {
    runningMode: "VIDEO",              // VIDEO 模式啟用內建時序平滑（等效 smooth_landmarks=True）
    numPoses: 1,
    minPoseDetectionConfidence: 0.65,  // 拉高偵測門檻，減少寬鬆衣物誤判
    minPosePresenceConfidence: 0.65,   // 不確定時寧可維持前幀，不讓關節暴走
    minTrackingConfidence: 0.55        // 追蹤穩定性
  };
  try {
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);
    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      ...MP_BASE_OPTIONS,
      baseOptions: { modelAssetPath: HEAVY_MODEL, delegate: "GPU" }
    });
    console.log("✅ MediaPipe Pose Heavy 模型載入成功 (VIDEO+GPU+高層平滑)");
  } catch (err) {
    console.warn("⚠️ GPU Heavy 失敗，嘗試 CPU Heavy:", err);
    try {
      const vision = await FilesetResolver.forVisionTasks(WASM_URL);
      poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        ...MP_BASE_OPTIONS,
        baseOptions: { modelAssetPath: HEAVY_MODEL, delegate: "CPU" }
      });
      console.log("✅ MediaPipe Pose Heavy (CPU fallback)");
    } catch (e) {
      console.warn("⚠️ Heavy 全部失敗，回退至 Full 模型:", e);
      try {
        const vision = await FilesetResolver.forVisionTasks(WASM_URL);
        poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          ...MP_BASE_OPTIONS,
          baseOptions: { modelAssetPath: FULL_MODEL, delegate: "CPU" }
        });
        console.log("✅ MediaPipe Pose Full (CPU fallback)");
      } catch (e2) {
        console.warn("⚠️ AI 骨架模型載入異常 (已轉靜默模式):", e2);
      }
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

// ============================================================
// 2.5 音訊撞擊鎖定：Web Audio API 解碼影片音訊尋找擊球衝擊尖峰
// ============================================================
async function detectAudioImpactFrame(file, fps, totalFrames, p4FrameIdx) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    // 注意：Safari / LINE WebView 需在用戶互動後才可建立 AudioContext
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    let audioBuffer;
    try {
      audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    } catch (decodeErr) {
      console.warn("⚠️ 音訊解碼失敗（可能為靜音或不支援格式）:", decodeErr.message);
      audioCtx.close();
      return null;
    }

    const channelData = audioBuffer.getChannelData(0); // 左聲道 PCM
    const audioSampleRate = audioBuffer.sampleRate;     // 通常 44100 Hz
    const samplesPerFrame = Math.round(audioSampleRate / fps);

    // 計算每個視訊幀的短時平方能量（Short-Time Energy）
    const stePerFrame = new Float32Array(totalFrames);
    for (let frame = 0; frame < totalFrames; frame++) {
      const start = frame * samplesPerFrame;
      const end = Math.min(start + samplesPerFrame, channelData.length);
      if (start >= channelData.length) break;
      let ste = 0;
      for (let i = start; i < end; i++) ste += channelData[i] * channelData[i];
      stePerFrame[frame] = ste / Math.max(1, end - start);
    }

    audioCtx.close();

    // 搜尋範圍：P4 之後 0.15s 到 P4 之後 1.5s（高爾夫下桿時間窗）
    const searchStart = Math.min(totalFrames - 1, p4FrameIdx + Math.round(fps * 0.15));
    const searchEnd   = Math.min(totalFrames - 1, p4FrameIdx + Math.round(fps * 1.50));

    if (searchStart >= searchEnd) {
      console.warn("⚠️ 音訊搜尋範圍太小，跳過音訊鎖定");
      return null;
    }

    // 找尖峰幀（STE 最大幀）
    let peakFrame = searchStart;
    let peakSTE = stePerFrame[searchStart];
    for (let f = searchStart + 1; f <= searchEnd; f++) {
      if (stePerFrame[f] > peakSTE) {
        peakSTE = stePerFrame[f];
        peakFrame = f;
      }
    }

    // 靜音驗證：若尖峰能量相較全局最大值太低（< 5%），視為靜音影片，放棄音訊路線
    let globalMax = 0;
    for (let f = 0; f < totalFrames; f++) if (stePerFrame[f] > globalMax) globalMax = stePerFrame[f];
    if (globalMax < 1e-8 || peakSTE < globalMax * 0.05) {
      console.log("🔇 影片音訊能量過低（靜音或無擊球聲），跳過音訊鎖定，改用視覺方案");
      return null;
    }

    console.log(`🎵 音訊撞擊尖峰鎖定成功：幀 ${peakFrame}（STE=${peakSTE.toFixed(6)}，全局最大=${globalMax.toFixed(6)}，比值=${(peakSTE/globalMax*100).toFixed(1)}%）`);
    return { peakFrameIdx: peakFrame, peakSTE, globalMax };

  } catch (err) {
    console.warn("⚠️ 音訊撞擊偵測異常，跳過音訊路線:", err);
    return null;
  }
}

// ============================================================
// 時間維度平滑插值（Temporal Smoothing & Linear Interpolation）
// 補齊缺失影格、消除單幀斷手斷肢、平滑手腕與關節運動軌跡
// ============================================================
function applyTemporalSmoothingAndInterpolation(wristData) {
  const n = wristData.length;
  if (n < 2) return wristData;

  // 1. 全局影格級別骨架補齊 (Frame-Level Landmark Interpolation)
  const validIndices = [];
  for (let i = 0; i < n; i++) {
    if (wristData[i]?.landmarks && Array.isArray(wristData[i].landmarks) && wristData[i].isDetected) {
      validIndices.push(i);
    }
  }

  // 若無任何檢測幀，直接嘗試使用非空幀
  if (validIndices.length === 0) {
    for (let i = 0; i < n; i++) {
      if (wristData[i]?.landmarks && Array.isArray(wristData[i].landmarks)) {
        validIndices.push(i);
      }
    }
  }

  if (validIndices.length === 0) return wristData;

  // 對於整幀缺失骨架的影格，在前後最近的有效幀之間進行全骨架線性內插
  for (let i = 0; i < n; i++) {
    if (!wristData[i]?.landmarks || !Array.isArray(wristData[i].landmarks) || !wristData[i].isDetected) {
      let prevIdx = -1;
      for (let k = validIndices.length - 1; k >= 0; k--) {
        if (validIndices[k] < i) {
          prevIdx = validIndices[k];
          break;
        }
      }
      let nextIdx = -1;
      for (let k = 0; k < validIndices.length; k++) {
        if (validIndices[k] > i) {
          nextIdx = validIndices[k];
          break;
        }
      }

      if (prevIdx !== -1 && nextIdx !== -1) {
        // 核心公式：P_N = P_prev + (P_next - P_prev) * (N - prev) / (next - prev)
        // 當 prev=N-1, next=N+1 時即為精確的 (P_{N-1} + P_{N+1}) / 2
        const alpha = (i - prevIdx) / (nextIdx - prevIdx);
        const prevLm = wristData[prevIdx].landmarks;
        const nextLm = wristData[nextIdx].landmarks;
        const interpolatedLm = [];
        for (let j = 0; j < 33; j++) {
          const pP = prevLm[j] || { x: 0.5, y: 0.5, visibility: 0.5 };
          const pN = nextLm[j] || { x: 0.5, y: 0.5, visibility: 0.5 };
          interpolatedLm.push({
            x: pP.x + (pN.x - pP.x) * alpha,
            y: pP.y + (pN.y - pP.y) * alpha,
            z: (pP.z ?? 0) + ((pN.z ?? 0) - (pP.z ?? 0)) * alpha,
            visibility: Math.max(0.75, Math.min(pP.visibility ?? 0.8, pN.visibility ?? 0.8)),
            interpolated: true
          });
        }
        wristData[i].landmarks = interpolatedLm;
        wristData[i].x = interpolatedLm[15].x;
        wristData[i].y = interpolatedLm[15].y;
        wristData[i].isInterpolated = true;
      } else if (prevIdx !== -1) {
        wristData[i].landmarks = wristData[prevIdx].landmarks.map(p => ({ ...p, interpolated: true }));
        wristData[i].x = wristData[prevIdx].x;
        wristData[i].y = wristData[prevIdx].y;
        wristData[i].isInterpolated = true;
      } else if (nextIdx !== -1) {
        wristData[i].landmarks = wristData[nextIdx].landmarks.map(p => ({ ...p, interpolated: true }));
        wristData[i].x = wristData[nextIdx].x;
        wristData[i].y = wristData[nextIdx].y;
        wristData[i].isInterpolated = true;
      }
    }
  }

  // 2. 關節點級別時間維度插值與 Fallback (Joint-Level Temporal Interpolation)
  // 針對身體核心關節 (雙肩 11, 12; 雙肘 13, 14; 雙腕 15, 16; 雙臀 23, 24; 雙膝 25, 26; 雙踝 27, 28)
  // 若某幀單個關節點信心不足 (visibility < 0.20) 或丟失，沿用前後相鄰影格的線性內插補齊：
  // P_N = (P_{N-1} + P_{N+1}) / 2
  const criticalJoints = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

  for (const jIdx of criticalJoints) {
    for (let i = 0; i < n; i++) {
      const curPt = wristData[i]?.landmarks?.[jIdx];
      const vis = curPt?.visibility ?? curPt?.vis ?? 0;
      // 判定為信心不足、遮蔽或斷肢
      if (!curPt || vis < 0.20) {
        // 向前搜尋最近有效關節點 (最多向前 8 幀)
        let pIdx = -1;
        for (let step = 1; step <= 8 && (i - step) >= 0; step++) {
          const cand = wristData[i - step]?.landmarks?.[jIdx];
          if (cand && (cand.visibility ?? 0) >= 0.25) {
            pIdx = i - step;
            break;
          }
        }
        // 向後搜尋最近有效關節點 (最多向後 8 幀)
        let nIdx = -1;
        for (let step = 1; step <= 8 && (i + step) < n; step++) {
          const cand = wristData[i + step]?.landmarks?.[jIdx];
          if (cand && (cand.visibility ?? 0) >= 0.25) {
            nIdx = i + step;
            break;
          }
        }

        if (pIdx !== -1 && nIdx !== -1) {
          // 線性內插：P_N = P_prev + (P_next - P_prev) * (N - prev) / (next - prev)
          // 當前一幀與後一幀都在時，公式精確為：P_N = (P_{N-1} + P_{N+1}) / 2
          const alpha = (i - pIdx) / (nIdx - pIdx);
          const pP = wristData[pIdx].landmarks[jIdx];
          const pN = wristData[nIdx].landmarks[jIdx];
          wristData[i].landmarks[jIdx] = {
            x: pP.x + (pN.x - pP.x) * alpha,
            y: pP.y + (pN.y - pP.y) * alpha,
            z: (pP.z ?? 0) + ((pN.z ?? 0) - (pP.z ?? 0)) * alpha,
            visibility: 0.85, // 標記為補齊修復的高信心值
            interpolated: true
          };
        } else if (pIdx !== -1) {
          const pP = wristData[pIdx].landmarks[jIdx];
          wristData[i].landmarks[jIdx] = {
            ...pP,
            visibility: 0.80,
            interpolated: true
          };
        } else if (nIdx !== -1) {
          const pN = wristData[nIdx].landmarks[jIdx];
          wristData[i].landmarks[jIdx] = {
            ...pN,
            visibility: 0.80,
            interpolated: true
          };
        }
      }
    }
  }

  // 3. 握把中心黏合與手腕坐標同步回寫
  for (let i = 0; i < n; i++) {
    if (wristData[i]?.landmarks) {
      wristData[i].landmarks = clampGolfLimbs(wristData[i].landmarks);
      wristData[i].x = wristData[i].landmarks[15].x;
      wristData[i].y = wristData[i].landmarks[15].y;
    }
  }

  console.log("✅ 時間維度平滑插值 (Temporal Smoothing & Interpolation) 完成！");
  return wristData;
}

// 3. 逐影格解碼與邊緣 AI 姿態分析
async function handleVideoFile(file) {
  if (!file) return;

  // [防呆停用] 1. 照片 / 非影片格式防呆
  // const isVideoType = file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(file.name);
  // if (!isVideoType) {
  //   await triggerFoolproofWarning("本系統僅支援影片檔案，不支援靜態照片");
  //   return;
  // }

  if (!poseLandmarker) {
    progressContainer.style.display = "block";
    statusMsg.innerText = "正在等待 AI 模型就緒...";
    let waitCount = 0;
    while (!poseLandmarker && waitCount < 30) {
      await new Promise(r => setTimeout(r, 200));
      waitCount++;
    }
    if (!poseLandmarker) {
      statusMsg.innerText = "模型載入超時，請重新選取影片";
      return;
    }
  }

  progressContainer.style.display = "block";
  statusMsg.innerText = "準備解碼影片...";
  progressFill.style.width = "5%";
  progressPct.innerText = "5%";

  const fileUrl = URL.createObjectURL(file);
  hiddenVideo.src = fileUrl;

  // 等待元數據載入以取得長寬與時長 (防呆超時與已載入檢測)
  await new Promise(resolve => {
    if (hiddenVideo.readyState >= 1 && hiddenVideo.duration && !isNaN(hiddenVideo.duration)) {
      resolve();
      return;
    }
    const timer = setTimeout(() => resolve(), 3000);
    hiddenVideo.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve();
    };
    hiddenVideo.onerror = () => {
      clearTimeout(timer);
      resolve();
    };
    hiddenVideo.load();
  });

  const duration = hiddenVideo.duration || 5;

  // [防呆停用] 2. 影片時長防呆
  // if (!duration || isNaN(duration) || duration > 60) {
  //   await triggerFoolproofWarning("影片長度超過 60 秒（建議上傳 5~15 秒之揮桿片段）");
  //   return;
  // }
  // if (duration < 0.8) {
  //   await triggerFoolproofWarning("影片長度過短，無法解析完整揮桿動作");
  //   return;
  // }

  const fps = 60; // 預設採樣率
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

  // 每次分析新影片時時間戳前進 10 秒，確保換影片時 timestamp 絕對單調遞增且觸發時序濾波重設
  globalMediaPipeTimestampMs += 10000;

  while (currentTime < duration) {
    hiddenVideo.currentTime = currentTime;
    await new Promise(resolve => {
      const timer = setTimeout(() => resolve(), 250);
      hiddenVideo.onseeked = () => {
        clearTimeout(timer);
        resolve();
      };
    });

    // 繪製至離屏 Canvas 供 MediaPipe 姿態推論
    ctx.drawImage(hiddenVideo, 0, 0, targetW, targetH);

    // MediaPipe 姿態推論（VIDEO 模式：時間戳必須全域嚴格單調遞增）
    const frameDtMs = Math.max(1, Math.round(step * 1000));
    globalMediaPipeTimestampMs += frameDtMs;

    let res;
    try {
      res = poseLandmarker.detectForVideo(processCanvas, globalMediaPipeTimestampMs);
    } catch (mpErr) {
      console.warn("⚠️ detectForVideo 遭遇時間戳異常，嘗試安全前進時間戳重試:", mpErr);
      globalMediaPipeTimestampMs += 50000;
      try {
        res = poseLandmarker.detectForVideo(processCanvas, globalMediaPipeTimestampMs);
      } catch (e2) {
        console.error("❌ MediaPipe 姿態推論失敗:", e2);
        res = { landmarks: [] };
      }
    }

    let validPose = false;
    let currentLandmarks = null;

    if (res.landmarks && res.landmarks.length > 0) {
      const lm = res.landmarks[0];
      const hipX = (lm[23].x + lm[24].x) / 2.0;
      const hipY = (lm[23].y + lm[24].y) / 2.0;
      const shX = (lm[11].x + lm[12].x) / 2.0;
      const shY = (lm[11].y + lm[12].y) / 2.0;
      const torsoH = Math.hypot(hipX - shX, hipY - shY);

      // 骨架有效性篩選 (放寬可見度門檻，避免穿深色衣或背景複雜時全被排除)
      const sh11Vis = lm[11].visibility ?? 0;
      const sh12Vis = lm[12].visibility ?? 0;
      const hip23Vis = lm[23].visibility ?? 0;
      const hip24Vis = lm[24].visibility ?? 0;
      const lw15Vis = lm[15].visibility ?? 0;
      const rw16Vis = lm[16].visibility ?? 0;
      // 只要雙肩/雙臀/至少一手有基本可見度即通過（MediaPipe visibility 值普遍偏低）
      const keyPartsVisible = (
        sh11Vis > 0.20 && sh12Vis > 0.20 &&
        hip23Vis > 0.15 && hip24Vis > 0.15 &&
        (lw15Vis > 0.10 || rw16Vis > 0.10)
      );

      if (!lastValidHip) {
        // 第一次：骨架在畫面中，軀幹有基本高度，且關鍵部位可見
        if (hipX > 0.10 && hipX < 0.90 && torsoH > 0.08 && keyPartsVisible) {
          lastValidHip = { x: hipX, y: hipY, torsoH };
          lastValidLandmarks = lm;
          validPose = true;
          currentLandmarks = lm;
        }
      } else {
        // 後續：臀部位移不超過 0.25、軀幹高度不低於前一幀的 40%，且關鍵部位可見
        const dist = Math.hypot(hipX - lastValidHip.x, hipY - lastValidHip.y);
        if (dist < 0.25 && torsoH > lastValidHip.torsoH * 0.40 && keyPartsVisible) {
          lastValidHip = { x: hipX, y: hipY, torsoH };
          lastValidLandmarks = lm;
          validPose = true;
          currentLandmarks = lm;
        }
      }
    }

    if (validPose && currentLandmarks) {
      // ✅ 強制雙手腕點位 100% 黏合在握把中心（Golf Grip Lock）
      currentLandmarks = clampGolfLimbs(currentLandmarks);

      const handX = currentLandmarks[15].x;
      const handY = currentLandmarks[15].y;

      lastValidWrist = { x: handX, y: handY };
      lastValidLandmarks = currentLandmarks;
      wristData.push({ frame: frameIdx, x: handX, y: handY, t: currentTime, landmarks: currentLandmarks, isDetected: true });

    } else {
      // 記錄無效或遺失幀，標記為 isDetected: false，供後續時間維度平滑插值精確填補
      if (lastValidWrist) {
        wristData.push({ frame: frameIdx, x: lastValidWrist.x, y: lastValidWrist.y, t: currentTime, landmarks: null, isDetected: false });
      } else {
        wristData.push({ frame: frameIdx, x: 0.5, y: 0.5, t: currentTime, landmarks: null, isDetected: false });
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
  statusMsg.innerText = "正在進行時間維度平滑插值與關鍵姿勢計算...";

  // ⭐️ 核心演算法：時間維度平滑插值 (Temporal Smoothing & Linear Interpolation)
  // 補齊缺失影格座標、消除斷手斷肢、平滑手腕與關節運動軌跡
  applyTemporalSmoothingAndInterpolation(wristData);

  // =============================================================
  // 4. 計算揮桿關鍵影格 (速度與運動學動力學演算法)
  // =============================================================
  const totalFrames = wristData.length;

  // 保存 file 引用供後續音訊解碼使用
  const _videoFile = file;
  // [防呕停用] 影片有效影格數過少防呕
  // if (totalFrames < 15) {
  //   await triggerFoolproofWarning("影片有效影格數過少，無法完成揮桿分析");
  //   return;
  // }

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

  // [防呆停用] 3. 骨架有效性與識別率防呆
  // if (validData.length < 15 || (validData.length / totalFrames) < 0.30) {
  //   await triggerFoolproofWarning("無法清晰識別出人體骨架（請確保人物全身清楚入鏡）");
  //   return;
  // }

  // 🛡️ 安全兜底：validData 為空時注入一個佔位幀，避免後續 reduce/filter 崩潰
  if (validData.length === 0) {
    const fallback = wristData.find(d => d) || { frame: 0, x: 0.5, y: 0.5, t: 0, landmarks: null };
    validData.push({
      idx: 0, t: fallback.t || 0,
      hx: fallback.x || 0.5, hy: fallback.y || 0.5,
      hipX: 0.5, hipY: 0.6, shX: 0.5, shY: 0.35,
      landmarks: fallback.landmarks,
      vx: 0, vy: 0
    });
  }

  // [防呆停用] 4. 揮桿運動軌跡防呆
  const minHx = validData.length > 0 ? Math.min(...validData.map(d => d.hx)) : 0.3;
  const maxHx = validData.length > 0 ? Math.max(...validData.map(d => d.hx)) : 0.7;
  const minHy = validData.length > 0 ? Math.min(...validData.map(d => d.hy)) : 0.3;
  const maxHy = validData.length > 0 ? Math.max(...validData.map(d => d.hy)) : 0.7;
  const motionRangeX = maxHx - minHx;
  const motionRangeY = maxHy - minHy;
  // if (motionRangeX < 0.12 && motionRangeY < 0.10) {
  //   await triggerFoolproofWarning("未偵測到揮桿運動軌跡（請確認為高爾夫揮桿動作）");
  //   return;
  // }

  // ✅ 優化二：Gaussian 加權移動平均平滑手腕軌跡（窗口 = 5 幀），再做中心差分速度計算
  // Gaussian 核心權重 [1, 2, 4, 2, 1] / 10
  const gaussWeights = [0.1, 0.2, 0.4, 0.2, 0.1];
  const smoothed = validData.map((_, i) => {
    let sumX = 0, sumY = 0, sumW = 0;
    for (let k = -2; k <= 2; k++) {
      const j = Math.max(0, Math.min(validData.length - 1, i + k));
      const w = gaussWeights[k + 2];
      sumX += validData[j].hx * w;
      sumY += validData[j].hy * w;
      sumW += w;
    }
    return { hx: sumX / sumW, hy: sumY / sumW };
  });
  // 以平滑後座標回寫，並用步長=2 的中心差分計算速度（更穩健）
  for (let i = 0; i < validData.length; i++) {
    validData[i].hxSmooth = smoothed[i].hx;
    validData[i].hySmooth = smoothed[i].hy;
    const pI = Math.max(0, i - 2);
    const nI = Math.min(validData.length - 1, i + 2);
    const dt = (nI - pI) || 1;
    validData[i].vx = (smoothed[nI].hx - smoothed[pI].hx) / dt;
    validData[i].vy = (smoothed[nI].hy - smoothed[pI].hy) / dt;
  }
  // 後續相位計算改用平滑座標（hxSmooth / hySmooth），保留原始座標備用
  validData.forEach(d => { d.hx = d.hxSmooth ?? d.hx; d.hy = d.hySmooth ?? d.hy; });

  // 2. 基準站姿中軸與身體固定比例 (以影片前段站姿統一骨架尺度，避免轉身變形)
  const setupFrames = validData.slice(0, Math.max(1, Math.floor(validData.length * 0.15)));
  const refHipX = setupFrames.reduce((acc, cur) => acc + cur.hipX, 0) / setupFrames.length;
  const refHipY = setupFrames.reduce((acc, cur) => acc + cur.hipY, 0) / setupFrames.length;
  const refHandX = setupFrames.reduce((acc, cur) => acc + cur.hx, 0) / setupFrames.length;
  const refShY = setupFrames.reduce((acc, cur) => acc + cur.shY, 0) / setupFrames.length;

  // ⭐️ 學員標準站姿固定身高尺標（像素）
  const setupTorsoPx = setupFrames.reduce((acc, cur) => {
    const hx = cur.hipX * targetW, hy = cur.hipY * targetH;
    const sx = cur.shX * targetW, sy = cur.shY * targetH;
    return acc + Math.hypot(hx - sx, hy - sy);
  }, 0) / setupFrames.length || (targetH * 0.28);

  const setupShoulderWPx = setupFrames.reduce((acc, cur) => {
    if (cur.landmarks && cur.landmarks[11] && cur.landmarks[12]) {
      return acc + Math.abs(cur.landmarks[11].x - cur.landmarks[12].x) * targetW;
    }
    return acc + (targetW * 0.20);
  }, 0) / setupFrames.length;

  // 基準職業站姿 (P1) 尺寸比例
  const proP1 = proBenchmark?.phases?.P1?.landmarks ? clampGolfLimbs(proBenchmark.phases.P1.landmarks) : null;
  const proBaseTorso = proP1
    ? Math.hypot((proP1[23].x + proP1[24].x)/2 - (proP1[11].x + proP1[12].x)/2, (proP1[23].y + proP1[24].y)/2 - (proP1[11].y + proP1[12].y)/2)
    : 0.22;
  const proBaseShoulderW = proP1 ? Math.abs(proP1[11].x - proP1[12].x) : 0.15;

  // ⭐️ 全局唯一固定比例尺（整套 10 個相位統一尺寸）
  const globalProScalePx = setupTorsoPx / proBaseTorso;
  const globalProScaleX = Math.max(0.80, Math.min(1.25, setupShoulderWPx / (proBaseShoulderW * globalProScalePx)));

  // 儲存全局歸一化比例尺（以 height 為基準），供後續畫布 Canvas 渲染呼叫
  globalUserSetupRatio = {
    torsoRatio: setupTorsoPx / targetH,
    shoulderWRatio: setupShoulderWPx / targetW,
    proBaseTorso,
    proBaseShoulderW
  };

  // =============================================================
  // 簡化判定：尋找學員手腕點及職業手腕點座標相對最近點 (重合為最佳)
  // 將職業選手骨架以固定站姿比例，以學員當前幀骨盆中心為錨點投影到畫面像素座標上
  // =============================================================

  // 1. 取得職業選手在各相位下的基準特徵
  function getProWristProjected(phaseKey, studentFrame) {
    // 學員當前幀骨盆像素座標
    const uHipX = studentFrame.hipX * targetW;
    const uHipY = studentFrame.hipY * targetH;

    const pData = proBenchmark?.phases?.[phaseKey];
    if (pData && pData.landmarks) {
      const plm = clampGolfLimbs(pData.landmarks);
      const pHipX = (plm[23].x + plm[24].x) / 2.0;
      const pHipY = (plm[23].y + plm[24].y) / 2.0;

      // 職業選手手腕 (15, 16 握把中心)
      const pWristX = (plm[15].x + plm[16].x) / 2.0;
      const pWristY = (plm[15].y + plm[16].y) / 2.0;

      // 🚀 核心映射：以全局站姿固定比例投影，手腕不再因轉身前後縮小或變形
      return {
        x: uHipX + (pWristX - pHipX) * globalProScalePx * globalProScaleX,
        y: uHipY + (pWristY - pHipY) * globalProScalePx
      };
    }

    // 兜底相對向量表 (以站姿軀幹尺度映射)
    const fallbackVector = {
      P1:  { dx:  0.051, dy:  0.211 },
      P2:  { dx: -0.730, dy: -0.180 },
      P3:  { dx: -0.931, dy: -1.004 },
      P4:  { dx: -0.483, dy: -1.557 },
      P5:  { dx: -0.818, dy: -1.211 },
      P6:  { dx: -0.671, dy: -0.157 },
      P7:  { dx:  0.021, dy:  0.147 },
      P8:  { dx:  0.466, dy: -0.206 },
      P9:  { dx:  0.358, dy: -1.276 },
      P10: { dx: -0.354, dy: -1.444 }
    }[phaseKey] || { dx: 0, dy: 0 };

    return {
      x: uHipX + fallbackVector.dx * setupTorsoPx,
      y: uHipY + fallbackVector.dy * setupTorsoPx
    };
  }

  // 計算學員手腕像素座標 (hx, hy) 與投影在學員身上的職業手腕座標 (X_pro_on_user, Y_pro_on_user) 的真實距離
  function calcWristDist(d, phaseKey) {
    const proWristOnUser = getProWristProjected(phaseKey, d);
    const userWristPxX = d.hx * targetW;
    const userWristPxY = d.hy * targetH;
    return Math.hypot(userWristPxX - proWristOnUser.x, userWristPxY - proWristOnUser.y);
  }

  // ⭐️ 核心規則：尋找手腕與職業基準重合最佳之影格；若有多個相近座標的幀位（距離誤差在容差內），優先選最小幀 (最小 idx)
  const tolerancePx = Math.max(6.0, setupTorsoPx * 0.035);

  function findBestPhaseFrame(pool, phaseKey, tolerance = tolerancePx) {
    if (!pool || pool.length === 0) return null;

    const withDist = pool.map(d => ({
      d,
      dist: calcWristDist(d, phaseKey)
    }));

    // 1. 找出全域最小重合距離
    const minDist = Math.min(...withDist.map(item => item.dist));

    // 2. 篩選出所有與最小距離相近（在容差範圍內）的候選幀
    const closeCandidates = withDist.filter(item => (item.dist - minDist) <= tolerance);

    // 3. 若有多個相近座標的幀位，選最小幀（最先到達該動作姿勢之幀，即 idx 最小）
    closeCandidates.sort((a, b) => a.d.idx - b.d.idx);

    return closeCandidates[0].d;
  }

  // -------------------------------------------------------------
  // 步驟 A：定位 P4（上桿頂點 Top of Swing）
  // 搜尋時間：影片前 55% 內，手腕高於肩膀，手腕與職業 P4 重合最佳之幀（若相近選最小幀）
  // -------------------------------------------------------------
  const p4Boundary = Math.floor(validData.length * 0.55);
  const p4Pool = validData.filter(d => d.idx <= p4Boundary && d.hy < d.shY);
  const p4Target = (p4Pool.length > 0 ? p4Pool : validData.slice(0, Math.max(1, p4Boundary)));
  const p4Data = findBestPhaseFrame(p4Target, 'P4') || validData[0];
  const p4Idx = p4Data.idx;

  // -------------------------------------------------------------
  // 步驟 B：定位 P1（準備站姿 Address）
  // 搜尋時間：P4 前
  // 條件 A：起桿前「最後一個靜止幀」（手腕速度接近 0，且在起桿前夕）
  // 條件 B：手腕 Y 軸最大點（即手垂到最低、離球最近的一刻）
  // -------------------------------------------------------------
  const preP4 = validData.filter(d => d.idx < p4Idx);
  let p1Data = validData[0];

  if (preP4.length > 0) {
    // 1. 條件 B：尋找手腕 Y 軸最大值 (手垂到畫面最下方)
    const maxY = Math.max(...preP4.map(d => d.hy));
    // 允許在手腕垂到最低點附近容差範圍 (例如 5% 軀幹高以內)
    const lowWristPool = preP4.filter(d => (maxY - d.hy) <= 0.05);

    // 2. 條件 A：起桿前「最後一個靜止幀」
    // 計算手腕綜合速度 magnitude = hypot(vx, vy)
    const stationaryCandidates = (lowWristPool.length > 0 ? lowWristPool : preP4).map(d => ({
      d,
      speed: Math.hypot(d.vx || 0, d.vy || 0),
      wristDist: calcWristDist(d, 'P1')
    }));

    // 取得候選群速度中位數作為低速標準
    const speeds = stationaryCandidates.map(c => c.speed).sort((a, b) => a - b);
    const speedThreshold = speeds[Math.floor(speeds.length * 0.40)] || 0.01;

    // 篩選低速靜止格，並依「在起桿前夕（靠近 P4 前但仍靜止）」以及「手腕重合最佳」綜合判定
    const stillFrames = stationaryCandidates.filter(c => c.speed <= speedThreshold * 1.5);
    const targetPool = stillFrames.length > 0 ? stillFrames : stationaryCandidates;

    // 在候選池中，選出最靠近起桿點（最後一個靜止）且手腕重合度極佳之幀
    p1Data = targetPool.reduce((best, cur) => {
      // 評分標準：手腕重合誤差越小越好，同時越接近起桿前夕 (idx 較大但未開始上桿) 越佳
      const scoreCur = cur.wristDist - (cur.d.idx / p4Idx) * 0.15;
      const scoreBest = best.wristDist - (best.d.idx / p4Idx) * 0.15;
      return scoreCur < scoreBest ? cur : best;
    }, targetPool[0]).d;
  }
  const p1Idx = p1Data.idx;

  // -------------------------------------------------------------
  // 步驟 C：定位 P2（起桿水平）與 P3（上桿半程）
  // 搜尋時間：介於 P1 與 P4 之間，手腕與職業 P2、P3 重合最佳之幀（若相近選最小幀）
  // -------------------------------------------------------------
  const backRange = validData.filter(d => d.idx > p1Idx && d.idx < p4Idx);
  const p2Data = backRange.length > 0
    ? findBestPhaseFrame(backRange, 'P2')
    : p1Data;
  const p2Idx = p2Data.idx;

  const p3Range = validData.filter(d => d.idx > p2Idx && d.idx < p4Idx);
  const p3Data = p3Range.length > 0
    ? findBestPhaseFrame(p3Range, 'P3')
    : validData[Math.round((p2Idx + p4Idx) / 2)];
  const p3Idx = p3Data.idx;

  // -------------------------------------------------------------
  // 步驟 D：定位 P7（擊球瞬間 Impact）
  // 搜尋時間：P4 之後，手腕與職業 P7 座標相對最近之幀（若相近選最小幀）
  // -------------------------------------------------------------
  const postP4 = validData.filter(d => d.idx > p4Idx);
  const bestVisualP7 = findBestPhaseFrame(postP4.length > 0 ? postP4 : validData, 'P7') || postP4[0] || validData[p4Idx];

  // 音訊擊球訊號輔助微調（若有音訊訊號且在重合點附近 ±4 幀內）
  statusMsg.innerText = "正在解析音訊擊球訊號（P7 精準鎖定）...";
  const audioImpact = await detectAudioImpactFrame(_videoFile, fps, totalFrames, p4Idx);

  let p7Data = bestVisualP7;
  let p7Method = "wrist overlap (P7 match)";

  if (audioImpact && audioImpact.peakFrameIdx) {
    const aIdx = audioImpact.peakFrameIdx;
    if (Math.abs(aIdx - bestVisualP7.idx) <= 4) {
      p7Data = validData.find(d => d.idx === aIdx) || bestVisualP7;
      p7Method = `audio-anchored wrist overlap (diff=${Math.abs(aIdx - bestVisualP7.idx)}f)`;
    }
  }
  const p7Idx = p7Data.idx;

  // -------------------------------------------------------------
  // 步驟 E：定位 P5（下桿半程）與 P6（擊球前導 Delivery Lag）
  // 搜尋時間：介於 P4 與 P7 之間，手腕與職業 P5、P6 重合最佳之幀（若相近選最小幀）
  // -------------------------------------------------------------
  const p5Range = validData.filter(d => d.idx > p4Idx && d.idx < p7Idx);
  const p5Data = p5Range.length > 0
    ? findBestPhaseFrame(p5Range, 'P5')
    : validData[Math.round((p4Idx + p7Idx) / 2)];
  const p5Idx = p5Data.idx;

  const p6Range = validData.filter(d => d.idx >= p5Idx && d.idx < p7Idx);
  const p6Data = p6Range.length > 0
    ? findBestPhaseFrame(p6Range, 'P6')
    : validData[Math.max(0, p7Idx - 2)];
  const p6Idx = p6Data.idx;

  // -------------------------------------------------------------
  // 步驟 F：定位 P8（送桿水平 Follow-Through）
  // 搜尋時間：P7 之後，手腕向目標延伸，與職業 P8 重合最佳之幀（若相近選最小幀）
  // -------------------------------------------------------------
  const followRange = validData.filter(d => d.idx > p7Idx);
  const p8Data = followRange.length > 0
    ? findBestPhaseFrame(followRange, 'P8')
    : validData[Math.min(validData.length - 1, p7Idx + 1)];
  const p8Idx = p8Data.idx;

  // -------------------------------------------------------------
  // 步驟 G：定位 P10（收桿完成 Finish）
  // 搜尋時間：P8 之後後段，手腕繞至左肩後方高處，與職業 P10 重合最佳之幀（若相近選最小幀）
  // -------------------------------------------------------------
  const p10Pool = validData.filter(d => d.idx > p8Idx);
  const p10Data = p10Pool.length > 0
    ? findBestPhaseFrame(p10Pool, 'P10')
    : validData[validData.length - 1];
  const p10Idx = p10Data.idx;

  // -------------------------------------------------------------
  // 步驟 H：定位 P9（送桿半程 Mid-Exit）
  // 搜尋時間：介於 P8 與 P10 之間，手腕與職業 P9 重合最佳之幀（若相近選最小幀）
  // -------------------------------------------------------------
  const p9Range = validData.filter(d => d.idx > p8Idx && d.idx < p10Idx);
  const p9Data = p9Range.length > 0
    ? findBestPhaseFrame(p9Range, 'P9')
    : validData[Math.round((p8Idx + p10Idx) / 2)];
  const p9Idx = p9Data.idx;

  const phaseIndices = {
    P1: p1Idx, P2: p2Idx, P3: p3Idx,
    P4: p4Idx, P5: p5Idx, P6: p6Idx,
    P7: p7Idx, P8: p8Idx, P9: p9Idx, P10: p10Idx
  };

  console.log(`⛳ 手腕相對最近點 (重合最佳) 定位完成 (${p7Method}):`, phaseIndices);

  // 8. 精準單獨擷取 10 個關鍵相位清晰截圖 (記憶體自 1.2GB 驟降至 10MB，徹底防閃退)
  statusMsg.innerText = "正在擷取 10 大關鍵影格清晰截圖...";
  const keyBitmaps = {};
  for (const [phase, fIdx] of Object.entries(phaseIndices)) {
    if (fIdx !== undefined) {
      const t = wristData[fIdx]?.t ?? (fIdx * step);
      hiddenVideo.currentTime = t;
      await new Promise(resolve => {
        const timer = setTimeout(() => resolve(), 250);
        hiddenVideo.onseeked = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      ctx.drawImage(hiddenVideo, 0, 0, targetW, targetH);
      keyBitmaps[phase] = await createImageBitmap(processCanvas);
    }
  }

  // 渲染 P1 ~ P10 全部 10 個相位預覽 Canvas (包含粗深紫色職業標準桿身 + 亮黃色學員桿身)
  const pKeys = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'];
  pKeys.forEach((k) => {
    const pKeyUpper = k.toUpperCase();
    const fIdx = phaseIndices[pKeyUpper];
    const proLm = proBenchmark?.phases?.[pKeyUpper]?.landmarks || null;
    const bitmap = keyBitmaps[pKeyUpper];
    if (fIdx !== undefined && bitmap) {
      renderPoseToCanvas(`${k}-canvas`, bitmap, wristData[fIdx]?.landmarks, proLm, pKeyUpper);
      const label = document.getElementById(`${k}-frame-label`);
      if (label) label.innerText = `第 ${fIdx} 幀 (${(fIdx / fps).toFixed(2)}s)`;
    }
  });

  // 9. 國際標準即時比對與口語化動作提示 (compareWithPro)
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
  document.getElementById("score-grade").innerText = `標準相似度 ${similarity}% (${similarity >= 70 ? '標準級對齊' : '進階微調建議'})`;

  // 10. 產生【3 + 4 + 3】分組照片組（粗深紫色職業標準桿身 + 亮黃色學員桿身直覺對比）
  // 組 1（上揚）：P1 準備站姿, P2 起桿水平, P3 上桿半程 (3格)
  const imgSet1 = createCompositeSetImage([
    { frame: keyBitmaps.P1, lm: wristData[p1Idx]?.landmarks, proLm: proBenchmark?.phases?.P1?.landmarks, phaseKey: "P1", tag: "P1  準備站姿" },
    { frame: keyBitmaps.P2, lm: wristData[p2Idx]?.landmarks, proLm: proBenchmark?.phases?.P2?.landmarks, phaseKey: "P2", tag: "P2  起桿水平" },
    { frame: keyBitmaps.P3, lm: wristData[p3Idx]?.landmarks, proLm: proBenchmark?.phases?.P3?.landmarks, phaseKey: "P3", tag: "P3  上桿半程" }
  ]);

  // 組 2（擊球）：P4 上桿頂點, P5 下桿半程, P6 擊球前導, P7 擊球瞬間 (4格)
  const imgSet2 = createCompositeSetImage([
    { frame: keyBitmaps.P4, lm: wristData[p4Idx]?.landmarks, proLm: proBenchmark?.phases?.P4?.landmarks, phaseKey: "P4", tag: "P4  上桿頂點" },
    { frame: keyBitmaps.P5, lm: wristData[p5Idx]?.landmarks, proLm: proBenchmark?.phases?.P5?.landmarks, phaseKey: "P5", tag: "P5  下桿半程" },
    { frame: keyBitmaps.P6, lm: wristData[p6Idx]?.landmarks, proLm: proBenchmark?.phases?.P6?.landmarks, phaseKey: "P6", tag: "P6  擊球前導" },
    { frame: keyBitmaps.P7, lm: wristData[p7Idx]?.landmarks, proLm: proBenchmark?.phases?.P7?.landmarks, phaseKey: "P7", tag: "P7  擊球瞬間" }
  ]);

  // 組 3（送出）：P8 送桿水平, P9 送桿半程, P10 收桿完成 (3格)
  const imgSet3 = createCompositeSetImage([
    { frame: keyBitmaps.P8, lm: wristData[p8Idx]?.landmarks, proLm: proBenchmark?.phases?.P8?.landmarks, phaseKey: "P8", tag: "P8  送桿水平" },
    { frame: keyBitmaps.P9, lm: wristData[p9Idx]?.landmarks, proLm: proBenchmark?.phases?.P9?.landmarks, phaseKey: "P9", tag: "P9  送桿半程" },
    { frame: keyBitmaps.P10, lm: wristData[p10Idx]?.landmarks, proLm: proBenchmark?.phases?.P10?.landmarks, phaseKey: "P10", tag: "P10 收桿完成" }
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
  statusMsg.innerText = "正在同步揮桿對比診斷報告至伺服器...";
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

    // 1. 繪製底層淡深紫色國際標準骨架與【粗深紫色國際標準桿身】
    if (p.proLm) {
      drawGhostSkeleton(ctx, startX, 0, panelW, panelH, p.lm, p.proLm, p.phaseKey);
    }

    // 2. 繪製頂層使用者骨架與關節點 (亮綠色骨架 + 鮮豔亮藍色手腕點)
    if (p.lm) {
      const clampedLm = clampGolfLimbs(p.lm); // 渲染前手臂鎖鏈修正
      const pts = {};
      for (let idx = 11; idx <= 28; idx++) {
        if (idx >= 17 && idx <= 22) continue; // 排除手指雜點
        const lm = clampedLm[idx];
        if (lm && ((lm.visibility ?? 1.0) >= 0.10 || lm.interpolated)) {
          pts[idx] = [startX + lm.x * panelW, lm.y * panelH];
        }
      }

      // 🛡️ Fallback 備援（立竿見影）：若連線端點因門檻略低缺漏，但具有座標，立即進行 Fallback 保全肢體完整
      for (const [start, end] of POSE_CONNECTIONS) {
        if (!pts[start] && clampedLm[start]) {
          pts[start] = [startX + clampedLm[start].x * panelW, clampedLm[start].y * panelH];
        }
        if (!pts[end] && clampedLm[end]) {
          pts[end] = [startX + clampedLm[end].x * panelW, clampedLm[end].y * panelH];
        }
      }

      // 2a. 先繪製骨架連線 (螢光綠)
      ctx.lineWidth = count === 4 ? 3.5 : 4;
      ctx.strokeStyle = "#00E676";
      ctx.lineCap = "round";

      // 計算軀幹參考長度（放寬連線門檻至 3.2 倍軀幹長，避免合理揮桿大幅伸展時斷肢）
      const refTorsoLen = (pts[11] && pts[23])
        ? Math.hypot(pts[11][0] - pts[23][0], pts[11][1] - pts[23][1])
        : panelH * 0.35;
      const maxLinkLen = refTorsoLen * 3.2;

      for (const [start, end] of POSE_CONNECTIONS) {
        if (pts[start] && pts[end]) {
          const linkLen = Math.hypot(pts[start][0] - pts[end][0], pts[start][1] - pts[end][1]);
          if (linkLen > maxLinkLen) continue; // 超出合理骨架長度，跳過（防扭曲）
          ctx.beginPath();
          ctx.moveTo(pts[start][0], pts[start][1]);
          ctx.lineTo(pts[end][0], pts[end][1]);
          ctx.stroke();
        }
      }

      // 2b. 後繪製關節點（浮在連線上方，排除 17~22 手指雜點）
      // 手腕 15, 16 黏合為單一手腕點，中心黃點 + 擴張藍色外框包裹
      let studentWristDrawn = false;
      for (let idx = 11; idx <= 28; idx++) {
        if (idx >= 17 && idx <= 22) continue; // 排除手指雜點，避免手部出現多餘黃色碎點
        if (pts[idx]) {
          const [cx, cy] = pts[idx];
          const isWrist = (idx === 15 || idx === 16);

          if (isWrist) {
            if (studentWristDrawn) continue; // 避免左右手腕重繪兩次
            studentWristDrawn = true;

            // 學員手腕：黃點然後擴張一點距離用藍色外匡包著
            // 1. 核心黃點
            ctx.beginPath();
            ctx.arc(cx, cy, (count === 4 ? 4.5 : 5.0), 0, 2 * Math.PI);
            ctx.fillStyle = "#FFEB3B";
            ctx.shadowColor = "#000000";
            ctx.shadowBlur = 4;
            ctx.fill();
            ctx.shadowBlur = 0;

            // 2. 擴張一點距離用藍色外框包裹
            ctx.beginPath();
            ctx.arc(cx, cy, (count === 4 ? 9.5 : 11.0), 0, 2 * Math.PI);
            ctx.strokeStyle = "#00B0FF"; // 亮藍色外框
            ctx.lineWidth = 2.5;
            ctx.shadowColor = "#0284C7";
            ctx.shadowBlur = 8;
            ctx.stroke();
            ctx.shadowBlur = 0;
          } else {
            // 其餘身體關節點：亮黃色
            ctx.beginPath();
            ctx.arc(cx, cy, (count === 4 ? 4 : 5), 0, 2 * Math.PI);
            ctx.fillStyle = "#FFEB3B";
            ctx.shadowColor = "#000000";
            ctx.shadowBlur = 4;
            ctx.fill();
            ctx.shadowBlur = 0;
          }
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

  // 左下角繪製骨架對比圖例
  ctx.fillStyle = "rgba(0, 0, 0, 0.88)";
  ctx.beginPath();
  ctx.roundRect(14, totalH - 36, 210, 26, 6);
  ctx.fill();
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillStyle = "#C084FC";
  ctx.fillText("🟣 職業標準", 24, totalH - 19);
  ctx.fillStyle = "#00E676";
  ctx.fillText("🟢 學員骨架", 145, totalH - 19);

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

// 繪製淡深紫色國際標準幽靈對比骨架 (Ghost Pro Skeleton)，與學員骨架完美合併疊加
export function drawGhostSkeleton(ctx, originX, originY, width, height, userLm, rawProLm, phaseKey) {
  if (!rawProLm) return;
  // 職業標準骨架使用基準標註座標，保持關節連線完整無損
  const proLm = rawProLm;

  // 1. 學員骨盆中心（畫布像素座標）
  const userClamped = userLm ? clampGolfLimbs(userLm) : null;
  const uHipX = (userClamped && userClamped[23] && userClamped[24])
    ? (userClamped[23].x + userClamped[24].x) / 2.0 : 0.5;
  const uHipY = (userClamped && userClamped[23] && userClamped[24])
    ? (userClamped[23].y + userClamped[24].y) / 2.0 : 0.6;
  const userCenterPx = originX + uHipX * width;
  const userCenterPy = originY + uHipY * height;

  // 2. 職業基準骨盆中心（歸一化 0~1，pro_benchmark 基準圖為 1:1 正方形）
  const proHipX = (proLm[23] && proLm[24]) ? (proLm[23].x + proLm[24].x) / 2.0 : 0.5;
  const proHipY = (proLm[23] && proLm[24]) ? (proLm[23].y + proLm[24].y) / 2.0 : 0.5;

  // 3. 計算學員與職業選手的固定身體像素比例（統一使用學員站姿比例尺，避免轉身變形忽大忽小）
  let scalePx = height * 0.35;
  let scaleX = 1.0;

  if (globalUserSetupRatio) {
    // 依當前畫布高度 height 還原固定軀幹長度
    const fixedTorsoPx = height * globalUserSetupRatio.torsoRatio;
    const fixedShoulderWPx = width * globalUserSetupRatio.shoulderWRatio;
    scalePx = fixedTorsoPx / (globalUserSetupRatio.proBaseTorso || 0.22);
    const expectedShoulderPx = (globalUserSetupRatio.proBaseShoulderW || 0.15) * scalePx;
    scaleX = Math.max(0.80, Math.min(1.25, fixedShoulderWPx / expectedShoulderPx));
  } else if (userClamped && userClamped[11] && userClamped[12] && userClamped[23] && userClamped[24] &&
      proLm[11] && proLm[12] && proLm[23] && proLm[24]) {
    // 備用局部自適應計算
    const uShPx = ((userClamped[11].x + userClamped[12].x) / 2.0) * width;
    const uShPy = ((userClamped[11].y + userClamped[12].y) / 2.0) * height;
    const uHipPx = uHipX * width;
    const uHipPy = uHipY * height;
    const userTorsoPx = Math.hypot(uHipPx - uShPx, uHipPy - uShPy);
    const userShoulderWPx = Math.abs(userClamped[11].x - userClamped[12].x) * width;

    const pShX = (proLm[11].x + proLm[12].x) / 2.0;
    const pShY = (proLm[11].y + proLm[12].y) / 2.0;
    const proTorso = Math.hypot(proHipX - pShX, proHipY - pShY);
    const proShoulderW = Math.abs(proLm[11].x - proLm[12].x);

    if (proTorso > 0.04 && userTorsoPx > 20) {
      scalePx = userTorsoPx / proTorso;
      if (proShoulderW > 0.01 && userShoulderWPx > 10) {
        const expectedShoulderPx = proShoulderW * scalePx;
        scaleX = Math.max(0.75, Math.min(1.30, userShoulderWPx / expectedShoulderPx));
      }
    }
  }

  // 4. 收集職業選手各關節點像素座標
  const pts = {};
  for (let idx = 11; idx <= 28; idx++) {
    if (idx >= 17 && idx <= 22) continue; // 排除手指雜點
    const p = proLm[idx];
    if (p) {
      // 🚀 核心像素對齊：骨盆中心 100% 疊合，身形依像素等比例貼合在學員身上
      pts[idx] = [
        userCenterPx + (p.x - proHipX) * scalePx * scaleX,
        userCenterPy + (p.y - proHipY) * scalePx
      ];
    }
  }

  // 4a. 先繪製淡深紫色骨架連線
  ctx.lineWidth = 3.0;
  ctx.strokeStyle = "rgba(126, 34, 206, 0.70)"; // 淡深紫色 #7E22CE
  ctx.lineCap = "round";

  for (const [start, end] of POSE_CONNECTIONS) {
    if (pts[start] && pts[end]) {
      ctx.beginPath();
      ctx.moveTo(pts[start][0], pts[start][1]);
      ctx.lineTo(pts[end][0], pts[end][1]);
      ctx.stroke();
    }
  }

  // 4b. 後繪製關節點（手腕強制綁定為單一紅色點，其餘為紫色節點）
  let proWristDrawn = false;
  for (let idx = 11; idx <= 28; idx++) {
    if (idx >= 17 && idx <= 22) continue;
    if (pts[idx]) {
      const [cx, cy] = pts[idx];
      const isWrist = (idx === 15 || idx === 16);

      if (isWrist) {
        if (proWristDrawn) continue;
        proWristDrawn = true;
        ctx.beginPath();
        ctx.arc(cx, cy, 6.5, 0, 2 * Math.PI);
        ctx.fillStyle = "#EF4444"; // 職業選手手腕：強制單點，鮮豔紅色
        ctx.shadowColor = "#DC2626";
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        ctx.beginPath();
        ctx.arc(cx, cy, 3.5, 0, 2 * Math.PI);
        ctx.fillStyle = "rgba(147, 51, 234, 0.85)";
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.fill();
      }
    }
  }
}


// ============================================================
// 高爾夫揮桿骨架約束：手腕點位強制黏在一起（Golf Grip Lock）
// 高爾夫雙手握桿時，左右手腕空間點位永遠黏合在同一個握把點
// 同步修正手指 (17~22) 與手臂鏈 (11->13->15, 12->14->16)
// ============================================================
function clampGolfLimbs(lm) {
  if (!lm || !Array.isArray(lm)) return lm;
  const out = lm.map(pt => pt ? { ...pt } : pt);

  // ── Step 1: 雙手腕強制黏合（左右手腕距離絕對為 0）──
  const lw = out[15], rw = out[16];
  if (lw && rw) {
    const vL = Math.max(0.01, lw.visibility ?? lw.vis ?? 0.5);
    const vR = Math.max(0.01, rw.visibility ?? rw.vis ?? 0.5);

    // 參考軀幹長度，防止單手飄移至畫面背景雜訊
    let torsoLen = 0.3;
    if (out[11] && out[23] && out[12] && out[24]) {
      const tL = Math.hypot(out[11].x - out[23].x, out[11].y - out[23].y);
      const tR = Math.hypot(out[12].x - out[24].x, out[12].y - out[24].y);
      if (tL > 0.05 && tR > 0.05) torsoLen = (tL + tR) / 2;
    }

    const distL = out[11] ? Math.hypot(lw.x - out[11].x, lw.y - out[11].y) : 0.4;
    const distR = out[12] ? Math.hypot(rw.x - out[12].x, rw.y - out[12].y) : 0.4;

    let ancX, ancY;
    // 若單手嚴重飄移（大於軀幹 2.2 倍），以合理手臂為基準
    if (distL > torsoLen * 2.2 && distR <= torsoLen * 2.2) {
      ancX = rw.x;
      ancY = rw.y;
    } else if (distR > torsoLen * 2.2 && distL <= torsoLen * 2.2) {
      ancX = lw.x;
      ancY = lw.y;
    } else {
      // 依置信度加權握把中心
      ancX = (lw.x * vL + rw.x * vR) / (vL + vR);
      ancY = (lw.y * vL + rw.y * vR) / (vL + vR);
    }

    const avgVis = (vL + vR) / 2;

    // ✅ 強制左手腕 (15) 與右手腕 (16) 完全黏合在同一個坐標點
    out[15] = { ...lw, x: ancX, y: ancY, visibility: avgVis };
    out[16] = { ...rw, x: ancX, y: ancY, visibility: avgVis };

    // ✅ 手掌與手指點（17~22）同步鎖定至握把中心，消除漂浮雜點
    for (const fIdx of [17, 18, 19, 20, 21, 22]) {
      if (out[fIdx]) {
        out[fIdx] = { ...out[fIdx], x: ancX, y: ancY, visibility: avgVis };
      }
    }
  } else if (lw && !rw) {
    out[16] = { ...lw };
  } else if (!lw && rw) {
    out[15] = { ...rw };
  }

  // ── Step 2: 手肘合理性修正（防止手肘飛出畫面外異常拉伸）──
  // 注意：高爾夫揮桿上桿頂點（P4）或收桿（P10）時，手腕接近肩膀，手肘自然彎曲，
  // 此時肩到腕距離極小，絕不能以肩-腕投影距離約束手肘長度（否則會將手肘壓扁貼回肩膀）！
  // 應以軀幹長度 (torsoLen) 作為人體工學物理上限
  let refTorso = 0.3;
  if (out[11] && out[23] && out[12] && out[24]) {
    const tL = Math.hypot(out[11].x - out[23].x, out[11].y - out[23].y);
    const tR = Math.hypot(out[12].x - out[24].x, out[12].y - out[24].y);
    if (tL > 0.05 && tR > 0.05) refTorso = (tL + tR) / 2;
  }
  const maxUpperArmPhys = refTorso * 0.95; // 單段上臂在畫面中最大物理合理長度

  const armChains = [[11, 13, 15], [12, 14, 16]];
  for (const [shIdx, elIdx, wrIdx] of armChains) {
    const sh = out[shIdx], el = out[elIdx], wr = out[wrIdx];
    if (!sh || !el) continue;

    const upperArmLen = Math.hypot(sh.x - el.x, sh.y - el.y);
    // 僅在手肘異常爆出超出人體物理極限時做縮回投影，不破壞自然彎曲手肘
    if (upperArmLen > maxUpperArmPhys && upperArmLen > 0.005) {
      const ratio = maxUpperArmPhys / upperArmLen;
      out[elIdx] = {
        ...el,
        x: sh.x + (el.x - sh.x) * ratio,
        y: sh.y + (el.y - sh.y) * ratio
      };
    }
  }

  return out;
}


// 繪製骨架到預覽 Canvas (底層淡深紫色職業標準骨架 + 頂層學員骨架)
function renderPoseToCanvas(canvasId, frameBitmap, landmarks, proLandmarks, phaseKey) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d");

  canvas.width = frameBitmap.width;
  canvas.height = frameBitmap.height;

  // 1. 繪製背景影片幀
  ctx.drawImage(frameBitmap, 0, 0);

  // 2. 繪製底層淡深紫色國際標準骨架
  if (proLandmarks) {
    drawGhostSkeleton(ctx, 0, 0, canvas.width, canvas.height, landmarks, proLandmarks, phaseKey);
  }

  // 3. 繪製頂層使用者骨架 (亮綠色骨架 + 鮮豔亮藍色手腕點)
  if (landmarks) {
    const clampedLm = clampGolfLimbs(landmarks); // 渲染前手臂鎖鏈修正
    const w = canvas.width;
    const h = canvas.height;
    const pts = {};

    for (let idx = 11; idx <= 28; idx++) {
      if (idx >= 17 && idx <= 22) continue; // 排除手指雜點
      const lm = clampedLm[idx];
      if (lm && ((lm.visibility ?? 1.0) >= 0.10 || lm.interpolated)) {
        pts[idx] = [lm.x * w, lm.y * h];
      }
    }

    // 🛡️ Fallback 備援（立竿見影）：若連線端點因門檻略低缺漏，但具有座標，立即進行 Fallback 保全肢體完整
    for (const [start, end] of POSE_CONNECTIONS) {
      if (!pts[start] && clampedLm[start]) {
        pts[start] = [clampedLm[start].x * w, clampedLm[start].y * h];
      }
      if (!pts[end] && clampedLm[end]) {
        pts[end] = [clampedLm[end].x * w, clampedLm[end].y * h];
      }
    }

    // 3a. 先繪製骨架連線 (螢光綠)
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = "#00E676";
    ctx.lineCap = "round";

    // 合理性校驗：放寬連線門檻至 3.2 倍軀幹長，避免高舉手臂時連線被誤裁切
    const refTorsoLenR = (pts[11] && pts[23])
      ? Math.hypot(pts[11][0] - pts[23][0], pts[11][1] - pts[23][1])
      : canvas.height * 0.35;
    const maxLinkLenR = refTorsoLenR * 3.2;

    for (const [start, end] of POSE_CONNECTIONS) {
      if (pts[start] && pts[end]) {
        const linkLen = Math.hypot(pts[start][0] - pts[end][0], pts[start][1] - pts[end][1]);
        if (linkLen > maxLinkLenR) continue;
        ctx.beginPath();
        ctx.moveTo(pts[start][0], pts[start][1]);
        ctx.lineTo(pts[end][0], pts[end][1]);
        ctx.stroke();
      }
    }

    // 3b. 後繪製關節點（浮在連線上方，排除 17~22 手指雜點）
    // 學員手腕 15, 16 黏合為單一手腕點：黃點 + 擴張一點距離用藍色外框包裹
    let studentWristDrawn = false;
    for (let idx = 11; idx <= 28; idx++) {
      if (idx >= 17 && idx <= 22) continue; // 排除手指雜點，避免手部出現多餘黃色碎點
      if (pts[idx]) {
        const [cx, cy] = pts[idx];
        const isWrist = (idx === 15 || idx === 16);

        if (isWrist) {
          if (studentWristDrawn) continue;
          studentWristDrawn = true;

          // 1. 核心黃點
          ctx.beginPath();
          ctx.arc(cx, cy, 4.5, 0, 2 * Math.PI);
          ctx.fillStyle = "#FFEB3B";
          ctx.shadowColor = "#000000";
          ctx.shadowBlur = 4;
          ctx.fill();
          ctx.shadowBlur = 0;

          // 2. 擴張一點距離用藍色外框包裹
          ctx.beginPath();
          ctx.arc(cx, cy, 10.0, 0, 2 * Math.PI);
          ctx.strokeStyle = "#00B0FF"; // 亮藍色外框
          ctx.lineWidth = 2.5;
          ctx.shadowColor = "#0284C7";
          ctx.shadowBlur = 8;
          ctx.stroke();
          ctx.shadowBlur = 0;
        } else {
          ctx.beginPath();
          ctx.arc(cx, cy, 4.5, 0, 2 * Math.PI);
          ctx.fillStyle = "#FFEB3B";
          ctx.shadowColor = "transparent";
          ctx.shadowBlur = 0;
          ctx.fill();
        }
      }
    }
  }

  // 4. 左上角小圖例
  ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
  ctx.beginPath();
  ctx.roundRect(10, 10, 190, 24, 6);
  ctx.fill();
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillStyle = "#C084FC";
  ctx.fillText("🟣 職業標準", 18, 26);
  ctx.fillStyle = "#00E676";
  ctx.fillText("🟢 學員骨架", 100, 26);
}

// 角度計算輔助函數
function calcSpineAngle(landmarks) {
  if (!landmarks) return 5;
  const hipX = (landmarks[23].x + landmarks[24].x) / 2.0;
  const hipY = (landmarks[23].y + landmarks[24].y) / 2.0;
  const shX = (landmarks[11].x + landmarks[12].x) / 2.0;
  const shY = (landmarks[11].y + landmarks[12].y) / 2.0;

  const dx = shX - hipX;
  const dy = hipY - shY; // 影像 Y 往下為正
  const deg = Math.round(Math.abs(Math.atan2(dx, dy) * (180 / Math.PI)));
  return Math.min(50, Math.max(0, deg));
}

// ✅ 優化五：calcArmTorsoAngle 加入左右手可見度加權，修正上桿段左右手不對稱造成的角度偏差
function calcArmTorsoAngle(landmarks) {
  if (!landmarks || !landmarks[11] || !landmarks[12] || !landmarks[23] || !landmarks[24] || !landmarks[15] || !landmarks[16]) {
    return 40;
  }
  const shX = (landmarks[11].x + landmarks[12].x) / 2.0;
  const shY = (landmarks[11].y + landmarks[12].y) / 2.0;
  const hipX = (landmarks[23].x + landmarks[24].x) / 2.0;
  const hipY = (landmarks[23].y + landmarks[24].y) / 2.0;

  // 以可見度加權平均計算手腕位置（而非等權平均）
  const vis15 = Math.max(0.1, landmarks[15].visibility ?? 0.5);
  const vis16 = Math.max(0.1, landmarks[16].visibility ?? 0.5);
  const wX = (landmarks[15].x * vis15 + landmarks[16].x * vis16) / (vis15 + vis16);
  const wY = (landmarks[15].y * vis15 + landmarks[16].y * vis16) / (vis15 + vis16);

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
  const proSpine = (pro && pro.metrics && pro.metrics.spine_angle !== undefined) ? pro.metrics.spine_angle : 1;
  const proArm = (pro && pro.metrics && pro.metrics.arm_angles) ? pro.metrics.arm_angles : {
    P1: 3,
    P2: 43,
    P3: 99,
    P4: 145,
    P5: 114,
    P6: 41,
    P7: 1,
    P8: 28,
    P9: 99,
    P10: 154
  };

  const userArm = userMetrics.armAngles || {
    P1: 3, P2: 43, P3: 99, P4: 145, P5: 114,
    P6: 41, P7: 1, P8: 28, P9: 99, P10: 154
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

  // 計算有效誤差 (忽略 +-10° 以內的模型合理誤差)
  const effSpine = Math.max(0, Math.abs(spineDiff) - 10);
  const effP2 = Math.max(0, Math.abs(diffP2) - 10);
  const effP3 = Math.max(0, Math.abs(diffP3) - 10);
  const effP4 = Math.max(0, Math.abs(diffP4) - 10);
  const effP5 = Math.max(0, Math.abs(diffP5) - 10);
  const effP6 = Math.max(0, Math.abs(diffP6) - 10);
  const effP7 = Math.max(0, Math.abs(diffP7) - 10);
  const effP8 = Math.max(0, Math.abs(diffP8) - 10);
  const effP9 = Math.max(0, Math.abs(diffP9) - 10);
  const effP10 = Math.max(0, Math.abs(diffP10) - 10);

  // 相似度指標：P1~P10 一個黑字(良好對齊，偏差<=10°)佔 10%，3黑7紅即為 30%
  const phaseGoodStatus = [
    Math.abs(spineDiff) <= 10,
    Math.abs(diffP2) <= 10,
    Math.abs(diffP3) <= 10,
    Math.abs(diffP4) <= 10,
    Math.abs(diffP5) <= 10,
    Math.abs(diffP6) <= 10,
    Math.abs(diffP7) <= 10,
    Math.abs(diffP8) <= 10,
    Math.abs(diffP9) <= 10,
    Math.abs(diffP10) <= 10
  ];
  const blackCount = phaseGoodStatus.filter(Boolean).length;
  const similarity = blackCount * 10;
  const score = similarity;

  // P1 ~ P10 逐張詳細角度差異與直覺調整處方 (誤差 <= 10° 視為良好對齊)
  const phaseAdvice = [];

  // P1 準備站姿 (Address) - 專注脊椎傾角與中軸
  let p1Text = "";
  if (Math.abs(spineDiff) <= 10) {
    p1Text = `P1 站姿：脊椎側傾 ${userMetrics.spineAngle}° (與標準對齊良好)。雙手自然垂於兩胯中軸，站姿穩定極佳！`;
  } else if (spineDiff > 10) {
    p1Text = `P1 站姿：脊椎側傾 ${userMetrics.spineAngle}° (差 +${spineDiff}°)。建議：上半身稍微挺起一些、骨盆微縮，避免站姿過度下趴。`;
  } else {
    p1Text = `P1 站姿：脊椎側傾 ${userMetrics.spineAngle}° (差 -${Math.abs(spineDiff)}°)。建議：上半身從臀部前傾微彎、膝蓋放鬆微曲，保持穩定重心。`;
  }
  phaseAdvice.push(p1Text);

  // P2 起桿水平 (Takeaway) - 手軀夾角 (標準 43°)
  let p2Text = "";
  if (Math.abs(diffP2) <= 10) {
    p2Text = `P2 起桿：手軀夾角 ${userArm.P2}° (與標準 43° 對齊良好)。手臂維持寬闊大三角形，引桿路徑標準！`;
  } else if (diffP2 > 10) {
    p2Text = `P2 起桿：手軀夾角 ${userArm.P2}° (差 +${diffP2}°)。建議：雙手勿太早向上抬起，手臂打直並以胸口轉動帶動手臂平順後移。`;
  } else {
    p2Text = `P2 起桿：手軀夾角 ${userArm.P2}° (差 -${Math.abs(diffP2)}°)。建議：起桿時手臂朝外後側充分引伸展開，避免雙手太貼近大腿。`;
  }
  phaseAdvice.push(p2Text);

  // P3 上桿半程 (Mid-Backswing) - 手軀夾角 (標準 99°)
  let p3Text = "";
  if (Math.abs(diffP3) <= 10) {
    p3Text = `P3 上桿半程：手軀夾角 ${userArm.P3}° (與標準 99° 對齊良好)。手腕自然立腕延伸，上揚軌跡扎實！`;
  } else if (diffP3 > 10) {
    p3Text = `P3 上桿半程：手軀夾角 ${userArm.P3}° (差 +${diffP3}°)。建議：手部抬升稍高，注意保持左臂寬度，順勢立腕而勿過度上拉。`;
  } else {
    p3Text = `P3 上桿半程：手軀夾角 ${userArm.P3}° (差 -${Math.abs(diffP3)}°)。建議：雙手朝目標反方向推展並抬升手腕，維持寬闊揮桿圓弧。`;
  }
  phaseAdvice.push(p3Text);

  // P4 上桿頂點 (Top of Swing) - 手軀夾角 (標準 145°)
  let p4Text = "";
  if (Math.abs(diffP4) <= 10) {
    p4Text = `P4 上桿頂點：手軀夾角 ${userArm.P4}° (與標準 145° 對齊良好)。雙手高舉蓄力充分，頂點結構優異！`;
  } else if (diffP4 < -10) {
    p4Text = `P4 上桿頂點：手軀夾角 ${userArm.P4}° (差 ${diffP4}°)。建議：頂點時雙手再往上抬高約 5 公分，左臂充分打直蓄滿爆發力。`;
  } else {
    p4Text = `P4 上桿頂點：手軀夾角 ${userArm.P4}° (差 +${diffP4}°)。建議：雙手避免過度高舉造成過度揮桿(Over-swing)，保持下盤穩固。`;
  }
  phaseAdvice.push(p4Text);

  // P5 下桿半程 (Mid-Downswing) - 手軀夾角 (標準 114°)
  let p5Text = "";
  if (Math.abs(diffP5) <= 10) {
    p5Text = `P5 下桿半程：手軀夾角 ${userArm.P5}° (與標準 114° 對齊良好)。下桿由下盤啟動沉手順暢，淺化路徑精準！`;
  } else if (diffP5 > 10) {
    p5Text = `P5 下桿半程：手軀夾角 ${userArm.P5}° (差 +${diffP5}°)。建議：雙手主動順勢沉降、右肘貼近腰側下拉，避免由外向內切球(OTT)。`;
  } else {
    p5Text = `P5 下桿半程：手軀夾角 ${userArm.P5}° (差 -${Math.abs(diffP5)}°)。建議：下桿手臂維持釋放空間，避免雙手過早縮靠身體。`;
  }
  phaseAdvice.push(p5Text);

  // P6 擊球前導 (Lag Delivery) - 手軀夾角 (標準 41°)
  let p6Text = "";
  if (Math.abs(diffP6) <= 10) {
    p6Text = `P6 擊球前導：手軀夾角 ${userArm.P6}° (與標準 41° 對齊良好)。手腕維持極佳滯後延遲(Lag)，蓄力飽滿！`;
  } else if (diffP6 > 10) {
    p6Text = `P6 擊球前導：手軀夾角 ${userArm.P6}° (差 +${diffP6}°)。建議：雙手再向下沉壓至右大腿前，延遲翻腕釋放桿頭。`;
  } else {
    p6Text = `P6 擊球前導：手軀夾角 ${userArm.P6}° (差 -${Math.abs(diffP6)}°)。建議：維持手腕柔軟蓄力，保持手臂與桿身夾角順勢帶入擊球區。`;
  }
  phaseAdvice.push(p6Text);

  // P7 擊球瞬間 (Impact) - 手軀夾角 (標準 1°)
  let p7Text = "";
  if (Math.abs(diffP7) <= 10) {
    p7Text = `P7 擊球瞬間：手軀夾角 ${userArm.P7}° (與標準 1° 對齊良好)。左手臂垂直貫穿擊球點，力量傳導極佳！`;
  } else if (diffP7 > 10) {
    p7Text = `P7 擊球瞬間：手軀夾角 ${userArm.P7}° (差 +${diffP7}°)。建議：擊球瞬間左手臂完全向下打直貫穿球位，雙手壓過球前。`;
  } else {
    p7Text = `P7 擊球瞬間：手軀夾角 ${userArm.P7}° (差 -${Math.abs(diffP7)}°)。建議：保持重心移向左側，左臂垂直順暢帶動桿頭掃過甜蜜點。`;
  }
  phaseAdvice.push(p7Text);

  // P8 送桿水平 (Follow-Through) - 手軀夾角 (標準 28°)
  let p8Text = "";
  if (Math.abs(diffP8) <= 10) {
    p8Text = `P8 送桿水平：手軀夾角 ${userArm.P8}° (與標準 28° 對齊良好)。雙臂朝目標大圓弧送出，釋放延伸非常漂亮！`;
  } else if (diffP8 < -10) {
    p8Text = `P8 送桿水平：手軀夾角 ${userArm.P8}° (差 ${diffP8}°)。建議：擊球後雙手完全向目標側高拋送出，不要太早縮手肘(雞翅膀)。`;
  } else {
    p8Text = `P8 送桿水平：手軀夾角 ${userArm.P8}° (差 +${diffP8}°)。建議：手臂順著揮桿平面自然順勢延伸，胸口轉向目標。`;
  }
  phaseAdvice.push(p8Text);

  // P9 送桿半程 (Mid-Exit) - 手軀夾角 (標準 99°)
  let p9Text = "";
  if (Math.abs(diffP9) <= 10) {
    p9Text = `P9 送桿半程：手軀夾角 ${userArm.P9}° (與標準 99° 對齊良好)。雙手順勢向上劃出漂亮出桿弧度！`;
  } else if (diffP9 < -10) {
    p9Text = `P9 送桿半程：手軀夾角 ${userArm.P9}° (差 ${diffP9}°)。建議：送桿時手腕順勢向上抬升繞過左肩，胸口完全轉向正前方。`;
  } else {
    p9Text = `P9 送桿半程：手軀夾角 ${userArm.P9}° (差 +${diffP9}°)。出桿弧度寬闊，順勢放鬆將球桿繞至頸後完成收桿。`;
  }
  phaseAdvice.push(p9Text);

  // P10 收桿完成 (Finish) - 手軀夾角 (標準 154°)
  let p10Text = "";
  if (Math.abs(diffP10) <= 10) {
    p10Text = `P10 收桿完成：手軀夾角 ${userArm.P10}° (與標準 154° 對齊良好)。收桿手部位置優雅，重心完美踩穩左腳！`;
  } else if (diffP10 < -10) {
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
        console.log("✅ LIFF sendMessages 成功發送觸發文字！");
        btnShareLine.innerText = "✅ 分析完成！正在跳轉至 LINE 查看診斷小卡...";
        btnShareLine.style.background = "#059669";
        statusMsg.innerText = "✅ 分析完成！即將自動關閉頁面，請於 LINE 聊天室查看診斷小卡...";

        // 核心功能：分析完成後自動切掉頁面，強制引導使用者回到 LINE 查看診斷小卡
        setTimeout(() => {
          try {
            liff.closeWindow();
          } catch (e) {
            console.warn("liff.closeWindow 異常，嘗試 window.close():", e);
            window.close();
          }
        }, 400);
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