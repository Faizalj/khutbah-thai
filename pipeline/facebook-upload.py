#!/usr/bin/env python3
"""
Upload video to Facebook Page — resumable upload with retry
Usage: python3 facebook-upload.py <video_path> <title> <description>
"""

import json, os, sys, time, urllib.request, urllib.parse, io
from pathlib import Path

ROOT = Path(__file__).parent.parent

def get_config():
    config = ROOT / ".fb-config.json"
    if config.exists():
        return json.load(open(config))
    raise Exception("No .fb-config.json")

def upload_video(video_path, title, description):
    config = get_config()
    PAGE_ID = config["page_id"]
    TOKEN = config["page_token"]
    file_size = os.path.getsize(video_path)
    chunk_size = 20 * 1024 * 1024  # 20MB chunks

    # Init
    init_data = urllib.parse.urlencode({
        "upload_phase": "start",
        "file_size": str(file_size),
        "access_token": TOKEN,
    }).encode()
    resp = urllib.request.urlopen(urllib.request.Request(
        f"https://graph.facebook.com/v21.0/{PAGE_ID}/videos", data=init_data))
    result = json.loads(resp.read())
    session_id = result["upload_session_id"]
    video_id = result["video_id"]
    print(f"  Init: {video_id} ({file_size // 1024 // 1024}MB)")

    # Upload chunks with retry
    with open(video_path, "rb") as f:
        offset = 0
        while offset < file_size:
            chunk = f.read(chunk_size)
            for attempt in range(3):
                try:
                    boundary = f"----FB{int(time.time())}{attempt}"
                    body = io.BytesIO()
                    for k, v in [("upload_phase", "transfer"), ("upload_session_id", session_id),
                                 ("start_offset", str(offset)), ("access_token", TOKEN)]:
                        body.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
                    body.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"video_file_chunk\"; filename=\"v.mp4\"\r\nContent-Type: video/mp4\r\n\r\n".encode())
                    body.write(chunk)
                    body.write(f"\r\n--{boundary}--\r\n".encode())
                    req = urllib.request.Request(
                        f"https://graph.facebook.com/v21.0/{PAGE_ID}/videos",
                        data=body.getvalue(),
                        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
                    urllib.request.urlopen(req, timeout=120)
                    break
                except Exception as e:
                    if attempt < 2:
                        print(f"  Retry {attempt+1}...")
                        time.sleep(3)
                    else:
                        raise
            offset += len(chunk)
            print(f"  {offset * 100 // file_size}%")

    # Finish
    boundary = f"----FBFinish{int(time.time())}"
    body = io.BytesIO()
    for k, v in [("upload_phase", "finish"), ("upload_session_id", session_id),
                 ("title", title), ("description", description), ("access_token", TOKEN)]:
        body.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode("utf-8"))
    body.write(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(
        f"https://graph-video.facebook.com/v21.0/{PAGE_ID}/videos",
        data=body.getvalue(),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    resp = urllib.request.urlopen(req, timeout=60)
    print(f"  ✅ Published: {video_id}")
    return video_id

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python3 facebook-upload.py <video> <title> <description>")
        sys.exit(1)
    upload_video(sys.argv[1], sys.argv[2], sys.argv[3])
