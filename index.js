// ============================================================
// XFREEHD SCRAPER + TELEGRAM UPLOADER (FULL MERGED)
// Tech: Node.js + Playwright + GramJS + MongoDB + BullMQ
// ============================================================

import dotenv from 'dotenv';
dotenv.config();

import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import mongoose from 'mongoose';

import { createHash } from 'crypto';
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
// CONFIG — SIRF YAHAN LINK CHANGE KARO
// ============================================================
const CONFIG = {
    // .env file se configurations load ho rahe hain
    CHANNEL_ID_KEYWORDS: process.env.CHANNEL_ID_KEYWORDS,
    CHANNEL_ID_DEFLORATION: process.env.CHANNEL_ID_DEFLORATION,
    TARGET_DOMAIN: (process.env.TARGET_DOMAIN || '').includes('beta.xf') ? (process.env.TARGET_DOMAIN || '').replace('beta.xf', 'beta.xfreehd.com') : process.env.TARGET_DOMAIN,
    KEYWORDS: (process.env.KEYWORDS || "").split(',').map(k => k.trim()).filter(Boolean),
    SEARCH_URL_DEFLORATION: process.env.SEARCH_URL_DEFLORATION,
    MAX_PAGES_DEFLORATION: 50, // Wapas 50 kar diya taaki alternating poora chal sake
    MAX_PAGES_KEYWORDS: 1,    // Har keyword ka 1 page

    DOWNLOAD_PATH: path.join(__dirname, 'downloads'),
    THUMB_PATH: path.join(__dirname, 'thumbs'),
    TEST_MODE: false, 
    DELAY_BETWEEN_UPLOADS: 30 * 1000, // 30 seconds ka gap har video ke beech
    UPLOAD_SESSION_DURATION: 15 * 60 * 1000, // 15 minutes tak lagatar upload karega
    UPLOAD_REST_DURATION: 15 * 60 * 1000, // 15 minute ka lamba rest lega ban se bachne ke liye
    DELAY_BETWEEN_PAGES: 5000,      // 5 sec delay (Website ban / IP block se bachne ke liye)
    MAX_FILE_SIZE: '1900M',         // Telegram ki maximum 2GB limit hoti hai, toh hum 1.9GB tak allow kar rahe hain
    MAX_RETRIES: 3,

    // Telegram
    API_ID: parseInt(process.env.API_ID),
    API_HASH: process.env.API_HASH,
    PHONE: process.env.PHONE,
    STRING_SESSION: process.env.STRING_SESSION || '',

    // MongoDB
    MONGO_URI: process.env.MONGO_URI,

};

// ============================================================
// MONGODB SETUP + SCHEMA
// ============================================================
const videoSchema = new mongoose.Schema({
    hash: { type: String, unique: true },
    title: String,
    originalUrl: String,
    directUrl: String,
    fileId: String,
    messageId: Number,
    channelId: String,
    tags: String,
    status: { type: String, default: 'pending' },  // pending | uploaded | failed
    uploadedAt: { type: Date, default: Date.now },
    retries: { type: Number, default: 0 },
    error: String,
});

const Video = mongoose.model('Video', videoSchema);

async function connectDB() {
    await mongoose.connect(CONFIG.MONGO_URI);
    console.log('✅ MongoDB Connected');
}

function generateHash(url, title) {
    return createHash('md5').update(url + title).digest('hex');
}

async function isDuplicate(url, title) {
    const hash = generateHash(url, title);
    const exists = await Video.findOne({ hash });
    return { isDup: !!exists, hash };
}

async function saveVideo(data) {
    try {
        await Video.create(data);
    } catch (e) {
        if (e.code !== 11000) throw e; // ignore duplicate key error
    }
}

async function updateVideo(hash, update) {
    await Video.updateOne({ hash }, { $set: update });
}

// ============================================================
// SINGLE PAGE SCRAPER (FAST & ALTERNATING)
// ============================================================
async function scrapeSinglePage(page, url, topicName) {
    console.log(`\n🔍 Scraping: ${topicName}`);
    
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(CONFIG.DELAY_BETWEEN_PAGES);

        const videoCount = await page.$$eval('a.video-link', els => els.length).catch(() => 0);
        if (videoCount === 0) {
            console.log(`⚠️  Koi video nahi mila.`);
            return [];
        }

        const videos = await page.evaluate((domain) => {
            const cards = document.querySelectorAll('a.video-link, .thumb-block a, .video-item a');
            return Array.from(cards).map(el => {
                const href = el.getAttribute('href') || '';
                const titleEl = el.querySelector('h6, .title, span.title, p.title');
                return {
                    title: titleEl?.innerText?.trim() || el.getAttribute('title') || 'Untitled',
                    url: href.startsWith('http') ? href : domain + href
                };
            }).filter(v => v.url && v.url.includes('/video/'));
        }, CONFIG.TARGET_DOMAIN);

        console.log(`✅ Found: ${videos.length} videos`);
        return videos;
    } catch (err) {
        console.error(`❌ Page error:`, err.message);
        return [];
    }
}

