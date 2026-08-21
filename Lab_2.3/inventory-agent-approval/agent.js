/**
 * Claude Agent SDK — custom tool behind an in-process MCP server, with an
 * explicit human approval gate in front of every tool call.
 *
 * Run:  npm start
 * Needs a .env file next to this script containing: ANTHROPIC_API_KEY=sk-ant-...
 */

import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "Missing ANTHROPIC_API_KEY. Create a .env file next to this script with:\n" +
      "  ANTHROPIC_API_KEY=sk-ant-...",
  );
  process.exit(1);
}

const MODEL = "claude-sonnet-5";

/** Registration key for the MCP server. Also the `{server}` segment of every
 *  fully qualified tool name: mcp__inventory-tools__get_stock_level */
const SERVER_NAME = "inventory-tools";

const PROMPT = "How many of SKU WB-1L do we have in stock?";

// ---------------------------------------------------------------------------
// 2. The custom tool
// ---------------------------------------------------------------------------

/**
 * Mock warehouse. Stands in for a real inventory API.
 * @type {ReadonlyMap<string, number>}
 */
const MOCK_STOCK = new Map([
  ["WB-1L", 42],
  ["WB-750ML", 17],
  ["WB-500ML", 8],
  ["MUG-CER", 0],
]);

const getStockLevel = tool(
  "get_stock_level",
  "Look up inventory for a SKU. Use this instead of guessing or recalling a " +
    "stock number — inventory changes constantly.",
  {
    // Zod validates the model's arguments before the handler runs, so by the
    // time the handler runs, args.sku is guaranteed to be a non-empty string.
    sku: z
      .string()
      .min(1)
      .describe("The SKU to look up, e.g. WB-1L. Case-insensitive."),
  },
  async (args) => {
    const sku = args.sku.trim().toUpperCase();
    const count = MOCK_STOCK.get(sku);

    if (count === undefined) {
      // isError tells Claude the call failed, so it reports "unknown SKU"
      // rather than treating a missing entry as a stock level of zero.
      return {
        content: [
          {
            type: "text",
            text:
              `Unknown SKU '${sku}'. Known SKUs: ` +
              `${[...MOCK_STOCK.keys()].join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: `SKU ${sku}: ${count} in stock` }],
    };
  },
  { annotations: { readOnlyHint: true } },
);

/** In-process MCP server: an object in THIS process, not a spawned subprocess. */
const inventoryToolsServer = createSdkMcpServer({
  name: SERVER_NAME,
  version: "1.0.0",
  tools: [getStockLevel],
});

// ---------------------------------------------------------------------------
// 3. The approval gate
// ---------------------------------------------------------------------------

/**
 * Reads one line from the operator. The readline interface is created per
 * question rather than once at startup: a long-lived interface emits 'close'
 * as soon as stdin hits EOF (any non-TTY stdin — a pipe, CI, a test harness),
 * and every later question() then rejects with "readline was closed".
 * Returns "" if stdin is already exhausted, which the caller treats as "no".
 *
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function askOperator(prompt) {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(prompt)).trim().toLowerCase();
  } catch {
    return "";
  } finally {
    rl.close();
  }
}

/**
 * Called before a tool runs, for every call the permission flow did not
 * already resolve. Returning `deny` stops the call; the model is told it was
 * refused and continues the turn without the result.
 *
 * Fails closed: anything other than an explicit yes denies the call.
 *
 * @type {import("@anthropic-ai/claude-agent-sdk").CanUseTool}
 */
const requireApproval = async (toolName, toolInput) => {
  console.log("\n--- permission request ------------------------------------");
  console.log(`  tool:  ${toolName}`);
  console.log(`  input: ${JSON.stringify(toolInput)}`);

  const answer = await askOperator("  approve? [y/N] ");
  const approved = answer === "y" || answer === "yes";

  console.log(`  -> ${approved ? "APPROVED" : "DENIED"}`);
  console.log("-----------------------------------------------------------\n");

  return approved
    ? { behavior: "allow", updatedInput: toolInput }
    : { behavior: "deny", message: `The operator denied the ${toolName} call.` };
};

// The SDK warns once if a config would auto-approve calls before `canUseTool`
// is consulted — i.e. if this gate were silently bypassed. Surface it loudly.
process.on("warning", (warning) => {
  // Node attaches `code` to warnings; it is not on the base Error type.
  const { code } = /** @type {{ code?: string }} */ (warning);
  if (code === "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED") {
    console.error(`\n!! APPROVAL GATE BYPASSED: ${warning.message}\n`);
  }
});

// ---------------------------------------------------------------------------
// 4. Options
// ---------------------------------------------------------------------------

/** @type {import("@anthropic-ai/claude-agent-sdk").Options} */
const options = {
  model: MODEL,

  systemPrompt:
    "You are an inventory assistant. Answer stock questions using the " +
    "inventory tools; never state a stock number you did not read from a tool.",

  // The key here — not createSdkMcpServer's `name` — namespaces the tools.
  mcpServers: { [SERVER_NAME]: inventoryToolsServer },

  // 'default' means no auto-approvals: every tool call that no rule already
  // resolved falls through to the canUseTool callback for an explicit decision.
  permissionMode: "default",
  canUseTool: requireApproval,

  // Deliberately NO `allowedTools`. Listing a tool there pre-approves it, and
  // an auto-approved call never reaches canUseTool — the gate above would be
  // dead code. Same reason settingSources is empty: an allow rule in an
  // on-disk .claude/settings.json would also skip the gate.
  settingSources: [],

  // Remove Claude Code's built-in tools (Read/Write/Edit/Bash/...), which are
  // on by default. This agent can only use get_stock_level.
  tools: [],

  maxTurns: 10,
};

// ---------------------------------------------------------------------------
// 5. Run the loop and print every turn
// ---------------------------------------------------------------------------

/**
 * Renders a tool_result block's payload, which is a string or a block array.
 * @param {string | ReadonlyArray<{ type: string }> | undefined} payload
 * @returns {string}
 */
function renderToolResult(payload) {
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

async function main() {
  console.log(`You: ${PROMPT}\n`);

  for await (const message of query({ prompt: PROMPT, options })) {
    switch (message.type) {
      // Emitted once, before any model output.
      case "system": {
        if (message.subtype === "init") {
          console.log(
            `[session] model=${message.model} ` +
              `tools=[${message.tools.join(", ")}] ` +
              `permissionMode=${message.permissionMode}`,
          );
        }
        break;
      }

      // One per assistant turn — this is where a tool call is decided.
      case "assistant": {
        for (const block of message.message.content) {
          if (block.type === "text") {
            console.log(`\n[assistant] ${block.text}`);
          } else if (block.type === "thinking") {
            console.log(`\n[thinking] ${block.thinking}`);
          } else if (block.type === "tool_use") {
            console.log(
              `\n[tool call] ${block.name}(${JSON.stringify(block.input)})`,
            );
          }
        }
        break;
      }

      // Tool results come back as a user-role turn.
      case "user": {
        const content = message.message.content;
        if (typeof content === "string") {
          console.log(`\n[user] ${content}`);
          break;
        }
        for (const block of content) {
          if (block.type === "tool_result") {
            const label = block.is_error ? "tool error" : "tool result";
            console.log(`[${label}] ${renderToolResult(block.content)}`);
          }
        }
        break;
      }

      // Terminal message: the loop is finished.
      case "result": {
        if (message.subtype === "success") {
          console.log(`\n[final answer] ${message.result}`);
          console.log(
            `\n[usage] ${message.num_turns} turns, ` +
              `$${message.total_cost_usd.toFixed(4)}, ${message.duration_ms}ms`,
          );
        } else {
          console.error(`\n[ended without a result] ${message.subtype}`);
        }
        break;
      }

      default:
        break;
    }
  }
}

main().catch((error) => {
  console.error(
    `\nAgent failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
