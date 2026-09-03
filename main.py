import os
import uuid
import threading
from fastapi import FastAPI, Request, Header, HTTPException
from fastapi.staticfiles import StaticFiles

from linebot.v3 import WebhookHandler
from linebot.v3.exceptions import InvalidSignatureError
from linebot.v3.messaging import (
    Configuration, ApiClient, MessagingApi, MessagingApiBlob,
    PushMessageRequest, ReplyMessageRequest, TextMessage, ImageMessage,
    ShowLoadingAnimationRequest
)
from linebot.v3.webhooks import MessageEvent, TextMessageContent, VideoMessageContent

from analyzer import analyze_golf_swing

app = FastAPI()

# 靜態目錄：產生的分析結果圖放這裡，供 LINE 下載
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

# 從環境變數讀取金鑰與公開網址
CHANNEL_SECRET = os.getenv("CHANNEL_SECRET", "")
CHANNEL_ACCESS_TOKEN = os.getenv("CHANNEL_ACCESS_TOKEN", "")
SERVER_BASE_URL = os.getenv("SERVER_BASE_URL", "") # Render 的公開網址 (例如 https://xxx.onrender.com)

configuration = Configuration(access_token=CHANNEL_ACCESS_TOKEN)
handler = WebhookHandler(CHANNEL_SECRET)

@app.get("/")
def index():
    return {"status": "Golf Swing Analyzer is running!"}

@app.post("/callback")
async def callback(request: Request, x_line_signature: str = Header(None)):
    body = await request.body()
    try:
        handler.handle(body.decode("utf-8"), x_line_signature)
    except InvalidSignatureError:
        raise HTTPException(status_code=400, detail="Invalid signature")
    return "OK"

def process_video_task(message_id: str, user_id: str):
    raw_video = f"temp_{message_id}.mp4"
    img_filename = f"{uuid.uuid4().hex[:8]}.jpg"
    out_image_path = os.path.join("static", img_filename)

    with ApiClient(configuration) as api_client:
        blob_api = MessagingApiBlob(api_client)
        msg_api = MessagingApi(api_client)

        try:
            # 1. 顯示轉圈思考動畫
            msg_api.show_loading_animation(
                ShowLoadingAnimationRequest(chatId=user_id, loadingSeconds=30)
            )

            # 2. 下載影片檔案
            video_bytes = blob_api.get_message_content(message_id)
            with open(raw_video, "wb") as f:
                f.write(video_bytes)

            # 3. 呼叫骨架分析
            res = analyze_golf_swing(raw_video, out_image_path)

            if res.get("success"):
                public_img_url = f"{SERVER_BASE_URL.rstrip('/')}/static/{img_filename}"
                report = (
                    f"⛳ 揮桿骨架分析完成！\n"
                    f"━━━━━━━━━━━━\n"
                    f"• 總分析影格：{res['total_frames']} 幀\n"
                    f"• P1 預備站姿：第 {res['p1']} 幀\n"
                    f"• P4 上桿頂點：第 {res['p4']} 幀\n"
                    f"• P7 擊球瞬間：第 {res['p7']} 幀\n"
                    f"━━━━━━━━━━━━\n"
                    f"已為您標註 P1/P4/P7 骨架對比圖如下："
                )
                
                # 4. 回傳文字與圖片
                msg_api.push_message(
                    PushMessageRequest(
                        to=user_id,
                        messages=[
                            TextMessage(text=report),
                            ImageMessage(
                                originalContentUrl=public_img_url,
                                previewImageUrl=public_img_url
                            )
                        ]
                    )
                )
            else:
                msg_api.push_message(
                    PushMessageRequest(
                        to=user_id,
                        messages=[TextMessage(text=f"分析失敗：{res.get('error', '未知錯誤')}")]
                    )
                )

        except Exception as e:
            print(f"處理出錯: {e}")
        finally:
            if os.path.exists(raw_video):
                os.remove(raw_video)

# 處理文字訊息 (傳 hi 就會回覆)
@handler.add(MessageEvent, message=TextMessageContent)
def handle_text(event: MessageEvent):
    with ApiClient(configuration) as api_client:
        msg_api = MessagingApi(api_client)
        msg_api.reply_message(
            ReplyMessageRequest(
                reply_token=event.reply_token,
                messages=[
                    TextMessage(
                        text="你好！請直接傳送一段 3~5 秒的揮桿影片，我會為你擷取 P1/P4/P7 關鍵姿勢並標註骨架！"
                    )
                ]
            )
        )

# 處理影片訊息 (使用背景 Thread 避免 LINE Webhook 連線逾時)
@handler.add(MessageEvent, message=VideoMessageContent)
def handle_video(event: MessageEvent):
    user_id = event.source.user_id
    message_id = event.message.id
    # 在背景 thread 執行耗時的 MediaPipe 影像分析
    threading.Thread(target=process_video_task, args=(message_id, user_id), daemon=True).start()