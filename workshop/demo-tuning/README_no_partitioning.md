# [Postgresql table 

## Table structure

```sql
CREATE TABLE products (
    product_id SERIAL PRIMARY KEY,
    product_name VARCHAR(255) NOT NULL,
    price DECIMAL(10, 2) NOT NULL
);

CREATE TABLE orders (
    order_id SERIAL PRIMARY KEY,
    order_date DATE NOT NULL,
    customer_id INT NOT NULL,
    total_amount DECIMAL(10, 2) NOT NULL,
    order_status VARCHAR(50) NOT NULL CHECK (order_status IN ('pending', 'processing', 'shipped', 'delivered', 'cancelled'))
);

CREATE TABLE orders_items (
    order_item_id SERIAL PRIMARY KEY,
    order_id INT NOT NULL,
    order_date DATE NOT NULL,
    product_id INT NOT NULL,
    quantity INT NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(order_id)
);
```

## Generate data for testing

Products table = 100,000 rows

```sql
INSERT INTO products (product_name, price)
SELECT 'Product ' || i, (random() * 100)::numeric(10, 2)
FROM generate_series(1, 100000) AS s(i);

SELECT count(*) FROM products;
```

Orders table = 1,000,000 rows

```sql
INSERT INTO orders (order_date, customer_id, total_amount, order_status)
SELECT (date '2026-01-01' + (random() * 365)::int), (random() * 1000000)::int, (random() * 1000)::numeric(10, 2), (ARRAY['pending', 'processing', 'shipped', 'delivered', 'cancelled'])[floor(random() * 5 + 1)]
FROM generate_series(1, 1000000) AS s(i);

SELECT count(*) FROM orders;
```

Orders_items table = 3,000,000 rows => 3 rows per order

```sql
INSERT INTO orders_items (order_id, order_date, product_id, quantity, price)
SELECT o.order_id, o.order_date, (random() * 100000)::int, (random() * 10)::int, (random() * 100)::numeric(10, 2)
FROM orders o
JOIN generate_series(1, 3) AS s(i) ON true;


SELECT count(*) FROM orders_items;
```

## Analyse Query

````sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT
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
WHERE o.order_date = COALESCE(CURRENT_DATE)
GROUP BY o.order_id, o.order_date, o.total_amount, o.order_status
ORDER BY o.order_date DESC
LIMIT 10
````

List of problems found in the query plan:
* The query is performing a sequential scan on the orders table, which is slow for large tables
* GROUP BY 
  * Large Aggregation Memory footprint (increased memory usage with `work_mem` setting)
* Redundant Final Sorting
  * Filter by o.order_date = CURRENT_DATE and then ORDER BY o.order_date DESC. Since all rows have the exact same date, the sort operation consumes memory and CPU for no reason
* Late Limit Filtering
  * The query joins orders, orders_items, and products across all of today's orders before slicing the final result down to 10 rows

## Start server
```
$npm install
$npm start
```

## Test GET /orders/summary/daily
```
$curl -X GET "http://localhost:3000/orders/summary/daily"
$curl -X GET "http://localhost:3000/orders/summary/daily?date=2026-01-01"
``` 

## Tuning SQL query without partitioning
```
EXPLAIN (ANALYZE, BUFFERS)
WITH filtered_orders AS (
    -- Step 1: Fetch only the 10 orders we actually need (Minimal memory footprint)
    SELECT order_id, total_amount, order_status, order_date
    FROM orders
    WHERE order_date = CURRENT_DATE
    LIMIT 10
)
SELECT
    fo.order_id,
    -- Step 3: Build JSON aggregates only for those 10 specific rows
    jsonb_agg(
        jsonb_build_object(
            'product_name', p.product_name,
            'quantity', oi.quantity,
            'price', oi.price
        )
        ORDER BY oi.order_item_id
    ) AS products,
    fo.total_amount,
    fo.order_status,
    fo.order_date
FROM filtered_orders fo
-- Step 2: Join items and products only for the 10 orders
JOIN orders_items oi ON oi.order_id = fo.order_id
JOIN products p ON p.product_id = oi.product_id
GROUP BY fo.order_id, fo.order_date, fo.total_amount, fo.order_status;
```

Create index on order_date column of orders table and order_id column of orders_items table
```sql
CREATE INDEX idx_orders_date ON orders (order_date);
CREATE INDEX idx_orders_items_order_id ON orders_items (order_id);
```


## Other solutions
* Use a materialized view to pre-aggregate the data and query the materialized view instead
* Use a caching layer (e.g., Redis) to cache the results of the query and serve subsequent requests from the cache

Example of materialized view for daily order summary

```sql
CREATE MATERIALIZED VIEW daily_order_summary AS
SELECT
    o.order_date,
    COUNT(DISTINCT o.order_id) AS total_orders,
    SUM(o.total_amount) AS total_amount,
    COUNT(DISTINCT CASE WHEN o.order_status = 'pending' THEN o.order_id END) AS pending_orders,
    COUNT(DISTINCT CASE WHEN o.order_status = 'processing' THEN o.order_id END) AS processing_orders,
    COUNT(DISTINCT CASE WHEN o.order_status = 'shipped' THEN o.order_id END) AS shipped_orders,
    COUNT(DISTINCT CASE WHEN o.order_status = 'delivered' THEN o.order_id END) AS delivered_orders,
    COUNT(DISTINCT CASE WHEN o.order_status = 'cancelled' THEN o.order_id END) AS cancelled_orders
FROM orders o
GROUP BY o.order_date;
```

Query the materialized view for daily order summary

```sql
SELECT *
FROM daily_order_summary
WHERE order_date = CURRENT_DATE
LIMIT 10;
```

Update the materialized view daily_order_summary every day at midnight using a cron job or a scheduled task in your application.
```sql
REFRESH MATERIALIZED VIEW daily_order_summary;
```