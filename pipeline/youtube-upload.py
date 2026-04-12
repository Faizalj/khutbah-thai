#!/usr/bin/env python3
"""
Upload video to YouTube — uses refresh token (no OAuth browser flow needed)
Usage: python3 pipeline/youtube-upload.py <video_path> <title> <description> <tags_comma_separated>
"""

import json, sys, os
from pathlib import Path
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from google.oauth2.credentials import Credentials
import yaml

ROOT = Path(__file__).parent.parent
CONFIG = yaml.safe_load((ROOT / "config.yaml").read_text())

def _read_env():
    env = {}
    with open(os.path.expanduser("~/.env")) as f:
        for line in f:
            if "=" in line:
                k, v = line.strip().split("=", 1)
                env[k] = v
    return env

def get_youtube():
    env = _read_env()
    creds = Credentials(
        token=None,
        refresh_token=env["YOUTUBE_REFRESH_TOKEN"],
        client_id=env["YOUTUBE_CLIENT_ID"],
        client_secret=env["YOUTUBE_CLIENT_SECRET"],
        token_uri="https://oauth2.googleapis.com/token",
    )
    return build("youtube", "v3", credentials=creds)

def upload(video_path, title, description, tags):
    yt = get_youtube()

    body = {
        "snippet": {
            "title": title[:100],
            "description": description,
            "tags": tags,
            "categoryId": "27",
            "defaultLanguage": "th",
            "defaultAudioLanguage": "th",
        },
        "status": {
            "privacyStatus": "public",
            "selfDeclaredMadeForKids": False,
        },
    }

    media = MediaFileUpload(video_path, mimetype="video/mp4", resumable=True)
    request = yt.videos().insert(part="snippet,status", body=body, media_body=media)

    print("Uploading...", flush=True)
    response = None
    while response is None:
        status, response = request.next_chunk()
        if status:
            print(f"  {int(status.progress() * 100)}%", flush=True)

    vid = response["id"]
    print(f"VIDEO_ID={vid}")
    return vid

if __name__ == "__main__":
    if len(sys.argv) < 5:
        print("Usage: python3 youtube-upload.py <video> <title> <description> <tags>")
        sys.exit(1)

    upload(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split(","))
