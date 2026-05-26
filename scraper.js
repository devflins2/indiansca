const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { config } = require('./config');

function getProxyAgent() {
  if (config.provider.proxyUrl) {
    return new HttpsProxyAgent(config.provider.proxyUrl);
  }
  return null;
}

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [SCRAPER] ${message}`);
}

function logError(message, error) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [SCRAPER] ❌ ${message}`, error?.message || error);
}

/**
 * Countdown timer displayed in console
 */
async function countdown(seconds, label = 'Waiting') {
  for (let i = seconds; i > 0; i--) {
    process.stdout.write(`\r[${new Date().toISOString()}] [SCRAPER] ⏳ ${label}: ${i}s remaining...   `);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  process.stdout.write(`\r[${new Date().toISOString()}] [SCRAPER] ✅ ${label}: Done!                    \n`);
}

/**
 * Fetch a single page of videos from Provider API
 */
async function fetchPage(query, page = 1) {
  const activeQuery = query || config.provider.queries[0] || 'indian';
  const params = {
    query: activeQuery,
    per_page: config.provider.perPage,
    page: page,
    format: config.provider.format,
    order: config.provider.order,
    lq: config.provider.lq,
    thumbsize: config.provider.thumbsize,
  };

  log(`Fetching page ${page} for query "${activeQuery}" from Provider API...`);

  try {
    const axiosOptions = {
      params,
      timeout: 60000, // increased from 30s to 60s to prevent stream abort
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
      },
    };

    const agent = getProxyAgent();
    if (agent) {
      axiosOptions.httpsAgent = agent;
    }

    const response = await axios.get(config.provider.baseUrl, axiosOptions);

    const data = response.data;

    if (!data || !data.videos) {
      log(`No videos found on page ${page}`);
      return { videos: [], totalPages: 0, totalVideos: 0 };
    }

    log(`Page ${page}: Found ${data.videos.length} videos (Total: ${data.total_count || 'unknown'})`);

    return {
      videos: data.videos,
      totalPages: data.total_pages || Math.ceil((data.total_count || 0) / config.provider.perPage),
      totalVideos: data.total_count || 0,
    };
  } catch (error) {
    logError(`Failed to fetch page ${page}`, error);
    throw error;
  }
}

/**
 * Parse raw video data from API into clean format
 */
function parseVideo(rawVideo) {
  // Build direct URL for the video page
  const base = config.provider.videoPageUrl || '';
  const videoPageUrl = rawVideo.url
    ? (rawVideo.url.startsWith('http') ? rawVideo.url : `${config.provider.refererUrl}${rawVideo.url.replace(/^\//, '')}`)
    : `${base}${rawVideo.id}/`;

  // Get the best available direct video source
  let directUrl = '';
  let fileSize = 0;

  // Check for direct source URLs in various quality tiers
  if (rawVideo.default_thumb && rawVideo.default_thumb.src) {
    // thumbnails exist, video is accessible
  }

  // Provider API v2 provides embed URL and sometimes source URLs
  if (rawVideo.embed) {
    directUrl = rawVideo.embed;
  }

  // Use the video page URL as fallback — actual download link requires an extra call
  if (!directUrl) {
    directUrl = videoPageUrl;
  }

  // Duration formatting
  let durationStr = '';
  if (rawVideo.length_sec) {
    const totalSec = parseInt(rawVideo.length_sec, 10);
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    if (hours > 0) {
      durationStr = `${hours}h ${mins}m ${secs}s`;
    } else {
      durationStr = `${mins}m ${secs}s`;
    }
  } else if (rawVideo.length_min) {
    durationStr = rawVideo.length_min;
  }

  return {
    id: rawVideo.id,
    title: rawVideo.title || 'Untitled',
    duration: durationStr,
    duration_sec: parseInt(rawVideo.length_sec || 0, 10),
    views: parseInt(rawVideo.views || 0, 10),
    rating: parseFloat(rawVideo.rate || 0).toFixed(1),
    direct_url: directUrl,
    page_url: videoPageUrl,
    thumbnail: rawVideo.default_thumb?.src || '',
    keywords: rawVideo.keywords || '',
    added: rawVideo.added || '',
  };
}

