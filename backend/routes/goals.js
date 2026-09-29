const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../config/supabase');

router.get('/:clientId', async (req, res) => {
  if (!supabaseAdmin) return res.status(503).json({
    goals: [], unavailable: true,
    message: 'Your goals are temporarily unavailable.',
  });
  const { data, error } = await supabaseAdmin.from('client_goals').select(`*, client_goal_buckets(*)`).eq('client_id', req.params.clientId).eq('is_active', true).order('priority_rank');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ goals: data });
});

router.post('/add', async (req, res) => {
  const { client_id, goal_name, goal_type, target_amount_inr, target_date, priority_rank, is_non_negotiable } = req.body;
  if (!supabaseAdmin) return res.status(503).json({
    success: false, unavailable: true,
    error: 'Could not save right now — no change was made.',
  });
  const { data, error } = await supabaseAdmin.from('client_goals').insert({
    client_id, goal_name, goal_type, target_amount_inr, target_date,
    priority_rank: priority_rank || 1, is_non_negotiable: is_non_negotiable || false,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, goal: data });
});

router.put('/:goalId/progress', async (req, res) => {
  const { current_corpus_inr } = req.body;
  if (!supabaseAdmin) return res.status(503).json({
    success: false, unavailable: true,
    error: 'Could not save right now — no change was made.',
  });
  const { data: goal } = await supabaseAdmin.from('client_goals').select('target_amount_inr').eq('id', req.params.goalId).single();
  const funding_pct = goal ? (current_corpus_inr / goal.target_amount_inr * 100) : 0;
  const { error } = await supabaseAdmin.from('client_goals').update({ current_corpus_inr, funding_pct, on_track: funding_pct >= 60, updated_at: new Date().toISOString() }).eq('id', req.params.goalId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, funding_pct });
});



module.exports = router;
