const express = require("express");
const bcrypt = require("bcrypt");
const { createClient } = require("redis");

// ----------------------------------------------------------------------------
// Redis cache config
// ----------------------------------------------------------------------------
// prefix แยก namespace ของ key กันชนกับข้อมูลอื่นใน Redis
const USER_CACHE_PREFIX = "login:user:";
// TTL กัน cache ค้างนานเกินไป (ข้อมูล user อาจถูก disable/เปลี่ยนรหัส)
const USER_CACHE_TTL_SECONDS = parseInt(process.env.REDIS_USER_TTL) || 3600;

/**
 * สร้าง Redis client (node-redis v6)
 * docs: https://redis.io/docs/latest/develop/clients/nodejs/
 *
 * แนวคิด: ใช้ Redis เป็น read-through cache ของการ lookup username -> user_id
 *  - ลด load การ scan index username บน Postgres (1,000,000 rows) ทุก request
 * - ลด cold-start load spike ที่ยิงตรงไป Postgres ตอน traffic spike
 */
function createRedisClient() {
    const client = createClient({
        url: process.env.REDIS_URL || "redis://localhost:6379",
        socket: {
            // reconnect แบบ backoff กัน reconnect ตอน Redis ล่ม
            reconnectStrategy: (retries) => Math.min(retries * 50, 2000),
        },
    });

    // อย่าให้ error ของ Redis ทำให้ process ตาย — แค่ log แล้ว fallback ไป Postgres
    client.on("error", (err) => console.error("redis error:", err.message));

    return client;
}

// สร้าง cache key จาก username
function userCacheKey(username) {
    return `${USER_CACHE_PREFIX}${username}`;
}

// บันทึก audit log แบบ async ไม่ block response หลัก
async function writeAuditAsync(pool, { userId, username, success }) {
    // ไม่ block response หลัก
    setImmediate(async () => {
        try {
            await pool.query(
                `INSERT INTO login_audit(user_id, username, success)
         VALUES($1, $2, $3)`,
                [userId || null, username, success]
            );
        } catch (err) {
            console.error("audit error:", err.message);
        }
    });
}

/**
 * @param {import('pg').Pool} pool       pool ที่ชี้ไปยัง Postgres / PgBouncer
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
            // หมายเหตุด้านความปลอดภัย/PII:
            //   cache เก็บแค่ id + bcrypt password_hash (เป็น hash ทางเดียว)
            //   "ไม่" เก็บข้อมูล PII อื่น (อีเมล/เบอร์/ชื่อจริง) เพื่อรักษา data privacy
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
                    writeAuditAsync(pool, { username, success: false });
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
            // 3) ตรวจสอบรหัสผ่าน (เหมือน /login เดิม)
            // ----------------------------------------------------------------
            // native bcrypt offloads to C++ threadpool — does not block the Node.js event loop
            if (!(await bcrypt.compare(password, user.password_hash))) {
                writeAuditAsync(pool, {
                    userId: user.id,
                    username,
                    success: false,
                });

                return res
                    .status(401)
                    .json({ message: "Invalid username or password" });
            }

            // Successful login
            writeAuditAsync(pool, {
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
            console.error("login/cache error:", err.message);
            return res.status(503).json({
                message: "Service temporarily unavailable",
            });
        }
    });

    return router;
};

// export helper เผื่อ api.js / initial_cache.js อยาก reuse client และ key เดียวกัน
module.exports.createRedisClient = createRedisClient;
module.exports.userCacheKey = userCacheKey;
module.exports.USER_CACHE_PREFIX = USER_CACHE_PREFIX;
module.exports.USER_CACHE_TTL_SECONDS = USER_CACHE_TTL_SECONDS;
