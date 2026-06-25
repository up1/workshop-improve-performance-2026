/**
 * initial_cache.js
 * ----------------------------------------------------------------------------
 * Warmup script: โหลด user_id ของผู้ใช้ที่ active จาก Postgres (table: users)
 * เข้าไปไว้ใน Redis ล่วงหน้า เพื่อให้ POST /login/cache เป็น cache hit ตั้งแต่
 * request แรก (ลด cold-start load ที่ยิงตรงไป Postgres ตอน traffic spike)
 *
 * วิธีรัน:
 *   node initial_cache.js
 *
 * ปรับแต่งผ่าน env:
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS
 *   REDIS_URL            (default redis://localhost:6379)
 *   WARMUP_BATCH_SIZE    (default 5000)  จำนวน row ต่อรอบ
 *   WARMUP_LIMIT         (default 0 = ทั้งหมด) จำกัดจำนวน user ที่ warmup
 *
 * ----------------------------------------------------------------------------
 * PII & Data Privacy
 * ----------------------------------------------------------------------------
 * - คอลัมน์ที่ "อนุญาต" ให้แคชได้: id, password_hash (bcrypt = hash ทางเดียว)
 * - คอลัมน์ที่ "ห้าม" แคช (PII): ชื่อจริง, อีเมล, เบอร์โทร, เลขบัตร ฯลฯ
 *   จึงเลือก SELECT เฉพาะคอลัมน์ที่จำเป็น และมี allowlist กันเผลอใส่ PII ลง cache
 * - username ใช้เป็นส่วนหนึ่งของ cache key เท่านั้น (ไม่ถูกเก็บเป็น value)
 * - warmup เฉพาะ user ที่ active = true
 */

const { Pool } = require("pg");
const {
    createRedisClient,
    userCacheKey,
    USER_CACHE_TTL_SECONDS,
} = require("./login_cache");

// คอลัมน์ที่อนุญาตให้นำไปเก็บใน Redis (กันเผลอ cache ข้อมูล PII)
const CACHEABLE_FIELDS = ["id", "password_hash"];

const BATCH_SIZE = parseInt(process.env.WARMUP_BATCH_SIZE) || 5000;
const WARMUP_LIMIT = parseInt(process.env.WARMUP_LIMIT) || 0; // 0 = ทั้งหมด

// คัดเฉพาะ field ที่อยู่ใน allowlist ออกมาเป็น cache value
function toCacheValue(row) {
    const value = {};
    for (const field of CACHEABLE_FIELDS) {
        value[field] = row[field];
    }
    return value;
}

function createPool() {
    return new Pool({
        host: process.env.DB_HOST || "localhost",
        port: parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || "orders",
        user: process.env.DB_USER || "user",
        password: process.env.DB_PASS || "pass",
        max: parseInt(process.env.POOL_MAX) || 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
    });
}

async function warmup() {
    const pool = createPool();
    const redis = createRedisClient();
    await redis.connect();

    let lastId = 0; // keyset pagination (เร็วกว่า OFFSET บนตารางใหญ่)
    let total = 0;
    const startedAt = Date.now();

    console.log(
        `Warmup started: batch=${BATCH_SIZE} ttl=${USER_CACHE_TTL_SECONDS}s ` +
            `limit=${WARMUP_LIMIT || "all"}`
    );

    try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            // SELECT เฉพาะคอลัมน์ที่จำเป็น — ไม่มี PII
            // keyset pagination: WHERE id > lastId ORDER BY id
            const result = await pool.query(
                `SELECT id, username, password_hash
         FROM users
         WHERE active = true
         AND id > $1
         ORDER BY id
         LIMIT $2`,
                [lastId, BATCH_SIZE]
            );

            if (result.rows.length === 0) {
                break;
            }

            // ใช้ pipeline (multi) เพื่อยิงหลาย SET ในรอบเดียว ลด round-trip
            const pipeline = redis.multi();
            for (const row of result.rows) {
                pipeline.set(
                    userCacheKey(row.username),
                    JSON.stringify(toCacheValue(row)),
                    { EX: USER_CACHE_TTL_SECONDS }
                );
                lastId = row.id;
            }
            await pipeline.exec();

            total += result.rows.length;
            if (total % (BATCH_SIZE * 10) === 0) {
                console.log(`  cached ${total} users... (lastId=${lastId})`);
            }

            if (WARMUP_LIMIT && total >= WARMUP_LIMIT) {
                break;
            }
        }

        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`Warmup done: ${total} users cached in ${seconds}s`);
    } catch (err) {
        console.error("warmup error:", err.message);
        process.exitCode = 1;
    } finally {
        await redis.quit().catch(() => {});
        await pool.end().catch(() => {});
    }
}

warmup();
