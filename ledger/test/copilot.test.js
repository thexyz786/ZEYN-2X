import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Assistant } from '../src/assistant.js';
import { MemoryStore } from '../src/store.js';
import { Copilot } from '../src/copilot.js';

// A scripted stand-in for Claude: each call returns the next scripted reply,
// and records what it was sent so tests can check the prompt.
function fakeClaude(script) {
  const calls = [];
  const json = async (turns, opts) => {
    calls.push({ turns, opts });
    const next = script.shift();
    if (!next) throw { code: 'upstream_error', message: 'script empty' };
    return typeof next === 'function' ? await next(turns, opts) : next;
  };
  return { json, calls };
}
const make = (script) => {
  const a = new Assistant(new MemoryStore(), { now: () => new Date('2026-10-12T12:00:00'), translate: null });
  const claude = fakeClaude(script);
  return { a, claude, co: new Copilot(a, claude) };
};

test('a record is proposed with specifics, written only on confirm, and remembered', async () => {
  const { a, claude, co } = make([
    { reply: 'Got it.', actions: [{ command: 'I paid 34.50 for "Trader Joe\'s" #groceries', summary: "$34.50 · Trader Joe's · groceries · you paid · today" }], question: '', lesson: '' },
  ]);
  const r = await co.ask('tj run 34.50');
  assert.equal(r.actions[0].summary, "$34.50 · Trader Joe's · groceries · you paid · today");
  assert.equal(a.ledger.state.expenses.length, 0, 'nothing written before confirm');
  // The prompt carried real numbers and the command grammar.
  const prompt = claude.calls[0].turns[0].content;
  assert.match(prompt, /Free to spend rest of Oct 2026/);
  assert.match(prompt, /Ledger commands you can propose/);
  co.confirm();
  const e = a.ledger.state.expenses[0];
  assert.equal(e.amount, 3450);
  assert.equal(e.category, 'groceries');
  assert.equal(a.s.brain.copilot.stats.firstTry, 1);
  assert.equal(a.s.brain.copilot.examples[0].text, 'tj run 34.50');
  // The offline engine learned the phrasing too.
  const off = await a.handle('tj run 12');
  assert.match(off.reply, /Trader Joe's/);
  assert.equal(a.ledger.state.expenses.at(-1).amount, 1200);
});

test('a correction revises the proposal and becomes a lesson used next time', async () => {
  const { a, claude, co } = make([
    { reply: 'Logging it.', actions: [{ command: 'I paid 21 for "BQHC" #transfers', summary: '$21 · BQHC · transfers' }], question: '', lesson: '' },
    { reply: 'Updated.', actions: [{ command: 'I paid 21 for "BQHC weekly saving" #savings', summary: '$21 · BQHC weekly saving · savings' }], question: '', lesson: 'BQHC transfers are savings, not spending transfers.' },
    { reply: 'Here you go.', actions: [], question: '', lesson: '' },
  ]);
  await co.ask('21 to bqhc');
  const r = await co.ask('no, that is savings');
  assert.match(claude.calls[1].turns.at(-1).content, /You proposed: "\$21 · BQHC · transfers"/);
  assert.equal(r.actions[0].summary, '$21 · BQHC weekly saving · savings');
  co.confirm();
  assert.equal(a.ledger.state.expenses[0].category, 'savings');
  assert.equal(a.s.brain.copilot.stats.corrected, 1);
  assert.equal(a.s.brain.copilot.lessons[0].text, 'BQHC transfers are savings, not spending transfers.');
  assert.equal(a.s.brain.copilot.examples[0].text, '21 to bqhc', 'the example keeps the original wording');
  await co.ask('how am I doing');
  assert.match(claude.calls[2].turns[0].content, /1\. BQHC transfers are savings/);
  assert.match(claude.calls[2].turns[0].content, /"21 to bqhc" →/);
  const learned = await a.handle('what have you learned');
  assert.match(learned.reply, /1 confirmed \(0 right first time, 1 after a correction\)/);
  await a.handle('forget lesson 1');
  assert.equal(a.s.brain.copilot.lessons.length, 0);
});

test('questions use the app for exact numbers and never write', async () => {
  const { a, co } = make([
    async (turns, opts) => {
      const tool = opts.tools.find((t) => t.name === 'ledger_query');
      const answer = tool.execute({ command: 'can I afford 300 for jacket next month' });
      assert.match(answer, /Yes|Tight|Not yet/);
      assert.throws(() => tool.execute({ command: 'I paid 300 for jacket' }), /Propose it as an action/);
      return { reply: `From the app: ${answer.split('\n')[0]}`, actions: [], question: '', lesson: '' };
    },
  ]);
  await a.handle('I have 2000 in the bank');
  const r = await co.ask('can i get that 300 jacket next month');
  assert.match(r.reply, /From the app/);
  assert.equal(a.ledger.state.expenses.length, 0);
  assert.equal(co.pending, null);
});

test('invalid commands get one repair round; cancel discards', async () => {
  const { a, claude, co } = make([
    { reply: 'ok', actions: [{ command: 'record thirty-four dollars groceries', summary: 'x' }], question: '', lesson: '' },
    { reply: 'ok', actions: [{ command: 'I paid 34 for groceries', summary: '$34 · groceries' }], question: '', lesson: '' },
  ]);
  const r = await co.ask('groceries 34');
  assert.equal(claude.calls.length, 2);
  assert.match(claude.calls[1].turns.at(-1).content, /could not read these commands/);
  assert.equal(r.actions[0].command, 'I paid 34 for groceries');
  co.cancel();
  assert.equal(a.ledger.state.expenses.length, 0);
  assert.equal(a.s.brain.copilot.stats.cancelled, 1);
});
