'use strict';
const path = require('node:path');
const fs = require('node:fs');

// Minimal .env loader (no dependency needed).
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const express = require('express');
const api = require('./src/api');
const { router: webhook } = require('./src/webhook');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({
    limit: '2mb',
    verify: (req, res, buf) => { req.rawBody = buf; }, // needed for Meta signature check
  }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use('/webhook', webhook);
  app.use('/api', api);
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => {
    console.log(`WhatsApp Business SaaS চালু হয়েছে: http://localhost:${port}`);
    if (!process.env.WEBHOOK_VERIFY_TOKEN) console.warn('WEBHOOK_VERIFY_TOKEN সেট করা নেই — Meta webhook যাচাই কাজ করবে না।');
    if (!process.env.META_APP_SECRET) console.warn('META_APP_SECRET সেট করা নেই — webhook সিগনেচার যাচাই বন্ধ আছে।');
  });
}

module.exports = { createApp };
