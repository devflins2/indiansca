// ============================================================
// XFREEHD SCRAPER + TELEGRAM UPLOADER — CLEAN VERSION
// No MongoDB | No Workers | Straight Pipeline
// ============================================================

import dotenv from 'dotenv';
dotenv.config();

// ━━━ GLOBAL CRASH PREVENTION ━━━
process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason);
    if (msg.includes('TIMEOUT') || msg.includes('FLOOD') || msg.includes('_updateLoop')) return;
    console.error('⚠️  Unhandled:', msg);
});
process.on('uncaughtException', (err) => {
    const msg = err?.message || String(err);
    if (msg.includes('TIMEOUT') || msg.includes('FLOOD')) return;
    console.error('⚠️  Uncaught:', msg);
});

import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import ytDlp from 'yt-dlp-exec';
const ytDlpExec = ytDlp.exec;
import ffmpeg from 'fluent-ffmpeg';
import input from 'input';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
chromium.use(stealth());

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
    // Channels
    CHANNEL_ID_KEYWORDS:    process.env.CHANNEL_ID_KEYWORDS,
    CHANNEL_ID_DEFLORATION: process.env.CHANNEL_ID_DEFLORATION,

    // Scraping
    TARGET_DOMAIN:           (process.env.TARGET_DOMAIN || '').replace(/\/$/, ''),
    KEYWORDS:                (process.env.KEYWORDS || '').split(',').map(k => k.trim()).filter(Boolean),
    SEARCH_URL_DEFLORATION:  process.env.SEARCH_URL_DEFLORATION,
    MAX_PAGES_DEFLORATION:   50,
    DELAY_BETWEEN_PAGES:     5000,  // 5 sec between page loads

    // Download/Upload
    DOWNLOAD_PATH:           path.join(__dirname, 'downloads'),
    THUMB_PATH:              path.join(__dirname, 'thumbs'),
    MAX_FILE_SIZE:           '1900M',
    MAX_RETRIES:             3,

    // Timing
    DELAY_BETWEEN_VIDEOS:   10 * 1000,      // 10 sec between videos
    REST_AFTER_PAGE:        15 * 60 * 1000, // 15 min rest after each page batch

    // Telegram
    API_ID:         parseInt(process.env.API_ID),
    API_HASH:       process.env.API_HASH,
    PHONE:          process.env.PHONE,
    STRING_SESSION: process.env.STRING_SESSION || '',

    // Duplicate tracking file (no MongoDB needed)
    SEEN_FILE: path.join(__dirname, 'seen.json'),
};

// ============================================================
// DUPLICATE TRACKING — Simple JSON file
// ============================================================
function loadSeen() {
    try {
        return new Set(JSON.parse(fs.readFileSync(CONFIG.SEEN_FILE, 'utf8')));
    } catch {
        return new Set();
    }
}

function markSeen(url) {
    const seen = loadSeen();
    seen.add(url);
    fs.writeFileSync(CONFIG.SEEN_FILE, JSON.stringify([...seen]));
}

function isSeen(url) {
    return loadSeen().has(url);
}

// ============================================================
// TELEGRAM CLIENT
// ============================================================
let tgClient = null;

async function getTelegramClient() {
    if (tgClient) {
        if (!tgClient.connected) {
            await tgClient.connect();
        }
        return tgClient;
    }

    const forceNewSession = process.argv.includes('--gen-session');
    const sessionString = forceNewSession ? '' : CONFIG.STRING_SESSION;

    tgClient = new TelegramClient(
        new StringSession(sessionString),
        CONFIG.API_ID,
        CONFIG.API_HASH,
        {
            connectionRetries: 10,
            retryDelay: 3000,
            autoReconnect: true,
            requestRetries: 5,
            floodSleepThreshold: 60,
        }
    );

    await tgClient.start({
        phoneNumber: async () => CONFIG.PHONE || await input.text('Phone Number (e.g. +919876543210): '),
        password:    async () => await input.text('2FA Password: '),
        phoneCode:   async () => await input.text('OTP Code: '),
        onError:     (err) => console.error('TG Error:', err.message),
    });

    const session = tgClient.session.save();
    if (session) {
        const envPath = path.join(__dirname, '.env');
        if (fs.existsSync(envPath)) {
            let env = fs.readFileSync(envPath, 'utf8');
            
            if (env.includes('STRING_SESSION=')) {
                env = env.replace(/^STRING_SESSION=.*$/m, `STRING_SESSION=${session}`);
            } else {
                env += `\nSTRING_SESSION=${session}`;
            }
            
            fs.writeFileSync(envPath, env);
            console.log('\n🔑 Naya STRING_SESSION automatically .env mein save ho gaya hai!');
        } else {
            console.log('\n🔑 Telegram Session is live!');
        }
    }

    console.log('✅ Telegram Connected!');
    return tgClient;
}

