#!/usr/bin/env node
// clean-products.js — reads products.csv, tidies it up, and fills in any
// missing descriptions with the Claude API. Node 20+, ESM.
//
//   npm install @anthropic-ai/sdk dotenv
//   node clean-products.js [path/to/products.csv]

import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5";

// The system prompt is used verbatim, exactly as supplied. Do not reword it.
const SYSTEM_PROMPT = `You are a product copywriter for an outdoor gear store.
Always respond with only a single valid JSON object, no markdown fences,
no text outside the object, matching exactly:
{ title: string, description: string, seo_keywords: string[] }
If no product information is given, respond with
{ "title": "", "description": "", "seo_keywords": [] } — do not invent a product.
Strip any HTML tags from the input before use.
Escape any double quotes inside string values so the JSON stays valid.
Always respond in English regardless of the input product name's language.
Example:
Input: "Insulated Water Bottle 1L, keeps drinks cold 24h"
Output: {"title":"Insulated Water Bottle 1L","description":"Stay refreshed all
day — this insulated bottle keeps drinks cold for a full 24 hours.",
"seo_keywords":["insulated water bottle","cold drinks","1L bottle","hydration"]}`;

const EXPECTED_COLUMNS = ["name", "description", "price"];
const DESCRIPTION_DISPLAY_LIMIT = 80;

/* ------------------------------------------------------------------ *
 * CSV parsing (RFC 4180-ish: quoted fields, "" escapes, embedded \n)  *
 * ------------------------------------------------------------------ */

function parseCsv(input) {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let unterminatedQuote = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // consume the escaped pair
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.trim() === "") {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (inQuotes) unterminatedQuote = true;
  row.push(field);
  rows.push(row);

  // Drop blank lines so a trailing newline doesn't become a phantom row.
  const cleaned = rows.filter(
    (r) => !(r.length === 1 && r[0].trim() === ""),
  );
  return { rows: cleaned, unterminatedQuote };
}

/* ------------------------------------------------------------------ *
 * Normalization                                                       *
 * ------------------------------------------------------------------ */

// Words containing a digit are uppercased whole ("1l" -> "1L", "20l" -> "20L");
// everything else gets a capital first letter and a lowercase tail. Hyphen and
// slash segments are title-cased independently ("all-season" -> "All-Season").
function titleCaseToken(token) {
  return token
    .split(/([-/])/)
    .map((part) => {
      if (!part || part === "-" || part === "/") return part;
      if (/\d/.test(part)) return part.toUpperCase();
      return part[0].toUpperCase() + part.slice(1).toLowerCase();
    })
    .join("");
}

function toTitleCase(value) {
  return value
    .trim()
    .split(/\s+/) // also collapses runs of internal whitespace
    .filter(Boolean)
    .map(titleCaseToken)
    .join(" ");
}

function formatPrice(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return { display: "—", ok: false, reason: "price is empty" };

  // Tolerate currency symbols, spaces and thousands separators, but nothing else —
  // stripping every non-digit would silently turn "abc" into 0.
  const bare = trimmed.replace(/[$€£¥,\s]/g, "");
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(bare)) {
    return { display: trimmed, ok: false, reason: `price "${trimmed}" is not a number` };
  }
  return { display: Number(bare).toFixed(2), ok: true };
}

/* ------------------------------------------------------------------ *
 * Claude API                                                          *
 * ------------------------------------------------------------------ */

function extractJsonObject(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // The prompt forbids fences, but be forgiving if one slips through.
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("response contained no JSON object");
    return JSON.parse(match[0]);
  }
}

async function generateDescription(client, productName) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    // Short, well-specified task — low effort keeps it fast and cheap while
    // leaving Opus 5's default adaptive thinking on.
    output_config: { effort: "low" },
    // Server-side refusal fallback: if a safety classifier declines the
    // request, the API retries it on another model inside the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Input: "${productName}"` }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(
      `Claude declined the request (${response.stop_details?.category ?? "unknown"})`,
    );
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  const parsed = extractJsonObject(text);
  const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
  if (!description) throw new Error('response had an empty "description" field');
  return description;
}

/* ------------------------------------------------------------------ *
 * Main                                                                *
 * ------------------------------------------------------------------ */

