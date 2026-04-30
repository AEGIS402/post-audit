import { Interface } from "ethers";

export const erc20Interface = new Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function transfer(address to,uint256 value) returns (bool)",
  "function approve(address spender,uint256 value) returns (bool)",
  "function transferFrom(address from,address to,uint256 value) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event Approval(address indexed owner,address indexed spender,uint256 value)",
]);

export const uniswapV3RouterInterface = new Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

export const metadataFunctionNames = ["name", "symbol", "decimals"] as const;