// ============================================================
// SCRAPER — Ek page ke videos fetch karo
// ============================================================
async function scrapePage(page, url, label) {
    console.log(`\n🔍 Scraping: ${label}`);
    console.log(`   URL: ${url}`);

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(CONFIG.DELAY_BETWEEN_PAGES);

        const videos = await page.evaluate((domain) => {
            const cards = document.querySelectorAll('a.video-link, .thumb-block a, .video-item a, .video-thumb a');
            return Array.from(cards).map(el => {
                const href = el.getAttribute('href') || '';
                const titleEl =
                    el.querySelector('h6') ||
                    el.querySelector('.title') ||
                    el.querySelector('span.title') ||
                    el.querySelector('.video-title') ||
                    el.querySelector('strong') ||
                    el.querySelector('span');

                const title =
                    titleEl?.innerText?.trim() ||
                    titleEl?.textContent?.trim() ||
                    el.getAttribute('title') ||
                    el.querySelector('img')?.getAttribute('alt') ||
                    el.textContent?.trim() || '';

                return {
                    title: title.slice(0, 200) || 'Untitled',
                    url: href.startsWith('http') ? href : domain + href
                };
            }).filter(v => v.url && v.url.includes('/video/') && v.title !== 'Untitled');
        }, CONFIG.TARGET_DOMAIN);

        console.log(`✅ Found: ${videos.length} videos`);
        return videos;
    } catch (err) {
        console.error(`❌ Scrape error: ${err.message}`);
        return [];
    }
}

// ============================================================
// DOWNLOADER
// ============================================================
async function downloadVideo(videoPageUrl, outputPath, title, statusMsgId, channelId) {
    const client = tgClient;

    console.log(`\n⬇️  Downloading: ${title}`);
    console.log(`   From: ${videoPageUrl}`);

    return new Promise((resolve, reject) => {
        let lastTerminalUpdate = 0;
        let lastTgUpdate = 0;

        const proc = ytDlpExec(videoPageUrl, {
            output: outputPath,
            noWarnings: true,
            noCheckCertificates: true,
            addHeader: [`referer:${CONFIG.TARGET_DOMAIN}`],
            format: 'bestvideo+bestaudio/best',
            maxFilesize: CONFIG.MAX_FILE_SIZE,
            mergeOutputFormat: 'mp4',
        });

        proc.stdout?.on('data', (chunk) => {
            const text = chunk.toString();
            const match = text.match(/\[download\]\s+([\d\.]+)%/);
            if (match) {
                const pct = parseFloat(match[1]).toFixed(1);
                const now = Date.now();

                if (now - lastTerminalUpdate > 10000) {
                    lastTerminalUpdate = now;
                    console.log(`   ⬇️  Downloading: ${pct}%`);
                }

                if (statusMsgId && client && now - lastTgUpdate > 10000) {
                    lastTgUpdate = now;
                    client.editMessage(channelId, {
                        message: statusMsgId,
                        text: `⬇️ **Downloading...**\n\n🎬 ${title}\n\n⏳ ${pct}%`,
                        parseMode: 'md'
                    }).catch(() => {});
                }
            }
        });

        proc.stderr?.on('data', (chunk) => {
            const t = chunk.toString();
            if (t.includes('ERROR')) console.error(`\n❌ yt-dlp: ${t.trim()}`);
        });

        proc.on('close', (code) => {
            process.stdout.write('\n');
            if (code === 0) {
                console.log(`✅ Download complete!`);
                resolve();
            } else {
                reject(new Error(`yt-dlp exit code ${code}`));
            }
        });

        proc.on('error', reject);
    });
}

