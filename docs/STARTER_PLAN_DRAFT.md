# Starting plan for clients with no holdings — DRAFT for review

Status: **not built, not sent to anyone.** These are proposed rules. Once you
approve or change them, they become a new "Your starting plan" section in the
morning brief for clients who have no holdings logged.

Every number below is a proposal. Change anything that does not match how you
want WealthGuard to advise.

---

## 1. Emergency fund comes first

- If the client has an "Emergency Fund" goal that is not yet met, the plan puts
  new money there first.
- Where it goes: liquid or ultra-short-duration debt funds (money available in a day).
- Target: the client's own Emergency Fund amount, or 6 months of expenses if no amount was given.
- Until it is met: at most 25% of the monthly amount goes to other goals.

## 2. Each goal gets a mix based on how far away it is

| Years to goal | Equity | Debt (short-term / liquid) | Gold |
|---|---|---|---|
| Under 3 | 0% | 100% | 0% |
| 3 to 5 | 30% | 65% | 5% |
| 5 to 7 | 50% | 40% | 10% |
| Over 7 | the equity limit for the client's risk band (below) | the rest | 10% |

The money moves gradually towards debt as a goal gets closer (the
"glide path"). The plan re-checks this every month.

## 3. The client's risk score caps equity

| Risk score | Band | Most equity in any goal | Equity split |
|---|---|---|---|
| 1–3 | Low | 40% | index / large-cap funds only |
| 4–6 | Moderate | 65% | 60% index or large-cap, 40% flexi-cap or mid-cap |
| 7–10 | High | 80% | 50% index or large-cap, 30% flexi or mid-cap, 20% small-cap |

If the client panicked in a past fall (`panic_history = true`), the cap is
10 points lower.

## 4. How much to invest each month

- For each goal, the monthly SIP needed to reach the target, using assumed
  yearly returns of: equity 11%, debt 7%, gold 7%. These are conservative,
  stated in the brief, and not promised.
- If the total is more than the client can invest, the order is: emergency
  fund, then goals nearest in time, and the brief says plainly which goals are
  under-funded.

## 5. Which instruments to name

- Only funds or ETFs from our instrument list in the right category.
- Only instruments whose latest score was measured from real price data and is not a SELL.
- Prefer index funds and lower expense ratios; at most 2 instruments per category.
- No individual stocks in a starting plan.

## 6. Wording

- Shown as "a starting plan based on your profile and goals", with the
  assumptions listed, and the existing not-advice line.
- A starting plan never uses BUY/SELL language; it says "consider starting a
  monthly SIP of about ₹X in …".

---

## Worked example — TEST One

Risk score 6 (moderate), no holdings. Goals: Emergency Fund ₹3 L by Mar 2030,
Child's Education ₹30 L by Mar 2035, Retirement ₹10 Cr by Mar 2047.

| Goal | Years | Mix | Monthly SIP needed (approx.) |
|---|---|---|---|
| Emergency Fund ₹3 L | 3.4 | 100% liquid / ultra-short debt (rule 1) | ₹6,500 |
| Child's Education ₹30 L | 8.4 | 65% equity, 25% debt, 10% gold | ₹19,000 |
| Retirement ₹10 Cr | 20.4 | 65% equity, 25% debt, 10% gold | ₹1,02,000 |

The retirement figure shows why rule 4 matters: most clients will not be able
to fund every goal, and the brief should say so honestly rather than quietly
assume they can.

## Questions for you

1. Are the equity caps and the time-to-goal mixes right for your clients?
2. Are 11% / 7% / 7% acceptable return assumptions to quote?
3. Do we have each client's monthly investable amount, or should we ask for it
   at registration?
4. Should individual stocks ever appear in a starting plan?
