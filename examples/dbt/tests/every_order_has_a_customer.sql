-- Fails with the orders that the join in orders_with_customers dropped (none, when every ref resolves).
select o.id
from {{ ref('orders') }} as o
left join {{ ref('orders_with_customers') }} as m
    on m.order_id = o.id
where m.order_id is null