// ============================================================
// THUMBNAIL
// ============================================================
async function generateThumbnail(videoPath, hash) {
    if (!fs.existsSync(CONFIG.THUMB_PATH)) {
        fs.mkdirSync(CONFIG.THUMB_PATH, { recursive: true });
    }
    const thumbPath = path.join(CONFIG.THUMB_PATH, `${hash}.jpg`);
    return new Promise((resolve) => {
        ffmpeg(videoPath)
            .screenshots({ count: 1, folder: CONFIG.THUMB_PATH, filename: `${hash}.jpg`, timemarks: ['10%'] })
            .on('end', () => resolve(thumbPath))
            .on('error', () => resolve(null));
    });
}

// ============================================================
// PROCESS ONE VIDEO — Download + Upload
// ============================================================
async function processOneVideo(video, channelId, tags) {
    const { title, url } = video;

    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║ 🎬 Processing: ${title.slice(0, 34)}`);
    console.log(`╚══════════════════════════════════════════╝`);

    // Ensure dirs exist
    if (!fs.existsSync(CONFIG.DOWNLOAD_PATH)) fs.mkdirSync(CONFIG.DOWNLOAD_PATH, { recursive: true });

    const hash     = Buffer.from(url).toString('base64').replace(/[^a-z0-9]/gi, '').slice(0, 32);
    const filePath = path.join(CONFIG.DOWNLOAD_PATH, `${hash}.mp4`);
    let thumbPath  = null;
    let statusMsgId = null;

    try {
        console.log(`🔗 Connecting to Telegram...`);
        const client = await getTelegramClient();

        // ━━━ STEP 1: Send link to your Telegram DM (Saved Messages) ━━━
        console.log(`📤 Sending direct link to your DM (Saved Messages)...`);
        const dmText = `🌟 **NEW VIDEO SCRAPED** 🌟\n\n🎬 **Title:** ${title}\n🔗 **Link:** ${url}\n\n🏷️ **Tags:** ${tags}`;
        await client.sendMessage('me', {
            message: dmText,
            parseMode: 'md',
            linkPreview: true
        }).catch(err => console.warn(`⚠️ DM send failed: ${err.message}`));

        // ━━━ STEP 2: Send Channel Status Message ━━━
        try {
            const msg = await client.sendMessage(channelId, {
                message: `⬇️ **Downloading...**\n\n🎬 ${title}\n\n⏳ Starting...`,
                parseMode: 'md'
            });
            statusMsgId = msg.id;
            console.log(`✅ Status message sent! (ID: ${statusMsgId})`);
        } catch (e) {
            console.warn(`⚠️ Status message send fail: ${e.message}`);
        }

        // ━━━ STEP 3: Download Video File ━━━
        await downloadVideo(url, filePath, title, statusMsgId, channelId);

        if (!fs.existsSync(filePath)) throw new Error('File nahi bani after download.');
        const { size } = fs.statSync(filePath);
        if (size < 100000) throw new Error(`File too small: ${size} bytes`);
        console.log(`   Size: ${(size / 1024 / 1024).toFixed(1)} MB`);

        // ━━━ STEP 4: Generate Thumbnail ━━━
        console.log(`\n🖼️ [2/3] Thumbnail...`);
        thumbPath = await generateThumbnail(filePath, hash);

        // Update Channel Status to Uploading
        if (statusMsgId) {
            await client.editMessage(channelId, {
                message: statusMsgId,
                text: `📤 **Uploading...**\n\n🎬 ${title}\n\n⏳ 0%`,
                parseMode: 'md'
            }).catch(() => {});
        }

        // ━━━ STEP 5: Upload Video to Channel ━━━
        console.log(`\n📤 [3/3] Uploading to Telegram Channel...`);
        const caption = `🎬 **${title}**\n\n${tags}`;
        let lastUploadUpdate = 0;
        let uploadedMsg = null;

        for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
            try {
                uploadedMsg = await client.sendFile(channelId, {
                    file: filePath,
                    thumb: thumbPath || undefined,
                    caption,
                    parseMode: 'md',
                    supportsStreaming: true,
                    workers: 4,
                    progressCallback: (uploaded, total) => {
                        if (total > 0) {
                            const pct = ((uploaded / total) * 100).toFixed(1);
                            const now = Date.now();
                             if (now - lastUploadUpdate > 10000) {
                                lastUploadUpdate = now;
                                console.log(`   📤 Uploading: ${pct}%`);
                            }
                            if (statusMsgId && now - lastUploadUpdate > 10000) {
                                client.editMessage(channelId, {
                                    message: statusMsgId,
                                    text: `📤 **Uploading...**\n\n🎬 ${title}\n\n⏳ ${pct}%`,
                                    parseMode: 'md'
                                }).catch(() => {});
                            }
                        }
                    }
                });
                break;
            } catch (e) {
                console.error(`\n❌ Upload fail (attempt ${attempt}/${CONFIG.MAX_RETRIES}): ${e.message}`);
                if (attempt >= CONFIG.MAX_RETRIES) throw e;
                await sleep(5000 * attempt);
            }
        }

        // Delete channel status message
        if (statusMsgId) {
            await client.deleteMessages(channelId, [statusMsgId], { revoke: true }).catch(() => {});
        }

        console.log(`\n🎉 DONE! "${title}" uploaded to channel! (Msg ID: ${uploadedMsg.id})`);

        // Mark as seen (duplicate prevention) ONLY after 100% successful process!
        markSeen(url);
        return true;

    } catch (err) {
        console.error(`\n❌ FAILED: ${title}\n   Reason: ${err.message}`);

        // Delete status message on failure
        if (statusMsgId && tgClient) {
            await tgClient.deleteMessages(channelId, [statusMsgId], { revoke: true }).catch(() => {});
        }
        return false;

    } finally {
        // Cleanup files
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
    }
}

// ============================================================
// MAIN PIPELINE
// ============================================================
async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function main() {
    console.log('\n🚀 ══════════════════════════════════');
    console.log('🚀  XFreeHD BOT — CLEAN VERSION');
    console.log('🚀 ══════════════════════════════════\n');

    // Express server (Render ke liye)
    const app = express();
    app.get('/', (_, res) => res.send('Bot is running!'));
    app.listen(process.env.PORT || 3000, () =>
        console.log(`🌐 Server port ${process.env.PORT || 3000} pe chal raha hai\n`)
    );

    // Session generation mode
    if (process.argv.includes('--gen-session')) {
        await getTelegramClient();
        console.log('✅ Session ready. Ab normal start karo.');
        process.exit(0);
    }

    console.log(`📋 Config:`);
    console.log(`   Keywords: ${CONFIG.KEYWORDS.join(', ')}`);
    console.log(`   Defloration pages: ${CONFIG.MAX_PAGES_DEFLORATION}`);
    console.log(`   Delay between videos: ${CONFIG.DELAY_BETWEEN_VIDEOS / 1000}s`);
    console.log(`   Rest after page: ${CONFIG.REST_AFTER_PAGE / 60000} min\n`);

    console.log('🔗 Connecting to Telegram...');
    await getTelegramClient();

    // Launch browser
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const context = await browser.newContext();
    const page    = await context.newPage();

    let deflPage     = 1;
    let deflDone     = false;
    let kwIndex      = 0;
    const keywords   = [...CONFIG.KEYWORDS];
    let totalUploaded = 0;
    let totalFailed   = 0;
    let totalSkipped  = 0;

    // ━━━ MAIN LOOP ━━━
    while (!deflDone || kwIndex < keywords.length) {

        // ─── Defloration Page ───
        if (!deflDone) {
            const url    = `${CONFIG.SEARCH_URL_DEFLORATION}&page=${deflPage}`;
            const videos = await scrapePage(page, url, `Defloration Page ${deflPage}`);

            if (videos.length === 0) {
                console.log(`\n⏹️  Defloration khatam! Koi naya page nahi.`);
                deflDone = true;
            } else {
                let pageUploaded = 0;
                for (const video of videos) {
                    if (isSeen(video.url)) {
                        console.log(`  ⏭️  Skip (already done): ${video.title}`);
                        totalSkipped++;
                        continue;
                    }

                    const ok = await processOneVideo(
                        video,
                        CONFIG.CHANNEL_ID_DEFLORATION,
                        '#defloration #teen #virgin #18plus'
                    );

                    if (ok) { totalUploaded++; pageUploaded++; }
                    else    { totalFailed++; }

                    if (videos.indexOf(video) < videos.length - 1) {
                        console.log(`\n⏳ Next video se pehle ${CONFIG.DELAY_BETWEEN_VIDEOS / 1000}s wait...`);
                        await sleep(CONFIG.DELAY_BETWEEN_VIDEOS);
                    }
                }

                console.log(`\n📊 Defloration Page ${deflPage}: ${pageUploaded} uploaded`);

                if (pageUploaded > 0) {
                    console.log(`\n😴 Page done! ${CONFIG.REST_AFTER_PAGE / 60000} min rest...`);
                    await sleep(CONFIG.REST_AFTER_PAGE);
                    console.log(`▶️  Rest khatam! Agla page...\n`);
                }

                deflPage++;
            }
        }

        // ─── Keyword ───
        if (kwIndex < keywords.length) {
            const keyword = keywords[kwIndex];
            const url     = `${CONFIG.TARGET_DOMAIN}/search?search_query=${encodeURIComponent(keyword)}&search_type=videos&o=tf&page=1`;
            const videos  = await scrapePage(page, url, `Keyword: ${keyword}`);

            if (videos.length === 0) {
                console.log(`  ⏭️  "${keyword}" mein koi video nahi. Next keyword...`);
            } else {
                let pageUploaded = 0;
                for (const video of videos) {
                    if (isSeen(video.url)) {
                        console.log(`  ⏭️  Skip (already done): ${video.title}`);
                        totalSkipped++;
                        continue;
                    }

                    const ok = await processOneVideo(
                        video,
                        CONFIG.CHANNEL_ID_KEYWORDS,
                        `#${keyword.replace(/\s+/g, '')} #desi #indian #18plus`
                    );

                    if (ok) { totalUploaded++; pageUploaded++; }
                    else    { totalFailed++; }

                    if (videos.indexOf(video) < videos.length - 1) {
                        console.log(`\n⏳ Next video se pehle ${CONFIG.DELAY_BETWEEN_VIDEOS / 1000}s wait...`);
                        await sleep(CONFIG.DELAY_BETWEEN_VIDEOS);
                    }
                }

                console.log(`\n📊 Keyword "${keyword}": ${pageUploaded} uploaded`);

                if (pageUploaded > 0) {
                    console.log(`\n😴 Keyword done! ${CONFIG.REST_AFTER_PAGE / 60000} min rest...`);
                    await sleep(CONFIG.REST_AFTER_PAGE);
                    console.log(`▶️  Rest khatam! Agla keyword...\n`);
                }
            }

            kwIndex++;
        }
    }

    await browser.close();

    console.log(`\n🎉 ══ ALL DONE! ══`);
    console.log(`   ✅ Uploaded: ${totalUploaded}`);
    console.log(`   ❌ Failed:   ${totalFailed}`);
    console.log(`   ⏭️  Skipped:  ${totalSkipped}`);
    console.log(`\n⏳ 30 min baad wapas shuru hoga...`);

    await sleep(30 * 60 * 1000);

    // Restart
    console.log('\n🔄 Restarting...\n');
    await main();
}

main().catch(err => console.error('💥 Fatal:', err.message));