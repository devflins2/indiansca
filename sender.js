const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const db = require('./database');
const { getDirectDownloadUrl, formatBytes, countdown } = require('./scraper');

function getProxyAgent() {
  if (config.provider.proxyUrl) {
    return new HttpsProxyAgent(config.provider.proxyUrl);
  }
  return null;
}

let telegramClient = null;

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [SENDER] ${message}`);
}

function logError(message, error) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [SENDER] ❌ ${message}`, error?.message || error);
}

/**
 * Initialize Telegram client with session string
 */
async function initClient() {
  try {
    log('Initializing Telegram client...');

    const session = new StringSession(config.telegram.sessionString);

    telegramClient = new TelegramClient(session, config.telegram.apiId, config.telegram.apiHash, {
      connectionRetries: 5,
      retryDelay: 3000,
      autoReconnect: true,
      requestRetries: 3,
    });

    await telegramClient.connect();

    // Verify connection
    const me = await telegramClient.getMe();
    log(`✅ Logged in as: ${me.firstName} ${me.lastName || ''} (@${me.username || 'no_username'})`);

    return telegramClient;
  } catch (error) {
    logError('Failed to initialize Telegram client', error);
    throw error;
  }
}

/**
 * Disconnect Telegram client
 */
async function disconnectClient() {
  try {
    if (telegramClient) {
      await telegramClient.disconnect();
      log('Telegram client disconnected');
    }
  } catch (error) {
    logError('Error disconnecting client', error);
  }
}

/**
 * Build caption for the video message
 */
function buildCaption(video) {
  const lines = [
    `🎬 **${escapeMarkdown(video.title)}**`,
    '',
    `⏱ **Duration:** ${video.duration}`,
    `👁 **Views:** ${formatNumber(video.views)}`,
    `⭐ **Rating:** ${video.rating}%`,
    '',
    `🔗 [Watch Online](${video.page_url})`,
  ];

  return lines.join('\n');
}

/**
 * Escape markdown special characters
 */
function escapeMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[');
}

/**
 * Format number with commas
 */
function formatNumber(num) {
  if (!num) return '0';
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Download video directly into memory buffer — no disk usage on Render
 */
async function downloadToBuffer(url, videoId) {
  log(`📥 Downloading ${videoId} into memory...`);

  try {
    const axiosOptions = {
      method: 'GET',
      url: url,
      responseType: 'arraybuffer',
      timeout: 600000, // 10 min for large files
      maxContentLength: config.limits.maxFileSizeBytes,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': config.provider.refererUrl || '',
        'Accept': 'video/mp4,video/*;q=0.9,*/*;q=0.8',
      },
    };

    const agent = getProxyAgent();
    if (agent) axiosOptions.httpsAgent = agent;

    const response = await axios(axiosOptions);
    const buffer = Buffer.from(response.data);

    if (buffer.length === 0) {
      log(`⚠️ Empty buffer received for ${videoId}. Skipping.`);
      return null;
    }

    if (buffer.length > config.limits.maxFileSizeBytes) {
      log(`⚠️ Buffer too large: ${formatBytes(buffer.length)}. Skipping.`);
      return null;
    }

    log(`✅ Downloaded to memory: ${formatBytes(buffer.length)}`);
    return buffer;
  } catch (error) {
    logError(`Download failed for ${videoId}`, error);
    return null;
  }
}

/**
 * Send a single video to the Telegram group
 * Downloads into memory buffer — zero disk usage on Render
 */
async function sendVideoToGroup(video) {
  if (!telegramClient) {
    throw new Error('Telegram client not initialized');
  }

  try {
    log(`\n${'='.repeat(60)}`);
    log(`Processing: ${video.title.substring(0, 50)}...`);
    log(`Video ID: ${video.id}`);

    await countdown(config.delays.betweenApiCalls, 'Pre-download API delay');

    // Step 1: Get direct MP4 download URL
    const downloadSource = await getDirectDownloadUrl(video);

    if (!downloadSource || !downloadSource.url) {
      log(`⚠️ No download URL for ${video.id}. Skipping.`);
      return false;
    }

    // Step 2: Check file size before downloading
    if (downloadSource.filesize > config.limits.maxFileSizeBytes) {
      log(`⚠️ File too large (${formatBytes(downloadSource.filesize)}). Skipping.`);
      return false;
    }

    // Step 3: Download into memory buffer (no disk I/O)
    let videoBuffer = await downloadToBuffer(downloadSource.url, video.id);

    if (!videoBuffer) {
      log(`⚠️ Download failed for ${video.id}. Skipping.`);
      return false;
    }

    // Step 4: Upload buffer directly to Telegram
    log(`📤 Uploading to Telegram (${formatBytes(videoBuffer.length)})...`);

    const caption = buildCaption(video);
    const groupEntity = await resolveGroupEntity();

    const progressCallback = (progress) => {
      const percent = (progress * 100).toFixed(1);
      process.stdout.write(
        `\r[${new Date().toISOString()}] [SENDER] 📤 Uploading: ${percent}%   `
      );
    };

    await telegramClient.sendFile(groupEntity, {
      file: videoBuffer,
      caption: caption,
      parseMode: 'md',
      supportsStreaming: true,
      progressCallback: progressCallback,
      attributes: [
        new Api.DocumentAttributeVideo({
          duration: video.duration_sec || 0,
          w: 1920,
          h: 1080,
          supportsStreaming: true,
        }),
        new Api.DocumentAttributeFilename({
          fileName: `${sanitizeFilename(video.title)}.mp4`,
        }),
      ],
    });

    console.log('');
    log(`✅ Successfully sent: ${video.title.substring(0, 50)}...`);

    // CRITICAL: Clear buffer from memory immediately to prevent Render RAM crash
    videoBuffer = null;

    return true;

  } catch (error) {
    console.log('');
    logError(`Failed to send video ${video.id}`, error);

    if (error.message?.includes('FLOOD_WAIT')) {
      const waitTime = parseInt(error.message.match(/\d+/)?.[0] || '60', 10);
      log(`⚠️ Flood wait! Waiting ${waitTime}s...`);
      await countdown(waitTime, 'Flood wait');
    }

    return false;
  }
}

