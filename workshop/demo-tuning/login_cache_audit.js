const express = require("express");
const bcrypt = require("bcrypt");

// reuse Redis client + cache key helpers จาก login_cache.js (DRY)
const {
    createRedisClient,
    userCacheKey,
    USER_CACHE_TTL_SECONDS,
} = require("./login_cache");

// ----------------------------------------------------------------------------
// Audit buffer config (Redis-first, async flush to Postgres)
// ----------------------------------------------------------------------------
// แนวคิด: เขียน login_audit ลง Redis (list) ก่อน แล้ว batch flush ลง Postgres
//  - request หลักไม่ต้องรอ INSERT Postgres ต่อ row (ลด latency)
//  - รวม rows เป็น 1 INSERT (bulk) ลดจำนวน round-trip + write load ของ Postgres
//  - ลด write spike ตอน traffic สูง โดยใช้ Redis เป็น write-buffer ชั่วคราว
const AUDIT_QUEUE_KEY = process.env.AUDIT_QUEUE_KEY || "login:audit:queue";
// จำนวน row สูงสุดต่อรอบ flush (bulk INSERT)
const AUDIT_FLUSH_BATCH = parseInt(process.env.AUDIT_FLUSH_BATCH) || 500;
// ความถี่ในการ flush (ms)
const AUDIT_FLUSH_INTERVAL_MS =
    parseInt(process.env.AUDIT_FLUSH_INTERVAL_MS) || 1000;

/**
 * เขียน audit log ลง Redis ก่อน (fire-and-forget) — ไม่ block response หลัก
 * เก็บเป็น JSON string ใน Redis list (RPUSH) เพื่อให้ flusher มา drain ทีหลัง
 */
function pushAuditToRedis(redis, { userId, username, success }) {
    const record = JSON.stringify({
        user_id: userId || null,
        username,
        success,
        // เก็บเวลาที่เกิดเหตุการณ์จริง (ตอน request) ไม่ใช่ตอน flush
        created_at: new Date().toISOString(),
    });

    // RPUSH แบบ fire-and-forget — ถ้า Redis ล่ม จะไม่กลับไป block request หลัก (at-most-once)
    redis
        .rPush(AUDIT_QUEUE_KEY, record)
        .catch((err) => console.error("audit rpush error:", err.message));
}

/**
 * drain audit queue จาก Redis แล้ว bulk INSERT ลง Postgres
 * เรียกซ้ำ ๆ จาก setInterval (background worker)
 */
async function flushAuditBatch(pool, redis) {
    try {
        // ดึงออกมาทีละ batch ด้วย LPOP count (node-redis v6 รองรับ count)
        // atomic pop ฝั่ง Redis กัน worker หลายตัวหยิบ row ซ้ำกัน
        const items = await redis.lPopCount(AUDIT_QUEUE_KEY, AUDIT_FLUSH_BATCH);

        if (!items || items.length === 0) {
            return; // ไม่มีอะไรให้ flush
        }

        // แปลง JSON string -> object (ข้าม record ที่ parse พัง)
        const rows = [];
        for (const item of items) {
            try {
                rows.push(JSON.parse(item));
            } catch (err) {
                console.error("audit parse error:", err.message);
            }
        }

        if (rows.length === 0) {
            return;
        }

        // สร้าง bulk INSERT: INSERT ... VALUES ($1,$2,$3,$4),($5,$6,$7,$8),...
        const values = [];
        const placeholders = rows.map((row, i) => {
            const base = i * 4;
            values.push(
                row.user_id,
                row.username,
                row.success,
                row.created_at
            );
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
        });

        await pool.query(
            `INSERT INTO login_audit(user_id, username, success, created_at)
       VALUES ${placeholders.join(", ")}`,
            values
        );
    } catch (err) {
        console.error("audit flush error:", err.message);
        // หมายเหตุ: row ที่ LPOP ออกมาแล้วแต่ INSERT ไม่สำเร็จจะหายไป (at-most-once)
        // สำหรับ audit log แบบ demo ยอมรับได้ เพื่อกัน infinite retry block worker
    }
}

/**
 * เริ่ม background flusher (idempotent — กัน start ซ้ำตอน require หลายที่)
 */
function startAuditFlusher(pool, redis) {
    if (startAuditFlusher._timer) {
        return startAuditFlusher._timer;
    }

    const timer = setInterval(() => {
        flushAuditBatch(pool, redis);
    }, AUDIT_FLUSH_INTERVAL_MS);

    if (typeof timer.unref === "function") {
        timer.unref();
    }

    startAuditFlusher._timer = timer;
    return timer;
}

