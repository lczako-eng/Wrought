import { DEFAULT_PLAN, validatePlan, totalSeconds, position, cue } from './workout-clock.js';
const $ = id => document.getElementById(id);
const time = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
let plan = { ...DEFAULT_PLAN }, running = false, paused = false, elapsedSaved = 0, started = 0;
let previous, audio, wake, watchState, watchReceived = 0, pendingPulse = [], readings = [];
const native = window.webkit?.messageHandlers?.wroughtWatch;
try {
  const params = new URLSearchParams(location.search), input = {};
  for (const key of Object.keys(DEFAULT_PLAN)) if (params.has(key)) input[key] = ['name', 'activity'].includes(key) ? params.get(key) : Number(params.get(key));
  plan = validatePlan(input);
} catch (error) { $('instruction').textContent = error.message; }

function fields() {
  $('name').value = plan.name; $('rounds').value = plan.rounds; $('work').value = plan.workSeconds; $('rest').value = plan.restSeconds;
  $('activity').value = plan.activity;
  $('open-native').href = `wrought://workout?${new URLSearchParams(plan)}`;
  $('open-native').hidden = !!native;
  $('total').textContent = `${time(totalSeconds(plan))} TOTAL`;
  $('plan-name').textContent = plan.name;
}
function formLock(lock) { $('plan-form').querySelectorAll('input,button,select').forEach(el => { el.disabled = lock; }); }
function clearPulses() { pendingPulse.forEach(clearTimeout); pendingPulse = []; }
function sound(count) {
  clearPulses();
  for (let i = 0; i < count; i++) pendingPulse.push(setTimeout(() => {
    if (!audio || audio.state !== 'running') return;
    const oscillator = audio.createOscillator(), gain = audio.createGain();
    oscillator.frequency.value = count === 3 ? 440 : 660;
    gain.gain.setValueAtTime(.08, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .13);
    oscillator.connect(gain); gain.connect(audio.destination);
    oscillator.start(); oscillator.stop(audio.currentTime + .15);
  }, i * 450));
}
async function keepAwake() {
  try { wake = await navigator.wakeLock?.request('screen'); } catch { /* Visible warning already explains screen requirement. */ }
}
function releaseWake() { wake?.release().catch(() => {}); wake = null; }
function elapsed() { return elapsedSaved + (running && !paused ? (performance.now() - started) / 1000 : 0); }
function draw(pos, count = plan.rounds, isPaused = paused) {
  $('countdown').textContent = time(pos.remaining);
  $('phase').textContent = isPaused ? 'PAUSED' : pos.phase === 'rest' ? 'RECOVER' : pos.phase === 'complete' ? 'SESSION COMPLETE' : running || watchState?.running ? 'WORK' : 'READY TO START';
  $('round').textContent = `ROUND ${pos.round} / ${count}`;
  $('dial').classList.toggle('rest', pos.phase === 'rest');
  $('arc').style.strokeDashoffset = String(1 - pos.remaining / Math.max(1, pos.duration));
  const key = `${pos.round}-${count}-${pos.phase}`;
  if ($('round-track').dataset.key !== key) {
    $('round-track').dataset.key = key;
    $('round-track').replaceChildren(...Array.from({ length: count }, (_, i) => {
      const dot = document.createElement('i');
      dot.className = i + 1 < pos.round || pos.phase === 'complete' ? 'done' : i + 1 === pos.round ? 'current' : '';
      return dot;
    }));
  }
}
function updateButtons() {
  $('start').hidden = running; $('pause').hidden = !running; $('end').hidden = !running;
  $('pause').textContent = paused ? 'Resume' : 'Pause'; formLock(running || !!watchState?.running);
  $('start').disabled = !!watchState?.running;
}
function stop(complete) {
  elapsedSaved = Math.min(elapsed(), totalSeconds(plan)); running = false; paused = false;
  clearPulses(); releaseWake(); updateButtons();
  $('summary').hidden = false;
  $('summary-title').textContent = complete ? 'Rounds complete.' : 'Session ended early.';
  const last = position(plan, elapsedSaved);
  const done = complete ? plan.rounds : last.round - 1 + (last.phase === 'rest' ? 1 : 0);
  const receipt = `${plan.name}: ${done} of ${plan.rounds} work intervals completed; ${time(Math.floor(elapsedSaved))} elapsed including recovery. Planned intervals: ${plan.workSeconds}s work / ${plan.restSeconds}s recovery. No heart-rate or calorie readings were recorded by this browser timer.`;
  $('summary-text').textContent = receipt;
  $('log-workout').href = `/go.html?kind=workout&q=${encodeURIComponent(`Wrought — review this timer receipt with me and log what I actually completed, not the full plan: ${receipt}`)}`;
  $('start').textContent = 'Start another workout';
}
$('start').addEventListener('click', async () => {
  if (watchState?.running) return;
  watchState = null; watchReceived = 0; readings = [];
  $('source').textContent = 'BROWSER TIMER'; fields();
  try { const Audio = window.AudioContext || window.webkitAudioContext; if (Audio) { audio ||= new Audio(); await audio.resume(); } } catch { /* Countdown remains usable without sound. */ }
  elapsedSaved = 0; started = performance.now(); previous = null; running = true; paused = false;
  $('summary').hidden = true; $('instruction').textContent = 'Follow the timer. Keep this screen open for sound cues.';
  updateButtons(); keepAwake(); tick();
});
function pause() {
  if (!running) return;
  if (paused) { started = performance.now(); paused = false; keepAwake(); }
  else { elapsedSaved = elapsed(); paused = true; clearPulses(); releaseWake(); }
  updateButtons(); draw(position(plan, elapsed()));
}
$('pause').addEventListener('click', pause);
$('end').addEventListener('click', () => { if (confirm('End this workout now? Only the elapsed portion will be in the receipt.')) stop(false); });
$('plan-form').addEventListener('submit', event => {
  event.preventDefault();
  if (running || watchState?.running) return;
  try {
    plan = validatePlan({ name: $('name').value.trim(), activity: $('activity').value, rounds: Number($('rounds').value), workSeconds: Number($('work').value), restSeconds: Number($('rest').value) });
    elapsedSaved = 0; fields(); draw(position(plan, 0));
    $('instruction').textContent = 'Session updated. Start when you are ready.';
    history.replaceState(null, '', `${location.pathname}?${new URLSearchParams(plan)}`);
  } catch (error) { $('instruction').textContent = error.message; }
});
$('send-watch').addEventListener('click', () => {
  if (!native) { $('watch-status').textContent = 'Open this session in the updated native WROUGHT iPhone app to send it to Apple Watch. Home Screen web apps cannot communicate directly with Watch.'; return; }
  if (running) { $('watch-status').textContent = 'End the browser timer before moving to Watch.'; return; }
  native.postMessage({ action: 'plan', plan });
});
window.addEventListener('wrought-watch', event => {
  if (!native) return;
  const data = event.detail;
  if (data?.type === 'watchStatus') { $('watch-status').textContent = data.message; return; }
  if (data?.type !== 'workoutState') return;
  if (!['work', 'rest', 'complete'].includes(data.phase) || !Number.isInteger(data.rounds) || data.rounds < 1 || data.rounds > 30) return;
  if (running) { elapsedSaved = elapsed(); running = false; paused = false; clearPulses(); releaseWake(); }
  watchState = data; watchReceived = Date.now();
  $('plan-name').textContent = data.name;
  $('source').textContent = 'APPLE WATCH';
  $('instruction').textContent = data.running ? 'Your Watch owns the timer. Pause or end the session on your wrist.' : data.message;
  $('pause').hidden = true; $('end').hidden = true;
  updateButtons();
  const stamp = data.heartTimestamp;
  if (Number.isFinite(data.heartRate) && data.heartRate > 0 && Number.isFinite(stamp)
      && (!readings.length || stamp > readings.at(-1).time)) {
    readings.push({ time: stamp, value: data.heartRate });
    readings = readings.filter(r => r.time >= Date.now() - 120000);
  }
});
function graph(now) {
  readings = readings.filter(r => r.time >= now - 120000);
  const points = readings.map(r => [480 - (now - r.time) / 120000 * 480, 110 - Math.max(0, Math.min(180, r.value - 40)) / 180 * 100]);
  let path = '';
  points.forEach(([x,y], i) => { path += `${i && readings[i].time - readings[i-1].time < 15000 ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `; });
  $('heart-line').setAttribute('d', path);
  // Gaps stay gaps; do not fill across unavailable readings.
  $('heart-area').setAttribute('d', '');
  const fresh = watchState && now - watchReceived < 10000;
  const hrFresh = fresh && Number.isFinite(watchState.heartTimestamp) && now - watchState.heartTimestamp < 15000;
  $('freshness').textContent = hrFresh ? 'LIVE · LAST 2 MIN' : watchState ? 'WAITING FOR FRESH READINGS' : 'NO SENSOR CONNECTED';
  $('heart').textContent = hrFresh ? Math.round(watchState.heartRate) : '—';
  $('energy').textContent = fresh && Number.isFinite(watchState.calories) ? Math.round(watchState.calories) : '—';
  $('heart-chart').setAttribute('aria-label', readings.length ? `Heart rate during the last two minutes. ${hrFresh ? `Latest ${Math.round(watchState.heartRate)} beats per minute.` : 'No fresh reading.'}` : 'No heart-rate readings yet.');
}
function tick() {
  if (watchState) {
    if (Date.now() - watchReceived < 10000) draw(watchState, watchState.rounds, watchState.paused);
    else if (watchState.running) { $('source').textContent = 'WATCH DISCONNECTED'; $('instruction').textContent = 'Live view disconnected. Your Watch continues independently; check your wrist.'; }
  } else if (running && !paused) {
    const next = position(plan, elapsed()), taps = cue(plan, previous, next);
    draw(next); previous = next;
    if (next.phase === 'complete') { stop(true); sound(3); }
    else if (taps) { sound(taps); $('instruction').textContent = next.phase === 'rest' ? 'Round done. Take your recovery.' : taps === 1 ? `${plan.warningSeconds} seconds left.` : 'New round. Begin when ready.'; }
  }
  graph(Date.now());
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden && running && !paused) { pause(); $('instruction').textContent = 'Paused because this screen closed. Resume when ready. Watch workouts continue on your wrist.'; }
});
window.addEventListener('pagehide', () => { clearPulses(); releaseWake(); });
fields(); draw(position(plan, 0)); setInterval(tick, 250);
native?.postMessage({ action: 'status' });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
