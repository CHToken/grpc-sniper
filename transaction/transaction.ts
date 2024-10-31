// External Libraries
import bs58 from 'bs58';
import { BN } from 'bn.js';
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { Liquidity, LiquidityPoolKeysV4, LiquidityStateV4, Token, TokenAmount, Percent } from '@raydium-io/raydium-sdk';
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';

// Internal Modules
import { logger } from '../utils/logger';
import { getWallet } from '../utils/wallet';
import { createAndFundWSOL, checkAuthority } from '../utils/helpers';
import { createPoolKeys, getTokenAccounts } from '../liquidity';
import { MinimalMarketLayoutV3 } from '../market';
import { COMMITMENT_LEVEL, LOG_LEVEL, PRIVATE_KEY, QUOTE_AMOUNT, QUOTE_MINT, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT, BUY_SLIPPAGE, TAKE_PROFIT, AMOUNT_TO_WSOL, AUTO_SELL, SELL_TIMER, MAX_RETRY, FREEZE_AUTHORITY, MINT_AUTHORITY, SELL_SLIPPAGE, STOP_LOSS, PRICE_CHECK_INTERVAL, ONE_TOKEN_AT_A_TIME, MAX_NUMBERS_TOKENS_TO_PROCESS } from '../constants';

// Token amount initialization
let quoteTokenAssociatedAddress: PublicKey;
let quoteAmount: TokenAmount;
let quoteToken = Token.WSOL;

// Initialize wallet using PRIVATE_KEY
quoteAmount = new TokenAmount(Token.WSOL, QUOTE_AMOUNT, false);

export interface MinimalTokenAccountData {
  mint: PublicKey;
  address: PublicKey;
  poolKeys?: LiquidityPoolKeysV4;
  market?: LiquidityStateV4;
};

const existingTokenAccounts: Map<string, MinimalTokenAccountData> = new Map<string, MinimalTokenAccountData>();
// Constants
export const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
export const wallet = getWallet(PRIVATE_KEY.trim()); // Initialize wallet once
export const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});