/**
 * @param {import('pg').Pool} pool       pool ชี้ไปยัง Postgres / PgBouncer
 * @param {import('redis').RedisClientType} [redisClient]
 *        Redis client (ถ้าไม่ส่งมา จะสร้างให้อัตโนมัติ)
 */
module.exports = function (pool, redisClient) {
    const redis = redisClient || createRedisClient();

    // connect แบบ lazy — ถ้ายังไม่ได้ต่อให้ต่อให้ (idempotent)
    if (!redis.isOpen) {
        redis.connect().catch((err) =>
            console.error("redis connect error:", err.message)
        );
    }

    // เริ่ม background worker ที่ flush audit จาก Redis -> Postgres
    startAuditFlusher(pool, redis);

    const router = express.Router();

    router.post("/", async (req, res) => {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                message: "username and password are required",
            });
        }

        const key = userCacheKey(username);

        try {
            // ----------------------------------------------------------------
            // 1) check Redis cache สำหรับ user_id (+ password_hash)
            // ----------------------------------------------------------------
            // cache เก็บ id + bcrypt password_hash (hash ทางเดียว) ไม่มี PII
            let user = null;

            try {
                const cached = await redis.get(key);
                if (cached !== null) {
                    user = JSON.parse(cached); // { id, password_hash }
                }
            } catch (err) {
                // ถ้า Redis ล่ม/parse พัง ให้ fallback ไป query Postgres ต่อได้
                console.error("redis get error:", err.message);
            }

            // ----------------------------------------------------------------
            // 2) cache miss -> query Postgres แล้ว cache user_id ไว้ใน Redis
            // ----------------------------------------------------------------
            if (!user) {
                // ใช้ parameterized query เพื่อป้องกัน SQL Injection
                const result = await pool.query(
                    `SELECT id, password_hash
           FROM users
           WHERE username = $1
           AND active = true
           LIMIT 1`,
                    [username]
                );

                if (result.rows.length === 0) {
                    // ไม่ cache กรณีไม่พบ user เพื่อกัน cache poisoning จาก username สุ่ม
                    // เขียน audit ลง Redis ก่อน (async flush ลง Postgres ภายหลัง)
                    pushAuditToRedis(redis, { username, success: false });
                    return res
                        .status(401)
                        .json({ message: "Invalid username or password" });
                }

                user = {
                    id: result.rows[0].id,
                    password_hash: result.rows[0].password_hash,
                };

                // เขียน cache แบบ fire-and-forget ไม่ block response
                // เก็บเฉพาะ id + password_hash (ไม่มี PII) พร้อม TTL
                redis
                    .set(key, JSON.stringify(user), {
                        EX: USER_CACHE_TTL_SECONDS,
                    })
                    .catch((err) =>
                        console.error("redis set error:", err.message)
                    );
            }

            // ----------------------------------------------------------------
            // 3) ตรวจสอบรหัสผ่าน
            // ----------------------------------------------------------------
            // native bcrypt offloads to C++ threadpool — does not block the Node.js event loop
            if (!(await bcrypt.compare(password, user.password_hash))) {
                // เขียน audit ลง Redis ก่อน แล้วค่อย async flush ลง Postgres
                pushAuditToRedis(redis, {
                    userId: user.id,
                    username,
                    success: false,
                });

                return res
                    .status(401)
                    .json({ message: "Invalid username or password" });
            }

            // Successful login — เขียน audit ลง Redis ก่อน (async flush ลง Postgres)
            pushAuditToRedis(redis, {
                userId: user.id,
                username,
                success: true,
            });

            // Return a fake JWT token for demonstration purposes
            return res.json({
                token: "fake-jwt-token",
                user: {
                    id: user.id,
                    username: username,
                },
            });
        } catch (err) {
            console.error("login/cache/audit error:", err.message);
            return res.status(503).json({
                message: "Service temporarily unavailable",
            });
        }
    });

    return router;
};

// export helper เผื่อ test/script อยาก reuse logic เดียวกัน
module.exports.pushAuditToRedis = pushAuditToRedis;
module.exports.flushAuditBatch = flushAuditBatch;
module.exports.startAuditFlusher = startAuditFlusher;
module.exports.AUDIT_QUEUE_KEY = AUDIT_QUEUE_KEY;
module.exports.AUDIT_FLUSH_BATCH = AUDIT_FLUSH_BATCH;
module.exports.AUDIT_FLUSH_INTERVAL_MS = AUDIT_FLUSH_INTERVAL_MS;
