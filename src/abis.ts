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

export const aegisEscrowInterface = new Interface([
  "event EscrowRegistered(bytes32 indexed escrowId,address indexed subject,address indexed beneficiary,bytes32 policyHash)",
  "event ProtectedSwapEscrowed(bytes32 indexed tradeId,address indexed user,address indexed settlementRecipient,address inputToken,uint256 inputAmount,address outputToken,uint256 outputAmount,uint256 expectedOutput)",
]);

export const aegisAdapterInterface = new Interface([
  "function protectedExactInputSingle((tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,bool zeroForOne,uint128 amountIn,uint256 expectedOutput,uint160 sqrtPriceLimitX96,bytes32 tradeId,address settlementRecipient) request)",
  "event ProtectedSwapSubmitted(bytes32 indexed tradeId,address indexed user,address indexed settlementRecipient,address inputToken,uint256 amountIn,uint256 protectionFee)",
]);

export const metadataFunctionNames = ["name", "symbol", "decimals"] as const;
