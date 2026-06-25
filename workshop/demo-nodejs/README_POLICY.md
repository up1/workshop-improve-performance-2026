

## Create table
```
CREATE TABLE policies (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  policy_no VARCHAR(50) NOT NULL UNIQUE,
  policy_type VARCHAR(100) NOT NULL,
  status VARCHAR(30) NOT NULL,
  premium_amount NUMERIC(12,2) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL
);

CREATE INDEX idx_policies_user_id
ON policies(user_id);
```

## Initial data for testing
```
INSERT INTO policies(
  user_id,
  policy_no,
  policy_type,
  status,
  premium_amount,
  start_date,
  end_date
)
SELECT
  id,
  'POL-' || id,
  'life',
  'active',
  12000.00,
  CURRENT_DATE,
  CURRENT_DATE + INTERVAL '1 year'
FROM users
WHERE id <= 1000000;
```
Check data
```
SELECT count(*) from policies;
```

## Start API
```
$npm install
$npm start
```

## Testing with policies endpoint
```
$curl -X GET http://localhost:3000/me/policies -H "Authorization: Bearer token-123"
``` 

## Improve SQL query performance
Analyze SQL
```
EXPLAIN ANALYZE
SELECT
    policy_no,
    policy_type,
    status,
    premium_amount,
    start_date,
    end_date
FROM policies
WHERE user_id = 1
ORDER BY start_date DESC
```

Change SQL
```
SELECT policy_no, policy_type, status, premium_amount, start_date, end_date
FROM policies
WHERE user_id = $1
ORDER BY start_date DESC
LIMIT 20;
```

Create index for performance
```
CREATE INDEX idx_policies_user_id_start_date
ON policies(user_id, start_date DESC);
```