module.exports = {
  apps: [
    {
      name: "tlcc-audio-rtmp-server",
      script: "dist/index.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
