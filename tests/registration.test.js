/**
 * Registration, end to end.
 *
 * The fake Supabase here REJECTS UNKNOWN COLUMNS exactly as PostgREST does —
 * whole statement, error not throw. That is the behaviour that broke account
 * creation, so a stub that accepted anything would prove nothing.
 */
process.env.NODE_ENV='test'; process.env.JWT_SECRET='test-secret-test-secret-test-secret-123';
const Module=require('module'), orig=Module._load;
const ck=require('./_check');

// Real column sets, from scripts/schema.sql + migration 003
const COLS = {
  clients: new Set(['id','full_name','pan_hash','email','phone_wa','tax_bracket','kyc_status',
    'is_active','onboarded_at','updated_at','pin_hash','pin_set','pin_attempts','pin_locked_until',
    'last_login_at','is_admin','onboarding_complete','subscription_plan','subscription_status',
    'subscription_expires_at','grace_stage','payment_failed_at','referral_code','referred_by',
    'referral_months_earned','email_verified','email_alerts_enabled','email_opt_in_brief',
    'last_brief_sent_at','stated_risk_score']),
  client_life_profiles: new Set(['id','client_id','age','retirement_age','income_type',
    'monthly_income_inr','income_stability','monthly_committed_expenses','client_tier',
    'marital_status','num_children','dual_income','dependents_json','upcoming_events_json',
    'health_status','health_insurance_cover_inr','term_cover_inr','has_critical_illness_cover',
    'has_disability_cover','protection_gaps_json','existing_investments_json',
    'outstanding_loans_json','version','assessed_at']),
  client_behavioural_profiles: new Set(['id','client_id','stated_risk_score','effective_risk_score',
    'risk_category','panic_history','portfolio_check_frequency','money_relationship',
    'decision_style','prior_loss_experience','prior_loss_amount_inr','communication_preference',
    'trust_disposition','stability_intervention_threshold_pct','sleep_test_threshold_pct',
    'max_single_position_pct','max_drawdown_tolerance_pct','version','assessed_at']),
  client_goals: new Set(['id','client_id','goal_name','goal_type','bucket_number',
    'target_amount_inr','inflation_rate_pct','target_date','current_corpus_inr','funding_pct',
    'monthly_sip_required_inr','on_track','priority_rank','is_non_negotiable','is_active',
    'created_at','updated_at']),
};

let ROWS={}, REJECTED=[];
const reject = (t,row) => {
  const bad = Object.keys(row).filter(k=>!COLS[t]?.has(k));
  if (bad.length){ REJECTED.push({t,bad});
    return {data:null,error:{code:'PGRST204',
      message:`Could not find the '${bad[0]}' column of '${t}' in the schema cache`}}; }
  return null;
};
const chain=(t)=>{const c={_f:[],
  select(){return c}, eq(k,v){c._f.push([k,v]);return c}, limit(){return c},
  single(){ const d=(ROWS[t]||[]).filter(r=>c._f.every(([k,v])=>r[k]===v));
    return Promise.resolve(d.length?{data:d[0],error:null}:{data:null,error:{message:'no rows'}}) },
  insert(row){
    const rows=Array.isArray(row)?row:[row];
    for(const r of rows){ const e=reject(t,r); if(e) return {select:()=>({single:()=>Promise.resolve(e)}), then:res=>res(e)}; }
    rows.forEach((r,i)=>{ (ROWS[t]=ROWS[t]||[]).push({id:t[0]+'-'+((ROWS[t]||[]).length+1),...r}) });
    const inserted=ROWS[t][ROWS[t].length-1];
    return {select:()=>({single:()=>Promise.resolve({data:inserted,error:null})}),
            then:res=>res({data:rows,error:null})};
  },
  update(row){ const e=reject(t,row); return {eq:()=>Promise.resolve(e||{error:null})} },
  then(res){ let d=ROWS[t]||[]; for(const [k,v] of c._f) d=d.filter(x=>x[k]===v); return res({data:d,error:null}) }};
  return c;};

Module._load=function(r,p,i){
  if(r.includes('config/supabase')) return {supabaseAdmin:{from:chain},supabase:{from:chain}};
  return orig(r,p,i)};

// Minimal express harness
const express=require('express');
const authRouter=require('../backend/routes/auth');
const clientsRouter=require('../backend/routes/clients');
const app=express();
app.use(express.json());
app.use('/api/auth',authRouter);
app.use('/api/clients',clientsRouter);
// The real server's fallback, post-fix
app.use((req,res)=>{ if(req.path.startsWith('/api'))
  return res.status(404).json({error:`No such endpoint: ${req.method} ${req.path}`});
  res.status(200).send('spa'); });

const http=require('http');
const srv=http.createServer(app);

function call(method,path,body,token){
  return new Promise((resolve)=>{
    const data=body?JSON.stringify(body):null;
    const req=http.request({host:'127.0.0.1',port:srv.address().port,path,method,
      headers:Object.assign(data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{}, token?{Authorization:'Bearer '+token}:{})},
      r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{
        let j=null; try{j=JSON.parse(b)}catch{}
        resolve({status:r.statusCode,body:j});});});
    req.setTimeout(4000,()=>{req.destroy();resolve({status:'TIMEOUT',body:null})});
    req.on('error',()=>resolve({status:'ERROR',body:null}));
    if(data)req.write(data); req.end();
  });
}

