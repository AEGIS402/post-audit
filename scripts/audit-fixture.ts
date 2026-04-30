import { readFile } from "node:fs/promises";
import { config as loadEnv } from "dotenv";
import { buildAuditPayload } from "../src/payload.js";
import { parsePriceOverrides } from "../src/prices.js";
import { runLlmAudit } from "../src/llm.js";
import { emitJson } from "../src/output.js";
import type { RawRpcInput } from "../src/types.js";
import { checksumAddress, getOutputPath, requireEnv } from "../src/utils.js";

loadEnv({ quiet: true });

const fixturePath = requireEnv("FIXTURE_PATH");
const outputPath = getOutputPath();
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as RawRpcInput;

if (process.env.SUBJECT_ADDRESS !== undefined && process.env.SUBJECT_ADDRESS.trim() !== "") {
  fixture.subject_address = checksumAddress(process.env.SUBJECT_ADDRESS);
}

const payload = buildAuditPayload(fixture, {
  priceOverrides: parsePriceOverrides(),
});
const audit = await runLlmAudit(payload);

await emitJson(audit, outputPath);
