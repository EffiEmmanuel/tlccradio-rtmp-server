import cors from "cors";
import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import NodeMediaServer, { type NodeMediaSession } from "node-media-server";

type LiveState = {
  isLive: boolean;
  startedAt: string | null;
  streamPath: string | null;
  publisherId: string | null;
  ffmpegRunning: boolean;
};

const env = {
  rtmpPort: parsePort(process.env.RTMP_PORT, 1935),
  httpPort: parsePort(process.env.HTTP_PORT, 3000),
  streamKey: process.env.STREAM_KEY?.trim() || "church",
  rtmpApp: process.env.RTMP_APP?.trim() || "live",
  hlsOutputDir: path.resolve(process.env.HLS_OUTPUT_DIR || "./public"),
  ffmpegPath: process.env.FFMPEG_PATH?.trim() || "ffmpeg",
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""),
  corsOrigin: process.env.CORS_ORIGIN || "*",
};

const hlsPlaylistName = "live.m3u8";
const hlsPlaylistPath = path.join(env.hlsOutputDir, hlsPlaylistName);
const hlsSegmentPattern = path.join(env.hlsOutputDir, "live%03d.ts");
const playbackUrl = env.publicBaseUrl
  ? `${env.publicBaseUrl}/${hlsPlaylistName}`
  : `/${hlsPlaylistName}`;

let ffmpegProcess: ChildProcessByStdio<null, Readable, Readable> | null = null;
let ffmpegStopTimer: NodeJS.Timeout | null = null;

const liveState: LiveState = {
  isLive: false,
  startedAt: null,
  streamPath: null,
  publisherId: null,
  ffmpegRunning: false,
};

fs.mkdirSync(env.hlsOutputDir, { recursive: true });
cleanupHlsFiles();

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: env.corsOrigin }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/status", (_req, res) => {
  res.json({ isLive: liveState.isLive });
});

app.get("/api/live", (_req, res) => {
  res.json({
    live: liveState.isLive,
    startedAt: liveState.startedAt,
    playbackUrl,
    streamPath: liveState.streamPath,
    ffmpegRunning: liveState.ffmpegRunning,
  });
});

app.use(
  express.static(env.hlsOutputDir, {
    etag: false,
    lastModified: false,
    setHeaders(res, filePath) {
      res.setHeader("Access-Control-Allow-Origin", env.corsOrigin);
      res.setHeader("Cache-Control", "no-store");

      if (filePath.endsWith(".m3u8")) {
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      }

      if (filePath.endsWith(".ts")) {
        res.setHeader("Content-Type", "video/mp2t");
      }
    },
  })
);

app.listen(env.httpPort, () => {
  console.log(`HTTP server listening on :${env.httpPort}`);
  console.log(`HLS playback URL: ${playbackUrl}`);
});

const mediaServer = new NodeMediaServer({
  bind: "0.0.0.0",
  rtmp: {
    port: env.rtmpPort,
    chunk_size: 60000,
    gop_cache: false,
    ping: 30,
    ping_timeout: 60,
  },
});

mediaServer.on("prePublish", (session) => {
  if (!isExpectedStream(session)) {
    console.warn(
      `Rejecting RTMP publish for ${session.streamPath}; expected /${env.rtmpApp}/${env.streamKey}`
    );
    session.close();
  }
});

mediaServer.on("postPublish", (session) => {
  if (!isExpectedStream(session)) {
    return;
  }

  liveState.isLive = true;
  liveState.startedAt = new Date().toISOString();
  liveState.streamPath = session.streamPath;
  liveState.publisherId = session.id;

  console.log(`Stream started: ${session.streamPath} from ${session.ip}`);
  cleanupHlsFiles();

  setTimeout(() => {
    if (liveState.publisherId === session.id) {
      startFfmpeg(session.streamPath);
    }
  }, 300);
});

mediaServer.on("donePublish", (session) => {
  if (liveState.publisherId !== session.id) {
    return;
  }

  console.log(`Stream ended: ${session.streamPath}`);
  resetLiveState();
  stopFfmpeg();
});

mediaServer.run();

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function parsePort(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isExpectedStream(session: NodeMediaSession) {
  return (
    session.streamApp === env.rtmpApp && session.streamName === env.streamKey
  );
}

function startFfmpeg(streamPath: string) {
  stopFfmpeg();

  const inputUrl = `rtmp://127.0.0.1:${env.rtmpPort}${streamPath}`;
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-i",
    inputUrl,
    "-vn",
    "-acodec",
    "aac",
    "-b:a",
    "64k",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-f",
    "hls",
    "-hls_time",
    "6",
    "-hls_list_size",
    "5",
    "-hls_flags",
    "delete_segments+omit_endlist",
    "-hls_segment_filename",
    hlsSegmentPattern,
    hlsPlaylistPath,
  ];

  console.log(`Starting FFmpeg: ${env.ffmpegPath} ${args.join(" ")}`);
  const child = spawn(env.ffmpegPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  ffmpegProcess = child;
  liveState.ffmpegRunning = true;

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[ffmpeg] ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[ffmpeg] ${chunk}`);
  });

  child.once("error", (error) => {
    console.error(`FFmpeg failed to start: ${error.message}`);
    if (ffmpegProcess === child) {
      ffmpegProcess = null;
      liveState.ffmpegRunning = false;
    }
  });

  child.once("exit", (code, signal) => {
    console.log(
      `FFmpeg exited with code=${code ?? "null"} signal=${signal ?? "null"}`
    );
    if (ffmpegProcess === child) {
      ffmpegProcess = null;
      liveState.ffmpegRunning = false;
    }
  });
}

function stopFfmpeg() {
  if (ffmpegStopTimer) {
    clearTimeout(ffmpegStopTimer);
    ffmpegStopTimer = null;
  }

  if (!ffmpegProcess) {
    liveState.ffmpegRunning = false;
    return;
  }

  const child = ffmpegProcess;
  ffmpegProcess = null;
  liveState.ffmpegRunning = false;

  child.kill("SIGTERM");
  ffmpegStopTimer = setTimeout(() => {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  }, 5000);
}

function resetLiveState() {
  liveState.isLive = false;
  liveState.startedAt = null;
  liveState.streamPath = null;
  liveState.publisherId = null;
  liveState.ffmpegRunning = false;
}

function cleanupHlsFiles() {
  for (const entry of fs.readdirSync(env.hlsOutputDir)) {
    if (/^live(?:\d+\.ts|\.m3u8)$/.test(entry)) {
      fs.rmSync(path.join(env.hlsOutputDir, entry), { force: true });
    }
  }
}

function shutdown() {
  console.log("Shutting down audio RTMP server...");
  resetLiveState();
  stopFfmpeg();
  process.exit(0);
}
