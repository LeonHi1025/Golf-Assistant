import os
import json
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from linebot.v3 import WebhookHandler
from linebot.v3.exceptions import InvalidSignatureError
from linebot.v3.messaging import (
    Configuration, ApiClient, MessagingApi,
    ReplyMessageRequest, FlexMessage, FlexContainer
)
from linebot.v3.webhooks import MessageEvent, TextMessageContent, VideoMessageContent

app = FastAPI(title="Golf Swing AI Assistant (Edge PWA)")

# 靜態檔案服務 (包含 PWA 網頁、Service Worker 與圖標)
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

# 從環境變數讀取金鑰與網址設定
CHANNEL_SECRET = os.getenv("CHANNEL_SECRET", "")
CHANNEL_ACCESS_TOKEN = os.getenv("CHANNEL_ACCESS_TOKEN", "")
SERVER_BASE_URL = os.getenv("SERVER_BASE_URL", "")
LIFF_ID = os.getenv("LIFF_ID", "")

configuration = Configuration(access_token=CHANNEL_ACCESS_TOKEN)
handler = WebhookHandler(CHANNEL_SECRET)

def get_app_url() -> str:
    """取得 PWA / LIFF 網頁專屬連結"""
    if LIFF_ID:
        return f"https://liff.line.me/{LIFF_ID}"
    if SERVER_BASE_URL:
        return f"{SERVER_BASE_URL.rstrip('/')}/static/index.html"
    return "/static/index.html"

def build_flex_card() -> dict:
    """建立高質感 LINE Flex Message 導流卡片"""
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
                    "text": "手機邊緣晶片即時運算・零等待",
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

@app.get("/")
def index():
    """首頁自動轉跳至 PWA 揮桿分析儀"""
    return RedirectResponse(url="/static/index.html")

@app.post("/callback")
async def callback(request: Request):
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
        print(f"當前 CHANNEL_SECRET: '{CHANNEL_SECRET}'")
        raise HTTPException(status_code=400, detail="Invalid signature")

    return "OK"

# 處理文字訊息：傳送任何文字皆回傳分析儀卡片
@handler.add(MessageEvent, message=TextMessageContent)
def handle_text(event: MessageEvent):
    flex_json = build_flex_card()
    with ApiClient(configuration) as api_client:
        msg_api = MessagingApi(api_client)
        msg_api.reply_message(
            ReplyMessageRequest(
                reply_token=event.reply_token,
                messages=[
                    FlexMessage(
                        alt_text="🏌️ 高爾夫 AI 揮桿分析儀已就緒，請點擊打開！",
                        contents=FlexContainer.from_json(json.dumps(flex_json))
                    )
                ]
            )
        )

# 處理影片訊息：若使用者直接傳送影片，引導至 PWA 獲得最流暢的晶片即時體驗
@handler.add(MessageEvent, message=VideoMessageContent)
def handle_video(event: MessageEvent):
    flex_json = build_flex_card()
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