// EXACTLY what the deployed frontend sends
const PAYLOAD = {
  full_name:'Mayur Bothra', phone_wa:'+919830000000', email:'test@example.com',
  age:38, income_type:'business', monthly_income_inr:200000, monthly_committed_expenses:80000,
  marital_status:'married', num_children:2,
  health_insurance_cover_inr:1000000, term_cover_inr:10000000,
  stated_risk_score:6, panic_history:false, money_relationship:'security',
  sleep_test_threshold_pct:15,
  goals:[{goal_name:'Retirement',target_amount_inr:50000000,target_date:'2045'},
         {goal_name:"Child's education",target_amount_inr:8000000,target_date:'2033'}],
  tax_bracket:30,
};

srv.listen(0, async () => {
  console.log('\n── THE BUG: the real onboarding payload ──');
  ROWS={}; REJECTED=[];
  let r = await call('POST','/api/auth/register',{...PAYLOAD});
  ck('registration returns 200 (was 500)', r.status===200);
  ck('registration signs the new client in (token)', !!r.body?.token);
  ck('a new account with profile answers is onboarding_complete', ROWS.clients?.[0]?.onboarding_complete===true);
  ck('a client_id comes back', !!r.body?.client_id);
  ck('no column was rejected', REJECTED.length===0);
  if(REJECTED.length) console.log('   rejected:', JSON.stringify(REJECTED));

  console.log('\n── the payload landed in the right four tables ──');
  ck('clients: 1 row', (ROWS.clients||[]).length===1);
  ck('clients has email + phone + name',
     ROWS.clients?.[0].email==='test@example.com' && ROWS.clients[0].phone_wa==='+919830000000');
  ck('clients does NOT hold goals', !('goals' in (ROWS.clients?.[0]||{})));
  ck('clients does NOT hold age', !('age' in (ROWS.clients?.[0]||{})));
  ck('life profile created', (ROWS.client_life_profiles||[]).length===1);
  ck('life profile has age + income', ROWS.client_life_profiles?.[0].age===38 &&
     ROWS.client_life_profiles?.[0].monthly_income_inr===200000);
  ck('behavioural profile created', (ROWS.client_behavioural_profiles||[]).length===1);
  ck('behavioural has risk + sleep test',
     ROWS.client_behavioural_profiles?.[0].stated_risk_score===6 &&
     ROWS.client_behavioural_profiles?.[0].sleep_test_threshold_pct===15);
  ck('both goals created', (ROWS.client_goals||[]).length===2);
  ck('goal year "2045" became a DATE', ROWS.client_goals?.[0].target_date==='2045-03-31');
  ck('goals linked to the client', ROWS.client_goals?.[0].client_id===ROWS.clients[0].id);
  ck('goals numbered', ROWS.client_goals?.[0].bucket_number===1 && ROWS.client_goals?.[1].bucket_number===2);

  console.log('\n── duplicates are reported in plain words ──');
  r = await call('POST','/api/auth/register',{...PAYLOAD});
  ck('same phone → 409', r.status===409);
  ck('message is readable', /phone number already exists/i.test(r.body?.error||''));
  r = await call('POST','/api/auth/register',{...PAYLOAD, phone_wa:'+919830000001'});
  ck('same email → 409 (email is UNIQUE)', r.status===409);
  ck('names the email, not a constraint', /email address already exists/i.test(r.body?.error||''));

  console.log('\n── an unknown field can never break registration again ──');
  ROWS={}; REJECTED=[];
  r = await call('POST','/api/auth/register',
    {...PAYLOAD, phone_wa:'+919830000009', email:'new@example.com',
     some_future_field:'x', another:{nested:true}});
  ck('still 200', r.status===200);
  ck('nothing rejected', REJECTED.length===0);
  ck('the account was created', (ROWS.clients||[]).length===1);

  console.log('\n── validation ──');
  r = await call('POST','/api/auth/register',{full_name:'No Phone'});
  ck('missing phone → 400', r.status===400);
  r = await call('POST','/api/auth/register',{phone_wa:'+91999'});
  ck('missing name → 400', r.status===400);

  console.log('\n── R2: the email route now EXISTS ──');
  ROWS={}; REJECTED=[];
  const reg = await call('POST','/api/auth/register',{...PAYLOAD, phone_wa:'+919830000077', email:'a@b.com'});
  const cid = ROWS.clients[0].id, tok = reg.body.token;
  r = await call('POST',`/api/clients/${cid}/email`,{email:'Brief@Example.COM'}, tok);
  ck('returns 200 (was hanging for 60s)', r.status===200);
  ck('did not time out', r.status!=='TIMEOUT');
  ck('email normalised to lowercase', r.body?.email==='brief@example.com');
  r = await call('POST',`/api/clients/${cid}/email`,{email:'nonsense'}, tok);
  ck('invalid email → 400', r.status===400);
  r = await call('POST',`/api/clients/${cid}/email`,{}, tok);
  ck('missing email → 400', r.status===400);

  console.log('\n── R3: an unmatched /api path 404s instead of hanging ──');
  r = await call('POST','/api/does/not/exist',{});
  ck('returns 404, not a hang', r.status===404);
  ck('did not time out', r.status!=='TIMEOUT');
  ck('names the path', /does\/not\/exist/.test(r.body?.error||''));
  r = await call('GET','/some/spa/route');
  ck('non-api path still serves the SPA', r.status===200);

  srv.close();
});
