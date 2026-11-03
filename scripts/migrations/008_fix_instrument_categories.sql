-- 008 — put listed companies in the right category.
-- Found on review of the live Markets dashboard (3 Nov 2026): listed stocks were
-- sitting under "Large-Cap Funds" / "Flexi & Mid-Cap Funds" / "Index ETFs", and
-- small companies under "Large-Cap Equity". The category decides the baseline
-- scores, the risk label and the accuracy group, so a wrong one skews the call.
-- Safe to re-run: it only sets the category by symbol.

-- Infosys is a large-cap company, not an index ETF.
update instrument_universe set category = 'large_cap_equity'
 where symbol in ('INFY');

-- Mid-cap companies.
update instrument_universe set category = 'mid_cap_equity'
 where symbol in ('PERSISTENT','VOLTAS','TIINDIA','MPHASIS','KPITTECH','SCHAEFFLER',
                  'SYNGENE','ASTRAL','PIIND','SUPREMEIND','CHOLAFIN');

-- Small-cap companies.
update instrument_universe set category = 'small_cap_equity'
 where symbol in ('MASTEK','ZENSARTECH','INTELLECT','TANLA','HAPPSTMNDS','AAVAS',
                  'ROUTE','LATENTVIEW','DATAMATICS');