// ============================================================
// DOWNLOADER
// ============================================================
async function downloadVideo(directUrl, filename, videoPageUrl, statusMsgId, client, channelId, title) {
    const outputPath = path.join(CONFIG.DOWNLOAD_PATH, filename);

    if (!fs.existsSync(CONFIG.DOWNLOAD_PATH)) {
        fs.mkdirSync(CONFIG.DOWNLOAD_PATH, { recursive: true });
    }

    console.log(`⬇️  Downloading: ${filename}`);

    return new Promise((resolve, reject) => {
        let lastUpdate = 0;

        const subprocess = ytDlpExec(videoPageUrl, {
            output: outputPath,
            noWarnings: true,
            noCheckCertificates: true,
            addHeader: [`referer:${CONFIG.TARGET_DOMAIN}`],
            format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            maxFilesize: CONFIG.MAX_FILE_SIZE,
            mergeOutputFormat: 'mp4',
        });

        let lastTerminalUpdate = 0;

        subprocess.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            const match = text.match(/\[download\]\s+([\d\.]+)%/);
            if (match) {
                const pct = match[1];
                
                const now = Date.now();
                
                if (now - lastTerminalUpdate > 20000) { // Sirf 20 second mein ek baar terminal pe dikhaye taaki spam na ho
                    lastTerminalUpdate = now;
                    console.log(`⬇️ Download Progress: ${pct}%`);
                }

                // 10 second throttle for Telegram edit
                if (statusMsgId && client && (now - lastUpdate > 10000)) {
                    lastUpdate = now;
                    client.editMessage(channelId, {
                        message: statusMsgId,
                        text: `⬇️ **Downloading Video...**\n⏳ Progress: ${pct}%\n\n🎬 ${title}`,
                        parseMode: 'md'
                    }).catch(()=>{});
                }
            }
        });

        subprocess.on('close', (code) => {
            process.stdout.write('\n');
            if (code === 0) resolve(outputPath);
            else reject(new Error(`yt-dlp failed with code ${code}`));
        });

        subprocess.on('error', (err) => reject(err));
    });
}

// ============================================================
// THUMBNAIL GENERATOR
// ============================================================
async function generateThumbnail(videoPath, hash) {
    if (!fs.existsSync(CONFIG.THUMB_PATH)) {
        fs.mkdirSync(CONFIG.THUMB_PATH, { recursive: true });
    }

    const thumbPath = path.join(CONFIG.THUMB_PATH, `${hash}.jpg`);

    return new Promise((resolve) => {
        ffmpeg(videoPath)
            .screenshots({
                count: 1,
                folder: CONFIG.THUMB_PATH,
                filename: `${hash}.jpg`,
                timemarks: ['10%']
            })
            .on('end', () => resolve(thumbPath))
            .on('error', () => resolve(null));
    });
}

// ============================================================
// TELEGRAM CLIENT SETUP
// ============================================================
let tgClient = null;

async function getTelegramClient() {
    if (tgClient?.connected) return tgClient;

    tgClient = new TelegramClient(
        new StringSession(CONFIG.STRING_SESSION),
        CONFIG.API_ID,
        CONFIG.API_HASH,
        {
            connectionRetries: -1,          // Unlimited retries (kabhi give up mat kar)
            retryDelay: 3000,               // 3 sec wait between retries
            autoReconnect: true,
            requestRetries: 5,              // Har request 5 baar retry karega
            keepAliveInterval: 10000,       // Har 10 sec mein ping bhejega → idle disconnect nahi hoga
            floodSleepThreshold: 60,        // FloodWait errors ko auto handle karega
        }
    );

    await tgClient.start({
        phoneNumber: async () => CONFIG.PHONE,
        password: async () => await input.text('2FA Password (agar ho to): '),
        phoneCode: async () => await input.text('OTP Code: '),
        onError: (err) => console.error('TG Error:', err),
    });

    const session = tgClient.session.save();
    if (session && !CONFIG.STRING_SESSION) {
        console.log('\n🔑 STRING_SESSION (ise .env mein daal do):\n', session, '\n');
        // Auto .env mein save
        const envPath = path.join(__dirname, '.env');
        let envContent = fs.readFileSync(envPath, 'utf8');
        envContent = envContent.replace('STRING_SESSION=', `STRING_SESSION=${session}`);
        fs.writeFileSync(envPath, envContent);
        console.log('✅ Session .env mein save ho gaya!');
    }

    console.log('✅ Telegram Client Connected');
    return tgClient;
}

