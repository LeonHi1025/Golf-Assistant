import os
import re
import json
import time
import base64
import uuid
from typing import Dict, Any, Optional
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from linebot.v3 import WebhookHandler
from linebot.v3.exceptions import InvalidSignatureError
from linebot.v3.messaging import (
    Configuration, ApiClient, MessagingApi,
    ReplyMessageRequest, FlexMessage, FlexContainer, ImageMessage
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
    spineAngle: int = 32
    shoulderTurn: int = 89
    imageBase64: str

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
    """接收前端 Edge AI 產生的 3 影格骨架合成照片與動作指標"""
    global latest_global_report, latest_server_host
    
    # 紀錄最新伺服器網址供 LINE 圖片下載
    base_url = SERVER_BASE_URL or str(request.base_url).rstrip("/")
    if base_url.startswith("http://"):
        base_url = base_url.replace("http://", "https://")
    latest_server_host = base_url

    try:
        # 解碼 Base64 圖片
        img_str = re.sub(r"^data:image/.+;base64,", "", payload.imageBase64)
        img_bytes = base64.b64decode(img_str)
        
        report_id = f"report_{int(time.time())}_{uuid.uuid4().hex[:6]}"
        filename = f"{report_id}.jpg"
        filepath = os.path.join(REPORTS_DIR, filename)

        with open(filepath, "wb") as f:
            f.write(img_bytes)

        report_data = {
            "report_id": report_id,
            "filename": filename,
            "score": payload.score,
            "spine": payload.spineAngle,
            "turn": payload.shoulderTurn,
            "created_at": time.time()
        }

        user_id = payload.userId.strip() if payload.userId else ""
        if user_id:
            user_reports[user_id] = report_data
        
        latest_global_report = report_data

        # 定期清理舊圖片 (保留最新的 40 張)
        cleanup_old_reports()

        img_url = f"{latest_server_host}/static/reports/{filename}"
        print(f"✅ 成功儲存骨架分析照片: {img_url} (使用者: {user_id or '匿名'})")
        return {"status": "ok", "reportId": report_id, "imageUrl": img_url}

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
                    "color": "#00E676"
                },
                {
                    "type": "text",
                    "text": "手機邊緣晶片即時運算・零等待 0% 伺服器負載",
                    "size": "xs",
                    "color": "#81C784",
                    "margin": "xs"
                }
            ],
            "backgroundColor": "#0d1f18",
            "paddingAll": "20px"
        },
        "body": {
            "type": "box",
            "layout": "vertical",
            "contents": [
                {
                    "type": "text",
                    "text": "智慧分析 P1 / P4 / P7 關鍵動作",
                    "weight": "bold",
                    "size": "md",
                    "color": "#FFFFFF"
                },
                {
                    "type": "text",
                    "text": "點擊下方按鈕開啟分析儀，選取 3 秒影片即可透過手機 GPU 在 2 秒內完成骨架擷取與動作評分！",
                    "size": "xs",
                    "color": "#B0BEC5",
                    "wrap": True,
                    "margin": "md"
                }
            ],
            "backgroundColor": "#132a21",
            "paddingAll": "20px"
        },
        "footer": {
            "type": "box",
            "layout": "vertical",
            "contents": [
                {
                    "type": "button",
                    "style": "primary",
                    "color": "#00E676",
                    "action": {
                        "type": "uri",
                        "label": "🚀 立即打開揮桿分析儀",
                        "uri": get_app_url()
                    }
                }
            ],
            "backgroundColor": "#0d1f18",
            "paddingAll": "16px"
        }
    }

from fastapi.responses import RedirectResponse, Response

