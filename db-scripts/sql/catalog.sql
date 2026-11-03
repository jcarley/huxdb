-- Mock products catalog for local huxdb development. Test data only.
--
-- Run by ../01-seed-catalog.sh. Everything lives in the public schema and is
-- dropped and recreated on every run, so the script can be rerun safely.
-- Only the objects created here are dropped; the schema itself is left alone.

BEGIN;

-- ---------------------------------------------------------------------------
-- Reset
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS refresh_catalog_summaries();
DROP FUNCTION IF EXISTS products_in_category(integer);
DROP FUNCTION IF EXISTS product_margin(bigint);
DROP MATERIALIZED VIEW IF EXISTS category_sales_summary;
DROP VIEW IF EXISTS order_totals;
DROP VIEW IF EXISTS low_stock_products;
DROP VIEW IF EXISTS active_products;
DROP TABLE IF EXISTS product_reviews CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
DROP TABLE IF EXISTS product_inventory CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS suppliers CASCADE;
DROP TABLE IF EXISTS categories CASCADE;

-- Same "random" data on every run.
DO $$ BEGIN PERFORM setseed(0.42); END $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
    category_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent_id   integer REFERENCES categories (category_id) ON DELETE RESTRICT,
    name        text NOT NULL UNIQUE,
    description text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE categories IS 'Product categories; subcategories point at their parent.';
COMMENT ON COLUMN categories.parent_id IS 'NULL for top-level categories.';