// ============================================================
// UPLOADER
// ============================================================
async function uploadToTelegram(videoPath, title, thumbPath, channelId, tags, statusMsgId) {
    const client = await getTelegramClient();

    const caption = [
        `🎬 **${title}**`,
        ``,
        tags,
    ].join('\n');

    let retries = 0;
    let lastUpdate = 0;
    let lastTerminalUpdate = 0;
    
    while (retries < CONFIG.MAX_RETRIES) {
        try {
            const message = await client.sendFile(channelId, {
                file: videoPath,
                thumb: thumbPath || undefined,
                caption: caption,
                parseMode: 'md',
                supportsStreaming: true,
                workers: 4,                     // Parallel upload workers
                progressCallback: (uploaded, total) => {
                    if (total > 0) {
                        const pct = ((uploaded / total) * 100).toFixed(1);

                        const now = Date.now();
                        if (now - lastTerminalUpdate > 20000) {
                            lastTerminalUpdate = now;
                            console.log(`📤 Telegram Uploading: ${pct}%`);
                        }

                        // 10 second throttle for Telegram edit
                        if (statusMsgId && (now - lastUpdate > 10000)) {
                            lastUpdate = now;
                            client.editMessage(channelId, {
                                message: statusMsgId,
                                text: `📤 **Uploading to Telegram...**\n⏳ Progress: ${pct}%\n\n🎬 ${title}`,
                                parseMode: 'md'
                            }).catch(()=>{});
                        }
                    }
                }
            });

            console.log(`✅ Uploaded: ${title} | Message ID: ${message.id}`);
            return message;
        } catch (err) {
            retries++;
            console.error(`\n❌ Upload failed (retry ${retries}/${CONFIG.MAX_RETRIES}):`, err.message);
            if (statusMsgId) {
                await client.editMessage(channelId, { message: statusMsgId, text: `❌ **Upload failed (retry ${retries}/${CONFIG.MAX_RETRIES})...**\n\n🎬 ${title}`, parseMode: 'md' }).catch(()=>{});
            }
            await sleep(5000 * retries);
        }
    }

    throw new Error(`Upload failed after ${CONFIG.MAX_RETRIES} retries`);
}

