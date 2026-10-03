/**
 * A small in-memory stand-in for the Supabase client, enough for the route and
 * engine tests: select / insert / upsert / update / delete with eq, is, in,
 * gte, gt, lt, or, order, limit, single, maybeSingle, and head+count selects.
 *
 * `rejectColumns` lets a test pretend a column does not exist yet (PostgREST
 * rejects the whole statement), to prove code works on an unmigrated database.
 */
function makeDb() {
  const T = {};              // table -> rows
  let seq = 1;
  const rejectColumns = {};  // table -> Set of columns that "do not exist"
  const rows = t => (T[t] = T[t] || []);

  function builder(table) {
    const q = { op: 'select', filters: [], order: null, lim: null, payload: null, head: false, count: false, onConflict: null, single: null };
    const match = r => q.filters.every(f => f(r));
    const run = () => {
      const bad = q.payload && [].concat(q.payload).flatMap(Object.keys).find(k => rejectColumns[table]?.has(k));
      if (bad) return { data: null, error: { code: 'PGRST204', message: `Could not find the '${bad}' column of '${table}' in the schema cache` } };

      if (q.op === 'insert') {
        const list = [].concat(q.payload).map(r => ({ id: `${table[0]}${seq++}`, ...r }));
        // unique (code, client_id) on discount_code_usage, like the migration adds
        if (table === 'discount_code_usage') {
          for (const r of list) if (rows(table).some(x => x.code === r.code && x.client_id === r.client_id))
            return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        }
        rows(table).push(...list);
        return { data: Array.isArray(q.payload) ? list : list[0], error: null };
      }
      if (q.op === 'upsert') {
        const keys = (q.onConflict || 'id').split(',');
        for (const r of [].concat(q.payload)) {
          const i = rows(table).findIndex(x => keys.every(k => x[k] === r[k]));
          if (i >= 0) Object.assign(rows(table)[i], r); else rows(table).push({ id: `${table[0]}${seq++}`, ...r });
        }
        return { data: null, error: null };
      }
      if (q.op === 'update') {
        const hit = rows(table).filter(match);
        hit.forEach(r => Object.assign(r, q.payload));
        return { data: q.single ? (hit[0] || null) : hit, error: null };
      }
      if (q.op === 'delete') {
        T[table] = rows(table).filter(r => !match(r));
        return { data: null, error: null };
      }
      let out = rows(table).filter(match);
      if (q.order) out = [...out].sort((a, b) => (a[q.order.k] > b[q.order.k] ? 1 : -1) * (q.order.asc ? 1 : -1));
      if (q.lim != null) out = out.slice(0, q.lim);
      if (q.head) return { data: null, count: out.length, error: null };
      if (q.single === 'single') return out.length ? { data: out[0], error: null } : { data: null, error: { message: 'no rows' } };
      if (q.single === 'maybe') return { data: out[0] || null, error: null };
      return { data: out, error: null };
    };

    const api = {
      select(_cols, opts) { if (opts?.head) q.head = true; return api; },
      insert(p) { q.op = 'insert'; q.payload = p; return api; },
      upsert(p, o) { q.op = 'upsert'; q.payload = p; q.onConflict = o?.onConflict; return api; },
      update(p) { q.op = 'update'; q.payload = p; return api; },
      delete() { q.op = 'delete'; return api; },
      eq(k, v) { q.filters.push(r => r[k] === v); return api; },
      is(k, v) { q.filters.push(r => (r[k] ?? null) === v); return api; },
      in(k, vs) { q.filters.push(r => vs.includes(r[k])); return api; },
      gte(k, v) { q.filters.push(r => r[k] >= v); return api; },
      gt(k, v) { q.filters.push(r => r[k] > v); return api; },
      lt(k, v) { q.filters.push(r => r[k] < v); return api; },
      or(expr) {
        const parts = expr.split(',').map(p => p.split('.'));
        q.filters.push(r => parts.some(([k, op, v]) => op === 'eq' ? String(r[k]) === v : op === 'is' ? (r[k] ?? null) === null : false));
        return api;
      },
      order(k, o) { q.order = { k, asc: o?.ascending !== false }; return api; },
      limit(n) { q.lim = n; return api; },
      single() { q.single = 'single'; return api; },
      maybeSingle() { q.single = 'maybe'; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }

  return { from: builder, T, rows, rejectColumns, seed(t, list) { rows(t).push(...list.map(r => ({ id: r.id || `${t[0]}${seq++}`, ...r }))); } };
}
module.exports = makeDb;
