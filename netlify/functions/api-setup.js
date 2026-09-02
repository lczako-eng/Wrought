// netlify/functions/api-setup.js
// The questionnaire, answerable from the website.
//
// The founder: "can you defer the GPT to the app to manually fill it in? Make
// it as easy as possible — multiple choice, yes or no." Two doors into one
// record: the assistant asks one question at a time through answer_setup, and
// this endpoint takes the same answers from a screen where all of them sit on
// one page with buttons. Both write through lib/setup.js — the recordSet
// lesson — so a question the website shows as answered is one the assistant
// stops asking, and vice versa.
//
// GET  → the state: every question with its options and what is on file.
// POST → { answers: [{ key, answer }] } or { answers: { key: answer } }.
//        Saves what parses, reports what did not by key, returns the state
//        read back off the record.

import { supabase, getAuthUser } from './lib/wrought.js';
import { applyAnswers, setupState } from './lib/setup.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const shape = state => ({
  answered: state.gate.known, of: state.gate.total, complete: state.gate.complete,
  remaining: state.gate.remaining, next: state.gate.next,
  known_all: state.known, of_all: state.total,
  questions: state.questions,
  setup_url: state.setup_url,
});

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!supabase) return json(500, { error: 'server_not_configured' });

  const user = await getAuthUser(event);
  if (!user) return json(401, { error: 'sign_in_required' });

  if (event.httpMethod === 'GET') {
    return json(200, shape(await setupState(user.id)));
  }

  if (event.httpMethod === 'POST') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad_json' }); }
    const answers = body.answers;
    if (!answers || (Array.isArray(answers) ? !answers.length : !Object.keys(answers).length)) {
      return json(400, { error: 'nothing_to_save', message: 'Send answers as [{ key, answer }].' });
    }
    const out = await applyAnswers(user.id, answers);
    // A write that did not land is said, by field — "could not save" sends
    // somebody hunting through fourteen boxes.
    return json(200, {
      saved: out.saved, rejected: out.rejected, not_saved: out.not_saved,
      message: out.rejected.length
        ? `Could not read ${out.rejected.map(r => `${r.key.replace(/_/g, ' ')} — needs ${r.why}`).join('; ')}.`
        : out.not_saved.length
          ? `Saved, except ${out.not_saved.map(k => k.replace(/_/g, ' ')).join(', ')}: the database needs schema/023_wrought_commitment.sql run first.`
          : 'Saved.',
      ...shape(out.state),
    });
  }

  return json(405, { error: 'method_not_allowed' });
};
