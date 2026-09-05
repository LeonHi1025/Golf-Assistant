import os
import re
import json
import time
import base64
import uuid
from typing import Dict, Any, Optional, List
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from linebot.v3 import WebhookHandler
from linebot.v3.exceptions import InvalidSignatureError
from linebot.v3.messaging import (
    Configuration, ApiClient, MessagingApi,
    ReplyMessageRequest, FlexMessage, FlexContainer, ImageMessage, TextMessage
)
from linebot.v3.webhooks import MessageEvent, TextMessageContent, VideoMessageContent

app = FastAPI(title="Golf Swing AI Assistant (Edge PWA)")

# 啟用 CORS 讓 GitHub Pages 與 LIFF 瀏覽器能呼叫 API 上傳報告
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 靜態檔案服務 (包含 PWA 網頁、Service Worker 與分析截圖)
REPORTS_DIR = os.path.join("static", "reports")
os.makedirs(REPORTS_DIR, exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

# 從環境變數讀取金鑰與網址設定
CHANNEL_SECRET = os.getenv("CHANNEL_SECRET", "")
CHANNEL_ACCESS_TOKEN = os.getenv("CHANNEL_ACCESS_TOKEN", "")
# 預設使用 Render 伺服器網址
SERVER_BASE_URL = os.getenv("SERVER_BASE_URL", os.getenv("RENDER_EXTERNAL_URL", "https://golf-assistant.onrender.com"))
LIFF_ID = os.getenv("LIFF_ID", "2011445978-6xeS4R70")

configuration = Configuration(access_token=CHANNEL_ACCESS_TOKEN)
handler = WebhookHandler(CHANNEL_SECRET)

# 記憶體快取使用者最近的分析報告
# 格式: { user_id: { "report_id": ..., "score": 88, "spine": 32, "turn": 89, "img_filename": ..., "created_at": ... } }
user_reports: Dict[str, Dict[str, Any]] = {}
latest_global_report: Optional[Dict[str, Any]] = None
latest_server_host: str = SERVER_BASE_URL

def get_app_url() -> str:
    """取得 PWA / LIFF 網頁專屬連結"""
    if LIFF_ID:
        return f"https://liff.line.me/{LIFF_ID}"
    if SERVER_BASE_URL:
        return f"{SERVER_BASE_URL.rstrip('/')}/static/index.html"
    return "/static/index.html"

class ReportUploadPayload(BaseModel):
    userId: Optional[str] = ""
    score: int = 88
    similarity: Optional[int] = 87
    spineAngle: Optional[int] = 32
    shoulderTurn: Optional[int] = 89
    imageBase64: Optional[str] = ""
    images: Optional[List[str]] = []
    p1Spine: Optional[float] = 32.0
    p4Turn: Optional[float] = 88.0
    p6Lag: Optional[float] = 34.0
    p7Ext: Optional[float] = 5.5
    p10Bal: Optional[str] = "94%"
    diffs: Optional[dict] = {}
    stageAdvice: Optional[List[str]] = []
    summaryAdvice: Optional[List[str]] = []

@app.get("/api/config")
def get_config(request: Request):
    """提供前端動態讀取 LIFF_ID 與設定"""
    global latest_server_host
    base_url = SERVER_BASE_URL or str(request.base_url).rstrip("/")
    if base_url.startswith("http://"):
        base_url = base_url.replace("http://", "https://")
    latest_server_host = base_url

    return {
        "liffId": LIFF_ID,
        "serverBaseUrl": base_url
    }

@app.post("/api/upload_report")
async def upload_report(payload: ReportUploadPayload, request: Request):
    """接收前端 Edge AI 產生的 1+3+3+3 骨架合成照片組與 Tiger 十階段比對指標"""
    global latest_global_report, latest_server_host
    
    # 紀錄最新伺服器網址供 LINE 圖片下載
    base_url = SERVER_BASE_URL or str(request.base_url).rstrip("/")
    if base_url.startswith("http://"):
        base_url = base_url.replace("http://", "https://")
    latest_server_host = base_url

    try:
        report_id = f"report_{int(time.time())}_{uuid.uuid4().hex[:6]}"
        filenames = []
        
        # 判斷是否為 3 張連格照片組 (1+3+3+3)
        raw_images = payload.images if (payload.images and len(payload.images) > 0) else ([payload.imageBase64] if payload.imageBase64 else [])
        
        for idx, img_b64 in enumerate(raw_images):
            if not img_b64:
                continue
            img_str = re.sub(r"^data:image/.+;base64,", "", img_b64)
            img_bytes = base64.b64decode(img_str)
            fn = f"{report_id}_{idx+1}.jpg" if len(raw_images) > 1 else f"{report_id}.jpg"
            fp = os.path.join(REPORTS_DIR, fn)
            with open(fp, "wb") as f:
                f.write(img_bytes)
            filenames.append(fn)

        report_data = {
            "report_id": report_id,
            "filename": filenames[0] if filenames else "",
            "filenames": filenames,
            "score": payload.score,
            "similarity": payload.similarity or 87,
            "spine": payload.spineAngle or int(payload.p1Spine or 32),
            "turn": payload.shoulderTurn or int(payload.p4Turn or 89),
            "p1Spine": payload.p1Spine or 32.0,
            "p4Turn": payload.p4Turn or 88.0,
            "p6Lag": payload.p6Lag or 34.0,
            "p7Ext": payload.p7Ext or 5.5,
            "p10Bal": payload.p10Bal or "94%",
            "diffs": payload.diffs or {},
            "stageAdvice": payload.stageAdvice or [],
            "advice": payload.stageAdvice or payload.summaryAdvice or [],
            "created_at": time.time()
        }

        user_id = payload.userId.strip() if payload.userId else ""
        if user_id:
            user_reports[user_id] = report_data
        
        latest_global_report = report_data

        # 定期清理舊圖片 (保留最新的 40 張)
        cleanup_old_reports()

        image_urls = [f"{latest_server_host}/static/reports/{fn}" for fn in filenames]
        print(f"✅ 成功儲存 Tiger 對比骨架組 ({len(filenames)}張): {image_urls} (使用者: {user_id or '匿名'})")
        return {
            "status": "ok",
            "reportId": report_id,
            "imageUrl": image_urls[0] if image_urls else "",
            "imageUrls": image_urls
        }

    except Exception as e:
        print(f"❌ 儲存骨架報告失敗: {e}")
        raise HTTPException(status_code=500, detail=str(e))

def cleanup_old_reports():
    """自動清理超過 40 張的舊報告照片，節省硬碟空間"""
    try:
        files = [os.path.join(REPORTS_DIR, f) for f in os.listdir(REPORTS_DIR) if f.endswith(".jpg")]
        if len(files) > 40:
            files.sort(key=os.path.getmtime)
            for old_file in files[:-30]:
                try:
                    os.remove(old_file)
                except Exception:
                    pass
    except Exception as e:
        print("清理暫存報告異常:", e)

def build_entry_card() -> dict:
    """建立揮桿分析儀入口卡片"""
    return {
        "type": "bubble",
        "size": "mega",
        "hero": {
            "type": "box",
            "layout": "vertical",
            "contents": [
                {
                    "type": "text",
                    "text": "🏌️ GOLF SWING AI",
                    "weight": "bold",
                    "size": "xl",
                    "color": "#111111"
                },
                {
                    "type": "text",
                    "text": "Tiger Woods 職業標準 P1~P10 揮桿對比分析",
                    "size": "xs",
                    "color": "#6B7280",
                    "margin": "xs"
                }
            ],
            "backgroundColor": "#F4F5F7",
            "paddingAll": "20px"
        },
        "body": {
            "type": "box",
            "layout": "vertical",
            "contents": [
                {
                    "type": "text",
                    "text": "自動對齊 Tiger 十階段揮桿動作",
                    "weight": "bold",
                    "size": "md",
                    "color": "#111111"
                },
                {
                    "type": "text",
                    "text": "即時診斷起桿、頂點蓄力、下桿延遲與擊球釋放差值，給予專屬改善處方！",
                    "size": "xs",
                    "color": "#4B5563",
                    "wrap": True,
                    "margin": "sm"
                }
            ],
            "backgroundColor": "#FFFFFF",
            "paddingAll": "16px"
        },
        "footer": {
            "type": "box",
            "layout": "vertical",
            "contents": [
                {
                    "type": "button",
                    "style": "primary",
                    "color": "#18181B",
                    "action": {
                        "type": "uri",
                        "label": "🚀 打開分析儀",
                        "uri": get_app_url()
                    }
                }
            ],
            "backgroundColor": "#FFFFFF",
            "paddingAll": "16px"
        }
    }

def build_diagnosis_card(
    score: int = 88,
    similarity: int = 87,
    spine: int = 32,
    turn: int = 89,
    diffs: dict = None,
    advice: list = None
) -> dict:
    """生成 100% 免費的 Reply Tiger 職業標準揮桿診斷處方箋 (簡潔白底黑字卡片)"""
    grade = "Tour Pro 級" if score >= 90 else ("Semi-Pro 級" if score >= 85 else "業餘進階級")
    diffs = diffs or {}
    
    # 差值字串處理
    spine_diff_val = diffs.get("spineDiff", 0)
    turn_diff_val = diffs.get("turnDiff", 0)
    spine_diff_str = f" (差 {spine_diff_val:+d}°)" if spine_diff_val != 0 else " (完美)"
    turn_diff_str = f" (差 {turn_diff_val:+d}°)" if turn_diff_val != 0 else " (完美)"
    
    # 改善建議
    if advice and len(advice) > 0:
        advice_contents = []
        for adv in advice:
            advice_contents.append({
                "type": "text",
                "text": str(adv),
                "size": "xxs",
                "color": "#374151",
                "wrap": True,
                "margin": "xs"
            })
    else:
        advice_contents = [{
            "type": "text",
            "text": "1. 保持下桿時頭部穩定，維持下桿延遲釋放 (Lag)。\n2. 擊球瞬間保持左臂延展，釋放桿頭速度更具穿透力！",
            "size": "xxs",
            "color": "#374151",
            "wrap": True,
            "margin": "xs"
        }]

    return {
        "type": "bubble",
        "size": "mega",
        "body": {
            "type": "box",
            "layout": "vertical",
            "backgroundColor": "#FFFFFF",
            "paddingAll": "20px",
            "contents": [
                {
                    "type": "box",
                    "layout": "horizontal",
                    "contents": [
                        {
                            "type": "text",
                            "text": f"⛳ 動作評定：{grade}",
                            "weight": "bold",
                            "size": "md",
                            "color": "#111111",
                            "flex": 7
                        },
                        {
                            "type": "text",
                            "text": f"{score}分",
                            "weight": "bold",
                            "size": "lg",
                            "color": "#111111",
                            "align": "end",
                            "flex": 3
                        }
                    ]
                },
                {
                    "type": "text",
                    "text": f"🐅 Tiger 職業標準相似度：{similarity}%",
                    "size": "xs",
                    "color": "#4B5563",
                    "weight": "bold",
                    "margin": "xs"
                },
                {"type": "separator", "margin": "md", "color": "#E5E7EB"},
                {
                    "type": "box",
                    "layout": "vertical",
                    "margin": "md",
                    "spacing": "sm",
                    "contents": [
                        {
                            "type": "box",
                            "layout": "baseline",
                            "contents": [
                                {"type": "text", "text": "• P1~P3 上揚", "color": "#4B5563", "size": "xs", "flex": 4},
                                {"type": "text", "text": f"脊椎 {spine}°{spine_diff_str}", "color": "#111111", "size": "xs", "weight": "bold", "flex": 6}
                            ]
                        },
                        {
                            "type": "box",
                            "layout": "baseline",
                            "contents": [
                                {"type": "text", "text": "• P4~P7 擊球", "color": "#4B5563", "size": "xs", "flex": 4},
                                {"type": "text", "text": f"轉身 {turn}°{turn_diff_str}", "color": "#111111", "size": "xs", "weight": "bold", "flex": 6}
                            ]
                        },
                        {
                            "type": "box",
                            "layout": "baseline",
                            "contents": [
                                {"type": "text", "text": "• P8~P10 送出", "color": "#4B5563", "size": "xs", "flex": 4},
                                {"type": "text", "text": "核心完全釋放・平衡收桿", "color": "#059669", "size": "xs", "weight": "bold", "flex": 6}
                            ]
                        }
                    ]
                },
                {"type": "separator", "margin": "md", "color": "#E5E7EB"},
                {
                    "type": "text",
                    "text": "💡 Tiger 對比改進處方：",
                    "weight": "bold",
                    "size": "xs",
                    "color": "#111111",
                    "margin": "sm"
                },
                {
                    "type": "box",
                    "layout": "vertical",
                    "contents": advice_contents
                }
            ]
        },
        "footer": {
            "type": "box",
            "layout": "vertical",
            "backgroundColor": "#FFFFFF",
            "paddingAll": "16px",
            "contents": [
                {
                    "type": "button",
                    "style": "primary",
                    "color": "#2D3748",
                    "action": {
                        "type": "uri",
                        "label": "🏌️ 再次揮桿分析",
                        "uri": get_app_url()
                    }
                }
            ]
        }
    }

@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)

