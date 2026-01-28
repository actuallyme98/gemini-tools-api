module.exports = {
  apps: [
    {
      name: 'gemini-tools-api',
      script: 'dist/main.js',
      interpreter: '/root/.nvm/versions/node/v18.20.8/bin/node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
    },
  ],
};
