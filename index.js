/**
 * Media Channels Uploader & Rotator
 * Main entry point with auto-resume and crash recovery
 */

require('dotenv').config();

const { config, validateConfig } = require('./config');
const db = require('./database');
const scraper = require('./scraper');
const sender = require('./sender');
const health = require('./health');

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [MAIN] ${message}`);
}

function logError(message, error) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [MAIN] ❌ ${message}`, error?.message || error);
}

/**
 * Countdown timer for main process
 */
async function countdown(seconds, label = 'Waiting') {
  for (let i = seconds; i > 0; i--) {
    process.stdout.write(`\r[${new Date().toISOString()}] [MAIN] ⏳ ${label}: ${i}s remaining...   `);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  process.stdout.write(`\r[${new Date().toISOString()}] [MAIN] ✅ ${label}: Done!                      \n`);
}

/**
 * Calculate seconds until midnight (for daily reset)
 */
function getSecondsUntilMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return Math.floor((midnight - now) / 1000);
}

/**
 * Main processing cycle
 */
async function runCycle() {
  log('\n🚀 Starting new processing cycle...\n');
  health.updateStatus({ currentAction: 'starting_cycle' });

  // Check daily limit
  const todaySent = await db.getTodaySentCount();
  if (todaySent >= config.limits.maxVideosPerDay) {
    const waitSeconds = getSecondsUntilMidnight();
    log(`⚠️ Daily limit reached (${todaySent}/${config.limits.maxVideosPerDay}). Waiting until midnight.`);
    health.updateStatus({ currentAction: 'daily_limit_reached', videosSentToday: todaySent });
    await countdown(Math.min(waitSeconds, 3600), 'Waiting for daily reset (or 1 hour max)');
    return;
  }

  const remainingToday = config.limits.maxVideosPerDay - todaySent;
  log(`📊 Today's progress: ${todaySent}/${config.limits.maxVideosPerDay} sent (${remainingToday} remaining)`);

  // Step 1: Get all already-sent video IDs
  health.updateStatus({ currentAction: 'loading_sent_videos' });
  log('Loading sent video IDs from database...');
  const sentVideoIds = await db.getAllSentVideoIds();
  log(`Found ${sentVideoIds.size} previously sent videos`);

  // Step 2: Resolve active search keyword for rotation
  const queries = config.provider.queries;
  const currentKeywordIndex = await db.getState('last_scraped_keyword_index', 0);
  const activeKeywordIndex = currentKeywordIndex % queries.length;
  const activeQuery = queries[activeKeywordIndex];
  log(`Active query for this cycle: "${activeQuery}" (index ${activeKeywordIndex}/${queries.length})`);

  // Step 3: Get resume page for active keyword
  const lastPageKey = `last_scraped_page_${activeQuery.replace(/\s+/g, '_')}`;
  const lastPage = await db.getState(lastPageKey, 1);
  log(`Resuming "${activeQuery}" from page ${lastPage}`);

  // Step 4: Scrape videos
  health.updateStatus({ currentAction: 'scraping' });
  log(`Starting video scraping for "${activeQuery}"...\n`);

  // Optimize collection: collect up to double the remaining limit to have a buffer
  const maxCollect = Math.max(remainingToday * 2, 50);
  const videos = await scraper.fetchAllVideos(activeQuery, sentVideoIds, lastPage, maxCollect);

  if (videos.length === 0) {
    log(`No new videos found for "${activeQuery}". Will retry later.`);
    // Reset page counter for this keyword to start fresh
    await db.saveState(lastPageKey, 1);

    // Rotate keyword for next cycle even if no videos were found, to avoid getting stuck
    const nextKeywordIndex = (activeKeywordIndex + 1) % queries.length;
    await db.saveState('last_scraped_keyword_index', nextKeywordIndex);
    log(`Rotating to next keyword index: ${nextKeywordIndex} ("${queries[nextKeywordIndex]}")`);

    health.updateStatus({ currentAction: 'no_new_videos' });
    await countdown(300, 'Cooldown before retry');
    return;
  }

  log(`\n📹 Found ${videos.length} new videos to process for "${activeQuery}"\n`);

  // Step 5: Send videos
  health.updateStatus({ currentAction: 'sending_videos' });

  const results = await sender.processBatch(videos);

  // Step 6: Update state
  const totalSent = await db.getTotalSentCount();
  const todayFinal = await db.getTodaySentCount();

  health.updateStatus({
    currentAction: 'cycle_complete',
    videosSentToday: todayFinal,
    totalVideosSent: totalSent,
  });

  log(`\n📊 Cycle Summary ("${activeQuery}"):`);
  log(`   Sent: ${results.sentCount}`);
  log(`   Failed: ${results.failCount}`);
  log(`   Skipped: ${results.skipCount}`);
  log(`   Total today: ${todayFinal}/${config.limits.maxVideosPerDay}`);
  log(`   Total all-time: ${totalSent}`);

  // Save page progress for resume for this keyword
  if (videos.length < 30) {
    // Reached end for this keyword, reset to page 1
    await db.saveState(lastPageKey, 1);
  }

  // Advance keyword index for the next cycle
  const nextKeywordIndex = (activeKeywordIndex + 1) % queries.length;
  await db.saveState('last_scraped_keyword_index', nextKeywordIndex);
  log(`Saved next keyword index: ${nextKeywordIndex} ("${queries[nextKeywordIndex]}")`);

  // Cooldown before next cycle
  if (todayFinal >= config.limits.maxVideosPerDay) {
    const waitSeconds = getSecondsUntilMidnight();
    log(`\n⚠️ Daily limit reached. Waiting for midnight...`);
    await countdown(Math.min(waitSeconds, 3600), 'Daily reset');
  } else {
    await countdown(120, 'Cooldown before next cycle');
  }
}

