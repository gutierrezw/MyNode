module.exports = {
    apps: [
        {
            name: "server-api",
            script: "server.js",
            cwd: __dirname,
            watch: false,
            autorestart: true,
            max_restarts: 10,
            restart_delay: 5000,
            log_date_format: "YYYY-MM-DD HH:mm:ss",
            out_file: "logs/out.log",
            error_file: "logs/error.log",
        },
    ],
};
