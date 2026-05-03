import { config as loadEnv } from "dotenv";
import { configVariable, defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

loadEnv({ quiet: true });

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    mainnet: {
      type: "http",
      chainType: "l1",
      url: configVariable("MAINNET_RPC_URL"),
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
    },
    hardhatSepolia: {
      type: "edr-simulated",
      chainType: "l1",
      forking: {
        url: configVariable("SEPOLIA_RPC_URL"),
      },
    },
  },
});
