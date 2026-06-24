# Workshop with NodeJS + Express + PostgreSQL

## Initial database
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
```

Insert test data (1 million users) with password hash of "password" (bcrypt hash: $2b$10$EixZaYVK1fsbw1ZfbX3OXePaWxn96p36WQoeG6Lruj3vjPGga31lW):
```
INSERT INTO users(username, password_hash, active)
SELECT
  'user' || generate_series(1, 1000000),
  '$2b$10$lJRPkLLhB7SZbwR5Ol1yke72hkXOndqAoelwPHnsFffiGqA1eLiXi',
  true;
```

Check data
```
SELECT count(*) from users;
```

Config Autovacuum for the login_audit table (no update/delete, so we can disable autovacuum to avoid unnecessary overhead):
```
ALTER TABLE login_audit SET (autovacuum_enabled = false);   
```

## Start API
```
$npm install
$npm start
```

Check with health endpoint:
```
$curl http://localhost:3000/health
```

## Testing
```
$curl -X POST http://localhost:3000/login -H "Content-Type: application/json" -d '{"username":"user1","password":"password"}'
``` 

## Load testing with K6
* [Install K6](https://grafana.com/docs/k6/latest/set-up/install-k6/)
* [Tuning OS for high load](https://grafana.com/docs/k6/latest/set-up/fine-tune-os/)

```
$k6 run login_load_test.js
```