// Init Function
export async function init(): Promise<void> {
  logger.level = LOG_LEVEL;
  
  logger.info(`Wallet Address: ${wallet.publicKey}`);

  // Handle quote token based on QUOTE_MINT (WSOL or USDC)
  switch (QUOTE_MINT) {
    case 'WSOL': {
      quoteToken = Token.WSOL;
      quoteAmount = new TokenAmount(Token.WSOL, QUOTE_AMOUNT, false);
      logger.info('Quote token is WSOL');
      break;
    }
    case 'USDC': {
      quoteToken = new Token(
        TOKEN_PROGRAM_ID,
        new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
        6,
        'USDC',
        'USDC',
      );
      quoteAmount = new TokenAmount(quoteToken, QUOTE_AMOUNT, false);
      logger.info('Quote token is USDC');
      break;
    }
    default: {
      throw new Error(`Unsupported quote mint "${QUOTE_MINT}". Supported values are USDC and WSOL`);
    }
  }

  logger.info(
    `Script will buy all new tokens using ${QUOTE_MINT}. Amount that will be used to buy each token is: ${quoteAmount.toFixed().toString()}`
  );

  // Trading configurations
  logger.info(`AUTO_SELL: ${AUTO_SELL}`);
  logger.info(`BUY_SLIPPAGE: ${BUY_SLIPPAGE}%`);
  logger.info(`SELL_SLIPPAGE: ${SELL_SLIPPAGE}%`);
  logger.info(`STOP_LOSS: ${STOP_LOSS}%`);
  logger.info(`TAKE_PROFIT: ${TAKE_PROFIT}%`);
  logger.info(`ONE_TOKEN_AT_A_TIME: ${ONE_TOKEN_AT_A_TIME}`);
  logger.info(`MAX_NUMBERS_TOKENS_TO_PROCESS: ${MAX_NUMBERS_TOKENS_TO_PROCESS}`);
  logger.info(`AMOUNT_TO_WSOL: ${AMOUNT_TO_WSOL}`);
  logger.info(`QUOTE_AMOUNT: ${QUOTE_AMOUNT}`);
  logger.info(`MAX_RETRY: ${MAX_RETRY}`);

  // Timers and intervals
  logger.info(`SELL_TIMER: ${SELL_TIMER}ms`);
  logger.info(`PRICE_CHECK_INTERVAL: ${PRICE_CHECK_INTERVAL}ms`);

  // Authorities
  logger.info(`FREEZE_AUTHORITY: ${FREEZE_AUTHORITY}`);
  logger.info(`MINT_AUTHORITY: ${MINT_AUTHORITY}`);

  // Check existing wallet for associated token account of quote mint
  const tokenAccounts = await getTokenAccounts(solanaConnection, wallet.publicKey, COMMITMENT_LEVEL);
  logger.info('Fetched token accounts from wallet.');

  // Create WSOL ATA and fund it with SOL during initialization
  if (QUOTE_MINT === 'WSOL') {
    const wsolAta = getAssociatedTokenAddressSync(Token.WSOL.mint, wallet.publicKey);
    logger.info(`WSOL ATA: ${wsolAta.toString()}`);

    // Check if WSOL account exists in wallet
    const solAccount = tokenAccounts.find(
      (acc) => acc.accountInfo.mint.toString() === Token.WSOL.mint.toString()
    );

    if (!solAccount) {
      logger.info(`No WSOL token account found. Creating and funding with ` + `${AMOUNT_TO_WSOL} SOL...`);

      // Create WSOL (wrapped SOL) account and fund it with SOL
      await createAndFundWSOL(wsolAta);
    } else {
      logger.info('WSOL account already exists in the wallet.');

      // Fetch the WSOL account balance
      const wsolAccountInfo = await getAccount(solanaConnection, wsolAta);
      const wsolBalance = Number(wsolAccountInfo.amount) / LAMPORTS_PER_SOL;
      logger.info(`Current WSOL balance: ${wsolBalance} WSOL`);

      // If WSOL balance is less than AMOUNT_TO_WSOL, top up the WSOL account
      if (wsolBalance < AMOUNT_TO_WSOL) {
        logger.info(`Insufficient WSOL balance. Funding with additional ` + `${AMOUNT_TO_WSOL} +  SOL...`);
        await createAndFundWSOL(wsolAta);
      }
    }

    // Set the quote token associated address
    quoteTokenAssociatedAddress = wsolAta;
  } else {
    const tokenAccount = tokenAccounts.find(
      (acc) => acc.accountInfo.mint.toString() === quoteToken.mint.toString()
    );

    if (!tokenAccount) {
      throw new Error(`No ${quoteToken.symbol} token account found in wallet: ${wallet.publicKey}`);
    }

    quoteTokenAssociatedAddress = tokenAccount.pubkey;
  }
}


const priceMatch = async (poolKeys: LiquidityPoolKeysV4, amountIn: TokenAmount, sellTimer: number) => {
  if (PRICE_CHECK_INTERVAL === 0) {
    return true; // Immediately proceed if no interval is set
  }

  const profitFraction = quoteAmount.mul(TAKE_PROFIT).numerator.div(new BN(100));
  const profitAmount = new TokenAmount(quoteToken, profitFraction, true);
  const takeProfit = quoteAmount.add(profitAmount);

  const lossFraction = quoteAmount.mul(STOP_LOSS).numerator.div(new BN(100));
  const lossAmount = new TokenAmount(quoteToken, lossFraction, true);
  const stopLoss = quoteAmount.subtract(lossAmount);
  const slippage = new Percent(SELL_SLIPPAGE, 100);

  let startTime = Date.now();

  // Loop until the SELL_TIMER duration elapses or price conditions are met
  while (Date.now() - startTime < sellTimer) {
    try {
      const poolInfo = await Liquidity.fetchInfo({
        connection: solanaConnection,
        poolKeys,
      });

      const amountOut = Liquidity.computeAmountOut({
        poolKeys,
        poolInfo,
        amountIn: amountIn,
        currencyOut: quoteToken,
        slippage,
      }).amountOut;

      logger.debug(
        { mint: poolKeys.baseMint.toString() },
        `Take profit: ${takeProfit.toFixed()} | Stop loss: ${stopLoss.toFixed()} | Current: ${amountOut.toFixed()}`
      );

      // Check if the price meets the take profit or stop loss conditions
      if (amountOut.lt(stopLoss) || amountOut.gt(takeProfit)) {
        return true; // Sell conditions met, proceed to sell
      }

      // Wait before checking the price again
      await sleep(PRICE_CHECK_INTERVAL);
    } catch (e) {
      logger.trace({ mint: poolKeys.baseMint.toString(), e }, `Failed to check token price`);
    }
  }

  // If the SELL_TIMER has expired without meeting conditions, proceed with sell
  logger.info(`SELL_TIMER expired, proceeding with sell.`);
  return true;
};

