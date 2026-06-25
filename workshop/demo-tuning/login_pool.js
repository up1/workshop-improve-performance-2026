const express = require("express");
const bcrypt = require("bcrypt");

/**
 * สร้าง pg Pool ที่ชี้ไปยัง PgBouncer แทนที่จะต่อตรงไป Postgres
 *
 * แนวคิด: PgBouncer ทำหน้าที่เป็น connection multiplexer (transaction pooling)
 *  - client (Node.js แต่ละ worker) เปิด connection เข้า PgBouncer (MAX_CLIENT_CONN=10000)
 *  - PgBouncer แปลงเป็น server connection ไป Postgres (DEFAULT_POOL_SIZE=100)
 */
function createPgBouncerPool() {
    const { Pool } = require("pg");

    return new Pool({
        // ชี้ไปที่ PgBouncer (docker compose map host 6432 -> pgbouncer 5432)
        host: process.env.PGBOUNCER_HOST || "localhost",
        port: parseInt(process.env.PGBOUNCER_PORT) || 6432,
        database: process.env.DB_NAME || "orders",
        user: process.env.DB_USER || "user",
        password: process.env.DB_PASS || "pass",

        // ตั้ง max ได้สูงกว่าการต่อตรง เพราะ PgBouncer ดูดซับ connection แทน Postgres
        max: parseInt(process.env.POOL_MAX) || 50,
        idleTimeoutMillis: 30000, // ปิด connection ที่ idle เกิน 30s
        connectionTimeoutMillis: 10000, // รอ connection ไม่เกิน 10s (queuing for spike traffic)
        query_timeout: 10000, // รอ query ไม่เกิน 10s (ป้องกัน query ที่ lock table นานเกินไป)
    });
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
 * @param {import('pg').Pool} [pool] pool ที่ชี้ไปยัง PgBouncer
 *        ถ้าไม่ส่งมา จะสร้าง pool ใหม่ที่ต่อไป PgBouncer ให้อัตโนมัติ
 */
module.exports = function (pool) {
    // รองรับการ inject pool จากภายนอก หรือสร้าง pgbouncer pool เองถ้าไม่ได้ส่งมา
    const db = pool || createPgBouncerPool();

    const router = express.Router();

    router.post("/", async (req, res) => {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                message: "username and password are required",
            });
        }

        try {
            // ใช้ parameterized query เพื่อป้องกัน SQL Injection
            // (unnamed prepared statement ทำงานได้กับ PgBouncer transaction mode)
            const result = await db.query(
                `SELECT id, username, password_hash
       FROM users
       WHERE username = $1
       AND active = true
       LIMIT 1`,
                [username]
            );

            if (result.rows.length === 0) {
                writeAuditAsync(db, { username, success: false });
                return res
                    .status(401)
                    .json({ message: "Invalid username or password" });
            }

            const user = result.rows[0];

            // native bcrypt offloads to C++ threadpool — does not block the Node.js event loop
            if (!(await bcrypt.compare(password, user.password_hash))) {
                writeAuditAsync(db, {
                    userId: user.id,
                    username,
                    success: false,
                });

                return res
                    .status(401)
                    .json({ message: "Invalid username or password" });
            }

            // Successful login
            writeAuditAsync(db, {
                userId: user.id,
                username,
                success: true,
            });

            // Return a fake JWT token for demonstration purposes
            return res.json({
                token: "fake-jwt-token",
                user: {
                    id: user.id,
                    username: user.username,
                },
            });
        } catch (err) {
            console.error("login error:", err.message);
            return res.status(503).json({
                message: "Service temporarily unavailable",
            });
        }
    });

    return router;
};

// export helper เผื่อ api.js อยากสร้าง pgbouncer pool เองและ reuse กับ /health
module.exports.createPgBouncerPool = createPgBouncerPool;
