const express = require('express');
const { config } = require('./config');
const db = require('./database');

let app = null;
let botStatus = {
  status: 'starting',
  startedAt: new Date().toISOString(),
  lastActivity: null,
  currentAction: 'initializing',
  videosSentToday: 0,
  totalVideosSent: 0,
  errors: [],
};

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [HEALTH] ${message}`);
}

/**
 * Update bot status for health endpoint
 */
function updateStatus(updates) {
  Object.assign(botStatus, updates, { lastActivity: new Date().toISOString() });
}

/**
 * Add error to status tracking
 */
function addError(error) {
  botStatus.errors.push({
    time: new Date().toISOString(),
    message: error?.message || error,
  });

  // Keep only last 20 errors
  if (botStatus.errors.length > 20) {
    botStatus.errors = botStatus.errors.slice(-20);
  }
}

/**
 * Start Express health check server
 */
function startHealthServer() {
  app = express();

  // Main health check endpoint (for Render)
  app.get('/', (req, res) => {
    res.json({
      status: 'ok',
      service: 'media-telegram-uploader',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Detailed health endpoint
  app.get('/health', async (req, res) => {
    try {
      const todayCount = await db.getTodaySentCount();
      const totalCount = await db.getTotalSentCount();

      res.json({
        ...botStatus,
        videosSentToday: todayCount,
        totalVideosSent: totalCount,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        dailyLimit: config.limits.maxVideosPerDay,
        dailyRemaining: Math.max(0, config.limits.maxVideosPerDay - todayCount),
      });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        message: error.message,
      });
    }
  });

  // Stats endpoint
  app.get('/stats', async (req, res) => {
    try {
      const todayCount = await db.getTodaySentCount();
      const totalCount = await db.getTotalSentCount();

      res.json({
        today: todayCount,
        total: totalCount,
        limit: config.limits.maxVideosPerDay,
        remaining: Math.max(0, config.limits.maxVideosPerDay - todayCount),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Ping endpoint
  app.get('/ping', (req, res) => {
    res.send('pong');
  });

  app.listen(config.server.port, '0.0.0.0', () => {
    log(`✅ Health server running on port ${config.server.port}`);
  });
}

module.exports = {
  startHealthServer,
  updateStatus,
  addError,
};