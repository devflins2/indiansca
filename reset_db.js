import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function resetStuckVideos() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ MongoDB Connected\n');

        const db = mongoose.connection.db;

        // Count before reset
        const processing = await db.collection('videos').countDocuments({ status: 'processing' });
        const failed = await db.collection('videos').countDocuments({ status: 'failed' });
        const pending = await db.collection('videos').countDocuments({ status: 'pending' });
        const uploaded = await db.collection('videos').countDocuments({ status: 'uploaded' });

        console.log('📊 Current DB Status:');
        console.log(`   🟡 processing : ${processing}`);
        console.log(`   🔴 failed     : ${failed}`);
        console.log(`   🟢 pending    : ${pending}`);
        console.log(`   ✅ uploaded   : ${uploaded}`);
        console.log('');

        // Reset 'processing' → 'pending'
        if (processing > 0) {
            const r1 = await db.collection('videos').updateMany(
                { status: 'processing' },
                { $set: { status: 'pending' } }
            );
            console.log(`🔧 Reset 'processing' → 'pending': ${r1.modifiedCount} videos`);
        }

        // Reset 'failed' → 'pending' (retries bhi 0 kar denge taaki fresh start ho)
        if (failed > 0) {
            const r2 = await db.collection('videos').updateMany(
                { status: 'failed' },
                { $set: { status: 'pending', retries: 0, error: '' } }
            );
            console.log(`🔧 Reset 'failed' → 'pending': ${r2.modifiedCount} videos`);
        }

        const newPending = await db.collection('videos').countDocuments({ status: 'pending' });
        console.log(`\n✅ Done! Ab ${newPending} videos 'pending' hain — bot restart karo aur upload shuru ho jaega!`);

    } catch (err) {
        console.error('❌ Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

resetStuckVideos();
