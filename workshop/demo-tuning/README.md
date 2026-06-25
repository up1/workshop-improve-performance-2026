# Demo :: Tuning Performance
* NodeJS
* Postgres
* Redis


## 1. Start Postgres with port=5432
```
$cd docker
$docker-compose up -d db

$docker-compose ps
NAME          IMAGE         COMMAND                  SERVICE   CREATED         STATUS                   PORTS
docker-db-1   postgres:17   "docker-entrypoint.s…"   db        7 seconds ago   Up 6 seconds (healthy)   0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp
```

Initialize the database with sample data
```
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, -- bcrypt hash
  active BOOLEAN DEFAULT true
);

CREATE TABLE login_audit (
  id BIGSERIAL PRIMARY KEY,
  user_id INT,
  username VARCHAR(100),
  success BOOLEAN,
  created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_users_username_active
ON users(username)
WHERE active = true;

INSERT INTO users(username, password_hash, active)
SELECT
  'user' || generate_series(1, 1000000),
  '$2b$10$lJRPkLLhB7SZbwR5Ol1yke72hkXOndqAoelwPHnsFffiGqA1eLiXi',
  true;

SELECT count(*) from users;

ALTER TABLE login_audit SET (autovacuum_enabled = false);
```

## 2. Start first api with port=3000
* POST /login
```
$npm install
$npm start
```

Check the api with healthcheck
```
$curl -X GET http://localhost:3000/health
```

Test POST /login with username=user1 and password=password
```
$curl -X POST http://localhost:3000/login -H "Content-Type: application/json" -d '{"username":"user1","password":"password"}'
```

Load testing with [K6](https://grafana.com/docs/k6/latest/set-up/install-k6/)
* [Tuning OS for high load](https://grafana.com/docs/k6/latest/set-up/fine-tune-os/)
```
$k6 run login_load_test.js
```

## 3. Start PgBouncer with port=6432
```
$cd docker
$docker-compose up -d pgbouncer
$docker-compose ps
```

Start server
```
$npm install
$npm start
```

Check the api with healthcheck
```
$curl -X GET http://localhost:3000/health
```

Test POST /login with username=user1 and password=password
```
$curl -X POST http://localhost:3000/login/pool -H "Content-Type: application/json" -d '{"username":"user1","password":"password"}'
```

Load testing with [K6](https://grafana.com/docs/k6/latest/set-up/install-k6/)
* [Tuning OS for high load](https://grafana.com/docs/k6/latest/set-up/fine-tune-os/)
```
$k6 run login_pool_load_test.js
```

## 4. Start Redis with port=6379
* [Redis lib](https://redis.io/docs/latest/develop/clients/nodejs/)

```
$cd docker
$docker-compose up -d redis
$docker-compose ps
```

### Workflow
* Initial cache with Redis
* POST /login/cache
  * check redis cache for user_id
  * if not found, query Postgres for user_id and cache it in Redis

Initial cache from db to redis
```
$node initial_cache.js 
```

Check data in redis
```
$redis-cli -h localhost -p 6379

// Count keys in redis
> dbsize

// Delete all keys in redis
> flushall

// Stat of hit or miss
$redis-cli INFO stats | grep keyspace
$redis-cli --stat
```

### Start server
```
$npm install
$npm start
```

Check the api with healthcheck
```
$curl -X GET http://localhost:3000/health
```

Login with cache
```
$curl -X POST http://localhost:3000/login/cache -H "Content-Type: application/json" -d '{"username":"user1","password":"password"}'
```

Load testing with [K6](https://grafana.com/docs/k6/latest/set-up/install-k6/)
* [Tuning OS for high load](https://grafana.com/docs/k6/latest/set-up/fine-tune-os/)
```
$k6 run login_cache_load_test.js
```

## 5. Improve :: write login_audit to Redis first, then async write to Postgres
Flow:
* POST /login/cache/audit
  * check redis cache for user_id
  * if not found, query Postgres for user_id and cache it in Redis
  * write login_audit to Redis first, then async write to Postgres


### Start server
```
$npm install
$npm start
```

Check the api with healthcheck
```
$curl -X GET http://localhost:3000/health
```

Login with cache
```
$curl -X POST http://localhost:3000/login/cache/audit -H "Content-Type: application/json" -d '{"username":"user1","password":"password"}'
```

Load testing with [K6](https://grafana.com/docs/k6/latest/set-up/install-k6/)
* [Tuning OS for high load](https://grafana.com/docs/k6/latest/set-up/fine-tune-os/)
```
$k6 run login_cache_audit_load_test.js
```

Check data in Redis
```
$redis-cli -h localhost -p 6379

// Count keys in redis
> dbsize

// Check the first 10 items in the login audit queue
> LRANGE login:audit:queue 0 10

// Check all items in the login audit queue
> LRANGE login:audit:queue 0 -1

