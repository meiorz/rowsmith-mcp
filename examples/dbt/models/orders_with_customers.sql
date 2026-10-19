-- Each order with its customer's email. An inner join: tests/every_order_has_a_customer.sql checks that no order
-- is lost, which holds because every customer_id was drawn from the customers of the same call.
select
    o.id as order_id,
    o.total,
    c.id as customer_id,
    c.email
from {{ ref('orders') }} as o
join {{ ref('customers') }} as c
    on c.id = o.customer_id
