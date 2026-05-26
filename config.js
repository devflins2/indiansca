require('dotenv').config();

const config = {
  // MongoDB
  mongo: {
    uri: process.env.MONGO_URI || 'mongodb://localhost:27017/media_bot',
    dbName: 'media_bot',
    collectionVideos: 'sent_videos',
    collectionState: 'bot_state',
  },

  // Telegram
  telegram: {
    apiId: parseInt(process.env.API_ID, 10),
    apiHash: process.env.API_HASH,
    sessionString: process.env.SESSION_STRING || '',
    groupId: process.env.GROUP_ID,
  },

  // Provider API
  provider: {
    baseUrl: process.env.API_BASE_URL || '',
    detailUrl: process.env.API_DETAIL_URL || '',
    refererUrl: process.env.API_REFERER || '',
    videoPageUrl: process.env.API_VIDEO_PAGE || '',
    queries: (process.env.KEYWORDS || 'indian,desi,bhabhi,hindi,pakistani,bhojpuri,tamil,telugu,mallu,kerala,punjabi,marathi,bengali,bangla,aunty,gujarati,kannada,nepali,devar,indian bhabhi,desi bhabhi')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    query: 'indian', // fallback
    perPage: 30,
    format: 'json',
    order: 'latest',
    lq: 1,
    thumbsize: 'medium',
    proxyUrl: process.env.PROXY_URL || '',
  },

  // Delays (in seconds)
  delays: {
    betweenApiCalls: parseInt(process.env.DELAY_BETWEEN_API_CALLS, 10) || 3,
    betweenSends: parseInt(process.env.DELAY_BETWEEN_SENDS, 10) || 20,
    betweenPages: parseInt(process.env.DELAY_BETWEEN_PAGES, 10) || 30,
  },

  // Limits
  limits: {
    maxVideosPerDay: parseInt(process.env.MAX_VIDEOS_PER_DAY, 10) || 50,
    maxFileSizeBytes: (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 500) * 1024 * 1024, // Default 500MB safe limit for Render (512MB RAM)
  },

  // Server
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
  },
};

// Validation
function validateConfig() {
  const errors = [];

  if (!config.mongo.uri) errors.push('MONGO_URI is required');
  if (!config.telegram.apiId || isNaN(config.telegram.apiId)) errors.push('API_ID is required and must be a number');
  if (!config.telegram.apiHash) errors.push('API_HASH is required');
  if (!config.telegram.groupId) errors.push('GROUP_ID is required');
  if (!config.telegram.sessionString) errors.push('SESSION_STRING is required. Run "npm run auth" first.');

  if (errors.length > 0) {
    console.error('\n❌ Configuration Errors:');
    errors.forEach((err) => console.error(`   - ${err}`));
    console.error('\nPlease check your .env file.\n');
    process.exit(1);
  }
}

module.exports = { config, validateConfig };