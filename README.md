# Church Audio RTMP Server

Lightweight RTMP ingest service for TLCC audio-only live services. It accepts the encoder stream, pulls the audio with FFmpeg, writes a rolling HLS playlist, and exposes simple health/status endpoints.

## Endpoints

- RTMP ingest: `rtmp://stream.church.org/live`
- Stream key: `church`
- HLS playback: `https://stream.church.org/live.m3u8`
- Health: `GET /health`
- Basic status: `GET /api/status`
- Detailed status: `GET /api/live`
- Listener counts: `GET /api/listeners` → `{ live, startedAt, current, total }`

## Listener counts

Every fetch of `live.m3u8` during a broadcast marks that listener as active. HLS players refetch the playlist every few seconds, so `current` is the number of distinct listeners seen in the last 20 seconds. `total` is the number of distinct listeners since the broadcast started, and it resets when a new broadcast starts. Listeners are identified by the `lid` query parameter (the website player sends a per-device id), or by IP + user agent for other players such as VLC. Counts are kept in memory, so restarting the server resets them.

Behind Nginx/Cloudflare, `TRUST_PROXY` (default `true`) makes the server use `X-Forwarded-For` for the client IP. It takes Express `trust proxy` values (`true`, `false`, a hop count, or `loopback`).

## Environment

Copy `.env.example` to `.env` and adjust for the VPS.

```bash
RTMP_PORT=1935
HTTP_PORT=3000
STREAM_KEY=church
RTMP_APP=live
HLS_OUTPUT_DIR=./public
FFMPEG_PATH=/usr/bin/ffmpeg
PUBLIC_BASE_URL=https://stream.church.org
CORS_ORIGIN=*
TRUST_PROXY=true
```

## Local Development

```bash
npm install
npm run dev
```

Test with FFmpeg:

```bash
ffmpeg -re -f lavfi -i testsrc=size=1280x720:rate=30 -f lavfi -i sine=frequency=1000:sample_rate=44100 -c:v libx264 -c:a aac -f flv rtmp://127.0.0.1:1935/live/church
```

Then open:

```bash
curl http://127.0.0.1:3000/api/live
open http://127.0.0.1:3000/live.m3u8
```

## VPS Setup

Ubuntu 22.04 packages:

```bash
sudo apt update
sudo apt install -y ffmpeg
```

Build and start with PM2:

```bash
npm ci
npm run build
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Open/firewall ports:

- `1935/tcp` for RTMP from the OSEE GoStream Duet
- `80/443` for public HTTP(S), normally through Nginx
- `3000/tcp` only internally if Nginx proxies to this service

Example Nginx proxy:

```nginx
server {
  server_name stream.church.org;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## Website Embed

```html
<audio controls autoplay src="https://stream.church.org/live.m3u8"></audio>
```

For browsers without native HLS audio support, use HLS.js in the website player.
