const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../config/supabase');
const { requireSession, ownsParam, ownsBody } = require('../lib/session');
const { GOAL_EDITABLE, only } = require('../lib/clientFields');

const unavailable = res => res.status(503).json({
  success: false, unavailable: true, goals: [],
  error: 'Could not save right now — no change was made.',
  message: 'Your goals are temporarily unavailable.',
});

router.get('/:clientId', requireSession, ownsParam('clientId'), async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const { data, error } = await supabaseAdmin.from('client_goals').select(`*, client_goal_buckets(*)`).eq('client_id', req.params.clientId).eq('is_active', true).order('priority_rank');
  if (error) return res.status(500).json({ error: 'Could not load your goals.' });
  res.json({ goals: data });
});

router.post('/add', requireSession, ownsBody('client_id'), async (req, res) => {
  if (!supabaseAdmin) return unavailable(res);
  const fields = only(req.body, GOAL_EDITABLE);
  if (!fields.goal_name) return res.status(400).json({ error: 'goal_name is required' });
  const { data, error } = await supabaseAdmin.from('client_goals').insert({
    ...fields,
    client_id: req.auth.clientId,
    priority_rank: fields.priority_rank || 1,
    is_non_negotiable: fields.is_non_negotiable || false,
  }).select().single();
  if (error) return res.status(500).json({ error: 'Could not save your goal.' });
  res.json({ success: true, goal: data });
});

router.put('/:goalId/progress', requireSession, async (req, res) => {
  const current = Number((req.body || {}).current_corpus_inr);
  if (!supabaseAdmin) return unavailable(res);
  if (!Number.isFinite(current) || current < 0) return res.status(400).json({ error: 'current_corpus_inr must be a number ≥ 0' });

  // The goal must belong to the caller.
  const { data: goal } = await supabaseAdmin.from('client_goals')
    .select('target_amount_inr, client_id').eq('id', req.params.goalId).maybeSingle();
  if (!goal || (!req.auth.soft && String(goal.client_id) !== String(req.auth.clientId))) {
    return res.status(404).json({ error: 'Goal not found.' });
  }
  const target = Number(goal.target_amount_inr) || 0;
  const funding_pct = target > 0 ? (current / target * 100) : 0;   // no divide-by-zero
  const { error } = await supabaseAdmin.from('client_goals').update({
    current_corpus_inr: current, funding_pct, on_track: funding_pct >= 60, updated_at: new Date().toISOString(),
  }).eq('id', req.params.goalId);
  if (error) return res.status(500).json({ error: 'Could not save progress.' });
  res.json({ success: true, funding_pct });
});

module.exports = router;
