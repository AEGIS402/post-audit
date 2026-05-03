import { config as loadEnv } from "dotenv";
import { network } from "hardhat";
import { createAuditApiServer } from "../src/api.js";
import { parsePriceOverrides } from "../src/prices.js";

loadEnv({ quiet: true });

const port = Number(process.env.PORT ?? 13000);
const host = process.env.HOST ?? "127.0.0.1";
const { ethers } = await network.create();
const server = createAuditApiServer({
  provider: ethers.provider,
  priceOverrides: parsePriceOverrides(),
  ownerKey: process.env.PRIVATE_KEY,
  normalTraderKey: process.env.NORMAL_TRADER_KEY,
  sandwichTraderKey: process.env.SANDWICH_TRADER_KEY,
});

server.listen(port, host, () => {
  console.log(`post-audit API listening on http://${host}:${port}`);
});
