/**
 * Lab 2.6 — multi-tool-agent
 *
 * A Claude Agent SDK agent with three custom tools behind one in-process MCP
 * server, driven from an interactive REPL that keeps the FULL conversation
 * history across turns.
 *
 * Four ideas stack up here:
 *
 *   1. Every tool has an INPUT schema *and* an OUTPUT schema. Zod validates the
 *      model's arguments before the handler runs, and validates the handler's
 *      own return value before it goes back to the model. A tool that produces
 *      garbage reports a failure instead of teaching Claude something false.
 *   2. `calculate_discount` is guarded: it asks the operator on the terminal
 *      before it computes anything, and only an answer of exactly "y" lets the
 *      real number through. Everything else is refused.
 *   3. Failures travel as `isError` tool results, not thrown exceptions. Claude
 *      sees them, explains them, and keeps going.
 *   4. The REPL uses *streaming input mode*: one `query()` call consumes an
 *      async stream of user messages, so all turns share one session and one
 *      transcript. "What about that same order?" resolves against earlier
 *      context instead of starting over.
 *
 * Run:  npm start
 * Needs ANTHROPIC_API_KEY in a .env file (this folder or the Lab_2.6 folder).
 */

import readline from "node:readline/promises";
import { dirname, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));

// Look next to this script first, then one level up, so a single key at the
// Lab_2.6 root serves every project in the lab. First file to define a key wins.
dotenv.config({
  path: [resolve(HERE, ".env"), resolve(HERE, "..", ".env")],
  quiet: true,
});

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "Missing ANTHROPIC_API_KEY. Copy .env.example to .env and fill it in:\n" +
      "  ANTHROPIC_API_KEY=sk-ant-...",
  );
  process.exit(1);
}

const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-5";

/** Registration key for the in-process MCP server. Also the `{server}` segment
 *  of every fully qualified tool name: mcp__shop-tools__get_product_info */
const SERVER_NAME = "shop-tools";

// ---------------------------------------------------------------------------
// 2. Tool result helpers
// ---------------------------------------------------------------------------

/**
 * What a `tool()` handler resolves to — MCP's CallToolResult, narrowed to the
 * text-only subset this lab needs.
 */
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** A successful result. The payload is serialized as JSON so Claude reads
 *  fields rather than parsing prose. */
