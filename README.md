# WatchTogether — local MVP

A private browser watch-party MVP supporting 1–10 guests plus the host. The host creates a room and shares an invite link. Participants can use voice/video chat, room chat, and the host can share a movie or video from the host device.

## Requirements

- Node.js 18 or newer
- A modern browser such as Chrome, Edge, or Firefox
- A local network if testing with another device

## Run locally

```powershell
cd D:\Strawberry\watch_party_mvp
npm install
npm start
```

Open **http://localhost:8080**.

To test the page with a phone or another computer on the same Wi-Fi, find the computer's local IPv4 address and open `http://YOUR-IP:8080` on the other device. The host and guests must use the same server address. Browser camera/microphone/screen permissions generally require `localhost` or HTTPS; for reliable phone testing, deploy behind HTTPS. Mobile browsers may not support screen sharing as a host.

## Test flow

1. Open the app in one browser window, choose 1–10 guests using the toggle buttons, and create a room.
2. A five-second branded intro animation plays before entering the room.
3. Copy the invite link, or note the six-character room code. The server enforces the selected guest limit.
4. Open a second private/incognito window and join the room with another name. A full-room disclaimer appears if the guest capacity has been reached.
5. Allow microphone/camera permissions and test the Mic and Camera controls.
6. For synchronized playback, paste a direct `.mp4` or `.webm` video URL into the host's “Watch in sync” panel and choose Load URL. The host's play, pause, and seek actions are sent to everyone.
7. Or choose **Choose video file** and select an MP4, WebM, OGG, or MKV file from the host computer. The local server temporarily uploads it and shares it with the room.
8. For any movie or video already open on the host device, choose Share screen instead.
9. Use headphones during testing to reduce echo.

## Deploy: Netlify frontend + Render backend

The current app needs a persistent WebSocket server, so deploy the two parts separately:

1. Put this project in a GitHub repository. Do not commit `.env`, `uploads/`, or credentials.
2. In Render, create a new Web Service from the repository. Render can use the included `render.yaml`; use Node runtime, `npm ci --omit=dev` as the build command, and `npm start` as the start command.
3. Copy the Render service URL, such as `https://watchtogether-backend.onrender.com`.
4. Edit `public/config.js` and set `window.WATCHTOGETHER_BACKEND_URL` to that Render URL.
5. In Netlify, import the same repository. The included `netlify.toml` publishes the `public` folder.
6. After Netlify provides the site URL, set Render's `FRONTEND_ORIGIN` environment variable to that exact Netlify URL and redeploy the backend.
7. Open the Netlify HTTPS URL and test room creation, guest joining, uploads, chat, and media permissions.

The Render service keeps rooms in memory, and uploaded videos are temporary. A restart or service sleep can remove active rooms and uploaded files. For production video persistence, use object storage rather than the local `uploads/` directory. A TURN service may also be needed for WebRTC on restrictive networks.

## MVP limitations

- Rooms are held in memory and disappear when the server stops or everyone leaves.
- No registration, database, recording, or persistent room history yet.
- Synchronized playback accepts direct HTTP/HTTPS video URLs such as MP4/WebM, or a local MP4/WebM/OGG/MKV file up to 5 GB. Uploaded files are temporary, large uploads show a live percentage/progress bar, and files are removed when the room closes.
- MKV upload is supported, but browser playback depends on the MKV container and codec. If the browser cannot decode it, use MP4/WebM, convert the file, or use screen sharing.
- It does not control a separate streaming-service window; use screen sharing for that.
- The host controls synchronized playback; guests can watch and use voice/video/chat.
- WebRTC uses a public Google STUN server for peer discovery. For some networks, a production TURN server will be needed.
- Screen sharing is intended for content the host is legally allowed to share. Browser/streaming-service DRM policies may prevent capture.
- For local development, camera/microphone/screen permissions work on `localhost`. For a deployed version, HTTPS is required.