async function main() {
  const csvPath = path.resolve(process.argv[2] ?? "products.csv");

  let raw;
  try {
    raw = fs.readFileSync(csvPath, "utf8");
  } catch (error) {
    console.error(
      error.code === "ENOENT"
        ? `Could not find a CSV at ${csvPath}. Pass a path as the first argument, or create products.csv with the columns: ${EXPECTED_COLUMNS.join(", ")}.`
        : `Could not read ${csvPath}: ${error.message}`,
    );
    process.exitCode = 1;
    return;
  }

  const { rows, unterminatedQuote } = parseCsv(raw);
  const warnings = [];
  if (unterminatedQuote) {
    warnings.push("CSV ended inside an unclosed quote — the last row may be truncated.");
  }

  if (rows.length === 0) {
    console.error(`${path.basename(csvPath)} is empty.`);
    process.exitCode = 1;
    return;
  }

  // Map the header so column order in the file doesn't matter.
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const index = {};
  for (const column of EXPECTED_COLUMNS) index[column] = header.indexOf(column);

  const missingColumns = EXPECTED_COLUMNS.filter((c) => index[c] === -1);
  if (missingColumns.length > 0) {
    console.error(
      `Header is missing required column(s): ${missingColumns.join(", ")}. Found: ${header.join(", ") || "(nothing)"}.`,
    );
    process.exitCode = 1;
    return;
  }

  // Pass 1: clean every row. Bad rows are recorded and skipped, never fatal.
  const products = [];
  rows.slice(1).forEach((cells, offset) => {
    const lineNumber = offset + 2; // 1-based, +1 for the header
    try {
      const at = (column) => (cells[index[column]] ?? "").trim();

      const rawName = at("name");
      if (!rawName) {
        warnings.push(`Line ${lineNumber}: skipped — no product name.`);
        return;
      }

      if (cells.length !== header.length) {
        warnings.push(
          `Line ${lineNumber}: expected ${header.length} columns, found ${cells.length} — missing values treated as empty.`,
        );
      }

      const price = formatPrice(at("price"));
      if (!price.ok) warnings.push(`Line ${lineNumber}: ${price.reason}.`);

      products.push({
        line: lineNumber,
        name: toTitleCase(rawName),
        description: at("description").replace(/\s+/g, " "),
        price: price.display,
        source: "csv",
      });
    } catch (error) {
      warnings.push(`Line ${lineNumber}: skipped — ${error.message}`);
    }
  });

  // Pass 2: fill in the blanks with Claude.
  const needsDescription = products.filter((p) => !p.description);

  if (needsDescription.length > 0) {
    if (!process.env.ANTHROPIC_API_KEY) {
      warnings.push(
        `ANTHROPIC_API_KEY is not set (expected in .env) — left ${needsDescription.length} description(s) blank.`,
      );
      for (const product of needsDescription) product.source = "no api key";
    } else {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      console.log(`Generating ${needsDescription.length} missing description(s) with ${MODEL}…`);

      for (const product of needsDescription) {
        try {
          product.description = await generateDescription(client, product.name);
          product.source = "claude";
        } catch (error) {
          const detail =
            error instanceof Anthropic.APIError
              ? `API error ${error.status ?? ""}: ${error.message}`
              : error.message;
          warnings.push(`Line ${product.line}: could not generate a description — ${detail}`);
          product.source = "failed";
        }
      }
    }
  }

  // Output.
  if (products.length === 0) {
    console.error("No usable product rows found.");
    process.exitCode = 1;
    return;
  }

  const truncate = (text) =>
    text.length > DESCRIPTION_DISPLAY_LIMIT
      ? `${text.slice(0, DESCRIPTION_DISPLAY_LIMIT - 1)}…`
      : text;

  console.log();
  console.table(
    products.map((p) => ({
      Name: p.name,
      Description: truncate(p.description) || "(none)",
      Price: p.price,
      Source: p.source,
    })),
  );

  if (warnings.length > 0) {
    console.warn(`\n${warnings.length} issue(s):`);
    for (const warning of warnings) console.warn(`  • ${warning}`);
  }
}

main().catch((error) => {
  // Last-resort net so an unexpected failure still exits cleanly.
  console.error(`Unexpected failure: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
