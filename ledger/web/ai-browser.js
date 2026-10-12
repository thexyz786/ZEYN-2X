// Browser stand-in for src/ai.js, used by the published web page. Instead of
// an API key it asks Claude through the page's `sample` capability, as the
// person viewing the page. Same contract: text in, canonical commands out.

export const GRAMMAR = __GRAMMAR__;
export const AI_OFF_HINT = 'allow Claude for this page to enable';

let sampler = null;
export function setSampler(s) {
  sampler = s;
}
export function aiEnabled() {
  return Boolean(sampler);
}

export async function translate(text, context) {
  if (!sampler) return null;
  const prompt = `You translate a person's message about shared expenses and personal finances into canonical commands for their ledger app.
${GRAMMAR}

Rules:
- "I"/"me" is the user. Use people's names exactly as listed when they match; new names are allowed.
- Never invent amounts, people, or dates the message does not state or clearly imply.
- If who paid, how much, or who shares is genuinely unclear, return no commands and ask one short question.
- Prefer the fewest commands that capture the message.

Today: ${context.today}. Currency: ${context.currency}.
People: ${context.people.join(', ') || '(none yet)'}
Groups: ${context.groups.join(', ') || '(none)'}
Goals: ${context.goals.join(', ') || '(none)'}

Reply with only a JSON object: {"commands": ["..."], "clarification": ""}

Message: ${JSON.stringify(text)}`;
  let out;
  try {
    out = await sampler.json(prompt, { modelTier: 'default' });
  } catch (e) {
    if (e?.code === 'not_granted') {
      sampler = null; // the viewer declined; stay offline for this visit
      return null;
    }
    throw new Error(e?.message || 'Claude could not answer');
  }
  if (!out || !Array.isArray(out.commands)) return null;
  return {
    commands: out.commands.map((s) => String(s).trim()).filter(Boolean).slice(0, 10),
    clarification: String(out.clarification || '').trim(),
  };
}