def build_diagnosis_card(score: int = 88, spine: int = 32, turn: int = 89) -> dict:
    """生成 100% 免費的 Reply 專業教練診斷書 (純文字指標卡片)"""
    grade = "Tour Pro 級" if score >= 90 else ("Semi-Pro 級" if score >= 85 else "業餘進階級")

    return {
        "type": "bubble",
        "size": "mega",
        "body": {
            "type": "box",
            "layout": "vertical",
            "contents": [
                {
                    "type": "text",
                    "text": "⛳ 揮桿診斷處方箋",
                    "weight": "bold",
                    "size": "xl",
                    "color": "#FFD54F"
                },
                {
                    "type": "text",
                    "text": f"AI 教練動作評定：{grade} ({score}分)",
                    "size": "sm",
                    "color": "#00E676",
                    "weight": "bold",
                    "margin": "xs"
                },
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
                                {"type": "text", "text": "P1 準備站姿", "color": "#9E9E9E", "size": "sm", "flex": 3},
                                {"type": "text", "text": f"脊椎傾角 {spine}° (標準穩定)", "color": "#FFFFFF", "size": "sm", "weight": "bold", "flex": 5}
                            ]
                        },
                        {
                            "type": "box",
                            "layout": "baseline",
                            "contents": [
                                {"type": "text", "text": "P4 上桿頂點", "color": "#9E9E9E", "size": "sm", "flex": 3},
                                {"type": "text", "text": f"旋轉幅度 {turn}° (蓄力充足)", "color": "#FFFFFF", "size": "sm", "weight": "bold", "flex": 5}
                            ]
                        },
                        {
                            "type": "box",
                            "layout": "baseline",
                            "contents": [
                                {"type": "text", "text": "P7 擊球瞬間", "color": "#9E9E9E", "size": "sm", "flex": 3},
                                {"type": "text", "text": "核心完全釋放・加速流暢", "color": "#00E676", "size": "sm", "weight": "bold", "flex": 5}
                            ]
                        }
                    ]
                },
                {"type": "separator", "margin": "lg", "color": "#2E483D"},
                {
                    "type": "text",
                    "text": "💡 今日專屬教練建議：",
                    "weight": "bold",
                    "size": "sm",
                    "color": "#FFD54F",
                    "margin": "md"
                },
                {
                    "type": "text",
                    "text": "1. 保持下桿時頭部穩定，避免重心過早前移。\n2. 擊球瞬間保持左臂延展，釋放桿頭速度更具穿透力！",
                    "size": "xs",
                    "color": "#CFD8DC",
                    "wrap": True,
                    "margin": "xs"
                }
            ],
            "backgroundColor": "#132a21",
            "paddingAll": "20px"
        },
        "footer": {
            "type": "box",
            "layout": "vertical",
            "contents": [
                {
                    "type": "button",
                    "style": "primary",
                    "color": "#00E676",
                    "action": {
                        "type": "uri",
                        "label": "🏌️ 再次揮桿分析",
                        "uri": get_app_url()
                    }
                }
            ],
            "backgroundColor": "#0d1f18",
            "paddingAll": "16px"
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
    
    # 判斷是否為使用者回覆「查看本次揮桿診斷報告」
    if "查看本次揮桿診斷報告" in user_text:
        # 尋找此使用者最近上傳的分析報告 (或全域最新報告)
        report = user_reports.get(user_id) or latest_global_report
        
        reply_messages = []
        
        if report and report.get("filename"):
            score = report.get("score", 88)
            spine = report.get("spine", 32)
            turn = report.get("turn", 89)
            filename = report.get("filename")
            
            # 組成 HTTPS 圖片網址
            base_url = SERVER_BASE_URL or latest_server_host or "https://golf-assistant.onrender.com"
            img_url = f"{base_url.rstrip('/')}/static/reports/{filename}"
            
            # 1. 骨架分析照片 (發送一次獨立大圖)
            reply_messages.append(
                ImageMessage(
                    original_content_url=img_url,
                    preview_image_url=img_url
                )
            )
            
            # 2. 揮桿診斷處方箋 Flex Card (純文字與指標)
            flex_json = build_diagnosis_card(score=score, spine=spine, turn=turn)
            reply_messages.append(
                FlexMessage(
                    alt_text="⛳ 您的專屬高爾夫揮桿診斷處方箋已出爐！",
                    contents=FlexContainer.from_json(json.dumps(flex_json))
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

    else:
        # 一般文字訊息，引導使用者開啟分析儀
        flex_json = build_entry_card()
        reply_messages = [
            FlexMessage(
                alt_text="🏌️ 高爾夫 AI 揮桿分析儀已就緒，請點擊打開！",
                contents=FlexContainer.from_json(json.dumps(flex_json))
            )
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