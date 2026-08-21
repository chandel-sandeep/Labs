# Lab 2.6 — multi-tool-agent

A Claude Agent SDK agent with three custom tools behind one in-process MCP
server, driven from a REPL that keeps the full conversation history.

## Run

```
npm install          # if node_modules is missing
npm start            # node agent.ts
npm run typecheck    # tsc --noEmit
```

Needs `ANTHROPIC_API_KEY`. `agent.ts` looks for a `.env` next to itself first,
then one level up in `Lab_2.6/`, so one key at the lab root covers the whole lab.
Copy `.env.example` if you need a local one. Requires Node ≥ 22.18 — `agent.ts`
is run directly and Node strips the types.

## Tools

| Tool | Input | Output |
| --- | --- | --- |
| `get_product_info` | `name: string` | `{ name, price, inStock }` |
| `get_order_status` | `orderId: string` | `{ orderId, status, eta }` |
| `calculate_discount` | `price: number, percent: number` | `{ originalPrice, percent, discountedPrice }` |

Both directions are validated. The input schema is the one the SDK advertises to
the model, so a bad argument never reaches the handler. The **output** schema is
checked by the handler against its own return value, so a bad result never
reaches the model — it becomes an `isError` tool result instead.

## Things to try

| Type this | What it shows |
| --- | --- |
| `how much is the ceramic mug?` | a plain tool call and result |
| `take 15% off that` | history: "that" resolves to the mug; then the guardrail |
| `what is the status of order A-1001?` | the second tool |
| `what about that same order - has it arrived?` | answered from history, no new tool call |
| `how much is a gift card?` | output validation rejects a malformed upstream record |
| `how much is a unicorn?` | an `isError` result for an unknown product |
| `/exit` | quit |

## The guardrail

`calculate_discount` prints `Apply a {percent}% discount to ${price}? (y/n)` and
reads one line **before it computes anything**. Only an answer of exactly `y`
returns the real number; `Y`, `yes`, empty, anything else, or closed stdin is a
refusal, and the model gets an `isError` result explaining that the action was
declined. It fails closed on purpose.

This gate lives inside the tool handler rather than in `canUseTool` (which is
what Lab 2.3 uses) so it can see the actual arguments and phrase the question in
the operator's terms. Because of that, the three tools are listed in
`allowedTools` — the SDK-level permission layer is intentionally not the gate
here.

## Why one `query()` call

`query()` is called once, with an async stream of user messages as its prompt
("streaming input mode"). The session stays open, so every REPL turn appends to
the same transcript and follow-ups resolve against earlier context. The
`[session]` line printed at startup is the proof: it never changes between turns.

Calling `query()` per line would start a fresh session each time and discard
everything said before.

## Notes on the plumbing

- **One stdin reader.** The REPL prompt and the discount confirmation both read
  stdin, so `agent.ts` consumes `line` events into a FIFO queue instead of using
  `rl.question`, which drops any line that arrives with no question pending
  (i.e. whenever you type ahead, or when stdin is a pipe).
- **No built-in tools.** `tools: []` removes Claude Code's default
  Read/Write/Edit/Bash set; `settingSources: []` keeps on-disk settings from
  widening what this agent can do.
- **No `maxTurns`.** In streaming input mode the cap applies to the whole
  session, so any finite value would eventually cut the REPL off.
