import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
    scenarios: {
        login_spike_test: {
            executor: "ramping-vus",
            startVUs: 0,
            stages: [
                { duration: '1m', target: 1000 }, // Ramp up to 1k users in 1 minute
                { duration: '2m', target: 1000 }, // Sustain 1k users for 2 minutes
                { duration: '30s', target: 0 },     // Ramp down to 0
            ],
        }
    },
    thresholds: {
        http_req_failed: ["rate<0.05"], // <5% errors
        http_req_duration: ["p(95)<1000"] // 95% of requests must complete below 1s
    }
};

export default function () {
    const userId = Math.floor(Math.random() * 1000000) + 1;

    const payload = JSON.stringify({
        username: `user${userId}`,
        password: "password"
    });

    const params = {
        headers: {
            "Content-Type": "application/json"
        }
    };

    const res = http.post("http://localhost:3000/login/pool", payload, params);

    check(res, {
        "status is 200": (r) => r.status === 200,
        "response time < 1s": (r) => r.timings.duration < 1000
    });

    // Simulate user think time
    sleep(1);
}