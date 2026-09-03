import os
import time
from analyzer import analyze_golf_swing

def main():
    video_file = "test_swing.mp4"
    output_image = "test_result.jpg"
    
    if not os.path.exists(video_file):
        print(f"❌ 找不到測試影片：{video_file}，請放一支影片到目錄下再試！")
        return

    print("🚀 開始進行本地骨架分析...")
    start_time = time.time()
    
    # 直接呼叫你的核心分析函式
    result = analyze_golf_swing(video_file, output_image)
    
    elapsed = time.time() - start_time
    print(f"⏱️ 分析耗時：{elapsed:.2f} 秒\n")

    if result["success"]:
        print("✅ 分析成功！")
        print(f"• 總分析影格數：{result['total_frames']}")
        print(f"• P1 預備站姿 (Address)  ：第 {result['p1']} 幀")
        print(f"• P4 上桿頂點 (Top)      ：第 {result['p4']} 幀")
        print(f"• P7 擊球瞬間 (Impact)   ：第 {result['p7']} 幀")
        print(f"🖼️ 結果圖片已輸出至：{os.path.abspath(output_image)}")
        print("👉 請直接點開 test_result.jpg 查看骨架線與三個關鍵姿勢是否準確！")
    else:
        print(f"❌ 分析失敗，原因：{result.get('error')}")

if __name__ == "__main__":
    main()