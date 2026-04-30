import { config as loadEnv } from "dotenv";
import { network } from "hardhat";
import { buildAuditPayload } from "../src/payload.js";
import { parsePriceOverrides } from "../src/prices.js";
import { collectRawRpc } from "../src/rpc.js";
import { runLlmAudit } from "../src/llm.js";
import { emitJson } from "../src/output.js";
import { getOutputPath, requireEnv } from "../src/utils.js";

loadEnv({ quiet: true });

const txHash = requireEnv("TX_HASH");
const subjectAddress = requireEnv("SUBJECT_ADDRESS");
const outputPath = getOutputPath();
const { ethers } = await network.create();
const rawRpc = await collectRawRpc(ethers.provider, txHash, subjectAddress);
const payload = buildAuditPayload(rawRpc, {
  priceOverrides: parsePriceOverrides(),
});
const audit = await runLlmAudit(payload);

await emitJson(audit, outputPath);
