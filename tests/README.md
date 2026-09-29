# Tests

No framework — plain node, so `node tests/<file>` runs anywhere with zero setup.

```
node tests/levers.maths.test.js        # volatility, Sharpe, drawdown, RSI, returns
node tests/levers.scoring.test.js      # the nine levers, incl. extreme-input bounds
node tests/pipeline.test.js            # end to end with a fake Supabase and Yahoo
node tests/db.test.js                  # the error-surfacing data layer
node tests/opportunityEngine.test.js   # the double-insert and dedup fixes
```

Every suite prints PASS/FAIL per assertion. 167 assertions total.

The pipeline suite is the one that matters most: it drives the real modules
with a stubbed Supabase and a stubbed Yahoo, and covers the three failure
modes that matter in production — Yahoo healthy, quoteSummary down but charts
working, and Yahoo entirely unreachable. The last case asserts that a total
outage produces **zero directional signals** rather than 120 built from
category constants.