/**
 * Resolve the group entity from GROUP_ID
 */
let cachedGroupEntity = null;

async function resolveGroupEntity() {
  if (cachedGroupEntity) return cachedGroupEntity;

  try {
    const groupId = config.telegram.groupId;

    // Try different formats
    if (typeof groupId === 'string' && groupId.startsWith('@')) {
      cachedGroupEntity = await telegramClient.getEntity(groupId);
    } else {
      const numericId = BigInt(groupId);
      cachedGroupEntity = await telegramClient.getEntity(numericId);
    }

    log(`✅ Resolved group: ${cachedGroupEntity.title || cachedGroupEntity.id}`);
    return cachedGroupEntity;
  } catch (error) {
    logError('Failed to resolve group entity', error);
    throw error;
  }
}

/**
 * Sanitize filename
 */
function sanitizeFilename(name) {
  if (!name) return 'video';
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 100)
    .trim();
}

/**
 * Process and send a batch of videos with all safety delays
 */
async function processBatch(videos) {
  let sentCount = 0;
  let failCount = 0;
  let skipCount = 0;

  const todayCount = await db.getTodaySentCount();
  const remaining = config.limits.maxVideosPerDay - todayCount;

  if (remaining <= 0) {
    log(`⚠️ Daily limit reached (${config.limits.maxVideosPerDay} videos). Waiting until tomorrow.`);
    return { sentCount: 0, failCount: 0, skipCount: videos.length };
  }

  const videosToProcess = videos.slice(0, remaining);
  log(`\n📋 Processing ${videosToProcess.length} videos (${todayCount} already sent today, limit: ${config.limits.maxVideosPerDay})`);

  for (let i = 0; i < videosToProcess.length; i++) {
    const video = videosToProcess[i];

    // Check daily limit again
    const currentDayCount = await db.getTodaySentCount();
    if (currentDayCount >= config.limits.maxVideosPerDay) {
      log(`⚠️ Daily limit reached during processing. Stopping.`);
      skipCount += videosToProcess.length - i;
      break;
    }

    // Check if already sent (double-check)
    const alreadySent = await db.isVideoSent(video.id);
    if (alreadySent) {
      log(`⏭️ Already sent: ${video.id}. Skipping.`);
      skipCount++;
      continue;
    }

    log(`\n📹 [${i + 1}/${videosToProcess.length}] Processing video...`);

    // Send the video
    const success = await sendVideoToGroup(video);

    if (success) {
      // Mark as sent in database
      await db.markVideoAsSent(video);
      sentCount++;

      // Save progress
      await db.saveState('last_processed_video_id', video.id);
      await db.saveState('last_send_time', new Date().toISOString());
    } else {
      failCount++;
    }

    // Anti-ban delay between sends
    if (i < videosToProcess.length - 1) {
      await countdown(config.delays.betweenSends, `Anti-ban delay before next video`);
    }

    // Extra delay every 10 videos
    if ((i + 1) % 10 === 0 && i < videosToProcess.length - 1) {
      log(`📊 Progress: ${sentCount} sent, ${failCount} failed, ${skipCount} skipped`);
      await countdown(60, 'Extended cooldown (every 10 videos)');
    }
  }

  log(`\n${'='.repeat(60)}`);
  log(`📊 Batch Complete!`);
  log(`   ✅ Sent: ${sentCount}`);
  log(`   ❌ Failed: ${failCount}`);
  log(`   ⏭️ Skipped: ${skipCount}`);
  log(`${'='.repeat(60)}\n`);

  return { sentCount, failCount, skipCount };
}

module.exports = {
  initClient,
  disconnectClient,
  sendVideoToGroup,
  processBatch,
  buildCaption,
};