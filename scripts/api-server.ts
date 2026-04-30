import { config as loadEnv } from "dotenv";
import { network } from "hardhat";
import { createAuditApiServer } from "../src/api.js";
import { parsePriceOverrides } from "../src/prices.js";

loadEnv({ quiet: true });

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const { ethers } = await network.create();
const server = createAuditApiServer({
  provider: ethers.provider,
  priceOverrides: parsePriceOverrides(),
});

server.listen(port, host, () => {
  console.log(`post-audit API listening on http://${host}:${port}`);
});
