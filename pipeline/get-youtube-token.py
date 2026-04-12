#!/usr/bin/env python3
"""
Get YouTube refresh token for คุฏบะฮ์แปลไทย channel
Uses Web OAuth flow via localhost:4007 (already registered in Google Cloud Console)
"""

import http.server, urllib.parse, json, urllib.request, threading, webbrowser

import os
_env = {l.split("=",1)[0]: l.split("=",1)[1].strip() for l in open(os.path.expanduser("~/.env")) if "=" in l}
CLIENT_ID = _env.get("YOUTUBE_CLIENT_ID", "")
CLIENT_SECRET = _env.get("YOUTUBE_CLIENT_SECRET", "")
REDIRECT = "http://localhost:4007/integrations/social/youtube"
SCOPE = "https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.upload"

auth_code = [None]

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        query = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(query)
        if "code" in params:
            auth_code[0] = params["code"][0]
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"<h1>Done! Close this tab.</h1>")
        else:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"No code")
    def log_message(self, *args): pass

server = http.server.HTTPServer(("localhost", 4007), Handler)
thread = threading.Thread(target=server.handle_request)
thread.start()

url = (f"https://accounts.google.com/o/oauth2/v2/auth?"
       f"client_id={CLIENT_ID}&redirect_uri={REDIRECT}"
       f"&response_type=code&scope={urllib.parse.quote(SCOPE)}"
       f"&access_type=offline&prompt=consent")

print("Opening browser...")
print(">>> SELECT the Google account that owns คุฏบะฮ์แปลไทย YouTube channel <<<")
webbrowser.open(url)

thread.join(timeout=300)
server.server_close()

if auth_code[0]:
    data = urllib.parse.urlencode({
        "code": auth_code[0],
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "redirect_uri": REDIRECT,
        "grant_type": "authorization_code",
    }).encode()
    resp = urllib.request.urlopen(
        urllib.request.Request("https://oauth2.googleapis.com/token", data=data))
    tokens = json.loads(resp.read())
    print(f"\n✅ refresh_token: {tokens['refresh_token']}")
    print("\nAdd this to config.yaml under publish:")
    print(f'  youtube_refresh_token: "{tokens["refresh_token"]}"')
else:
    print("Timeout — no auth code received")
