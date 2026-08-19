// Lab 2.2 — Interactive terminal agent with a single "calculate" tool.
//
// Run:  node calculator-agent.js
// Needs a .env file in this folder containing:  ANTHROPIC_API_KEY=sk-ant-...

import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import Anthropic from "@anthropic-ai/sdk";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "Missing ANTHROPIC_API_KEY. Create a .env file next to this script with:\n" +
      "  ANTHROPIC_API_KEY=sk-ant-...",
  );
  process.exit(1);
}

const client = new Anthropic(); // picks up ANTHROPIC_API_KEY from the environment

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1024;

// ---------------------------------------------------------------------------
// Tool definition — exactly one tool.
// ---------------------------------------------------------------------------

const tools = [
  {
    name: "calculate",
    description:
      "Perform a basic arithmetic operation on two numbers. Use this for any " +
      "arithmetic the user asks for instead of computing the answer yourself.",
    input_schema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["add", "subtract", "multiply", "divide"],
          description: "The arithmetic operation to perform.",
        },
        a: { type: "number", description: "The left-hand operand." },
        b: { type: "number", description: "The right-hand operand." },
      },
      required: ["operation", "a", "b"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool implementation — the math actually happens here in JavaScript, never
// in the model. Returns a tool_result content block (without tool_use_id).
// ---------------------------------------------------------------------------

function runCalculate(input) {
  const { operation, a, b } = input ?? {};

  if (typeof a !== "number" || typeof b !== "number" || Number.isNaN(a) || Number.isNaN(b)) {
    return { is_error: true, content: "Error: 'a' and 'b' must both be numbers." };
  }

  switch (operation) {
    case "add":
      return { content: String(a + b) };
    case "subtract":
      return { content: String(a - b) };
    case "multiply":
      return { content: String(a * b) };
    case "divide":
      if (b === 0) {
        return { is_error: true, content: "Error: division by zero is undefined." };
      }
      return { content: String(a / b) };
    default:
      return { is_error: true, content: `Error: unknown operation '${operation}'.` };
  }
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

/** Full conversation history, resent on every request (the API is stateless). */
const messages = [];

function printAssistantText(response) {
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (text) console.log(`\nClaude: ${text}\n`);
}

async function handleTurn(userInput) {
  messages.push({ role: "user", content: userInput });

  // Keep going until Claude stops asking for tools.
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      tools,
      tool_choice: { type: "auto" },
      messages,
    });

    // Record the assistant turn verbatim (text + thinking + tool_use blocks).
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      printAssistantText(response);
      return;
    }

    // Show any text Claude wrote alongside the tool call.
    printAssistantText(response);

    const toolUses = response.content.filter((block) => block.type === "tool_use");
    const toolResults = [];

    for (const toolUse of toolUses) {
      const { operation, a, b } = toolUse.input ?? {};
      console.log(`  [tool] calculate(${operation}, ${a}, ${b})`);

      const { content, is_error } = runCalculate(toolUse.input);
      console.log(`  [tool] -> ${content}`);

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content,
        ...(is_error ? { is_error: true } : {}),
      });
    }

    // All tool_result blocks go back in a SINGLE user message.
    messages.push({ role: "user", content: toolResults });
  }
}

async function main() {
  const rl = readline.createInterface({ input, output });

  console.log("Calculator agent ready. Ask me some math. Type 'exit' or Ctrl+C to quit.\n");

  try {
    while (true) {
      const line = (await rl.question("You: ")).trim();

      if (!line) continue;
      if (["exit", "quit"].includes(line.toLowerCase())) break;

      try {
        await handleTurn(line);
      } catch (error) {
        if (error instanceof Anthropic.AuthenticationError) {
          console.error("\nInvalid API key — check ANTHROPIC_API_KEY in your .env file.\n");
        } else if (error instanceof Anthropic.RateLimitError) {
          console.error("\nRate limited. Wait a moment and try again.\n");
        } else if (error instanceof Anthropic.APIError) {
          console.error(`\nAPI error ${error.status}: ${error.message}\n`);
        } else {
          console.error(`\nUnexpected error: ${error.message}\n`);
        }
      }
    }
  } finally {
    rl.close();
  }

  console.log("Goodbye.");
}

main();
