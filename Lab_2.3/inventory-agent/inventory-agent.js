// Lab 2.3 — The same interactive terminal agent as Lab 2.2, but the agent loop
// is gone. The Claude Agent SDK runs it for us, and our tools are exposed
// through an *in-process MCP server*.
//
// What changed since Lab 2.2:
//   Lab 2.2                              Lab 2.3
//   -----------------------------------  -----------------------------------
//   client.messages.create(...)          query({ prompt, options })
//   hand-written `while (tool_use)` loop  the SDK owns the loop
//   JSON Schema by hand                  Zod schema, args typed for you
//   you dispatch on toolUse.name         the MCP server routes to the handler
//   you push tool_result blocks          the handler's return value IS the result
//   `messages` array you resend          a session the SDK persists and resumes
//
// Run:  npm start        (or: node inventory-agent.js)
// Needs a .env file in this folder containing:  ANTHROPIC_API_KEY=sk-ant-...

import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "Missing ANTHROPIC_API_KEY. Create a .env file next to this script with:\n" +
      "  ANTHROPIC_API_KEY=sk-ant-...",
  );
  process.exit(1);
}

const MODEL = "claude-sonnet-5";

// The key we register the server under. It shows up again in every tool's
// fully qualified name, so it is a constant rather than a string typed twice.
const SERVER_KEY = "inventory";

// ---------------------------------------------------------------------------
// Fake inventory backend
//
// Stands in for the Shopify Admin API. Everything the tools do happens here in
// plain JavaScript — the model never computes a stock number, it only asks.
// ---------------------------------------------------------------------------

/** @type {Map<string, { title: string; available: number; reserved: number }>} */
const INVENTORY = new Map([
  ["TSHIRT-BLK-M", { title: "Black T-Shirt / Medium", available: 42, reserved: 0 }],
  ["TSHIRT-BLK-L", { title: "Black T-Shirt / Large", available: 7, reserved: 0 }],
  ["MUG-CERAMIC", { title: "Ceramic Mug", available: 0, reserved: 0 }],
  ["STICKER-PACK", { title: "Sticker Pack", available: 250, reserved: 0 }],
]);

// ---------------------------------------------------------------------------
// Tool 1 — get_stock_level (read-only)
//
// tool() takes four arguments: name, description, input schema, handler.
// The schema is a plain object of Zod fields (a "raw shape"), not z.object().
// .describe() text is sent to Claude as the parameter description, so it does
// the same job as the `description` fields in Lab 2.2's JSON Schema.
// ---------------------------------------------------------------------------

