// One explicit timing contract for web and the connector; mirrored by RoundClock.swift.
export const DEFAULT_PLAN = Object.freeze({ name: 'Boxing', rounds: 8, workSeconds: 180, restSeconds: 60, warningSeconds: 30, activity: 'boxing' });
export function validatePlan(input = {}) {
  const plan = { ...DEFAULT_PLAN, ...input };
  if (!['boxing', 'hiit', 'strength', 'running'].includes(plan.activity)) throw new Error('Choose boxing, intervals, strength or indoor running.');
  if (typeof plan.name !== 'string' || !plan.name.trim() || plan.name.length > 80) throw new Error('Use a workout name of 1–80 characters.');
  for (const [key, min, max] of [['rounds', 1, 30], ['workSeconds', 10, 1800], ['restSeconds', 0, 600], ['warningSeconds', 0, 60]]) {
    if (!Number.isInteger(plan[key]) || plan[key] < min || plan[key] > max) throw new Error(`${key} must be a whole number between ${min} and ${max}.`);
  }
  if (totalSeconds(plan) > 14400) throw new Error('The timer supports sessions up to four hours.');
  return Object.fromEntries(Object.keys(DEFAULT_PLAN).map(key => [key, plan[key]]));
}
export function totalSeconds(p) { return p.rounds * p.workSeconds + (p.rounds - 1) * p.restSeconds; }
export function position(p, elapsed) {
  const seconds = Math.max(0, Math.floor(elapsed));
  if (seconds >= totalSeconds(p)) return { phase: 'complete', round: p.rounds, remaining: 0, duration: 0, key: 'complete' };
  const cycle = p.workSeconds + p.restSeconds, round = Math.floor(seconds / cycle) + 1, offset = seconds % cycle;
  const phase = offset < p.workSeconds ? 'work' : 'rest';
  return { phase, round, remaining: phase === 'work' ? p.workSeconds - offset : cycle - offset,
    duration: phase === 'work' ? p.workSeconds : p.restSeconds, key: `${round}-${phase}` };
}
export function cue(p, before, after) {
  if (before?.key !== after.key) return after.phase === 'work' ? 2 : 3;
  return after.phase === 'work' && p.warningSeconds > 0 && p.workSeconds > p.warningSeconds
    && after.remaining <= p.warningSeconds && before.remaining > p.warningSeconds ? 1 : 0;
}
export function workoutLink(plan) {
  const query = new URLSearchParams(validatePlan(plan));
  return `https://wrought.fit/workout.html?${query}`;
}
