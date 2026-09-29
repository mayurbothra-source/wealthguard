const { createClient } = require('@supabase/supabase-js');

const supabaseUrl  = process.env.SUPABASE_URL;
const supabaseAnon = process.env.SUPABASE_ANON_KEY;
const supabaseSvc  = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseAnon) {
  console.warn('⚠️  Supabase credentials not set — running in demo mode');
}

// Public client (respects RLS)
const supabase = supabaseUrl
  ? createClient(supabaseUrl, supabaseAnon)
  : null;

// Service client (bypasses RLS — backend only)
const supabaseAdmin = supabaseUrl && supabaseSvc
  ? createClient(supabaseUrl, supabaseSvc)
  : null;

module.exports = { supabase, supabaseAdmin };