/**
 * Fetch the actual downloadable MP4 URL for a video
 * Provider API provides this through their video ID lookup
 */
async function getDirectDownloadUrl(video) {
  const videoId = typeof video === 'object' ? video.id : video;
  const pageUrl = typeof video === 'object' ? video.page_url : null;
  let bestSource = null;
  let bestSize = 0;
  const agent = getProxyAgent();

  try {
    const apiUrl = `${config.provider.detailUrl}?id=${videoId}&format=json`;

    log(`Fetching direct download URL for video ${videoId}...`);

    const axiosOptions = {
      timeout: 60000, // increased from 30s to 60s
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
      },
    };

    if (agent) {
      axiosOptions.httpsAgent = agent;
    }

    const response = await axios.get(apiUrl, axiosOptions);
    const data = response.data;

    if (data && data.srcs) {
      const qualities = ['1080p', '720p', '480p', '360p', '240p'];

      for (const quality of qualities) {
        if (data.srcs[quality]) {
          const src = data.srcs[quality];
          const srcSize = parseInt(src.filesize || 0, 10);

          // Pick highest quality that's under 2GB
          if (srcSize > 0 && srcSize <= config.limits.maxFileSizeBytes) {
            if (!bestSource || srcSize > bestSize) {
              bestSource = {
                url: src.src,
                quality: quality,
                filesize: srcSize,
              };
              bestSize = srcSize;
            }
            break; // Take highest available quality under limit
          } else if (srcSize === 0 && src.src) {
            // Size unknown, take the URL anyway
            if (!bestSource) {
              bestSource = {
                url: src.src,
                quality: quality,
                filesize: 0,
              };
            }
          }
        }
      }
    }
  } catch (error) {
    logError(`API logic failed for ${videoId}, proceeding to page scrape...`, error.message);
  }

  // Fallback: Scrape HTML directly from the video page if API gave no results
  if (!bestSource && pageUrl) {
    log(`⚠️ Attempting to scrape HTML directly from page: ${pageUrl}`);
    try {
      const pageOpts = {
        timeout: 15000, // Reduced to 15s so dead proxy fails faster
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        }
      };
      if (agent) pageOpts.httpsAgent = agent;

      const pageRes = await axios.get(pageUrl, pageOpts);
      const html = pageRes.data;

      // Regex matching any .mp4 URL (even if escaped in JSON string)
      const mp4Matches = html.match(/https?:\/\/[^"'\s<>]+?\.mp4[^"'\s<>]*/gi);

      if (mp4Matches && mp4Matches.length > 0) {
        const uniqueUrls = [...new Set(mp4Matches)];
        log(`🔍 Found ${uniqueUrls.length} potential MP4 links on page.`);

        // Clean up backslashes if the URL was inside a JSON blob
        let finalUrl = uniqueUrls[0].replace(/\\/g, '');

        bestSource = {
          url: finalUrl,
          quality: 'scraped',
          filesize: 0 // Relying on maxContentLength during download
        };
        log(`✅ Successfully scraped download URL!`);
      } else {
        log(`❌ Could not find any MP4 links in the page HTML for ${videoId}`);
      }
    } catch (scrapeErr) {
      logError(`Page scrape failed for ${videoId}`, scrapeErr.message);

      // Agar proxy fail ho jaye, toh bina proxy ke retry karein
      if (agent) {
        log(`🔄 Proxy seems dead (${scrapeErr.message}). Retrying scrape WITHOUT proxy...`);
        try {
          const fallbackOpts = { ...pageOpts };
          fallbackOpts.timeout = 30000; // Restore standard 30s timeout for direct connection
          delete fallbackOpts.httpsAgent;

          const fallbackRes = await axios.get(pageUrl, fallbackOpts);
          const html = fallbackRes.data;

          const mp4Matches = html.match(/https?:\/\/[^"'\s<>]+?\.mp4[^"'\s<>]*/gi);

          if (mp4Matches && mp4Matches.length > 0) {
            const uniqueUrls = [...new Set(mp4Matches)];
            log(`🔍 Found ${uniqueUrls.length} potential MP4 links on page (no proxy).`);
            let finalUrl = uniqueUrls[0].replace(/\\/g, '');
            bestSource = { url: finalUrl, quality: 'scraped', filesize: 0 };
            log(`✅ Successfully scraped download URL without proxy!`);
          } else {
            log(`❌ Could not find any MP4 links in HTML (no proxy) for ${videoId}`);
          }
        } catch (fallbackErr) {
          logError(`Page scrape without proxy also failed`, fallbackErr.message);
        }
      }
    }
  }

  if (bestSource) {
    log(`Found ${bestSource.quality} source for ${videoId} (${formatBytes(bestSource.filesize)})`);
  } else {
    log(`⚠️ No suitable download source found for ${videoId}`);
  }

  return bestSource;
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Fetch ALL pages of Indian videos
 */
async function fetchAllVideos(query, sentVideoIds = new Set(), startPage = 1, maxCollect = 100) {
  const allVideos = [];
  let currentPage = startPage;
  let totalPages = 1;
  let retryCount = 0;
  const maxRetries = 3;

  const activeQuery = query || config.provider.queries[0] || 'indian';
  log(`Starting to scrape all "${activeQuery}" videos from page ${startPage}...`);

  while (currentPage <= totalPages) {
    try {
      const result = await fetchPage(activeQuery, currentPage);

      if (currentPage === startPage) {
        totalPages = result.totalPages;
        log(`📊 Total pages to scrape for "${activeQuery}": ${totalPages} (${result.totalVideos} videos)`);
      }

      if (result.videos.length === 0) {
        log(`No more videos found. Stopping at page ${currentPage}`);
        break;
      }

      // Parse and filter videos
      for (const rawVideo of result.videos) {
        const video = parseVideo(rawVideo);

        // Skip already sent videos
        if (sentVideoIds.has(video.id)) {
          log(`⏭️ Skipping already sent: ${video.id} - ${video.title.substring(0, 40)}...`);
          continue;
        }

        allVideos.push(video);
      }

      log(`📦 Collected ${allVideos.length} new videos so far (Page ${currentPage}/${totalPages})`);

      if (allVideos.length >= maxCollect) {
        log(`🎯 Collected enough new videos (${allVideos.length} >= ${maxCollect}). Stopping scrape.`);
        break;
      }

      currentPage++;
      retryCount = 0;

      // Delay between API calls
      if (currentPage <= totalPages) {
        await countdown(config.delays.betweenApiCalls, `API cooldown (page ${currentPage})`);
      }

      // Extra delay every 10 pages
      if (currentPage % 10 === 0 && currentPage <= totalPages) {
        await countdown(config.delays.betweenPages, `Extended cooldown after ${currentPage} pages`);
      }
    } catch (error) {
      retryCount++;
      logError(`Error on page ${currentPage} (retry ${retryCount}/${maxRetries})`, error);

      if (retryCount >= maxRetries) {
        log(`⚠️ Skipping page ${currentPage} after ${maxRetries} retries`);
        currentPage++;
        retryCount = 0;
      } else {
        // Increased from 10s to 20s — gives API server more time to recover from 503
        await countdown(20, `Retry cooldown`);
      }
    }
  }

  log(`\n✅ Scraping complete! Found ${allVideos.length} new videos across ${currentPage - startPage} pages`);
  return allVideos;
}

module.exports = {
  fetchPage,
  fetchAllVideos,
  parseVideo,
  getDirectDownloadUrl,
  formatBytes,
  countdown,
};