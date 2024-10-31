import { Commitment } from "@solana/web3.js";
import { logger, retrieveEnvVariable } from "../utils";

export const NETWORK = 'mainnet-beta';
export const COMMITMENT_LEVEL: Commitment = retrieveEnvVariable('COMMITMENT_LEVEL', logger) as Commitment;
export const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger);
export const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable('RPC_WEBSOCKET_ENDPOINT', logger);
export const LOG_LEVEL = retrieveEnvVariable('LOG_LEVEL', logger);
export const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY', logger);
export const QUOTE_MINT = retrieveEnvVariable('QUOTE_MINT', logger);
export const QUOTE_AMOUNT = retrieveEnvVariable('QUOTE_AMOUNT', logger);
export const AMOUNT_TO_WSOL = parseFloat(retrieveEnvVariable('AMOUNT_TO_WSOL', logger));
export const AUTO_SELL = retrieveEnvVariable('AUTO_SELL', logger) === 'true';
export const SELL_TIMER = parseInt(retrieveEnvVariable('SELL_TIMER', logger));
export const MAX_RETRY = parseInt(retrieveEnvVariable('MAX_RETRY', logger));
export const BUY_SLIPPAGE = parseFloat(retrieveEnvVariable('BUY_SLIPPAGE', logger));
export const SELL_SLIPPAGE = parseFloat(retrieveEnvVariable('SELL_SLIPPAGE', logger));
export const TAKE_PROFIT = Number(retrieveEnvVariable('TAKE_PROFIT', logger));
export const STOP_LOSS = Number(retrieveEnvVariable('TAKE_PROFIT', logger));
export const FREEZE_AUTHORITY = retrieveEnvVariable('FREEZE_AUTHORITY', logger) === 'true';
export const MINT_AUTHORITY = retrieveEnvVariable('MINT_AUTHORITY', logger) === 'true';
export const PRICE_CHECK_INTERVAL = Number(retrieveEnvVariable('PRICE_CHECK_INTERVAL', logger));
export const ONE_TOKEN_AT_A_TIME = retrieveEnvVariable('ONE_TOKEN_AT_A_TIME', logger) === 'true';
export const MAX_NUMBERS_TOKENS_TO_PROCESS = Number(retrieveEnvVariable('MAX_NUMBERS_TOKENS_TO_PROCESS', logger));