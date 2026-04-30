// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IMockERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract MockSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    mapping(bytes32 route => uint256 amountOut) public quote;

    function setQuote(address tokenIn, address tokenOut, uint256 amountOut) external {
        quote[_routeKey(tokenIn, tokenOut)] = amountOut;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        require(params.deadline == 0 || block.timestamp <= params.deadline, "deadline passed");

        amountOut = quote[_routeKey(params.tokenIn, params.tokenOut)];
        require(amountOut >= params.amountOutMinimum, "insufficient output");

        require(IMockERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn), "token in failed");
        require(IMockERC20(params.tokenOut).transfer(params.recipient, amountOut), "token out failed");
    }

    function _routeKey(address tokenIn, address tokenOut) private pure returns (bytes32) {
        return keccak256(abi.encode(tokenIn, tokenOut));
    }
}