const getStockLevel = tool(
  "get_stock_level",
  "Look up the current inventory for a single SKU. Use this instead of " +
    "guessing or recalling stock numbers — the catalog changes constantly.",
  {
    sku: z
      .string()
      .describe("The SKU to look up, e.g. TSHIRT-BLK-M. Case-insensitive."),
  },
  // `args` is typed from the schema above and already validated: by the time
  // this runs, args.sku is guaranteed to be a string.
  async (args) => {
    const sku = args.sku.trim().toUpperCase();
    const item = INVENTORY.get(sku);

    if (!item) {
      // A missing SKU is a real failure, not an odd-looking zero. isError tells
      // Claude the call failed so it can say so instead of reporting "0 in stock".
      return {
        content: [
          {
            type: "text",
            text:
              `Unknown SKU '${sku}'. Known SKUs: ${[...INVENTORY.keys()].join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    const sellable = item.available - item.reserved;
    return {
      content: [
        {
          type: "text",
          text:
            `${sku} (${item.title}): ${sellable} sellable ` +
            `(${item.available} on hand, ${item.reserved} reserved)`,
        },
      ],
    };
  },
  // Annotations are metadata. readOnlyHint lets Claude batch this call in
  // parallel with other read-only calls — ask about three SKUs at once and
  // you will see all three tool calls in a single turn.
  { annotations: { readOnlyHint: true } },
);

// ---------------------------------------------------------------------------
// Tool 2 — reserve_stock (mutating)
//
// Second tool on the same server, so you can see how a write differs: no
// readOnlyHint, and it refuses rather than overselling.
// ---------------------------------------------------------------------------

const reserveStock = tool(
  "reserve_stock",
  "Reserve a quantity of a SKU for an order. Fails if there is not enough " +
    "sellable stock. Always check availability first if you are unsure.",
  {
    sku: z.string().describe("The SKU to reserve."),
    quantity: z
      .number()
      .int()
      .min(1)
      .describe("How many units to reserve. Must be at least 1."),
  },
  async (args) => {
    const sku = args.sku.trim().toUpperCase();
    const item = INVENTORY.get(sku);

    if (!item) {
      return {
        content: [{ type: "text", text: `Unknown SKU '${sku}'. Nothing reserved.` }],
        isError: true,
      };
    }

    const sellable = item.available - item.reserved;
    if (args.quantity > sellable) {
      return {
        content: [
          {
            type: "text",
            text:
              `Cannot reserve ${args.quantity} of ${sku}: only ${sellable} sellable. ` +
              `Nothing was reserved.`,
          },
        ],
        isError: true,
      };
    }

    item.reserved += args.quantity;
    return {
      content: [
        {
          type: "text",
          text:
            `Reserved ${args.quantity} of ${sku}. ` +
            `${item.available - item.reserved} still sellable.`,
        },
      ],
    };
  },
  { annotations: { readOnlyHint: false, destructiveHint: false } },
);

// ---------------------------------------------------------------------------
// The in-process MCP server
//
// "In-process" is the whole point: this is an object living in *this* Node
// process. There is no second process, no stdio pipe, no server to launch or
// keep alive. Compare to a conventional MCP server, which you would configure
// as { command: "npx", args: [...] } and the SDK would spawn.
// ---------------------------------------------------------------------------

const inventoryServer = createSdkMcpServer({
  name: SERVER_KEY,
  version: "1.0.0",
  tools: [getStockLevel, reserveStock],
});

// ---------------------------------------------------------------------------
// Options — the wiring that actually makes the tools reachable
// ---------------------------------------------------------------------------

/** @type {import("@anthropic-ai/claude-agent-sdk").Options} */
const options = {
  model: MODEL,

  systemPrompt:
    "You are an inventory assistant for a Shopify store. Answer questions " +
    "about stock using the inventory tools — never state a stock number you " +
    "did not read from a tool. Be brief and concrete.",

  // Registering the server. The KEY here — not the `name` passed to
  // createSdkMcpServer — is what namespaces the tools. Claude sees them as:
  //   mcp__inventory__get_stock_level
  //   mcp__inventory__reserve_stock
  // (Keeping the two strings identical, as SERVER_KEY does, avoids a confusing
  // mismatch. They are allowed to differ, and the key is the one that wins.)
  mcpServers: { [SERVER_KEY]: inventoryServer },

  // Pre-approve our tools so they run without a permission prompt. The `*`
  // wildcard covers every tool on the server; list them individually if you
  // want only some to run unattended.
  allowedTools: [`mcp__${SERVER_KEY}__*`],

  // Availability, which is a different thing from permission. The Agent SDK
  // ships Claude Code's built-in tools (Read, Write, Edit, Bash, Glob, Grep,
  // WebFetch...) and they are ON by default. An empty array removes all of
  // them, so this agent can ONLY use our two tools — no filesystem, no shell.
  // Drop this line and ask it to "check the inventory file" to see the
  // difference.
  tools: [],

  // Never block on an interactive permission prompt: there is no UI to answer
  // one here. Anything not pre-approved above is denied outright.
  permissionMode: "dontAsk",

  // Do not read .claude/settings.json, CLAUDE.md, or any other on-disk config
  // from this repo. Keeps the lab reproducible on every machine.
  settingSources: [],

  // Cap runaway loops while you are experimenting.
  maxTurns: 10,
};

// ---------------------------------------------------------------------------
// Driving the agent
//
// query() returns an async iterable of messages. There is no loop to write:
// by the time the 'result' message arrives, every tool call has already been
// dispatched to a handler above and fed back to the model.
// ---------------------------------------------------------------------------

/**
 * Session id from the first turn. Passing it back as `resume` is how this
 * conversation stays multi-turn — it replaces Lab 2.2's `messages` array that
 * we resent by hand on every request.
 * @type {string | undefined}
 */
let sessionId;

async function handleTurn(userInput) {
  const stream = query({
    prompt: userInput,
    options: sessionId ? { ...options, resume: sessionId } : options,
  });

  for await (const message of stream) {
    switch (message.type) {
      // Emitted once per query, before any model output.
      case "system":
        if (message.subtype === "init") {
          sessionId = message.session_id;
        }
        break;

      // One per assistant turn. Contains the raw content blocks, so this is
      // where you can watch Claude decide to call a tool.
      case "assistant":
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            console.log(`  [tool] ${block.name} ${JSON.stringify(block.input)}`);
          }
        }
        break;

      // The final message: everything is done.
      case "result":
        if (message.subtype === "success") {
          console.log(`\nClaude: ${message.result}\n`);
          console.log(
            `  (${message.num_turns} turns, ` +
              `$${message.total_cost_usd.toFixed(4)}, ${message.duration_ms}ms)\n`,
          );
        } else {
          console.error(`\nRun ended without a result: ${message.subtype}\n`);
        }
        break;
    }
  }
}

async function main() {
  const rl = readline.createInterface({ input, output });

  console.log("Inventory agent ready. Try:");
  console.log("  how many black t-shirts do we have in medium?");
  console.log("  reserve 3 large black tees");
  console.log("  reserve 5 mugs");
  console.log("  what's in stock across the whole catalog?");
  console.log("\nType 'exit' or Ctrl+C to quit.\n");

  try {
    while (true) {
      const line = (await rl.question("You: ")).trim();

      if (!line) continue;
      if (["exit", "quit"].includes(line.toLowerCase())) break;

      try {
        await handleTurn(line);
      } catch (error) {
        // query() throws after yielding an error result — catch here so one bad
        // turn does not kill the REPL.
        console.error(`\nTurn failed: ${error.message}\n`);
      }
    }
  } finally {
    rl.close();
  }

  console.log("Goodbye.");
}

main();
