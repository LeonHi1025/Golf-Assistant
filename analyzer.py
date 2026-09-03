import cv2
import numpy as np
import mediapipe as mp
import os

mp_pose = mp.solutions.pose

# 12條主要肢體與軀幹連線 (排除面部雜點，使揮桿骨架更清晰)
GOLF_CONNECTIONS = [
    (11, 12),           # 雙肩
    (11, 13), (13, 15), # 左手臂 (左肩 -> 左肘 -> 左腕)
    (12, 14), (14, 16), # 右手臂 (右肩 -> 右肘 -> 右腕)
    (11, 23), (12, 24), # 軀幹兩側 (肩 -> 臀)
    (23, 24),           # 雙臀
    (23, 25), (25, 27), # 左腿 (左臀 -> 左膝 -> 左踝)
    (24, 26), (26, 28)  # 右腿 (右臀 -> 右膝 -> 右踝)
]

def draw_filtered_pose(image, landmarks, min_visibility=0.4):
    """
    自訂骨架繪製函數：
    1. 信心度過濾：只繪製信心度高於 min_visibility 的特徵點
    2. 空間合理性防呆：若手臂關節飄移至天空或背景路人，不予繪製
    3. 連線保護：只有當兩端特徵點皆有效時才繪製連線
    """
    if not landmarks:
        return
    
    h, w, _ = image.shape
    lm = landmarks.landmark
    
    # 軀幹中心與基準長度
    hip_x = (lm[23].x + lm[24].x) / 2.0
    hip_y = (lm[23].y + lm[24].y) / 2.0
    shoulder_x = (lm[11].x + lm[12].x) / 2.0
    shoulder_y = (lm[11].y + lm[12].y) / 2.0
    torso_h = np.hypot(hip_x - shoulder_x, hip_y - shoulder_y)
    max_reach = max(0.30, torso_h * 1.4)

    valid_pts = {}
    for idx in range(11, 29): # 只關注軀幹與四肢 (11 ~ 28)
        p = lm[idx]
        if p.visibility >= min_visibility:
            # 手肘(13, 14)與手腕(15, 16)進行空間距離限制防呆
            if idx in [13, 14, 15, 16]:
                if np.hypot(p.x - hip_x, p.y - hip_y) > max_reach:
                    continue
            
            cx, cy = int(p.x * w), int(p.y * h)
            # 確保座標在畫面內
            if 0 <= cx < w and 0 <= cy < h:
                valid_pts[idx] = (cx, cy)
                cv2.circle(image, (cx, cy), 5, (0, 255, 255), -1, cv2.LINE_AA)

    # 繪製骨架連線
    for s_idx, e_idx in GOLF_CONNECTIONS:
        if s_idx in valid_pts and e_idx in valid_pts:
            cv2.line(image, valid_pts[s_idx], valid_pts[e_idx], (0, 255, 0), 3, cv2.LINE_AA)

