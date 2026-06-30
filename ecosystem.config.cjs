module.exports = {
  apps: [{
    name: "dlmm-agent",
    script: "index.js",
    cwd: __dirname,
    max_memory_restart: "500M",
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    error_file: "./logs/pm2-error.log",
    out_file: "./logs/pm2-out.log",
    merge_logs: true,
    autorestart: true,
    watch: false,
  }]
};
