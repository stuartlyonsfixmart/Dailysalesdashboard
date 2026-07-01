# Fixmart Sales Orders Board

Daily orders-taken board over a custom date range, optional sales-rep filter.

Orders taken by order date (`oh_datetime`), OrderWise, sales order types 1,4,8,9,11,
credits (sot 4) sign-flipped. GP is order-book basis: it reads below the management
accounts because of the sleeve, by design. Do not reconcile the two.

- `GET /api/daily?startDate=&endDate=&rep=` daily rows + totals
- `GET /api/reps` sales-rep dropdown
- `GET /api/freshness` last order_header load timestamp

Data refreshes with the nightly OrderWise load (~04:00), so the board is current
to the last load.