// ============================================================
// MONGODB QUEUE PROCESSOR
// ============================================================
async function processPendingVideos() {
    console.log('\n🚀 Starting to process pending videos from database...');

    // ⚡ Startup Recovery: Pichle crash mein 'processing' reh gayi videos ko wapas 'pending' karo
    const stuckCount = await Video.countDocuments({ status: 'processing' });
    if (stuckCount > 0) {
        await Video.updateMany({ status: 'processing' }, { $set: { status: 'pending' } });
        console.log(`🔧 Recovery: ${stuckCount} stuck 'processing' videos wapas 'pending' kar di gayi.`);
    }
    
    let lastUploadedChannel = null;
    let uploadStartTime = Date.now();

    while (true) {
        let video = null;

        // Alternating logic (1 Defloration -> 1 Keyword -> 1 Defloration...)
        if (lastUploadedChannel === CONFIG.CHANNEL_ID_KEYWORDS) {
            // Pichli baar keyword upload hua tha, ab defloration ki baari hai
            video = await Video.findOneAndUpdate({ status: 'pending', channelId: CONFIG.CHANNEL_ID_DEFLORATION }, { status: 'processing' }, { new: true });
            if (!video) video = await Video.findOneAndUpdate({ status: 'pending', channelId: CONFIG.CHANNEL_ID_KEYWORDS }, { status: 'processing' }, { new: true });
        } else {
            // Pichli baar defloration tha (ya first time hai), ab keyword ki baari hai
            video = await Video.findOneAndUpdate({ status: 'pending', channelId: CONFIG.CHANNEL_ID_KEYWORDS }, { status: 'processing' }, { new: true });
            if (!video) video = await Video.findOneAndUpdate({ status: 'pending', channelId: CONFIG.CHANNEL_ID_DEFLORATION }, { status: 'processing' }, { new: true });
        }
        
        // Agar dono mein kuch nahi mila toh queue empty hai
        if (!video) {
            console.log('\n😴 Abhi naye videos nahi hain. 30 seconds wait kar raha hoon...');
            await sleep(30000);
            continue; // Loop chalta rahega
        }

        // Sequence maintain karne ke liye record kar lo ki is baar konsa upload hone jaa raha hai
        lastUploadedChannel = video.channelId;

        console.log(`\n==========================================`);
        console.log(`⏳ Uploading next: ${video.title}`);
        console.log(`==========================================`);
        
        let videoPath = null;
        let thumbPath = null;
        let statusMsg = null;
        let tgClient = null;

        try {
            tgClient = await getTelegramClient();
            statusMsg = await tgClient.sendMessage(video.channelId, { message: `⬇️ **Downloading Video...**\n\n🎬 ${video.title}`, parseMode: 'md' });

            // 1. Download video
            const filename = `${video.hash}.mp4`;
            videoPath = await downloadVideo(video.directUrl, filename, video.originalUrl, statusMsg?.id, tgClient, video.channelId, video.title);

            if (!fs.existsSync(videoPath)) {
                throw new Error("File bahut badi thi (maxFilesize limit crossed) isliye skip kar di gayi.");
            }

            const stats = fs.statSync(videoPath);
            if (stats.size < 100000) { // Agar file 100KB se chhoti hai (matlab error aayi hai)
                throw new Error("File 0 bytes ya bahut chhoti download hui hai, yt-dlp error.");
            }

            // 2. Thumbnail generate karo
            thumbPath = await generateThumbnail(videoPath, video.hash);

            if (statusMsg) {
                await tgClient.editMessage(video.channelId, { message: statusMsg.id, text: `📤 **Uploading to Telegram...**\n\n🎬 ${video.title}`, parseMode: 'md' }).catch(()=>{});
            }

            // 3. Telegram pe upload karo
            const message = await uploadToTelegram(videoPath, video.title, thumbPath, video.channelId, video.tags, statusMsg?.id);

            // Upload complete, status message delete kardo
            if (statusMsg) {
                await tgClient.deleteMessages(video.channelId, [statusMsg.id], { revoke: true }).catch(()=>{});
                statusMsg = null;
            }

            // 4. DB mein update karo
            await updateVideo(video.hash, {
                status: 'uploaded',
                messageId: message.id,
                fileId: message.media?.document?.id?.toString() || '',
                uploadedAt: new Date()
            });

            console.log(`✅ Done: ${video.title}`);
            
            // Cleanup files right away
            if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
            if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

            console.log(`⏳ Waiting ${CONFIG.DELAY_BETWEEN_UPLOADS / 1000} seconds before next video...`);
            await sleep(CONFIG.DELAY_BETWEEN_UPLOADS);

            const timeElapsed = Date.now() - uploadStartTime;
            if (timeElapsed >= CONFIG.UPLOAD_SESSION_DURATION) {
                console.log(`\n⏸️ Bot ne pichle 15 minute se lagatar videos daale hain! Account safe rakhne ke liye ab ${CONFIG.UPLOAD_REST_DURATION / 60000} minute ka aaram karega... 😴`);
                await sleep(CONFIG.UPLOAD_REST_DURATION);
                uploadStartTime = Date.now(); // Timer wapas zero se shuru
                console.log(`\n▶️ Aaram poora hua! Wapas upload shuru kar raha hoon...\n`);
            }

        } catch (err) {
            console.error(`❌ Failed: ${video.title} | Error: ${err.message}`);
            
            // Cleanup on error
            if (statusMsg && tgClient) {
                await tgClient.deleteMessages(video.channelId, [statusMsg.id], { revoke: true }).catch(()=>{});
            }
            if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
            if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

            const retries = (video.retries || 0) + 1;
            if (retries >= CONFIG.MAX_RETRIES) {
                await updateVideo(video.hash, { status: 'failed', error: err.message, retries });
                console.log(`⚠️ Video failed permanently after ${CONFIG.MAX_RETRIES} retries.`);
            } else {
                // 🐛 BugFix: status wapas 'pending' karo taaki dobara pick ho sake
                await updateVideo(video.hash, { status: 'pending', retries, error: err.message });
                console.log(`🔄 Will retry later (Retry ${retries}/${CONFIG.MAX_RETRIES})`);
                await sleep(5000); // Wait a bit before picking up the next task
            }
        }
    }
}

