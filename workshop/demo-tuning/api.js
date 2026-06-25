const express = require("express");
const { Pool } = require("pg");
const loginRouter = require("./login");
const loginPoolRouter = require("./login_pool");
const loginCacheRouter = require("./login_cache");
const loginCacheAuditRouter = require("./login_cache_audit");
const orderReportRouter = require("./order_report");

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
    max: parseInt(process.env.POOL_MAX) || 10, // ต่ำกว่า max_connections=200
    idleTimeoutMillis: 30000,         // ปิด connection ที่ idle เกิน 30s
    connectionTimeoutMillis: 10000              // รอ connection ไม่เกิน 10s (queuing for spike traffic)
});

app.use("/login", loginRouter(pool));

// pool ที่ต่อผ่าน PgBouncer (port 6432) สำหรับรองรับ client จำนวนมาก (heavy connection)
// PgBouncer multiplex client connection -> server connection ของ Postgres แบบ transaction pooling
const pgbouncerPool = loginPoolRouter.createPgBouncerPool();
app.use("/login/pool", loginPoolRouter(pgbouncerPool));

// Redis read-through cache: เช็ค Redis ก่อน ถ้า miss ค่อย query Postgres แล้ว cache ไว้
// warmup user_id ล่วงหน้าได้ด้วย: node initial_cache.js
const redisClient = loginCacheRouter.createRedisClient();
redisClient.connect().catch((err) => console.error("redis connect error:", err.message));
app.use("/login/cache", loginCacheRouter(pool, redisClient));

// เขียน login_audit ลง Redis ก่อน แล้ว background worker ค่อย batch flush ลง Postgres
// ลด write load + latency ที่ยิงตรงไป Postgres ต่อ request
app.use("/login/cache/audit", loginCacheAuditRouter(pool, redisClient));

// รายงานสรุปออเดอร์รายวัน join orders + orders_items + products
app.use("/orders", orderReportRouter(pool));


app.get("/health", async (req, res) => {
    try {
        await pool.query("SELECT 1");
        await pgbouncerPool.query("SELECT 1");
        await redisClient.ping();
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