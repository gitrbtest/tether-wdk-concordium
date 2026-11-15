/**
 * Talking to the testnet node through the wallet package, carefully (as in examples/wdk-end-to-end.mjs): the node
 * can be briefly unavailable, so reads are retried; a transfer is never sent twice; each fee is checked against the
 * sender's CCD before sending.
 */
import { AccountNotCreatedError } from '@concordium/wdk-wallet-concordium';

export const PLT = 'TN';
export const CIS2 = 'cis2:12754:0:01';

/** What the funding account sends a new account, in base units (CCD and TN: 6 decimals; this CIS-2 token: none). */
export const FUND = { ccd: 40_000_000n, plt: 5_000_000n, cis2: 500n };

/** The sponsored send: what the second account is given (TN only, no CCD), and what it sends. */
export const SPONSORED = { give: 2_000_000n, send: 1_000_000n };

/** The tokens the Send step offers: the name on the page, the wallet package's token id, and decimals. */
export const TOKENS = {
  CCD: { id: null, decimals: 6 },
  TN: { id: PLT, decimals: 6 },
  'CIS-2': { id: CIS2, decimals: 0 },
};

/** "1.5" in a token with 6 decimals → 1500000n. Refuses anything that is not a plain positive amount. */
export function toBaseUnits(amount, decimals) {
  const text = String(amount ?? '').trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error('Enter the amount as a number, e.g. 1 or 0.5.');
  const [, whole, fraction = ''] = match;
  if (fraction.length > decimals) {
    throw new Error(decimals === 0 ? 'This token has no decimals: enter whole units.' : `At most ${decimals} decimals.`);
  }
  const base = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (base <= 0n) throw new Error('The amount must be more than 0.');
  return base;
}

/** Text for an amount of a token: "1.500000 CCD", "1.000000 TN", "100 units". */
export function formatAmount(token, base) {
  return token === 'CCD' ? formatCcd(base) : token === 'TN' ? formatPlt(base) : `${base} units`;
}

export const formatCcd = (micro) => `${(Number(micro) / 1e6).toFixed(6)} CCD`;
export const formatPlt = (base) => `${(Number(base) / 1e6).toFixed(6)} ${PLT}`;
export const accountLink = (address) => `https://testnet.ccdscan.io/?dcount=1&dentity=account&daddress=${address}`;
export const transactionLink = (hash) => `https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=${hash}`;

/** Errors that mean "the node or the network failed for a moment", not "the request is wrong". */
export const isTransient = (e) => e?.code === 14 /* gRPC UNAVAILABLE */ || e?.code === 4 /* DEADLINE_EXCEEDED */
  || /\b50[234]\b|unavailable|ECONNRESET|ETIMEDOUT|socket hang up|timed out/i.test(e?.message ?? '');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A READ (balances, finding an account): retried on a transient failure, up to 5 times. Never used for sending. */
export async function read(fn, { pauseMs = 2000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransient(e) || attempt === 5) throw e;
      await pause(pauseMs);
    }
  }
}

/** Send once and wait until final. A node failure after submitting may still have sent it: say so, never resend. */
export async function sendOnce(description, send) {
  try {
    return await send();
  } catch (e) {
    if (isTransient(e)) {
      throw new Error(`The testnet node failed during "${description}" (${e.message}). The transfer may have gone `
        + 'through: check the account on CCDScan before trying again.');
    }
    throw e;
  }
}

/** The wallet package's account for a path. A brand-new account can take a moment to reach the node it asks. */
export async function walletAccount(manager, path, { pauseMs = 2000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read(() => manager.getAccountByPath(path), { pauseMs });
    } catch (e) {
      if (!(e instanceof AccountNotCreatedError) || attempt === 10) throw e;
      await pause(pauseMs);
    }
  }
}

/** An account's three balances, as numbers in base units and as text for the page. */
export async function balancesOf(account) {
  const [ccd, plt, cis2] = await read(async () => [
    await account.getBalance(), await account.getTokenBalance(PLT), await account.getTokenBalance(CIS2),
  ]);
  return { ccd: String(ccd), plt: String(plt), cis2: String(cis2), text: { ccd: formatCcd(ccd), plt: formatPlt(plt), cis2: `${cis2} units` } };
}