CREATE TABLE suppliers (
    supplier_id   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name          text NOT NULL UNIQUE,
    contact_email text NOT NULL,
    phone         text,
    country       text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE suppliers IS 'Vendors that supply catalog products.';

CREATE TABLE products (
    product_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sku         text NOT NULL UNIQUE,
    name        text NOT NULL,
    description text,
    category_id integer NOT NULL REFERENCES categories (category_id),
    supplier_id integer NOT NULL REFERENCES suppliers (supplier_id),
    price       numeric(10, 2) NOT NULL CHECK (price >= 0),
    cost        numeric(10, 2) NOT NULL CHECK (cost >= 0),
    weight_kg   numeric(8, 3),
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE products IS 'Sellable catalog items.';
COMMENT ON COLUMN products.sku IS 'Stock keeping unit, unique per product.';
COMMENT ON COLUMN products.cost IS 'Unit cost from the supplier.';
CREATE INDEX products_category_id_idx ON products (category_id);
CREATE INDEX products_supplier_id_idx ON products (supplier_id);

CREATE TABLE product_inventory (
    product_id       bigint NOT NULL REFERENCES products (product_id) ON DELETE CASCADE,
    warehouse        text NOT NULL,
    quantity_on_hand integer NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
    reorder_level    integer NOT NULL DEFAULT 10 CHECK (reorder_level >= 0),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (product_id, warehouse)
);
COMMENT ON TABLE product_inventory IS 'Stock on hand per product and warehouse.';

CREATE TABLE customers (
    customer_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    first_name  text NOT NULL,
    last_name   text NOT NULL,
    email       text NOT NULL UNIQUE,
    city        text,
    state       text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE customers IS 'People who place orders.';

CREATE TABLE orders (
    order_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id bigint NOT NULL REFERENCES customers (customer_id),
    status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled')),
    ordered_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE orders IS 'Customer orders.';
CREATE INDEX orders_customer_id_idx ON orders (customer_id);
CREATE INDEX orders_ordered_at_idx ON orders (ordered_at);

CREATE TABLE order_items (
    order_item_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id      bigint NOT NULL REFERENCES orders (order_id) ON DELETE CASCADE,
    product_id    bigint NOT NULL REFERENCES products (product_id),
    quantity      integer NOT NULL CHECK (quantity > 0),
    unit_price    numeric(10, 2) NOT NULL CHECK (unit_price >= 0),
    UNIQUE (order_id, product_id)
);
COMMENT ON TABLE order_items IS 'Line items of an order.';
COMMENT ON COLUMN order_items.unit_price IS 'Product price at the time of the order.';
CREATE INDEX order_items_product_id_idx ON order_items (product_id);

CREATE TABLE product_reviews (
    review_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id  bigint NOT NULL REFERENCES products (product_id) ON DELETE CASCADE,
    customer_id bigint NOT NULL REFERENCES customers (customer_id),
    rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
    title       text,
    body        text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE product_reviews IS 'Customer ratings and reviews of products.';
CREATE INDEX product_reviews_product_id_idx ON product_reviews (product_id);

-- ---------------------------------------------------------------------------
-- Hand-written lookup data
-- ---------------------------------------------------------------------------
INSERT INTO categories (name, description) VALUES
    ('Electronics',       'Computers, phones and audio gear'),
    ('Home & Kitchen',    'Everything for the house'),
    ('Sports & Outdoors', 'Gear for staying active'),
    ('Books',             'Printed and digital books'),
    ('Clothing',          'Apparel for everyone');

INSERT INTO categories (parent_id, name, description)
SELECT p.category_id, s.name, s.description
FROM (VALUES
    ('Electronics',       'Laptops',          'Portable computers'),
    ('Electronics',       'Phones',           'Smartphones and accessories'),
    ('Electronics',       'Audio',            'Headphones and speakers'),
    ('Home & Kitchen',    'Cookware',         'Pots, pans and bakeware'),
    ('Home & Kitchen',    'Furniture',        'Tables, chairs and storage'),
    ('Home & Kitchen',    'Appliances',       'Small kitchen appliances'),
    ('Sports & Outdoors', 'Camping',          'Tents, packs and lights'),
    ('Sports & Outdoors', 'Fitness',          'Home workout equipment'),
    ('Books',             'Fiction',          'Novels and short stories'),
    ('Books',             'Technical',        'Programming and reference'),
    ('Clothing',          'Men''s Clothing',   'Menswear'),
    ('Clothing',          'Women''s Clothing', 'Womenswear')
) AS s (parent, name, description)
JOIN categories p ON p.name = s.parent;

INSERT INTO suppliers (name, contact_email, phone, country) VALUES
    ('Acme Distribution',     'sales@acme.example.com',        '+1-555-0100',    'United States'),
    ('Northwind Traders',     'orders@northwind.example.com',  '+1-555-0101',    'United States'),
    ('Contoso Wholesale',     'hello@contoso.example.com',     '+1-555-0102',    'Canada'),
    ('Globex Supply Co.',     'supply@globex.example.com',     '+44-20-5550-0103', 'United Kingdom'),
    ('Initech Components',    'parts@initech.example.com',     '+1-555-0104',    'United States'),
    ('Umbrella Goods',        'contact@umbrella.example.com',  '+49-30-5550-0105', 'Germany'),
    ('Stark Outfitters',      'trade@stark.example.com',       '+1-555-0106',    'United States'),
    ('Wayne Home Essentials', 'b2b@wayne.example.com',         '+1-555-0107',    'United States'),
    ('Tyrell Textiles',       'info@tyrell.example.com',       '+81-3-5550-0108', 'Japan'),
    ('Soylent Publishing',    'books@soylent.example.com',     '+61-2-5550-0109', 'Australia');

-- ---------------------------------------------------------------------------
-- Generated data
-- ---------------------------------------------------------------------------

-- ~2,000 products spread across the leaf categories.
INSERT INTO products (sku, name, description, category_id, supplier_id, price, cost, weight_kg, is_active, created_at)
WITH leaf AS (
    SELECT c.category_id, n.nouns, n.base_price, n.base_weight,
           row_number() OVER (ORDER BY c.category_id) - 1 AS idx
    FROM categories c
    JOIN (VALUES
        ('Laptops',          ARRAY['Laptop', 'Notebook', 'Ultrabook', 'Chromebook'],               900, 2.0),
        ('Phones',           ARRAY['Smartphone', 'Phone Case', 'Charger', 'Screen Protector'],     300, 0.2),
        ('Audio',            ARRAY['Headphones', 'Earbuds', 'Speaker', 'Soundbar'],                120, 0.6),
        ('Cookware',         ARRAY['Skillet', 'Saucepan', 'Dutch Oven', 'Wok'],                     60, 2.5),
        ('Furniture',        ARRAY['Desk', 'Bookshelf', 'Armchair', 'Side Table'],                 250, 20.0),
        ('Appliances',       ARRAY['Blender', 'Toaster', 'Coffee Maker', 'Air Fryer'],              90, 3.5),
        ('Camping',          ARRAY['Tent', 'Sleeping Bag', 'Lantern', 'Backpack'],                 110, 1.8),
        ('Fitness',          ARRAY['Yoga Mat', 'Dumbbell Set', 'Jump Rope', 'Kettlebell'],          45, 4.0),
        ('Fiction',          ARRAY['Novel', 'Short Story Collection', 'Anthology'],                 18, 0.5),
        ('Technical',        ARRAY['Programming Guide', 'Reference Manual', 'Field Handbook'],      45, 0.9),
        ('Men''s Clothing',   ARRAY['Jacket', 'Shirt', 'Jeans', 'Sweater'],                          55, 0.7),
        ('Women''s Clothing', ARRAY['Jacket', 'Blouse', 'Dress', 'Sweater'],                         60, 0.6)
    ) AS n (name, nouns, base_price, base_weight) ON n.name = c.name
),
leaf_count AS (SELECT count(*) AS n FROM leaf),
adjectives AS (
    SELECT ARRAY['Classic', 'Premium', 'Compact', 'Deluxe', 'Essential', 'Pro', 'Lite',
                 'Ultra', 'Eco', 'Vintage', 'Smart', 'Rugged'] AS words
),
-- Volatile functions keep this CTE materialized, so each row's random
-- values are computed once and reused below.
gen AS (
    SELECT g,
           leaf.category_id,
           a.words[1 + floor(random() * array_length(a.words, 1))::int]
               || ' ' || leaf.nouns[1 + (g / lc.n) % array_length(leaf.nouns, 1)]
               || ' ' || chr(65 + g % 26) || (100 + g % 900) AS name,
           1 + floor(random() * 10)::int AS supplier_id,
           round((leaf.base_price * (0.5 + random()))::numeric, 2) AS price,
           0.4 + random() * 0.3 AS cost_ratio,
           round((leaf.base_weight * (0.5 + random()))::numeric, 3) AS weight_kg,
           random() < 0.92 AS is_active,
           now() - random() * interval '730 days' AS created_at
    FROM generate_series(1, 2000) AS g
    CROSS JOIN leaf_count lc
    CROSS JOIN adjectives a
    JOIN leaf ON leaf.idx = g % lc.n
)
SELECT format('SKU-%s', lpad(g::text, 6, '0')),
       name,
       'Mock catalog item: ' || lower(name) || '.',
       category_id,
       supplier_id,
       price,
       round(price * cost_ratio::numeric, 2),
       weight_kg,
       is_active,
       created_at
FROM gen
ORDER BY g;

-- Two warehouses per product (~4,000 rows); some end up at or below reorder level.
INSERT INTO product_inventory (product_id, warehouse, quantity_on_hand, reorder_level, updated_at)
SELECT p.product_id,
       (ARRAY['Dallas', 'Reno', 'Columbus'])[1 + (p.product_id + k) % 3],
       floor(random() * 200)::int,
       10 + floor(random() * 21)::int,
       now() - random() * interval '30 days'
FROM products p
CROSS JOIN generate_series(0, 1) AS k;

-- ~1,000 customers.
INSERT INTO customers (first_name, last_name, email, city, state, created_at)
WITH gen AS (
    SELECT g,
           (ARRAY['James', 'Mary', 'Robert', 'Patricia', 'John', 'Jennifer', 'Michael', 'Linda',
                  'David', 'Elizabeth', 'William', 'Barbara', 'Richard', 'Susan', 'Joseph',
                  'Jessica', 'Thomas', 'Sarah', 'Carlos', 'Aisha', 'Wei', 'Priya'])
               [1 + floor(random() * 22)::int] AS first_name,
           (ARRAY['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
                  'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Wilson', 'Anderson', 'Thomas',
                  'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Nguyen', 'Patel'])
               [1 + floor(random() * 22)::int] AS last_name,
           floor(random() * 10)::int AS place,
           now() - random() * interval '1095 days' AS created_at
    FROM generate_series(1, 1000) AS g
)
SELECT first_name,
       last_name,
       lower(first_name || '.' || last_name || g) || '@example.com',
       (ARRAY['Austin', 'Denver', 'Seattle', 'Chicago', 'Boston',
              'Atlanta', 'Phoenix', 'Portland', 'Nashville', 'Miami'])[1 + place],
       (ARRAY['TX', 'CO', 'WA', 'IL', 'MA', 'GA', 'AZ', 'OR', 'TN', 'FL'])[1 + place],
       created_at
FROM gen
ORDER BY g;

-- ~5,000 orders, mostly delivered.
INSERT INTO orders (customer_id, status, ordered_at)
WITH gen AS (
    SELECT g,
           1 + floor(random() * 1000)::bigint AS customer_id,
           random() AS r,
           now() - random() * interval '365 days' AS ordered_at
    FROM generate_series(1, 5000) AS g
)
SELECT customer_id,
       CASE
           WHEN r < 0.05 THEN 'pending'
           WHEN r < 0.12 THEN 'paid'
           WHEN r < 0.25 THEN 'shipped'
           WHEN r < 0.93 THEN 'delivered'
           ELSE 'cancelled'
       END,
       ordered_at
FROM gen
ORDER BY g;

-- 1-5 distinct products per order (~15,000 rows), priced at the product's price.
INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT o.order_id,
       p.product_id,
       1 + floor(random() * 4)::int,
       p.price
FROM orders o
CROSS JOIN LATERAL generate_series(1, 1 + (o.order_id % 5)::int) AS n
JOIN products p ON p.product_id = 1 + (o.order_id * 37 + n * 211) % 2000
ORDER BY o.order_id, n;

-- ~3,000 reviews, skewed toward good ratings.
INSERT INTO product_reviews (product_id, customer_id, rating, title, body, created_at)
WITH gen AS (
    SELECT g,
           1 + floor(random() * 2000)::bigint AS product_id,
           1 + floor(random() * 1000)::bigint AS customer_id,
           random() AS r,
           now() - random() * interval '365 days' AS created_at
    FROM generate_series(1, 3000) AS g
),
rated AS (
    SELECT *,
           CASE
               WHEN r < 0.05 THEN 1
               WHEN r < 0.12 THEN 2
               WHEN r < 0.27 THEN 3
               WHEN r < 0.60 THEN 4
               ELSE 5
           END AS rating
    FROM gen
)
SELECT product_id,
       customer_id,
       rating,
       (ARRAY['Disappointed', 'Not great', 'It''s okay', 'Very good', 'Love it!'])[rating],
       (ARRAY['Broke after a week and support was no help.',
              'Does the job, but the quality is not what I expected.',
              'Fine for the price. Nothing special.',
              'Solid product, would buy again.',
              'Exceeded my expectations in every way.'])[rating],
       created_at
FROM rated
ORDER BY g;

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
CREATE VIEW active_products AS
SELECT p.product_id,
       p.sku,
       p.name,
       c.name AS category,
       s.name AS supplier,
       p.price,
       p.cost,
       p.created_at
FROM products p
JOIN categories c USING (category_id)
JOIN suppliers s USING (supplier_id)
WHERE p.is_active;
COMMENT ON VIEW active_products IS 'Active products with their category and supplier names.';

CREATE VIEW low_stock_products AS
SELECT p.product_id,
       p.sku,
       p.name,
       i.warehouse,
       i.quantity_on_hand,
       i.reorder_level
FROM product_inventory i
JOIN products p USING (product_id)
WHERE p.is_active
  AND i.quantity_on_hand <= i.reorder_level;
COMMENT ON VIEW low_stock_products IS 'Active products at or below their reorder level in a warehouse.';

CREATE VIEW order_totals AS
SELECT o.order_id,
       o.customer_id,
       o.status,
       o.ordered_at,
       count(oi.order_item_id) AS item_count,
       coalesce(sum(oi.quantity * oi.unit_price), 0)::numeric(12, 2) AS total
FROM orders o
LEFT JOIN order_items oi USING (order_id)
GROUP BY o.order_id;
COMMENT ON VIEW order_totals IS 'Item count and total value per order.';

-- ---------------------------------------------------------------------------
-- Materialized view
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW category_sales_summary AS
SELECT c.category_id,
       c.name AS category,
       parent.name AS parent_category,
       count(DISTINCT o.order_id) AS order_count,
       coalesce(sum(oi.quantity), 0) AS units_sold,
       coalesce(sum(oi.quantity * oi.unit_price), 0)::numeric(14, 2) AS revenue
FROM categories c
LEFT JOIN categories parent ON parent.category_id = c.parent_id
LEFT JOIN products p ON p.category_id = c.category_id
LEFT JOIN (order_items oi
           JOIN orders o ON o.order_id = oi.order_id AND o.status <> 'cancelled')
       ON oi.product_id = p.product_id
WHERE c.parent_id IS NOT NULL
GROUP BY c.category_id, c.name, parent.name;
CREATE UNIQUE INDEX category_sales_summary_category_id_idx ON category_sales_summary (category_id);
COMMENT ON MATERIALIZED VIEW category_sales_summary IS
    'Orders, units and revenue per leaf category, excluding cancelled orders. Refresh with refresh_catalog_summaries().';

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------
CREATE FUNCTION product_margin(p_product_id bigint)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
    SELECT round((price - cost) / nullif(price, 0) * 100, 2)
    FROM products
    WHERE product_id = p_product_id;
$$;
COMMENT ON FUNCTION product_margin(bigint) IS 'Gross margin of a product as a percentage of its price.';

CREATE FUNCTION products_in_category(p_category_id integer)
RETURNS SETOF products
LANGUAGE sql
STABLE
AS $$
    WITH RECURSIVE tree AS (
        SELECT category_id FROM categories WHERE category_id = p_category_id
        UNION ALL
        SELECT c.category_id FROM categories c JOIN tree t ON c.parent_id = t.category_id
    )
    SELECT p.* FROM products p JOIN tree USING (category_id);
$$;
COMMENT ON FUNCTION products_in_category(integer) IS 'Products in a category and all of its subcategories.';

CREATE FUNCTION refresh_catalog_summaries()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY category_sales_summary;
END;
$$;
COMMENT ON FUNCTION refresh_catalog_summaries() IS 'Refreshes the catalog materialized views.';

COMMIT;

-- Update planner statistics so pg_class.reltuples (huxdb's Rows column) is accurate right away.
ANALYZE categories, suppliers, products, product_inventory, customers, orders, order_items, product_reviews;
