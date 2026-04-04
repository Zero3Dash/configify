module.exports = {
    apps: [{
        name:             'configify-app',
        script:           'server.js',
        instances:        1,
        autorestart:      true,
        watch:            false,
        max_memory_restart: '500M',
        env: {
            NODE_ENV: 'production',
            PORT:     3000
        },
        error_file: '/var/log/configify/err.log',
        out_file:   '/var/log/configify/out.log',
        log_file:   '/var/log/configify/combined.log',
        time:       true
    }]
};
