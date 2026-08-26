const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../config/supabase');

router.get('/:clientId', async (req, res) => {
  if (!supabaseAdmin) return res.json({ goals: getDemoGoals(), demo: true });
  const { data, error } = await supabaseAdmin.from('client_goals').select(`*, client_goal_buckets(*)`).eq('client_id', req.params.clientId).eq('is_active', true).order('priority_rank');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ goals: data });
});

router.post('/add', async (req, res) => {
  const { client_id, goal_name, goal_type, target_amount_inr, target_date, priority_rank, is_non_negotiable } = req.body;
  if (!supabaseAdmin) return res.json({ success: true, demo: true });
  const { data, error } = await supabaseAdmin.from('client_goals').insert({
    client_id, goal_name, goal_type, target_amount_inr, target_date,
    priority_rank: priority_rank || 1, is_non_negotiable: is_non_negotiable || false,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, goal: data });
});

router.put('/:goalId/progress', async (req, res) => {
  const { current_corpus_inr } = req.body;
  if (!supabaseAdmin) return res.json({ success: true, demo: true });
  const { data: goal } = await supabaseAdmin.from('client_goals').select('target_amount_inr').eq('id', req.params.goalId).single();
  const funding_pct = goal ? (current_corpus_inr / goal.target_amount_inr * 100) : 0;
  const { error } = await supabaseAdmin.from('client_goals').update({ current_corpus_inr, funding_pct, on_track: funding_pct >= 60, updated_at: new Date().toISOString() }).eq('id', req.params.goalId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, funding_pct });
});

function getDemoGoals() {
  return [
    { id:'g1', goal_name:'Emergency Fund', goal_type:'emergency', bucket_number:0, target_amount_inr:300000, current_corpus_inr:300000, funding_pct:100, on_track:true, priority_rank:1, is_non_negotiable:true },
    { id:'g2', goal_name:"Priya's College", goal_type:'short', bucket_number:1, target_amount_inr:750000, current_corpus_inr:547500, funding_pct:73, on_track:true, priority_rank:2, target_date:'2029-07-01' },
    { id:'g3', goal_name:'Home Down Payment', goal_type:'medium', bucket_number:2, target_amount_inr:1500000, current_corpus_inr:870000, funding_pct:58, on_track:true, priority_rank:3, target_date:'2027-12-01' },
    { id:'g4', goal_name:'Retirement at 55', goal_type:'long', bucket_number:3, target_amount_inr:5000000, current_corpus_inr:1550000, funding_pct:31, on_track:false, priority_rank:4, target_date:'2046-01-01' },
  ];
}

module.exports = router;