// Buy Function with Conditional Mint and Freeze Authority Check
export async function buy(
  latestBlockhash: string,
  newTokenAccount: PublicKey,
  poolState: LiquidityStateV4,
  minimalMarketLayoutV3: MinimalMarketLayoutV3
): Promise<void> {
  try {
    const mintAddress = poolState.baseMint;
    const shouldCheckFreezeAuthority = FREEZE_AUTHORITY;
    const shouldCheckMintAuthority = MINT_AUTHORITY;
    const { mintAuthority, freezeAuthorityExists } = await checkAuthority(mintAddress);
    
    // Check freeze authority conditionally based on environment variable
    if (shouldCheckFreezeAuthority && freezeAuthorityExists) {
      logger.info(`Freeze authority exists for token mint: ${mintAddress.toString()}, skipping buy.`);
      return;
    }

    // Check mint authority conditionally based on environment variable
    if (shouldCheckMintAuthority && mintAuthority) {
      logger.info(`Mint authority exists for token mint: ${mintAddress.toString()}, skipping buy.`);
      return;
    }

    // Log if the authority checks are disabled
    if (!shouldCheckMintAuthority) {
      logger.info(`MINT_AUTHORITY check is disabled for token mint: ${mintAddress.toString()}.`);
    }

    if (!shouldCheckFreezeAuthority) {
      logger.info(`FREEZE_AUTHORITY check is disabled for token mint: ${mintAddress.toString()}.`);
    }

    // If both checks are disabled or neither condition exists, proceed with the buy.
    logger.info(`No blocking authority conditions found or checks are disabled, proceeding with buy.`);

    const ata = getAssociatedTokenAddressSync(mintAddress, wallet.publicKey);
    const poolKeys = createPoolKeys(newTokenAccount, poolState, minimalMarketLayoutV3);

    // Determine the number of tokens to buy based on ONE_TOKEN_AT_A_TIME
    const numTokensToBuy = ONE_TOKEN_AT_A_TIME ? 1 : MAX_NUMBERS_TOKENS_TO_PROCESS;

    for (let i = 0; i < numTokensToBuy; i++) {
      logger.info(`Buying ${quoteAmount.toFixed()} of ${mintAddress.toString()}...`);

      const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
        {
          poolKeys: poolKeys,
          userKeys: {
            tokenAccountIn: quoteTokenAssociatedAddress,
            tokenAccountOut: ata,
            owner: wallet.publicKey,
          },
          amountIn: quoteAmount.raw,
          minAmountOut: 0,
        },
        poolKeys.version,
      );

      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: latestBlockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: 80000 }),
          createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            ata,
            wallet.publicKey,
            mintAddress,
          ),
          ...innerTransaction.instructions,
        ],
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([wallet, ...innerTransaction.signers]);

      const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
      });

      logger.info(`Buy transaction completed with signature - ${signature}`);
    }

    // After buy completes, initiate sell if AUTO_SELL is enabled
    if (AUTO_SELL) {
      logger.info(`AUTO_SELL is enabled, calling sell function to monitor conditions.`);
      await sleep(10000); // Wait for 12 seconds before selling
      await sell(wallet.publicKey, { mint: mintAddress, address: ata }, poolState, poolKeys);
    }
  } catch (error) {
    logger.error(error);
  }
}