def analyze_golf_swing(video_path: str, output_image_path: str) -> dict:
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    
    frames = []
    wrist_data = []
    frame_idx = 0
    
    pose = mp_pose.Pose(
        static_image_mode=False,
        model_complexity=1,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5
    )
    
    last_valid_hip = None
    last_valid_torso_h = None
    last_valid_landmarks = None
    last_valid_wrist = None

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break
            
        frames.append(frame)
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = pose.process(rgb)
        
        t = frame_idx / fps
        valid_pose = False
        current_landmarks = None

        if results.pose_landmarks:
            lm = results.pose_landmarks.landmark
            hip_x = (lm[23].x + lm[24].x) / 2.0
            hip_y = (lm[23].y + lm[24].y) / 2.0
            shoulder_x = (lm[11].x + lm[12].x) / 2.0
            shoulder_y = (lm[11].y + lm[12].y) / 2.0
            
            torso_h = np.hypot(hip_x - shoulder_x, hip_y - shoulder_y)
            shoulder_w = abs(lm[11].x - lm[12].x)

            # 初始鎖定主角：中央區間且身形比例符合前景打者
            if last_valid_hip is None:
                if 0.20 < hip_x < 0.80 and (torso_h > 0.10 or shoulder_w > 0.06):
                    last_valid_hip = (hip_x, hip_y)
                    last_valid_torso_h = torso_h
                    last_valid_landmarks = results.pose_landmarks
                    valid_pose = True
                    current_landmarks = results.pose_landmarks
            else:
                # 追蹤主角：防止位置與大小突變跳到背景
                dist = np.hypot(hip_x - last_valid_hip[0], hip_y - last_valid_hip[1])
                is_size_valid = (torso_h > last_valid_torso_h * 0.45) if last_valid_torso_h else True

                if dist < 0.22 and is_size_valid:
                    last_valid_hip = (hip_x, hip_y)
                    last_valid_torso_h = torso_h
                    last_valid_landmarks = results.pose_landmarks
                    valid_pose = True
                    current_landmarks = results.pose_landmarks
                else:
                    valid_pose = False

        if valid_pose and current_landmarks:
            lm = current_landmarks.landmark
            lw = lm[15] # 左手腕
            rw = lm[16] # 右手腕
            
            max_hand_dist = max(0.30, torso_h * 1.4)
            dist_lw = np.hypot(lw.x - hip_x, lw.y - hip_y)
            dist_rw = np.hypot(rw.x - hip_x, rw.y - hip_y)
            
            lw_valid = (dist_lw <= max_hand_dist) and (lw.visibility >= 0.30)
            rw_valid = (dist_rw <= max_hand_dist) and (rw.visibility >= 0.30)
            
            wr_dist = np.hypot(lw.x - rw.x, lw.y - rw.y)
            
            if lw_valid and rw_valid:
                # 若雙手腕間距過大 (單手飄移至背景)，以信心度高者修正
                if wr_dist > max(0.18, torso_h * 0.55):
                    if lw.visibility >= rw.visibility:
                        rw.x, rw.y = lw.x, lw.y
                        hand_x, hand_y = lw.x, lw.y
                    else:
                        lw.x, lw.y = rw.x, rw.y
                        hand_x, hand_y = rw.x, rw.y
                else:
                    # 正常握桿重疊，加權計算握把中心
                    w_l = max(0.01, lw.visibility)
                    w_r = max(0.01, rw.visibility)
                    hand_x = (lw.x * w_l + rw.x * w_r) / (w_l + w_r)
                    hand_y = (lw.y * w_l + rw.y * w_r) / (w_l + w_r)
            elif lw_valid:
                rw.x, rw.y = lw.x, lw.y
                hand_x, hand_y = lw.x, lw.y
            elif rw_valid:
                lw.x, lw.y = rw.x, rw.y
                hand_x, hand_y = rw.x, rw.y
            else:
                if last_valid_wrist:
                    hand_x, hand_y = last_valid_wrist['x'], last_valid_wrist['y']
                    lw.x, lw.y = hand_x, hand_y
                    rw.x, rw.y = hand_x, hand_y
                else:
                    hand_x, hand_y = 0.5, 0.5

            last_valid_wrist = {'x': hand_x, 'y': hand_y}
            wrist_data.append({'frame': frame_idx, 'x': hand_x, 'y': hand_y, 't': t, 'landmarks': current_landmarks})
        else:
            # 當前影格雜訊或漏抓，沿用上一幀主角資料
            if last_valid_wrist:
                wrist_data.append({'frame': frame_idx, 'x': last_valid_wrist['x'], 'y': last_valid_wrist['y'], 't': t, 'landmarks': last_valid_landmarks})
            else:
                wrist_data.append({'frame': frame_idx, 'x': 0.5, 'y': 0.5, 't': t, 'landmarks': None})
            
        frame_idx += 1
        
    cap.release()
    pose.close()
    
    total_frames = len(frames)
    if total_frames < 20:
        return {"success": False, "error": "影片過短"}

    # 1. 座標平滑 (5-frame Moving Average)
    ys = [d['y'] for d in wrist_data]
    smoothed_y = np.convolve(ys, np.ones(5)/5, mode='same')
    
    # 2. 計算合速度
    velocities = [0.0]
    for i in range(1, total_frames):
        dt = wrist_data[i]['t'] - wrist_data[i-1]['t']
        if dt > 0:
            dx = wrist_data[i]['x'] - wrist_data[i-1]['x']
            dy = wrist_data[i]['y'] - wrist_data[i-1]['y']
            velocities.append(np.hypot(dx, dy) / dt)
        else:
            velocities.append(velocities[-1])

    # 3. P4 (Top): 手腕 Y 軸最低 (影像最高點)
    s_start, s_end = int(total_frames * 0.1), int(total_frames * 0.8)
    p4_idx = s_start + int(np.argmin(smoothed_y[s_start:s_end]))
    
    # 4. P1 (Address): P4 前約 1~2 秒區間內速度最低處 (起桿前之靜止站姿)
    p1_start = max(1, p4_idx - int(fps * 2.0))
    p1_end = max(p1_start + 1, p4_idx - 5)
    p1_idx = p1_start + int(np.argmin(velocities[p1_start:p1_end]))
    
    # 5. P7 (Impact): 嚴格限制在下桿區間 (P4 後 0.1s ~ 0.4s 內)，避免飄移至收桿
    p7_start = p4_idx + 2
    p7_end = min(total_frames, p4_idx + int(fps * 0.40))
    if p7_end > p7_start:
        p7_idx = p7_start + int(np.argmax(velocities[p7_start:p7_end]))
    else:
        p7_idx = min(total_frames - 1, p4_idx + 6)

    # 6. 截圖標記並水平拼接成一張三格對比圖 (維持等比例縮放)
    key_indices = [("P1: Address", p1_idx), ("P4: Top", p4_idx), ("P7: Impact", p7_idx)]
    annotated_frames = []
    
    for label, idx in key_indices:
        target_frame = frames[idx].copy()
        landmarks = wrist_data[idx]['landmarks']
        if landmarks:
            # 採用信心度 >= 0.4 與空間過濾的自訂繪製
            draw_filtered_pose(target_frame, landmarks, min_visibility=0.6)
            
        # 繪製半透明標籤背景以增強可讀性
        cv2.rectangle(target_frame, (20, 20), (320, 80), (0, 0, 0), -1)
        cv2.putText(target_frame, label, (30, 62), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (0, 255, 0), 2, cv2.LINE_AA)
        
        # 等比例縮放至高度 720px，長寬比保護 (不拉伸、不變形)
        h, w, _ = target_frame.shape
        new_w = int(w * (720.0 / h))
        resized = cv2.resize(target_frame, (new_w, 720), interpolation=cv2.INTER_AREA)
        annotated_frames.append(resized)
        
    combined_img = np.hstack(annotated_frames)
    cv2.imwrite(output_image_path, combined_img)
    
    return {
        "success": True,
        "total_frames": total_frames,
        "p1": p1_idx,
        "p4": p4_idx,
        "p7": p7_idx
    }