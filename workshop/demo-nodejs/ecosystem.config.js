'use strict';

const os = require('os');

const PG_MAX_CONNECTIONS = 190;        // max_connections=200 หักไว้ 10 สำหรับ superuser/admin
const instances         = os.cpus().length;          // ใช้ทุก core (เปลี่ยนเป็นตัวเลขได้)
const poolMax           = Math.floor(PG_MAX_CONNECTIONS / instances);

// ตรวจสอบค่าที่คำนวณได้ก่อน deploy
console.log(`PM2 cluster: ${instances} workers × pool.max ${poolMax} = ${instances * poolMax} DB connections`);

module.exports = {
    apps: [
        {
            name       : 'login-api',
            script     : 'api.js',
            instances  : instances,        // จำนวน worker = จำนวน CPU core
            exec_mode  : 'cluster',        // PM2 cluster mode — แชร์ port เดียวกัน
            watch      : false,
            max_memory_restart: '512M',    // restart worker ถ้า memory เกิน 512 MB

            env: {
                NODE_ENV : 'production',
                POOL_MAX : poolMax,        // แต่ละ worker ได้รับ pool size ที่คำนวณแล้ว
                DB_HOST  : 'localhost',
                DB_PORT  : 5432,
                DB_NAME  : 'orders',
                DB_USER  : 'user',
                DB_PASS  : 'pass',
            }
        }
    ]
};
