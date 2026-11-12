# Starting plan — clients with no holdings

Built in `backend/services/startingPlan.js`; shown in the morning brief (app and
email) to every client who has no holdings logged. The client is never asked
how much they can invest — the plan says what each goal needs, and they invest
what they choose and add it as holdings.

## Rules and where the numbers come from (checked 12 Nov 2026)

### Equity cap by risk profile — follows PFRDA's NPS lifecycle funds

| Risk score | Band | Equity cap | NPS equivalent |
|---|---|---|---|
| 1–3 | Low | 25% | LC25 (conservative) |
| 4–6 | Moderate | 50% | LC50 (moderate, the NPS default) |
| 7–10 | High | 75% | LC75 (aggressive) |

A past panic-sell (`panic_history`) lowers the cap by 10 points.
Sources: [PIB](https://pib.gov.in/PressReleasePage.aspx?PRID=2182253),
[Business Standard](https://www.business-standard.com/finance/personal-finance/nps-ups-get-75-equity-option-for-govt-staff-here-s-what-it-means-125102800843_1.html),
[NPS investment options](https://www.npscra.proteantech.in/download/Investment_options_under_NPS_02.pdf).

### Mix by time to goal

| Years to goal | Equity | Debt | Gold |
|---|---|---|---|
| Under 3 | 0% | 100% (liquid / ultra-short) | 0% |
| 3–5 | up to 25% | rest | 5% |
| 5–7 | up to 50% | rest | 10% |
| Over 7 | the risk cap | rest | 10% |
| Emergency fund (any date) | 0% | 100% liquid / ultra-short | 0% |

- Under 3 years: debt only ([FundsIndia](https://www.fundsindia.com/blog/mf-research/is-a-higher-equity-allocation-injurious-to-your-short-term-goals/26809), [Freefincal](https://freefincal.com/the-trouble-with-planning-for-intermediate-term-goals)).
- 3–5 years: no more than 25–30% equity, in large-caps ([Outlook Money](https://www.outlookmoney.com/amp/story/magazine/archive/smart-investing-in-equity-mutual-funds-531)). We use 25%.
- 5+ years: Nifty 50 TRI lost money in ~7% of 3-year windows but essentially none of the 5-year windows since 1999 ([Craytheon](https://craytheon.com/charts/nifty-50-rolling-returns/), [Stable Investor](https://stableinvestor.com/2024/07/3-5-7-years-nifty50-cagr-return-analysis.html)).

Within equity: low — large-cap/index only; moderate — 60% large-cap/index,
40% flexi/mid-cap; high — 50/30/20 large/flexi-mid/small. A part with nothing
eligible folds into large-cap.

### Planning returns (deliberately below history, not promised)

| Asset | Used | Evidence |
|---|---|---|
| Equity | 10% | Nifty 50 TRI 20-yr CAGR ~11.2–12.4%; the 20-yr rolling figure fell below 10% for FY26 ([Bajaj AMC](https://www.bajajamc.com/knowledge-centre/nifty-50-historical-returns), [Finnovate](https://www.finnovate.in/learn/blog/nifty-20-year-cagr-below-10-percent-history), [Business Today](https://www.businesstoday.in/mutual-funds/story/can-indian-equities-and-mutual-funds-still-create-long-term-wealth-for-investors-531157-2026-05-13)) |
| Debt | 6.5% | Short/low-duration funds ~6.5–7.7% over 10 years; category average ~6.5% |
| Gold | 8% | 20-yr INR CAGR ~11–15%, inflated by the recent rally and rupee depreciation ([Aditya Birla Capital](https://www.adityabirlacapital.com/abc-of-money/gold-price-history-in-india), [Finnovate](https://www.finnovate.in/learn/blog/indian-equity-returns-vs-gold-global-markets)) |

### Emergency fund
If the client set an emergency-fund goal it is planned first, 100% in liquid /
ultra-short debt. Otherwise the plan reminds them that most guides suggest 3–6
months of expenses (9–12 if self-employed) in a liquid fund
([Finnovate](https://www.finnovate.in/learn/blog/emergency-fund-india-3-6-12-rule)).

### Instruments named
- Actively managed funds: only if measured on real price data and not on SELL; highest-scoring first, at most 2 per part.
- Stocks: only if measured, on BUY, and in a category the risk band allows (low: large-cap; moderate: + mid-cap; high: + small-cap).
- Broad index and gold ETFs (NIFTYBEES, SBINIFTY, HDFCSENSEX, JUNIORBEES; GOLDBEES, SBIGOLD …) stand in for the asset class itself; sector/thematic ETFs are not used.
- Statically-priced instruments (G-Secs, SGBs, RBI floating bonds) are never named — they cannot be bought on an exchange.

## Monthly amount
Future value of an annuity at the goal's blended planning return, after growing
any current corpus. Target amounts are used as entered (not inflation-adjusted).
