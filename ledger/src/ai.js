// Optional AI fallback. When the local parser and learned templates cannot read
// a sentence, Claude rewrites it into the ledger's own canonical command
// language. The rewrite is then parsed and executed by the same deterministic
// code as everything else — the model never touches a balance directly — and
// the (sentence → commands) pair is generalised into a template so the next
// sentence of that shape never needs the model at all.
//
// Enabled when the `@anthropic-ai/sdk` package is installed and credentials
// are available (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or LEDGER_AI=on with
// an `ant auth login` profile). Set LEDGER_AI=off to force offline mode.

const MODEL = process.env.LEDGER_MODEL || 'claude-opus-5-5';

export const GRAMMAR = `Canonical commands (one per line; amounts are plain numbers; quote multi-word descriptions):
  I paid 120 for "dinner" with Ali and Sara          (payer + listed people split equally)
  Ali paid 90 for "groceries" for me and Sara          (only the listed people owe)
  I paid 300 for "rent" split me 150, Ali 100, Sara 50 (exact shares; also 50%, or "2 shares")
  Ali paid 60 and I paid 40 for "dinner" with Sara    (several payers)
  ... add: yesterday | on 2026-10-01 | in <group> | #category | via <method>
  I paid Ali 30          Ali paid me 30          I lent Ali 50          Ali lent me 50
  I owe Ali 20 for "lunch"     Ali owes me 20    settle up with Ali
  I earned 5000 from salary
  rent 2000 every month on the 1st split with Ali    (recurring; also weekly / yearly)
  netflix 15 monthly                                  (recurring personal expense)
  salary 5000 every month on the 1st                  (recurring income)
  budget 400 for food            save 10000 for "car" by June 2027      add 500 to car
  I have 8000 in the bank        can I afford 1500 for "laptop" in March
  forecast 6 months   balances   how much do I owe Ali   how much did I spend last month
  simplify   who pays next in <group>   create group Trip with Ali and Sara
  categorize <word> as <category>   <nickname> is also called <name>   undo`;

let clientPromise = null;

export function aiEnabled() {
  if (/^(off|0|false|no)$/i.test(process.env.LEDGER_AI || '')) return false;
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || /^(on|1|true|yes)$/i.test(process.env.LEDGER_AI || ''));
}

async function client() {
  clientPromise ??= import('@anthropic-ai/sdk')
    .then(({ default: Anthropic }) => new Anthropic())
    .catch(() => null);
  return clientPromise;
}

const TOOL = {
  name: 'emit_commands',
  description: 'Return the canonical ledger commands equivalent to the user message, or a clarifying question if it is genuinely ambiguous.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      commands: { type: 'array', items: { type: 'string' }, description: 'Canonical commands, in order. Empty if clarification is needed.' },
      clarification: { type: 'string', description: 'A short question for the user, or an empty string.' },
    },
    required: ['commands', 'clarification'],
    additionalProperties: false,
  },
};

/**
 * Translate free text into canonical commands.
 * Returns { commands: string[], clarification: string } or null when offline.
 */
export async function translate(text, context) {
  if (!aiEnabled()) return null;
  const c = await client();
  if (!c) return null;
  const system = `You translate a person's message about shared expenses and personal finances into canonical commands for their ledger app.
${GRAMMAR}

Rules:
- "I"/"me" is the user. Use people's names exactly as listed when they match; new names are allowed.
- Never invent amounts, people, or dates the message does not state or clearly imply.
- If who paid, how much, or who shares is genuinely unclear, return no commands and ask one short question.
- Prefer the fewest commands that capture the message. Always answer by calling emit_commands.

Today: ${context.today}. Currency: ${context.currency}.
People: ${context.people.join(', ') || '(none yet)'}
Groups: ${context.groups.join(', ') || '(none)'}
Goals: ${context.goals.join(', ') || '(none)'}`;

  const response = await c.beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system,
    tools: [TOOL],
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: text }],
  });
  if (response.stop_reason === 'refusal') return null;
  const call = response.content.find((b) => b.type === 'tool_use' && b.name === TOOL.name);
  if (!call) return null;
  const input = typeof call.input === 'string' ? JSON.parse(call.input) : call.input;
  if (!Array.isArray(input?.commands)) return null;
  return {
    commands: input.commands.map((s) => String(s).trim()).filter(Boolean).slice(0, 10),
    clarification: String(input.clarification || '').trim(),
  };
}