@app.get("/")
def index():
    """首頁自動轉跳至 PWA 揮桿分析儀"""
    return RedirectResponse(url="/static/index.html")

@app.post("/callback")
async def callback(request: Request):
    global latest_server_host
    base_url = SERVER_BASE_URL or str(request.base_url).rstrip("/")
    if base_url.startswith("http://"):
        base_url = base_url.replace("http://", "https://")
    latest_server_host = base_url

    signature = request.headers.get("x-line-signature") or request.headers.get("X-Line-Signature", "")
    body = await request.body()
    body_str = body.decode("utf-8")

    if not signature:
        print("❌ 缺少 X-Line-Signature Header")
        raise HTTPException(status_code=400, detail="Missing X-Line-Signature header")

    try:
        handler.handle(body_str, signature)
    except InvalidSignatureError:
        print("❌ 簽章驗證失敗 (Invalid Signature)")
        raise HTTPException(status_code=400, detail="Invalid signature")

    return "OK"

# 處理文字訊息
@handler.add(MessageEvent, message=TextMessageContent)
def handle_text(event: MessageEvent):
    user_text = event.message.text.strip()
    user_id = getattr(event.source, "user_id", "") or ""
    normalized_text = user_text.lower()
    
    # 1. 判斷是否為使用者回覆「查看本次揮桿診斷報告」
    if "查看本次揮桿診斷報告" in user_text:
        # 尋找此使用者最近上傳的分析報告 (或全域最新報告)
        report = user_reports.get(user_id) or latest_global_report
        
        reply_messages = []
        
        if report and (report.get("filenames") or report.get("filename")):
            score = report.get("score", 88)
            similarity = report.get("similarity", 87)
            spine = report.get("spine", 32)
            turn = report.get("turn", 89)
            advice = report.get("advice", [])
            filenames = report.get("filenames") or ([report.get("filename")] if report.get("filename") else [])
            
            # 組成 HTTPS 圖片網址
            base_url = SERVER_BASE_URL or latest_server_host or "https://golf-assistant.onrender.com"
            
            # 1. 揮桿診斷處方箋 Flex Card (置頂診斷書)
            diffs = report.get("diffs", {})
            flex_json = build_diagnosis_card(score=score, similarity=similarity, spine=spine, turn=turn, diffs=diffs, advice=advice)
            reply_messages.append(
                FlexMessage(
                    alt_text="⛳ 您的專屬 Tiger 職業標準揮桿診斷處方箋已出爐！",
                    contents=FlexContainer.from_json(json.dumps(flex_json))
                )
            )

            # 2. 1+3+3+3 骨架分析照片組 (依序發送 3 組 3 連格照片)
            for fn in filenames:
                img_url = f"{base_url.rstrip('/')}/static/reports/{fn}"
                reply_messages.append(
                    ImageMessage(
                        original_content_url=img_url,
                        preview_image_url=img_url
                    )
                )
        else:
            # 若無先前分析記錄，發送預設處方箋
            flex_json = build_diagnosis_card()
            reply_messages.append(
                FlexMessage(
                    alt_text="⛳ 您的專屬高爾夫揮桿診斷處方箋已出爐！",
                    contents=FlexContainer.from_json(json.dumps(flex_json))
                )
            )

    # 2. 喚醒與伺服器狀態查詢：Hi! Wake up!
    elif "wake up" in normalized_text or "wake" in normalized_text:
        reply_messages = [
            TextMessage(text="Hi! 現在可以點Let’s Analyze來嘗試功能！")
        ]

    # 3. 彩蛋關鍵字：Amba
    elif normalized_text == "amba":
        reply_messages = [
            TextMessage(text="oh..Shit...")
        ]

    # 4. 其餘輸入統一回覆
    else:
        reply_messages = [
            TextMessage(text="可以嘗試Let’s Analyze進行高爾夫球姿勢影片分析哦")
        ]

    with ApiClient(configuration) as api_client:
        msg_api = MessagingApi(api_client)
        msg_api.reply_message(
            ReplyMessageRequest(
                reply_token=event.reply_token,
                messages=reply_messages
            )
        )

# 處理影片訊息：若使用者直接傳送影片，引導至 PWA 獲得最流暢的晶片即時體驗
@handler.add(MessageEvent, message=VideoMessageContent)
def handle_video(event: MessageEvent):
    flex_json = build_entry_card()
    with ApiClient(configuration) as api_client:
        msg_api = MessagingApi(api_client)
        msg_api.reply_message(
            ReplyMessageRequest(
                reply_token=event.reply_token,
                messages=[
                    FlexMessage(
                        alt_text="🏌️ 請點擊按鈕開啟分析儀選取影片！",
                        contents=FlexContainer.from_json(json.dumps(flex_json))
                    )
                ]
            )
        )