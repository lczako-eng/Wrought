// netlify/functions/api-progress.js
// The dashboard's data endpoint.
//
// This exists so the web charts and the MCP brief cannot disagree. Both call
// into lib/forge.js and both get the same arithmetic. If the dashboard drew its
// own averages in JavaScript, the day would come when the chart says 151g of
// protein and the nightly verdict says 148, and on that day nobody believes
// either one again.

import {
  getAuthUser, getProfile, getGoals, getWindow, windowStatus,
  localDateFor, addDays, humanDuration, kgToLb,
  rangeFacts, summariseRange, dayFacts, careFlags, scoreGoals, supabase,
} from './lib/forge.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!supabase) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_not_configured' }) };

  const user = await getAuthUser(event);
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'sign_in_required' }) };

  const params = event.queryStringParameters || {};
  const span = Math.min(Math.max(parseInt(params.days, 10) || 30, 3), 400);

  const profile = await getProfile(user.id);
  const to   = params.to || localDateFor(profile.timezone);
  const from = addDays(to, -(span - 1));

  const [range, today, goals, win] = await Promise.all([
    rangeFacts(user.id, profile, from, to),
    dayFacts(user.id, profile, to),
    getGoals(user.id),
    getWindow(user.id),
  ]);

  const summary = summariseRange(range, profile);
  const flags   = careFlags(range, profile);
  const imperial = profile.units === 'imperial';

  // Latest verdict, so the dashboard shows the same words the assistant said
  // rather than generating a second, subtly different opinion.
  const { data: brief } = await supabase.from('forge_briefs')
    .select('local_date, kind, verdict').eq('user_id', user.id)
    .order('local_date', { ascending: false }).limit(1).maybeSingle();

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      from, to, span_days: span,
      units: profile.units,
      weight_unit: imperial ? 'lb' : 'kg',
      today: {
        date: to,
        food: today.food,
        training: today.training,
        body: today.body,
        device: today.device,
        entries: today.log,
      },
      summary: {
        ...summary,
        sleep_avg_say: summary.sleep_avg_minutes ? humanDuration(summary.sleep_avg_minutes) : null,
      },
      goals: scoreGoals(goals, today, summary, profile),
      eating_window: windowStatus(win, profile.timezone),
      series: {
        weight:   range.days.map(d => ({ date: d.date, value: d.weight_kg == null ? null : (imperial ? kgToLb(d.weight_kg) : d.weight_kg) })),
        calories: range.days.map(d => ({ date: d.date, value: d.calories })),
        protein:  range.days.map(d => ({ date: d.date, value: d.protein_g })),
        volume:   range.days.map(d => ({ date: d.date, value: d.volume_kg })),
        steps:    range.days.map(d => ({ date: d.date, value: d.steps })),
        sleep:    range.days.map(d => ({ date: d.date, value: d.sleep_minutes })),
      },
      latest_verdict: brief || null,
      care_flags: flags,
    }),
  };
};
