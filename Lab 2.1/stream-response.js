import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "Error: ANTHROPIC_API_KEY is not set.\n" +
      "Create a .env file next to this script containing:\n" +
      "  ANTHROPIC_API_KEY=sk-ant-...",
  );
  process.exit(1);
}

const client = new Anthropic();

async function main() {
  const stream = client.messages.stream({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content:
          "Write a short, upbeat product description for an insulated water bottle.",
      },
    ],
  });

  // Each delta is written straight to stdout as it arrives — nothing is accumulated.
  stream.on("text", (text) => {
    process.stdout.write(text);
  });

  const message = await stream.finalMessage();

  process.stdout.write("\n");
  console.log(
    `Usage: input_tokens=${message.usage.input_tokens}, output_tokens=${message.usage.output_tokens}`,
  );
}

try {
  await main();
} catch (error) {
  if (error instanceof Anthropic.AuthenticationError) {
    console.error("\nError: the ANTHROPIC_API_KEY in .env was rejected.");
  } else if (error instanceof Anthropic.RateLimitError) {
    console.error("\nError: rate limited by the API — try again shortly.");
  } else if (error instanceof Anthropic.APIError) {
    console.error(`\nError: API request failed (${error.status}): ${error.message}`);
  } else {
    console.error(`\nError: ${error.message}`);
  }
  process.exit(1);
}
