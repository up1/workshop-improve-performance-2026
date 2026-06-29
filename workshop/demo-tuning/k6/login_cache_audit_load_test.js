import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
    scenarios: {
        login_spike_test: {
            executor: "ramping-vus",
            stages: [
                { duration: "30s", target: 500 },
                { duration: "30s", target: 800 },
                { duration: "30s", target: 1000 },
                { duration: "30s", target: 1000 },
                { duration: "30s", target: 0 }
            ]
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

    const res = http.post(
        "http://localhost:3000/login/cache/audit",
        payload,
        params
    );

    check(res, {
        "status is 200": (r) => r.status === 200,
        "response time < 1s": (r) => r.timings.duration < 1000
    });

    // sleep(1);
}
