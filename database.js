const { MongoClient } = require('mongodb');
const { config } = require('./config');

let client = null;
let db = null;

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [DATABASE] ${message}`);
}

function logError(message, error) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [DATABASE] ❌ ${message}`, error?.message || error);
}

/**
 * Connect to MongoDB with retry logic
 */
async function connect(retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      log(`Connecting to MongoDB (attempt ${attempt}/${retries})...`);

      client = new MongoClient(config.mongo.uri, {
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
      });

      await client.connect();
      db = client.db(config.mongo.dbName);

      // Create unique index on video_id
      const videosCollection = db.collection(config.mongo.collectionVideos);
      await videosCollection.createIndex({ video_id: 1 }, { unique: true });
      await videosCollection.createIndex({ sent_at: -1 });

      // Create state collection index
      const stateCollection = db.collection(config.mongo.collectionState);
      await stateCollection.createIndex({ key: 1 }, { unique: true });

      log('✅ Connected to MongoDB successfully');
      return true;
    } catch (error) {
      logError(`Connection attempt ${attempt} failed`, error);
      if (attempt < retries) {
        const waitTime = attempt * 3;
        log(`Retrying in ${waitTime} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime * 1000));
      }
    }
  }

  throw new Error('Failed to connect to MongoDB after all retries');
}

/**
 * Disconnect from MongoDB
 */
async function disconnect() {
  try {
    if (client) {
      await client.close();
      log('Disconnected from MongoDB');
    }
  } catch (error) {
    logError('Error disconnecting', error);
  }
}

/**
 * Check if a video has already been sent
 */
async function isVideoSent(videoId) {
  try {
    const collection = db.collection(config.mongo.collectionVideos);
    const existing = await collection.findOne({ video_id: videoId });
    return !!existing;
  } catch (error) {
    logError('Error checking video', error);
    return false;
  }
}

/**
 * Mark a video as sent
 */
async function markVideoAsSent(videoData) {
  try {
    const collection = db.collection(config.mongo.collectionVideos);
    const document = {
      video_id: videoData.id,
      title: videoData.title,
      duration: videoData.duration,
      views: videoData.views,
      rating: videoData.rating,
      direct_url: videoData.direct_url,
      thumbnail: videoData.thumbnail || '',
      sent_at: new Date(),
      sent_date: new Date().toISOString().split('T')[0],
    };

    await collection.insertOne(document);
    log(`✅ Marked video ${videoData.id} as sent`);
    return true;
  } catch (error) {
    if (error.code === 11000) {
      log(`⚠️ Video ${videoData.id} already exists (duplicate)`);
      return false;
    }
    logError('Error marking video as sent', error);
    return false;
  }
}

/**
 * Get count of videos sent today
 */
async function getTodaySentCount() {
  try {
    const collection = db.collection(config.mongo.collectionVideos);
    const today = new Date().toISOString().split('T')[0];
    const count = await collection.countDocuments({ sent_date: today });
    return count;
  } catch (error) {
    logError('Error getting today count', error);
    return 0;
  }
}

/**
 * Get total sent videos count
 */
async function getTotalSentCount() {
  try {
    const collection = db.collection(config.mongo.collectionVideos);
    return await collection.countDocuments();
  } catch (error) {
    logError('Error getting total count', error);
    return 0;
  }
}

/**
 * Save bot state (for resume after crash)
 */
async function saveState(key, value) {
  try {
    const collection = db.collection(config.mongo.collectionState);
    await collection.updateOne(
      { key },
      { $set: { key, value, updated_at: new Date() } },
      { upsert: true }
    );
  } catch (error) {
    logError('Error saving state', error);
  }
}

/**
 * Get bot state
 */
async function getState(key, defaultValue = null) {
  try {
    const collection = db.collection(config.mongo.collectionState);
    const doc = await collection.findOne({ key });
    return doc ? doc.value : defaultValue;
  } catch (error) {
    logError('Error getting state', error);
    return defaultValue;
  }
}

/**
 * Get all sent video IDs (for quick duplicate check)
 */
async function getAllSentVideoIds() {
  try {
    const collection = db.collection(config.mongo.collectionVideos);
    const docs = await collection.find({}, { projection: { video_id: 1 } }).toArray();
    return new Set(docs.map((d) => d.video_id));
  } catch (error) {
    logError('Error getting all sent video IDs', error);
    return new Set();
  }
}

module.exports = {
  connect,
  disconnect,
  isVideoSent,
  markVideoAsSent,
  getTodaySentCount,
  getTotalSentCount,
  saveState,
  getState,
  getAllSentVideoIds,
};