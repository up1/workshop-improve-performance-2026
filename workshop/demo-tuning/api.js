const express = require("express");
const { Pool } = require("pg");
const loginRouter = require("./login");

const app = express();
app.use(express.json());

// เมื่อ scale ด้วย PM2 cluster แต่ละ worker มี pool ของตัวเอง
// POOL_MAX ถูกคำนวณใน ecosystem.config.js: floor(190 / instances)
const pool = new Pool({
    host: process.env.DB_HOST     || "localhost",
    port: parseInt(process.env.DB_PORT)     || 6432,
    database: process.env.DB_NAME || "orders",
    user: process.env.DB_USER     || "user",
    password: process.env.DB_PASS || "pass",
    // connectionString: process.env.DATABASE_URL || "postgresql://user:pass@localhost:6432/orders",

    // ปรับค่า connection pool ให้เหมาะสมกับ load test
    max: parseInt(process.env.POOL_MAX) || 10, // ต่ำกว่า max_connections=200
    idleTimeoutMillis: 30000,         // ปิด connection ที่ idle เกิน 30s
    connectionTimeoutMillis: 10000              // รอ connection ไม่เกิน 10s (queuing for spike traffic)
});

app.use("/login", loginRouter(pool));

app.get("/health", async (req, res) => {
    try {
        await pool.query("SELECT 1");
        res.json({ status: "ok" });
    } catch(err) {
        // show error
        console.log(err);
        res.status(503).json({ status: "db_unavailable" });
    }
});

app.listen(3000, () => {
    console.log("Start API server running on port 3000");
});