function ok(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/** A failed result. `isError` tells Claude the call did not produce data, so it
 *  reports the problem instead of treating the message as a value. */
function failure(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * The OUTPUT-schema gate. Every tool routes its return value through here.
 *
 * `schema.safeParse` never throws, so a tool that builds a bad object cannot
 * crash the agent — and, more importantly, cannot hand Claude data that does
 * not match the contract the tool advertises. On a violation the value is
 * withheld and Claude gets an `isError` result naming the offending fields.
 */
function validated<T>(
  toolName: string,
  schema: z.ZodType<T>,
  candidate: unknown,
): ToolResult {
  const parsed = schema.safeParse(candidate);

  if (!parsed.success) {
    const detail = z.prettifyError(parsed.error);
    console.log(`  [output rejected] ${toolName} failed its own schema`);
    console.log(indent(detail));
    return failure(
      `${toolName} produced a result that failed its own output schema, so the ` +
        `value was withheld. Report this as a tool failure; do not guess or ` +
        `invent the missing data.\n${detail}`,
    );
  }

  // Return the *parsed* value, not the candidate, so what Claude sees is
  // exactly what the contract allows.
  return ok(parsed.data);
}

// ---------------------------------------------------------------------------
// 3. Mock backends
// ---------------------------------------------------------------------------

/**
 * Mock product API. Values are typed `unknown` on purpose — this stands in for
 * an upstream service whose payloads are not under our control, which is the
 * whole reason the tool re-validates them on the way out.
 *
 * The "gift card" row is deliberately malformed (`price` is a string) so the
 * output-validation path is reachable: ask about a gift card to see it fire.
 */
const MOCK_CATALOG: ReadonlyMap<string, unknown> = new Map([
  ["ceramic mug", { name: "Ceramic Mug", price: 18.5, inStock: true }],
  ["water bottle", { name: "Water Bottle 1L", price: 24, inStock: true }],
  ["tote bag", { name: "Canvas Tote Bag", price: 12.99, inStock: false }],
  ["desk lamp", { name: "Desk Lamp", price: 45, inStock: true }],
  ["gift card", { name: "Gift Card", price: "fifty dollars", inStock: true }],
]);

/** Mock order API. Same `unknown` treatment, same reason. */
const MOCK_ORDERS: ReadonlyMap<string, unknown> = new Map([
  ["A-1001", { orderId: "A-1001", status: "shipped", eta: "2026-08-24" }],
  ["A-1002", { orderId: "A-1002", status: "processing", eta: "2026-08-29" }],
  ["A-1003", { orderId: "A-1003", status: "delivered", eta: "2026-08-18" }],
  ["A-1004", { orderId: "A-1004", status: "cancelled", eta: "n/a" }],
]);

// ---------------------------------------------------------------------------
// 4. The tools — input schema, output schema, handler
// ---------------------------------------------------------------------------

const PRODUCT_OUTPUT = z.strictObject({
  name: z.string().min(1),
  price: z.number().positive(),
  inStock: z.boolean(),
});

const getProductInfo = tool(
  "get_product_info",
  "Look up a product's price and stock status by name. Use this instead of " +
    "recalling a price — the catalog changes.",
  {
    name: z
      .string()
      .min(1)
      .describe("Product name, e.g. 'ceramic mug'. Case-insensitive."),
  },
  async (args) => {
    const key = args.name.trim().toLowerCase();
    const record = MOCK_CATALOG.get(key);

    if (record === undefined) {
      return failure(
        `No product named '${args.name}'. Known products: ` +
          `${[...MOCK_CATALOG.keys()].join(", ")}.`,
      );
    }

    return validated("get_product_info", PRODUCT_OUTPUT, record);
  },
  { annotations: { readOnlyHint: true } },
);

const ORDER_OUTPUT = z.strictObject({
  orderId: z.string().min(1),
  status: z.enum(["processing", "shipped", "delivered", "cancelled"]),
  eta: z.string().min(1),
});

const getOrderStatus = tool(
  "get_order_status",
  "Look up the status and ETA of a customer order by its ID.",
  {
    orderId: z
      .string()
      .min(1)
      .describe("Order ID, e.g. 'A-1001'. Case-insensitive."),
  },
  async (args) => {
    const key = args.orderId.trim().toUpperCase();
    const record = MOCK_ORDERS.get(key);

    if (record === undefined) {
      return failure(
        `No order '${args.orderId}'. Known orders: ` +
          `${[...MOCK_ORDERS.keys()].join(", ")}.`,
      );
    }

    return validated("get_order_status", ORDER_OUTPUT, record);
  },
  { annotations: { readOnlyHint: true } },
);

/** The price in dollars, rounded to whole cents. */
function toCents(dollars: number): number {
  return Math.round(dollars * 100) / 100;
}

const DISCOUNT_OUTPUT = z
  .strictObject({
    originalPrice: z.number().positive(),
    percent: z.number().min(0).max(100),
    discountedPrice: z.number().nonnegative(),
  })
  // A cross-field check: the arithmetic has to be internally consistent, not
  // merely well-typed. This is the kind of bug an output schema catches that an
  // input schema never could. Restating the invariant here (rather than reusing
  // the handler's variable) is the point — the schema is an independent check.
  //
  // Note the comparison is against the cent-rounded value, not the raw product.
  // A "close enough" tolerance would have to be looser than 0.005 to accept
  // legitimate rounding (18.50 at 15% is 15.725, which rounds to 15.73), and at
  // that width it would also wave through genuinely wrong numbers.
  .refine(
    (d) =>
      Math.abs(d.discountedPrice - toCents(d.originalPrice * (1 - d.percent / 100))) <
      1e-9,
    {
      message:
        "discountedPrice is not originalPrice reduced by percent, rounded to cents",
    },
  );

const calculateDiscount = tool(
  "calculate_discount",
  "Apply a percentage discount to a price. Requires operator confirmation on " +
    "the terminal before it runs, and may be declined.",
  {
    price: z.number().positive().describe("The original price, in dollars."),
    percent: z.number().min(0).max(100).describe("Discount percentage, 0-100."),
  },
  async (args) => {
    // The guardrail. Nothing is computed until the operator answers. `ask` is
    // the single stdin reader in this process, so this question and the REPL's
    // own prompt never fight over the same keystrokes.
    const answer = await ask(
      `\n  [confirm] Apply a ${args.percent}% discount to $${args.price}? (y/n) `,
    );

    // Fails closed: exactly "y" approves. A null answer (stdin closed), "Y",
    // "yes", or anything else is a refusal.
    if (answer?.trim() !== "y") {
      console.log("  [guardrail] declined — no discount computed");
      return failure(
        "The operator declined the discount. No discounted price was " +
          "calculated, so there is nothing to report. Tell the user the " +
          "discount was not applied and ask whether they want to try again.",
      );
    }

    console.log("  [guardrail] approved");

    const discountedPrice = toCents(args.price * (1 - args.percent / 100));

    return validated("calculate_discount", DISCOUNT_OUTPUT, {
      originalPrice: args.price,
      percent: args.percent,
      discountedPrice,
    });
  },
);

/** In-process MCP server: an object in THIS process, not a spawned subprocess. */
const shopToolsServer = createSdkMcpServer({
  name: SERVER_NAME,
  version: "1.0.0",
  tools: [getProductInfo, getOrderStatus, calculateDiscount],
});

const TOOL_NAMES = [
  "get_product_info",
  "get_order_status",
  "calculate_discount",
] as const;

/** Fully qualified names — the form the model and the permission layer use. */
const QUALIFIED_TOOL_NAMES = TOOL_NAMES.map(
  (name) => `mcp__${SERVER_NAME}__${name}`,
);

// ---------------------------------------------------------------------------
// 5. Terminal I/O — one reader, serialized
// ---------------------------------------------------------------------------

/**
 * One readline interface for the whole process, and one queue in front of it.
 *
 * Two callers need to read stdin: the REPL prompt and the `calculate_discount`
 * confirmation. `rl.question` is the obvious tool and the wrong one here — it
 * holds a single callback, so a line that arrives while no question is pending
 * is emitted as a plain `line` event and lost. That happens whenever the
 * operator types ahead while a turn is still running, and on every non-TTY
 * stdin (a pipe, a test script, CI), where all input arrives at once.
 *
 * So we consume `line` events ourselves and keep them: unread lines go into
 * `lineBuffer`, unserved readers go into `waiters`, and both are FIFO. Reads
 * are therefore ordered and no keystroke is dropped.
 */
const rl = readline.createInterface({ input, output });

const lineBuffer: string[] = [];
const waiters: Array<(line: string | null) => void> = [];
let stdinClosed = false;

rl.on("line", (line: string) => {
  const waiter = waiters.shift();
  if (waiter === undefined) lineBuffer.push(line);
  else waiter(line);
});

rl.on("close", () => {
  stdinClosed = true;
  // Nothing more is coming; release everyone still waiting.
  for (const waiter of waiters.splice(0)) waiter(null);
});

// Ctrl-C closes the reader, which unblocks whatever read is pending and lets
// the shutdown path below run instead of killing the process mid-turn.
rl.on("SIGINT", () => rl.close());

/**
 * Reads one line. Resolves to `null` once stdin is exhausted or closed —
 * callers treat that as "no answer", which for the guardrail means "declined".
 */
function ask(prompt: string): Promise<string | null> {
  output.write(prompt);

  const buffered = lineBuffer.shift();
  if (buffered !== undefined) {
    // A TTY already echoed this line when it was typed; a pipe did not.
    if (input.isTTY !== true) output.write(`${buffered}\n`);
    return Promise.resolve(buffered);
  }

  if (stdinClosed) return Promise.resolve(null);

  return new Promise<string | null>((resolveLine) => {
    waiters.push(resolveLine);
  });
}

// ---------------------------------------------------------------------------
// 6. Streaming input — where the conversation history comes from
// ---------------------------------------------------------------------------

/**
 * A push-driven `AsyncIterable<SDKUserMessage>`.
 *
 * This is what makes the REPL a conversation rather than a series of unrelated
 * one-shots. `query()` is called ONCE with this stream as its prompt, so the
 * session stays open and every turn appends to the same transcript. Calling
 * `query()` per line would start a fresh session each time and throw away
 * everything said before.
 */
function createUserMessageStream() {
  const queued: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let ended = false;

  const nudge = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };

  return {
    send(text: string): void {
      queued.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      });
      nudge();
    },

    end(): void {
      ended = true;
      nudge();
    },

    async *stream(): AsyncGenerator<SDKUserMessage> {
      while (true) {
        const next = queued.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolveWake) => {
          wake = resolveWake;
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 7. Options
// ---------------------------------------------------------------------------

const userMessages = createUserMessageStream();

const options: Options = {
  model: MODEL,

  systemPrompt:
    "You are a shop assistant for an online store. Answer questions about " +
    "products, orders, and pricing using the provided tools only — never " +
    "state a price, stock level, order status, or discounted total that you " +
    "did not read from a tool result. If a tool returns an error, say what " +
    "went wrong in plain language and do not substitute a guess. The customer " +
    "may refer back to products and orders discussed earlier in this " +
    "conversation; resolve those references from the history.",

  // The key here — not createSdkMcpServer's `name` — namespaces the tools.
  mcpServers: { [SERVER_NAME]: shopToolsServer },

  // Drop Claude Code's built-in tools (Read/Write/Edit/Bash/...), which are on
  // by default. This agent has exactly the three tools above.
  tools: [],

  // The three tools are pre-approved because their guardrail lives inside the
  // handler, where it can inspect the actual numbers. 'dontAsk' denies anything
  // not on this list rather than blocking on a permission prompt that this
  // program has no handler for.
  allowedTools: QUALIFIED_TOOL_NAMES,
  permissionMode: "dontAsk",

  // No on-disk settings: an allow rule in some .claude/settings.json elsewhere
  // on this machine should not be able to widen what this lab can do.
  settingSources: [],

  // Deliberately no `maxTurns`. In streaming input mode the cap applies to the
  // whole session, so any finite value would eventually cut the REPL off.
};

const conversation = query({ prompt: userMessages.stream(), options });

// ---------------------------------------------------------------------------
// 8. Rendering — make every step of the loop visible
// ---------------------------------------------------------------------------

/** Indents a multi-line block so it stays visually attached to its label. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

/** Renders a tool_result payload, which is either a string or a block array. */
function renderToolResult(
  payload: string | ReadonlyArray<{ type: string }> | undefined,
): string {
  if (payload === undefined) return "(empty)";
  if (typeof payload === "string") return payload;
  return payload
    .map((part) =>
      part.type === "text" && "text" in part && typeof part.text === "string"
        ? part.text
        : `[${part.type} block]`,
    )
    .join("\n");
}

/** Strips the mcp__server__ prefix so tool names read cleanly in the log. */
function shortToolName(name: string): string {
  const prefix = `mcp__${SERVER_NAME}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

let sessionId: string | null = null;

function render(message: SDKMessage): void {
  switch (message.type) {
    // Emitted at the start of every turn. The session id is printed once, then
    // only if it ever changes — proof that all turns share one conversation.
    case "system": {
      if (message.subtype !== "init") break;
      if (sessionId === null) {
        sessionId = message.session_id;
        console.log(
          `\n[session] ${sessionId}\n` +
            `[session] model=${message.model} ` +
            `permissionMode=${message.permissionMode}\n` +
            `[session] tools=[${message.tools.map(shortToolName).join(", ")}]`,
        );
      } else if (message.session_id !== sessionId) {
        console.log(`\n[session] CHANGED to ${message.session_id}`);
        sessionId = message.session_id;
      }
      break;
    }

    // One per assistant turn — where a tool call is decided.
    case "assistant": {
      for (const block of message.message.content) {
        if (block.type === "text") {
          if (block.text.trim() !== "") {
            console.log(`\n[assistant]\n${indent(block.text)}`);
          }
        } else if (block.type === "thinking") {
          // Thinking arrives with empty text unless display is 'summarized',
          // so skip the empty placeholder blocks.
          if (block.thinking.trim() !== "") {
            console.log(`\n[thinking]\n${indent(block.thinking)}`);
          }
        } else if (block.type === "tool_use") {
          console.log(
            `\n[tool call] ${shortToolName(block.name)}` +
              `(${JSON.stringify(block.input)})`,
          );
        }
      }
      break;
    }

    // Tool results come back as a user-role turn.
    case "user": {
      const content = message.message.content;
      if (typeof content === "string") break; // our own echoed input
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const label = block.is_error ? "tool error" : "tool result";
        console.log(`\n[${label}]\n${indent(renderToolResult(block.content))}`);
      }
      break;
    }

    // Terminal message for this turn.
    case "result": {
      if (message.subtype === "success") {
        console.log(`\n[final answer]\n${indent(message.result)}`);
        console.log(
          `\n[turn] ${message.num_turns} model turns, ` +
            `$${message.total_cost_usd.toFixed(4)}, ${message.duration_ms}ms`,
        );
      } else {
        console.error(`\n[turn ended without a result] ${message.subtype}`);
      }
      break;
    }

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// 9. The REPL
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Set when the agent stream is done, so the REPL stops instead of hanging. */
let streamEnded = false;
/** Resolves the turn the REPL is currently waiting on. */
let finishTurn: (() => void) | null = null;
/** True once we are tearing down on purpose, so teardown errors stay quiet. */
let shuttingDown = false;

/**
 * Drains the agent's message stream for the whole session. It runs alongside
 * the REPL: the REPL pushes a message, then waits for this loop to see the
 * matching `result`.
 */
async function consumeAgentMessages(): Promise<void> {
  for await (const message of conversation) {
    render(message);
    if (message.type === "result") {
      const resume = finishTurn;
      finishTurn = null;
      resume?.();
    }
  }
}

const consumer = consumeAgentMessages()
  .catch((error: unknown) => {
    if (shuttingDown) return;
    console.error(`\n[agent error] ${describeError(error)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // However it ended, nothing more will arrive — release the REPL so the
    // `await turn` below can never deadlock.
    streamEnded = true;
    const resume = finishTurn;
    finishTurn = null;
    resume?.();
  });

async function main(): Promise<void> {
  console.log("multi-tool-agent — Lab 2.6");
  console.log(`tools: ${TOOL_NAMES.join(", ")}`);
  console.log("Type a question. /exit to quit.");
  console.log("\nTry:");
  console.log("  how much is the ceramic mug?");
  console.log("  take 15% off that");
  console.log("  what's the status of order A-1001?");
  console.log("  what about that same order - has it arrived?");
  console.log("  how much is a gift card?   <- trips output validation");

  while (!streamEnded) {
    const line = await ask("\nyou> ");
    if (line === null) break;

    const text = line.trim();
    if (text === "") continue;
    if (text === "/exit" || text === "/quit") break;

    console.log(`\n[user] ${text}`);

    const turn = new Promise<void>((resolveTurn) => {
      finishTurn = resolveTurn;
    });
    userMessages.send(text);
    await turn;
  }

  shuttingDown = true;
  userMessages.end();
  conversation.close();
  rl.close();
  await consumer;
  console.log("\nbye.");
}

main().catch((error: unknown) => {
  console.error(`\nAgent failed: ${describeError(error)}`);
  process.exitCode = 1;
  shuttingDown = true;
  conversation.close();
  rl.close();
});