// ============================================================
// UTILS
// ============================================================
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeFilename(name) {
    return name.replace(/[^a-z0-9\s]/gi, '').replace(/\s+/g, '_').slice(0, 50);
}

// ============================================================
// MAIN FUNCTION
// ============================================================
async function main() {
    console.log('🚀 XFreeHD Scraper + Telegram Uploader Starting...\n');

    // Dummy Express Server (Render Web Service ke liye zaroori hai taaki process fail na ho)
    const app = express();
    const port = process.env.PORT || 3000;
    app.get('/', (req, res) => res.send('Bot is running properly!'));
    app.listen(port, () => console.log(`🌐 Dummy Web Server running on port ${port} (For Render)`));

    // 1. DB Connect
    await connectDB();

    // 2. Gen session mode
    if (process.argv.includes('--gen-session')) {
        console.log('🔑 Session Generation Mode...');
        await getTelegramClient();
        console.log('✅ Session generate ho gaya, ab normal run karo.');
        process.exit(0);
    }

    if (CONFIG.TEST_MODE) {
        console.log("🛠️ TEST MODE ON: Sirf 1 round run hoga!");
    }

    // Start processor parallel mein taaki wait na karna pade
    processPendingVideos().catch(console.error);

    let newCount = 0;
    let dupCount = 0;
    let totalScraped = 0;

    // Launch single browser for fast alternating scraping
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Determine max rounds
    let maxRounds = Math.max(CONFIG.KEYWORDS.length, CONFIG.MAX_PAGES_DEFLORATION);
    if (CONFIG.TEST_MODE) maxRounds = 1;

    let stopDefloration = false;

    for (let i = 0; i < maxRounds; i++) {
        // 1. Defloration Scrape (Round i)
        if (i < CONFIG.MAX_PAGES_DEFLORATION && !stopDefloration) {
            const url = `${CONFIG.SEARCH_URL_DEFLORATION}&page=${i + 1}`;
            const videos = await scrapeSinglePage(page, url, `Defloration (Page ${i + 1})`);
            
            if (videos.length === 0) {
                stopDefloration = true;
                console.log(`⏹️ Defloration ke videos khatam! Ab aage ke pages skip kar raha hoon...`);
            } else {
                totalScraped += videos.length;
                
                for (const v of videos) {
                    const { isDup, hash } = await isDuplicate(v.url, v.title);
                    if (isDup) { dupCount++; continue; }
                    await saveVideo({
                        hash, title: v.title, originalUrl: v.url, directUrl: '',
                        channelId: CONFIG.CHANNEL_ID_DEFLORATION, tags: `#defloration #teen #virgin #18plus`, status: 'pending'
                    });
                    newCount++;
                }
            }
        }

        // 2. Keyword Scrape (Round i)
        if (i < CONFIG.KEYWORDS.length) {
            const keyword = CONFIG.KEYWORDS[i];
            const url = `${CONFIG.TARGET_DOMAIN}/search?search_query=${encodeURIComponent(keyword)}&search_type=videos&o=tf&page=1`;
            const videos = await scrapeSinglePage(page, url, `Keyword: ${keyword}`);
            totalScraped += videos.length;
            
            for (const v of videos) {
                const { isDup, hash } = await isDuplicate(v.url, v.title);
                if (isDup) { dupCount++; continue; }
                await saveVideo({
                    hash, title: v.title, originalUrl: v.url, directUrl: '',
                    channelId: CONFIG.CHANNEL_ID_KEYWORDS, tags: `#${keyword.replace(/\s+/g, '')} #desi #indian #18plus`, status: 'pending'
                });
                newCount++;
            }
        }
    }

    await browser.close();

    console.log(`\n📊 Total Summary:`);
    console.log(`   ✅ New Videos Added to Queue: ${newCount}`);
    console.log(`   🔁 Duplicates Skipped: ${dupCount}`);
    console.log(`   📦 Total Videos Scraped: ${totalScraped}`);
    console.log(`\n🎉 Scraping poori ho gayi hai!`);
    console.log(`⏳ Bot ab continuously background mein videos upload karta rahega (Ctrl+C dabane tak)\n`);
}

// ============================================================
// RUN
// ============================================================
main().catch(async (err) => {
    console.error('\n💥 Fatal Error:', err);
    await mongoose.disconnect();
    process.exit(1);
});