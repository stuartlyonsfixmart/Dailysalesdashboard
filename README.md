# Fixmart Sales Orders Board

Daily orders-taken board over a custom date range, optional sales-rep filter.

## What it counts

Orders taken by order date (`oh_datetime`) from OrderWise, reproducing OrderWise
report **10-0028-001** ("Top N Customers by Sales Net"), which is the daily sales
report circulated each morning:

- Sales order types **1, 4, 8, 9**. Credits and refunds (types **4 and 9**) are
  both sign-flipped, so figures are net of credits. Type 11 (Bulk Order) is
  excluded, matching the report.
- Internal Fixmart accounts are excluded (Ltd, Engineering, Subcontract, GmbH).
  The report inner-joins customer to sales rep, and those accounts carry no rep,
  so the board reproduces that join rather than hardcoding an account list. Any
  new internal account is therefore excluded automatically. The value removed is
  shown on screen rather than dropped silently.
- Quotes (type 2) are not counted. A won quote is changed in place into an order
  in OrderWise and is picked up as a sale at that point, so there is nothing extra
  to add.

Validated August 2026: July agreed with the OrderWise report to £1,178 on £2.0m
(0.06% on sales, 0.09% on margin), with three account managers matching exactly.

GP is order-book basis, using estimated costs. It moves as orders are despatched
and true costs pull through, which is why OrderWise re-runs the report from the
first of the month each day and its MTD figure differs from the sum of the frozen
daily rows.

## Metrics

For the period and per working day: orders, order lines, units, weight, sales, GP
and GP%. Each tile shows the rate per working day, the Orders tile shows average
order value, and the table carries an average-per-working-day row. Working days
are Mon-Fri less England and Wales public holidays, counted across the selected
range and never past today.

## Endpoints

- `GET /api/daily?startDate=&endDate=&rep=&compare=1` daily rows plus totals,
  per-working-day averages, average order value and the excluded internal value
- `GET /api/germany?startDate=&endDate=` GmbH, Cin7, invoiced basis, GBP
- `GET /api/combined?startDate=&endDate=` UK plus GmbH side by side (mixed basis)
- `GET /api/reps` sales-rep dropdown
- `GET /api/freshness` last `order_header` load timestamp

## Data notes

Data refreshes with the nightly OrderWise load (~04:00), so the board is current
to the last load.

The feed must refresh existing `order_header` rows, not only insert new ones.
Until August 2026 it loaded each document once and never revisited it, so won
quotes kept their original quote type and date for ever and never appeared as
sales. That understated the board by roughly 11%, about £199k in July 2026 alone.
Jo refreshed three months of history to correct it. If sales start drifting below
OrderWise again, check that first.

Germany is invoiced (Cin7, by invoice date) while the UK is orders taken, so the
combined tab mixes two bases. That is flagged on the tab itself.
