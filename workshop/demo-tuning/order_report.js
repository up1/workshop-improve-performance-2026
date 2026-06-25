const express = require("express");

// ตรวจสอบรูปแบบวันที่ YYYY-MM-DD ก่อนส่งเข้า query
function isValidDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

module.exports = function (pool) {
    const router = express.Router();

    // GET /orders/summary/daily?date=YYYY-MM-DD
    // สรุปออเดอร์รายวัน join orders + orders_items + products
    // default = วันปัจจุบัน (CURRENT_DATE)
    router.get("/summary/daily", async (req, res) => {
        const date = req.query.date;

        if (date !== undefined && !isValidDate(date)) {
            return res.status(400).json({
                message: "date must be in YYYY-MM-DD format",
            });
        }

        try {
            // ใช้ parameterized query เพื่อป้องกัน SQL Injection
            // COALESCE($1, CURRENT_DATE) -> ถ้าไม่ส่ง date มา ใช้วันปัจจุบัน
            // join ผ่าน (order_id, order_date) ตาม composite key ของ partitioned table
            // jsonb_agg รวมรายการสินค้าของแต่ละออเดอร์เป็น jsonb array
            const result = await pool.query(
                `SELECT
                     o.order_id,
                     jsonb_agg(
                         jsonb_build_object(
                             'product_name', p.product_name,
                             'quantity', oi.quantity,
                             'price', oi.price
                         )
                         ORDER BY oi.order_item_id
                     ) AS products,
                     o.total_amount,
                     o.order_status,
                     o.order_date
                 FROM orders o
                 JOIN orders_items oi
                     ON oi.order_id = o.order_id
                    AND oi.order_date = o.order_date
                 JOIN products p
                     ON p.product_id = oi.product_id
                 WHERE o.order_date = COALESCE($1::date, CURRENT_DATE)
                 GROUP BY o.order_id, o.order_date, o.total_amount, o.order_status
                 ORDER BY o.order_date DESC
                 LIMIT 10`,
                [date || null]
            );

            return res.json({
                date: date || new Date().toISOString().slice(0, 10),
                count: result.rows.length,
                orders: result.rows,
            });
        } catch (err) {
            console.error("order report error:", err.message);
            return res.status(503).json({
                message: "Service temporarily unavailable",
            });
        }
    });

    return router;
};