// Sell function
export const sell = async (
  accountId: PublicKey,
  rawAccount: MinimalTokenAccountData,
  poolState: LiquidityStateV4,
  poolKeys: LiquidityPoolKeysV4
): Promise<void> => {
  logger.info(`Sell function triggered for account: ${accountId.toString()}`);

  try {
    logger.info({ mint: rawAccount.mint }, `Processing sell for token...`);

    // Get the associated token account for the mint
    let ata = getAssociatedTokenAddressSync(rawAccount.mint, wallet.publicKey);
    let tokenAccountInfo;

    // Loop until the token account is found
    while (!tokenAccountInfo) {
      try {
        tokenAccountInfo = await getAccount(solanaConnection, ata);
      } catch (error) {
        if (error instanceof Error && error.name === 'TokenAccountNotFoundError') {
          logger.info(`Associated token account not found, retrying...`);
          await new Promise(resolve => setTimeout(resolve, 700)); // 0.7 seconds delay
        } else if (error instanceof Error) {
          logger.error(`Unexpected error while fetching token account: ${error.message}`);
          throw error;
        } else {
          logger.error(`An unknown error occurred while fetching token account.`);
          throw new Error("An unknown error occurred while fetching token account.");
        }
      }
    }

    // If tokenAccountInfo is still undefined after retries, create the associated token account
    if (!tokenAccountInfo) {
      logger.info(`Creating associated token account for mint: ${rawAccount.mint.toString()}...`);
      const transaction = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: (await solanaConnection.getLatestBlockhash()).blockhash,
        instructions: [
          createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            ata,
            wallet.publicKey,
            rawAccount.mint,
          ),
        ],
      }).compileToV0Message();

      const createAtaTx = new VersionedTransaction(transaction);
      createAtaTx.sign([wallet]);

      const signature = await solanaConnection.sendRawTransaction(createAtaTx.serialize());
      await solanaConnection.confirmTransaction(signature);
      logger.info(`Created associated token account with signature: ${signature}`);

      // Fetch the newly created token account
      tokenAccountInfo = await getAccount(solanaConnection, ata);
    }

    // Fetch the token balance after ensuring the account exists
    const tokenBalance = tokenAccountInfo.amount.toString();
    logger.info(`Token balance for ${rawAccount.mint.toString()} is: ${tokenBalance}`);

    if (tokenBalance === '0') {
      logger.info({ mint: rawAccount.mint.toString() }, `Empty balance, can't sell`);
      return;
    }

    const tokenIn = new Token(TOKEN_PROGRAM_ID, rawAccount.mint, poolState.baseDecimal.toNumber());
    const tokenAmountIn = new TokenAmount(tokenIn, tokenBalance, true); // Use the entire balance

    // Run priceMatch with SELL_TIMER as the timeout
    const shouldProceedWithSell = await priceMatch(poolKeys, tokenAmountIn, SELL_TIMER);

    if (shouldProceedWithSell) {
      await swap(
        poolKeys,
        ata,
        quoteTokenAssociatedAddress,
        tokenIn,
        quoteToken,
        tokenAmountIn,
        wallet,
        'sell'
      );
    } else {
      logger.info(`Conditions not met, and SELL_TIMER has expired; proceeding with sell.`);
    }
  } catch (error) {
    logger.error({ mint: rawAccount.mint.toString(), error }, `Failed to sell token`);
  }
};

// Swap Function
async function swap(
  poolKeys: LiquidityPoolKeysV4,
  ataIn: PublicKey, // Token you're selling
  ataOut: PublicKey, // Token you're receiving (quoteToken)
  tokenIn: Token,
  tokenOut: Token,
  amountIn: TokenAmount,
  wallet: Keypair,
  direction: 'buy' | 'sell',
) {
  // Determine slippage percentage based on transaction type
  const slippagePercent = new Percent(
    direction === 'buy' ? BUY_SLIPPAGE * 100 : SELL_SLIPPAGE * 100,
    10000
  );

  // Fetch pool info
  const poolInfo = await Liquidity.fetchInfo({
    connection: solanaConnection,
    poolKeys,
  });

  // Compute the minimum amount out (taking slippage into account)
  const computedAmountOut = Liquidity.computeAmountOut({
    poolKeys,
    poolInfo,
    amountIn,
    currencyOut: tokenOut,
    slippage: slippagePercent,
  });

  const latestBlockhash = await solanaConnection.getLatestBlockhash();
  const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
    {
      poolKeys: poolKeys,
      userKeys: {
        tokenAccountIn: ataIn,
        tokenAccountOut: ataOut,
        owner: wallet.publicKey,
      },
      amountIn: amountIn.raw,
      minAmountOut: computedAmountOut.minAmountOut.raw,
    },
    poolKeys.version,
  );

  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 80000 }),
      ...innerTransaction.instructions,
      ...(direction === 'sell' ? [createCloseAccountInstruction(ataIn, wallet.publicKey, wallet.publicKey)] : []), // Close account if selling
    ],
  }).compileToV0Message();

  // Sign and execute the transaction
  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([wallet, ...innerTransaction.signers]);

  const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: true,
  });

  logger.info(`Transaction ${direction} with signature - ${signature}`);
}
