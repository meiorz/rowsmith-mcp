def test_orders_are_reproducible(orders):
    assert len(orders) == 20
    assert orders[0]["order_id"] == "ord_0001"
    # Emails use only domains reserved for documentation and testing (RFC 2606 / RFC 6761).
    reserved = ("example.com", "example.net", "example.org", "mail.test")
    assert all(o["email"].rsplit("@", 1)[1] in reserved for o in orders)
