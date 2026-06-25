const express = require("express");

// demo token store
const sessions = new Map();
sessions.set("token-123", { id: 1, name: "Somkiat" });

function authMiddleware(req, res, next) {
  const authorization = req.headers.authorization;

  if (!authorization) {
    return res.status(401).json({ message: "Missing token" });
  }

  const token = authorization.replace("Bearer ", "");
  const session = sessions.get(token);

  if (!session) {
    return res.status(401).json({ message: "Invalid token" });
  }

  req.user = session;
  next();
}

module.exports = function (pool) {
    const router = express.Router();

    router.get("/", authMiddleware, async (req, res) => {
        const result = await pool.query(
            `SELECT
       policy_no,
       policy_type,
       status,
       premium_amount,
       start_date,
       end_date
     FROM policies
     WHERE user_id = $1
     ORDER BY start_date DESC`,
            [req.user.id]
        );

        return res.json({
            user_id: req.user.id,
            policies: result.rows
        });
    })

    return router;
}