/**
 * Main function with infinite loop and crash recovery
 */
async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('  MEDIA CHANNELS UPLOADER & ROTATOR');
  console.log('='.repeat(60) + '\n');

  // Validate configuration
  validateConfig();
  log('✅ Configuration validated');

  // Start health check server first (for Render)
  health.startHealthServer();

  // Connect to MongoDB
  await db.connect();
  health.updateStatus({ status: 'connected_to_db' });

  // Initialize Telegram client
  await sender.initClient();
  health.updateStatus({ status: 'running' });

  // Clean up temp directory on startup
  const fs = require('fs');
  const path = require('path');
  const tempDir = path.join(__dirname, 'temp');
  if (fs.existsSync(tempDir)) {
    const files = fs.readdirSync(tempDir);
    files.forEach((file) => {
      try {
        fs.unlinkSync(path.join(tempDir, file));
      } catch (e) {}
    });
    log(`🗑️ Cleaned ${files.length} temp files`);
  }

  log('✅ All systems initialized. Starting main loop...\n');

  // Main infinite loop
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 10;

  while (true) {
    try {
      await runCycle();
      consecutiveErrors = 0; // Reset on success
    } catch (error) {
      consecutiveErrors++;
      logError(`Cycle error (${consecutiveErrors}/${maxConsecutiveErrors})`, error);
      health.addError(error);
      health.updateStatus({ status: 'error', currentAction: `error_recovery_${consecutiveErrors}` });

      if (consecutiveErrors >= maxConsecutiveErrors) {
        logError('Too many consecutive errors. Performing extended recovery...');
        await countdown(600, 'Extended recovery (10 min)');
        consecutiveErrors = Math.floor(maxConsecutiveErrors / 2); // Partial reset
      } else {
        const backoff = Math.min(consecutiveErrors * 30, 300);
        await countdown(backoff, `Error recovery (backoff ${backoff}s)`);
      }

      // Try to reconnect services
      try {
        await db.connect();
        await sender.initClient();
        health.updateStatus({ status: 'running' });
      } catch (reconnectError) {
        logError('Reconnection failed', reconnectError);
      }
    }
  }
}

// Graceful shutdown handlers
process.on('SIGINT', async () => {
  log('\n⚠️ Received SIGINT. Shutting down gracefully...');
  health.updateStatus({ status: 'shutting_down' });
  await sender.disconnectClient();
  await db.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log('\n⚠️ Received SIGTERM. Shutting down gracefully...');
  health.updateStatus({ status: 'shutting_down' });
  await sender.disconnectClient();
  await db.disconnect();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  logError('Uncaught Exception', error);
  health.addError(error);
  // Don't exit — let the main loop handle recovery
});

process.on('unhandledRejection', (reason) => {
  logError('Unhandled Rejection', reason);
  health.addError(reason);
  // Don't exit — let the main loop handle recovery
});

// Start the application
main().catch((error) => {
  logError('Fatal error in main()', error);
  process.exit(1);
});