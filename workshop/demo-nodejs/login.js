const express = require("express");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcrypt");

// กัน brute force / login storm ต่อ IP หรือจัดการใน API Gateway / WAF
const loginLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false
});

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

module.exports = function (pool) {
    const router = express.Router();

    router.post("/", async (req, res) => {
        // router.post("/", loginLimiter, async (req, res) => {
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
                writeAuditAsync(pool, { username, success: false });
                return res.status(401).json({ message: "Invalid username or password" });
            }

            const user = result.rows[0];

            // native bcrypt offloads to C++ threadpool — does not block the Node.js event loop
            if (!(await bcrypt.compare(password, user.password_hash))) {
                writeAuditAsync(pool, {
                    userId: user.id,
                    username,
                    success: false
                });

                return res.status(401).json({ message: "Invalid username or password" });
            }

            writeAuditAsync(pool, {
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

    return router;
};
