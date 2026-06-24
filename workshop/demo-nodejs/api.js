const express = require("express");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const bcrypt = require('bcrypt');

const app = express();
app.use(express.json());

// เมื่อ scale ด้วย PM2 cluster แต่ละ worker มี pool ของตัวเอง
// POOL_MAX ถูกคำนวณใน ecosystem.config.js: floor(190 / instances)
const pool = new Pool({
    host: process.env.DB_HOST     || "localhost",
    port: parseInt(process.env.DB_PORT)     || 5432,
    database: process.env.DB_NAME || "orders",
    user: process.env.DB_USER     || "user",
    password: process.env.DB_PASS || "pass",

    // ปรับค่า connection pool ให้เหมาะสมกับ load test
    max: parseInt(process.env.POOL_MAX) || 190, // ต่ำกว่า max_connections=200 เพื่อเผื่อ superuser connections
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000              // เพิ่มจาก 2s เป็น 10s รองรับ queue ช่วง spike
});

// กัน brute force / login storm ต่อ IP หรือจัดการใน API Gateway / WAF
const loginLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false
});

// บันทึก audit log แบบ async ไม่ block response หลัก
async function writeAuditAsync({ userId, username, success }) {
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
app.post("/login", async (req, res) => {
    // app.post("/login", loginLimiter, async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            message: "username and password are required"
        });
    }

    try {
        // ใช้ parameterized query เพื่อป้องกัน SQL Injection
        const result = await pool.query(
            `SELECT id, username, password_hash
       FROM users
       WHERE username = $1
       AND active = true
       LIMIT 1`,
            [username]
        );

        if (result.rows.length === 0) {
            writeAuditAsync({ username, success: false });
            return res.status(401).json({ message: "Invalid username or password" });
        }

        const user = result.rows[0];

        // native bcrypt offloads to C++ threadpool — does not block the Node.js event loop
        if (!(await bcrypt.compare(password, user.password_hash))) {
            writeAuditAsync({
                userId: user.id,
                username,
                success: false
            });

            return res.status(401).json({ message: "Invalid username or password" });
        }

        writeAuditAsync({
            userId: user.id,
            username,
            success: true
        });

        // Return a fake JWT token for demonstration purposes
        return res.json({
            token: "fake-jwt-token",
            user: {
                id: user.id,
                username: user.username
            }
        });
    } catch (err) {
        console.error(err.message);

        return res.status(503).json({
            message: "Service temporarily unavailable"
        });
    }
});

app.get("/health", async (req, res) => {
    try {
        await pool.query("SELECT 1");
        res.json({ status: "ok" });
    } catch {
        res.status(503).json({ status: "db_unavailable" });
    }
});

app.listen(3000, () => {
    console.log("Start API server running on port 3000");
});