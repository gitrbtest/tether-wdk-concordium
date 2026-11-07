/**
 * WalletAccountConcordium
 * -------------------------------------------------------------------
 * Extends `WalletAccountReadOnly` from `@tetherto/wdk-wallet` with account
 * keys, message signing, CCD and token transfers, fee quotes, and sponsored
 * PLT transactions. Account paths identify provider, identity, and credential.
 *
 * Concordium-specific: an address only exists on-chain after identity +
 * credential onboarding, so getBalance throws AccountNotCreatedError for an
 * account that hasn't been created yet (rather than a misleading 0).
 */

import {
  WalletAccountReadOnly, NotImplementedError, InvalidTokenError, ValueError, TransferError, TransferErrorReason,
  TransactionError, TransactionErrorReason, NoSuchElementError, ProviderError, ProviderErrorReason,
} from '@tetherto/wdk-wallet';
import * as sdk from '@concordium/web-sdk';
import * as plt from '@concordium/web-sdk/plt';

export class AccountNotCreatedError extends Error {
  constructor(address, { path } = {}) {
    const account = path === undefined ? (address ?? '(derived)') : `at path "${path}"`;
    super(`Concordium account ${account} does not exist on-chain yet. ` +
          `It must be created via identity + credential onboarding first.`);
    this.name = 'AccountNotCreatedError';
    this.address = address;
    this.path = path;
  }
}

/**
 * Why a token transfer cannot happen, as checkTransfer reports it (and, later, as the transfer error says). WDK's
 * own reasons, plus Concordium's token rules:
 *   INSUFFICIENT_BALANCE        the account that pays the fee (this one, or the sponsor) holds too little CCD for it
 *   INSUFFICIENT_TOKEN_BALANCE  this account holds too little of the token
 *   INVALID_AMOUNT              the amount is not a whole number of base units above 0
 *   TOKEN_PAUSED                the token is paused: no transfers until its issuer resumes it
 *   SENDER_NOT_FOUND            this account is not on chain yet
 *   RECIPIENT_NOT_FOUND         there is no account at the recipient's address
 *   SPONSOR_NOT_FOUND           there is no account at the sponsor's address
 *   SENDER_NOT_ON_ALLOW_LIST    the token keeps an allow list, and this account is not on it
 *   RECIPIENT_NOT_ON_ALLOW_LIST the token keeps an allow list, and the recipient is not on it
 *   SENDER_ON_DENY_LIST         this account is on the token's deny list
 *   RECIPIENT_ON_DENY_LIST      the recipient is on the token's deny list
 *   CONTRACT_REFUSED            a CIS-2 token's contract would refuse the transfer (its own rules)
 * And, only when the chain itself refused a transfer that was sent (transfer, submitSponsored):
 *   OPERATION_NOT_PERMITTED     the token refused it, and its rules as they are now do not say why (the chain's own
 *                               words are in the message; e.g. the issuer changed a rule and changed it back)
 *   REJECTED                    the chain refused it for another reason (its reject reason is on the error)
 */
export const ConcordiumTransferErrorReason = Object.freeze({
  ...TransferErrorReason,
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  TOKEN_PAUSED: 'TOKEN_PAUSED',
  SENDER_NOT_FOUND: 'SENDER_NOT_FOUND',
  RECIPIENT_NOT_FOUND: 'RECIPIENT_NOT_FOUND',
  SPONSOR_NOT_FOUND: 'SPONSOR_NOT_FOUND',
  SENDER_NOT_ON_ALLOW_LIST: 'SENDER_NOT_ON_ALLOW_LIST',
  RECIPIENT_NOT_ON_ALLOW_LIST: 'RECIPIENT_NOT_ON_ALLOW_LIST',
  SENDER_ON_DENY_LIST: 'SENDER_ON_DENY_LIST',
  RECIPIENT_ON_DENY_LIST: 'RECIPIENT_ON_DENY_LIST',
  CONTRACT_REFUSED: 'CONTRACT_REFUSED',
  OPERATION_NOT_PERMITTED: 'OPERATION_NOT_PERMITTED',
  REJECTED: 'REJECTED',
});

/**
 * A token transfer that cannot happen, or that the chain refused: WDK's TransferError, with Concordium's reasons.
 *   reason        the first reason (a ConcordiumTransferErrorReason value)
 *   reasons       every reason found, each { reason, message, account? } (as checkTransfer gives them)
 *   hash          set only when the transfer was sent and the chain refused it (its fee was still charged)
 *   rejectReason  the chain's own reject reason, when it refused it
 */
export class ConcordiumTransferError extends TransferError {
  /**
   * @param {string} message
   * @param {{ reason: string, reasons?: Array<{reason: string, message: string, account?: string}>, hash?: string,
   *   rejectReason?: object, cause?: unknown }} options
   */
  constructor(message, { reason, reasons, hash, rejectReason, cause } = {}) {
    super(message, { reason, cause });
    this.name = 'ConcordiumTransferError';
    this.reasons = reasons ?? [{ reason, message }];
    this.hash = hash ?? null;
    this.rejectReason = rejectReason ?? null;
  }
}

/** The error for a transfer checkTransfer found problems with: the first problem says it, all are on `reasons`. */
function blockedTransfer(check) {
  const [first, ...more] = check.reasons;
  const message = more.length ? `${first.message} (and ${more.length} more: see reasons)` : first.message;
  return new ConcordiumTransferError(message, { reason: first.reason, reasons: check.reasons });
}

/** The standard CIS-2 refusals (the contract's reject codes), in plain words. */
const CIS2_REFUSALS = { [-42000001]: 'the token id is not known to the contract', [-42000002]: 'not enough of the token',
  [-42000003]: 'not authorised' };

/**
 * Thrown when a transaction is submitted and FINALIZES, but its on-chain outcome
 * is a rejection (e.g. insufficient balance). The transaction still has a hash
 * and cost the fee — it just didn't do what was asked. Carries the hash and the
 * SDK reject reason so callers can inspect why rather than parse a string.
 */
export class TransactionRejectedError extends Error {
  /**
   * @param {string} hash    The finalized transaction hash.
   * @param {object} [reason] The SDK RejectReason (a tagged object with a `tag`).
   */
  constructor(hash, reason) {
    super(`Transaction ${hash} finalized but was rejected (${reason?.tag ?? 'unknown reason'}).`);
    this.name = 'TransactionRejectedError';
    this.hash = hash;
    this.rejectReason = reason ?? null;
  }
}

export default class WalletAccountConcordium extends WalletAccountReadOnly {
  constructor({ wallet, getClient, getGlobal, network,
                providerIndex, identityIndex, credNumber, address }) {
    super(address);                 // base keeps the address (if known up front)
    this._sdk = sdk;                // the statically-imported @concordium/web-sdk namespace
    this._wallet = wallet;
    this._getClient = getClient;
    this._getGlobal = getGlobal;
    this._network = network;
    this._providerIndex = providerIndex;
    this._identityIndex = identityIndex;
    this._credNumber = credNumber;
    this._addr = address || null;   // subclass cache for the derived address
  }

  // ---- IWalletAccount identity ----

  /** Whether this account has been disposed. */
  get disposed() { return this._disposed === true; }

  /** Concordium path "provider/identity/cred". */
  get path() { return `${this._providerIndex}/${this._identityIndex}/${this._credNumber}`; }

  /** The account's key pair (Ed25519). */
  get keyPair() {
    return {
      publicKey: this._wallet.getAccountPublicKey(this._providerIndex, this._identityIndex, this._credNumber),
      privateKey: this._disposed ? null
        : this._wallet.getAccountSigningKey(this._providerIndex, this._identityIndex, this._credNumber),
    };
  }

  // ---- read operations ----

  /** Derive and return the Base58 account address. Overrides the base. */
  async getAddress() {
    if (this._addr) return this._addr;
    const global = await this._getGlobal();
    const onChainCommitmentKey = global?.onChainCommitmentKey ?? global?.value?.onChainCommitmentKey;
    const credId = this._wallet.getCredentialId(
      this._providerIndex, this._identityIndex, this._credNumber, { onChainCommitmentKey }
    );
    // getCredentialId returns a Buffer; getAccountAddress takes the hex string.
    this._addr = this._sdk.getAccountAddress(credId.toString('hex')).toString();
    return this._addr;
  }

  /** Native CCD balance (microCCD). Throws AccountNotCreatedError if not on-chain. */
  async getBalance() {
    return this.getBalanceForAddress(await this.getAddress());
  }

  /** Read the CCD balance of an explicit Base58 address. */
  async getBalanceForAddress(addressStr) {
    const client = await this._getClient();
    const addr = this._sdk.AccountAddress.fromBase58(addressStr);
    try {
      const info = await client.getAccountInfo(addr);
      const micro = info?.accountAmount?.microCcdAmount ?? info?.accountAmount ?? 0n;
      return BigInt(micro);
    } catch (e) {
      if (/not found/i.test(e.message || '')) throw new AccountNotCreatedError(addressStr);
      throw e;
    }
  }

  /** Returns this same instance; signing capabilities are not removed. */
  async toReadOnlyAccount() { return this; }

  /** Erase key references. */
  dispose() { this._disposed = true; this._wallet = null; }

  // ---- native CCD transfers ----

  /** Build an AccountSigner for this single-credential, single-key account. */
  _signer() {
    const keyHex = Buffer.from(
      this._wallet.getAccountSigningKey(this._providerIndex, this._identityIndex, this._credNumber)
    ).toString('hex');
    const s = this._sdk;
    return s.buildBasicAccountSigner(keyHex);
  }

  /** Build an unsigned simple-transfer transaction for { to, value(microCCD) }. */
  async _buildTransfer({ to, value }) {
    const s = this._sdk;
    const client = await this._getClient();
    const sender = s.AccountAddress.fromBase58(await this.getAddress());
    const toAddress = s.AccountAddress.fromBase58(to);
    const { nonce } = await client.getNextAccountNonce(sender);
    const amount = s.CcdAmount.fromMicroCcd(BigInt(value));
    const header = { sender, nonce, expiry: s.TransactionExpiry.futureMinutes(60) };
    return s.Transaction.transfer({ toAddress, amount }).addMetadata(header).build();
  }

  /** Sign a transfer, returning the finalized signed transaction (not broadcast). */
  async signTransaction(tx) {
    const transaction = await this._buildTransfer(tx);
    return this._sdk.Transaction.signAndFinalize(transaction, this._signer());
  }

  /**
   * Wait for a submitted transaction to finalize, then turn a rejected on-chain
   * outcome into a thrown error. Shared by every submission method so they all
   * report success and failure the same way.
   * @param {import('@concordium/web-sdk').TransactionHash.Type} hash
   * @returns {Promise<{hash: string, fee: bigint}>} On success (finalized, not rejected).
   * @throws {TransactionRejectedError} If the transaction finalizes in a rejected state.
   * @throws {Error} If the finalized outcome cannot be read.
   */
  async _awaitFinalized(hash) {
    const s = this._sdk;
    const client = await this._getClient();
    const { summary } = await client.waitForTransactionFinalization(hash);
    if (!summary) {
      throw new Error(`Could not read the finalized outcome of transaction ${hash.toString()}.`);
    }
    if (s.isRejectTransaction(summary)) {
      throw new TransactionRejectedError(hash.toString(), s.getTransactionRejectReason(summary));
    }
    return { hash: hash.toString(), fee: extractFee({ summary }) };
  }

  /**
   * Send native CCD. Accepts either a { to, value } transaction (built + signed
   * here) or an already-signed transaction. Waits for finalization and reports a
   * rejected on-chain outcome as an error rather than a normal result.
   * @returns {Promise<{hash: string, fee: bigint}>} On success (finalized, not rejected).
   * @throws {AccountNotCreatedError} If this account does not exist on-chain yet.
   * @throws {TransactionError} reason INSUFFICIENT_BALANCE (WDK's): too little CCD for the amount and the fee, found
   *   before sending (for a { to, value } request), or the chain refused it for that (then `hash` is set).
   * @throws {TransactionRejectedError} If the transaction finalizes in a rejected state for another reason.
   * @throws {Error} If the node rejects the submission (e.g. verification/nonce failure).
   */
  async sendTransaction(tx) {
    const client = await this._getClient();
    const isRequest = tx && typeof tx === 'object' && 'to' in tx && 'value' in tx;
    if (isRequest) {
      // Enough CCD for the amount and the fee? Said before anything is sent.
      const [balance, { fee }] = await Promise.all([this.getBalance(), this.quoteSendTransaction(tx)]);
      const needed = BigInt(tx.value) + fee;
      if (balance < needed) {
        throw new TransactionError(`This account holds ${units(balance, 6)} CCD; the transfer needs ${units(needed, 6)} CCD `
          + `(${units(BigInt(tx.value), 6)} plus a fee of ${units(fee, 6)}).`, { reason: TransactionErrorReason.INSUFFICIENT_BALANCE });
      }
    }
    const signed = isRequest ? await this.signTransaction(tx) : tx;

    const hash = await client.sendTransaction(signed);
    try {
      return await this._awaitFinalized(hash);
    } catch (e) {
      if (e instanceof TransactionRejectedError && e.rejectReason?.tag === 'AmountTooLarge') {
        throw Object.assign(new TransactionError('The chain refused the transfer: this account holds too little CCD for it.',
          { reason: TransactionErrorReason.INSUFFICIENT_BALANCE, cause: e }), { hash: e.hash });
      }
      throw e;
    }
  }

  /**
   * Estimate the fee of a transfer without sending, using the SDK's own cost
   * functions: getEnergyCost(type, payload) then convertEnergyToMicroCcd().
   * @returns {Promise<{fee: bigint}>} fee in microCCD
   */
  async quoteSendTransaction(tx) {
    const s = this._sdk;
    const client = await this._getClient();
    const payload = {
      toAddress: s.AccountAddress.fromBase58(tx.to),
      amount: s.CcdAmount.fromMicroCcd(BigInt(tx.value)),
    };
    const energy = s.getEnergyCost(s.AccountTransactionType.Transfer, payload, 1n);
    const chainParams = (await client.getBlockChainParameters());
    const feeAmount = s.convertEnergyToMicroCcd(energy, chainParams?.value ?? chainParams);
    const fee = BigInt(feeAmount?.microCcdAmount ?? feeAmount?.value ?? feeAmount);
    return { fee };
  }

  /** Sign an arbitrary message (Ed25519). */
  async sign(message) {
    const s = this._sdk;
    const sender = s.AccountAddress.fromBase58(await this.getAddress());
    const sig = await s.signMessage(sender, message, this._signer());
    return JSON.stringify(sig);
  }

  /** Verify a message signature produced by sign(). */
  async verify(message, signature) {
    const s = this._sdk;
    const sender = s.AccountAddress.fromBase58(await this.getAddress());
    const info = await (await this._getClient()).getAccountInfo(sender);
    return s.verifyMessageSignature(message, JSON.parse(signature), info);
  }

  // ---- transaction status (WDK's standard receipt) ----
  //
  // WDK describes every chain's transactions in the same words, so a wallet app handles them all alike; these
  // translate Concordium's. The node says a transaction is received (waiting for a block), committed (in a block, not
  // final yet: blocks can still be reorganised for a few seconds) or finalized (for good). WDK's words:
  //   received, committed   →  'pending'  (WDK's 'confirmed' means "reversible only under extreme conditions", which
  //                                        committed is not; Concordium is final within seconds anyway)
  //   finalized              →  'final', with success (false if the chain rejected it), fee and block
  //   not known to the node  →  NoSuchElementError, as WDK specifies for an unknown hash
  // WDK's 'dropped' has no Concordium counterpart: a transaction that never lands (it expired before reaching a block)
  // just stops being known. waitForTransaction then ends with WDK's TimeoutError.

  /**
   * How often waitForTransaction asks (ms): Concordium makes a block about every 2 seconds, and is final within
   * seconds. The time budget stays WDK's (60 s, defaultWaitTimeout).
   */
  get defaultWaitInterval() { return 2000; }

  /**
   * A transaction's status, as WDK's standard receipt (WDK's waitForTransaction builds on it).
   * @param {string} hash  the transaction's hash (hex)
   * @returns {Promise<{hash: string, finality: 'pending' | 'final', success?: boolean, block?: number, fee?: bigint,
   *   blockHash?: string}>}  once final: `success` (false if rejected), `fee` (microCCD; for a sponsored transaction,
   *   what the sponsor paid), `block` (the block's height) and `blockHash` (Concordium's own block reference)
   * @throws {NoSuchElementError} If the node does not know the transaction.
   * @throws {ProviderError} If the node could not be asked (waitForTransaction tries again, up to 3 times in a row).
   * @throws {ValueError} If `hash` is not a transaction hash.
   */
  async getTransaction(hash) {
    const s = this._sdk;
    let transactionHash;
    try { transactionHash = s.TransactionHash.fromHexString(hash); } catch {
      throw new ValueError('hash must be a transaction hash (64 hex characters).');
    }
    const client = await this._getClient();
    const askNode = async (question) => {
      try {
        return await question();
      } catch (e) {
        if (isNotFound(e)) throw new NoSuchElementError(`The node does not know transaction ${hash}.`);
        throw new ProviderError(`The node could not be asked: ${e?.message ?? e}`, { reason: ProviderErrorReason.NETWORK_ERROR, cause: e });
      }
    };
    const status = await askNode(() => client.getBlockItemStatus(transactionHash));
    if (status?.status === 'received' || status?.status === 'committed') return { hash, finality: 'pending' };
    if (status?.status !== 'finalized') {
      throw new ProviderError(`The node gave an unexpected status: ${JSON.stringify(status?.status)}.`, { reason: ProviderErrorReason.INTERNAL_SERVER_ERROR });
    }
    const { blockHash, summary } = status.outcome;
    const info = await askNode(() => client.getBlockInfo(blockHash));
    return {
      hash,
      finality: 'final',
      success: !s.isRejectTransaction(summary),
      block: Number(info.blockHeight),
      fee: feePaid(summary),
      blockHash: s.BlockHash.toHexString(blockHash),
    };
  }

  async getTransactionReceipt(hash) {
    const s = this._sdk;
    const client = await this._getClient();
    const h = s.TransactionHash.fromHexString(hash);
    try { return (await client.getBlockItemStatus(h)) ?? null; }
    catch { return null; }
  }

  // ---- token operations (PLT and CIS-2) ----
  //
  // Token identifier convention (the WDK `tokenAddress` / `token` string):
  //   PLT:    "USDT"  or  "plt:USDT"            (a protocol-level token symbol)
  //   CIS-2:  "cis2:<index>:<subindex>:<tokenIdHex>"   e.g. "cis2:1234:0:" or
  //           "cis2:1234:0:01"  (tokenIdHex may be empty for single-token contracts)
  // All amounts are in the token's base units (integer bigint).

  /** Balance of a PLT or CIS-2 token for this account, in base units. */
  async getTokenBalance(tokenAddress) {
    const ref = parseTokenRef(tokenAddress);
    return ref.kind === 'cis2' ? this._cis2Balance(ref) : this._pltBalance(ref);
  }

  /**
   * Transfer a PLT or CIS-2 token. amount is in base units.
   *
   * Checked first, as checkTransfer checks it: if anything would refuse it (a paused token, a list, the balance, the
   * fee…), nothing is sent and ConcordiumTransferError lists every reason. If the chain refuses it after all (its
   * rules changed in the moment between the check and the transfer), the error says why in the same reasons, with
   * the transaction's hash (its fee was charged).
   * @returns {Promise<{hash: string, fee: bigint}>} On success (finalized, not rejected).
   * @throws {ConcordiumTransferError} If the transfer cannot happen (nothing sent), or the chain refused it (`hash` set).
   * @throws {InvalidTokenError} If there is no such PLT on this network.
   * @throws {ValueError} If the recipient is not an account address.
   * @throws {Error} If the node cannot be asked, or rejects the submission itself.
   */
  async transfer({ token, recipient, amount }) {
    const check = await this.checkTransfer({ token, recipient, amount });
    if (!check.ok) throw blockedTransfer(check);
    const ref = parseTokenRef(token);
    try {
      return ref.kind === 'cis2'
        ? await this._cis2Transfer(ref, recipient, BigInt(amount))
        : await this._pltTransfer(ref, recipient, BigInt(amount));
    } catch (e) {
      throw await this._explainRefusal(e, { sender: await this.getAddress(), token: ref.kind === 'plt' ? ref.symbol : undefined });
    }
  }

  /**
   * Turn a refusal into ConcordiumTransferError, in checkTransfer's reasons: the chain's (a TransactionRejectedError),
   * or the SDK's own check just before sending (its token errors: the rules changed after our check). Anything else
   * is returned as it is. When the token "does not permit" it, the token's rules as they are now say why: paused,
   * or the account the chain names (the sender or the recipient) on its deny list, or not on its allow list.
   * @param {unknown} e
   * @param {{ sender: string, token?: string }} transfer  the transfer's sender (this account, or a sponsored
   *   transaction's sender) and, when known, the PLT's name (the SDK's own errors do not all carry it)
   */
  async _explainRefusal(e, { sender, token }) {
    const R = ConcordiumTransferErrorReason;
    const refused = (reason, message, account, { hash, rejectReason } = {}) => {
      const said = hash ? `The chain refused the transfer: ${message}` : message;
      return new ConcordiumTransferError(said, { reason, reasons: [{ reason, message, ...(account ? { account } : {}) }], hash, rejectReason, cause: e });
    };
    /** Why the token does not permit it, from its rules now; null if they do not say. */
    const whyNotPermitted = async (tokenName, named) => {
      try {
        if ((await this.getTokenRules(tokenName)).paused) return [R.TOKEN_PAUSED, `${tokenName} is paused.`, undefined];
        if (!named) return null;
        const party = named === sender ? 'SENDER' : 'RECIPIENT';
        const who = party === 'SENDER' ? 'The sending account' : 'The recipient';
        const standing = await this.getTokenAccountStatus(tokenName, named);
        if (standing.onDenyList === true) return [R[`${party}_ON_DENY_LIST`], `${who} is on ${tokenName}'s deny list.`, named];
        if (standing.onAllowList === false) return [R[`${party}_NOT_ON_ALLOW_LIST`], `${who} is not on ${tokenName}'s allow list.`, named];
      } catch { /* the rules could not be read: say what the chain said */ }
      return null;
    };

    // The SDK's own check just before sending (plt.Token.transfer validates): nothing was sent.
    if (e instanceof plt.Token.PausedError) return refused(R.TOKEN_PAUSED, `${e.tokenId} is paused: no transfers are possible until its issuer resumes it.`);
    if (e instanceof plt.Token.InsufficientFundsError) return refused(R.INSUFFICIENT_TOKEN_BALANCE, 'This account holds too little of the token.', sender);
    if (e instanceof plt.Token.NotAllowedError) {
      const named = e.receiver?.address ?? String(e.receiver);
      const why = token ? await whyNotPermitted(token, named) : null;
      return why ? refused(...why) : refused(R.OPERATION_NOT_PERMITTED, e.message, named);
    }

    if (!(e instanceof TransactionRejectedError)) return e;
    const chain = { hash: e.hash, rejectReason: e.rejectReason };
    const rr = e.rejectReason;
    if (rr?.tag === 'TokenUpdateTransactionFailed') {
      const tokenName = rr.contents?.tokenId?.value ?? String(rr.contents?.tokenId ?? '');
      let decoded;
      try { decoded = plt.parseTokenModuleRejectReason(rr.contents); } catch { decoded = rr.contents; }
      const named = decoded?.details?.address ? String(decoded.details.address.address ?? decoded.details.address) : undefined;
      switch (decoded?.type) {
        case 'tokenBalanceInsufficient':
          return refused(R.INSUFFICIENT_TOKEN_BALANCE, `the sending account holds too little ${tokenName}.`, sender, chain);
        case 'addressNotFound':
          return named === sender
            ? refused(R.SENDER_NOT_FOUND, 'the sending account is not on chain.', named, chain)
            : refused(R.RECIPIENT_NOT_FOUND, 'there is no account at the recipient\'s address.', named, chain);
        case 'operationNotPermitted': {
          const why = await whyNotPermitted(tokenName, named);
          if (why) return refused(why[0], why[1].replace(/^./, (c) => c.toLowerCase()), why[2], chain);
          return refused(R.OPERATION_NOT_PERMITTED, `${tokenName} does not permit it${named ? ` for ${named}` : ''}`
            + `${decoded.details?.reason ? ` ("${decoded.details.reason}")` : ''}.`, named, chain);
        }
        default:
          return refused(R.REJECTED, `${tokenName} refused it (${decoded?.type ?? 'unknown'}).`, undefined, chain);
      }
    }
    if (rr?.tag === 'RejectedReceive') {
      const why = CIS2_REFUSALS[Number(rr.rejectReason)] ?? `code ${rr.rejectReason}`;
      return refused(R.CONTRACT_REFUSED, `the token's contract refused it: ${why}.`, undefined, chain);
    }
    if (rr?.tag === 'AmountTooLarge') return refused(R.INSUFFICIENT_BALANCE, 'the paying account holds too little CCD.', undefined, chain);
    return refused(R.REJECTED, `it was rejected (${rr?.tag ?? 'unknown reason'}).`, undefined, chain);
  }

  /** Estimate the fee of a PLT or CIS-2 token transfer. */
  async quoteTransfer({ token, recipient, amount }) {
    const ref = parseTokenRef(token);
    return ref.kind === 'cis2'
      ? this._cis2QuoteTransfer(ref, recipient, BigInt(amount))
      : this._pltQuoteTransfer(ref, recipient, BigInt(amount));
  }

  /**
   * Read a CIS-2 token's descriptive metadata (name, symbol, decimals, ...).
   * Per the CIS-2 standard the contract stores only a metadata *URL* on-chain;
   * the human-readable fields live in the JSON document at that URL. Tokens are
   * identified by (contract, tokenId), not by their potentially shared name or symbol.
   * @param {string} tokenAddress  a "cis2:<index>:<subindex>:<tokenIdHex>" ref
   * @returns {Promise<{url: string, metadata: object | null}>}
   */
  async getCis2Metadata(tokenAddress) {
    const ref = parseTokenRef(tokenAddress);
    if (ref.kind !== 'cis2') {
      throw new NotImplementedError('getCis2Metadata: only CIS-2 tokens carry an on-chain metadata URL.');
    }
    const contract = await this._cis2Contract(ref);
    const { url } = await contract.tokenMetadata(ref.tokenId);
    let metadata = null;
    try { metadata = await (await fetch(url)).json(); } catch { /* url unreachable / not JSON */ }
    return { url, metadata };
  }

  // ---- token rules (regulated tokens) ----
  //
  // Protocol-level tokens (PLTs) can restrict who may hold or move them: a token may keep an allow list (only accounts
  // on it may send or receive), a deny list (accounts on it may not), and may be paused (no transfers at all). These
  // reads let a wallet see the rules before it offers a transfer, rather than finding out when it fails. CIS-2 tokens
  // have no standard rules: their smart contract decides when a transfer is made, so their rules read as null
  // ("not known").

  /**
   * A token's rules, as the chain holds them now.
   * @param {string} tokenAddress  a PLT ("UPEU" or "plt:UPEU") or a CIS-2 token ("cis2:<index>:<subindex>:<tokenIdHex>")
   * @returns {Promise<{kind: 'plt' | 'cis2', token: string, name: string | null, decimals: number | null,
   *   totalSupply: bigint | null, paused: boolean | null, allowList: boolean | null, denyList: boolean | null,
   *   mintable: boolean | null, burnable: boolean | null, governanceAccount: string | null, metadataUrl: string | null}>}
   *   For a PLT: `allowList` / `denyList` say whether the token keeps such a list; `governanceAccount` is the account
   *   that manages the token (its lists, pausing). For a CIS-2 token every rule is null.
   * @throws {InvalidTokenError} If there is no such PLT on this network.
   */
  async getTokenRules(tokenAddress) {
    const ref = parseTokenRef(tokenAddress);
    if (ref.kind === 'cis2') {
      return {
        kind: 'cis2', token: String(tokenAddress).trim(), name: null, decimals: null, totalSupply: null,
        paused: null, allowList: null, denyList: null, mintable: null, burnable: null, governanceAccount: null, metadataUrl: null,
      };
    }
    const tok = await this._pltToken(ref);
    const m = tok.moduleState ?? {};
    const governance = m.governanceAccount?.address ?? m.governanceAccount;
    return {
      kind: 'plt',
      token: tok.info.id.value,
      name: m.name ?? null,
      decimals: tokenDecimals(tok) ?? null,
      totalSupply: tok.info.state?.totalSupply ? BigInt(tok.info.state.totalSupply.value) : null,
      paused: m.paused === true,
      allowList: m.allowList === true,
      denyList: m.denyList === true,
      mintable: m.mintable === true,
      burnable: m.burnable === true,
      governanceAccount: governance ? governance.toString() : null,
      metadataUrl: m.metadata?.url ?? null,
    };
  }

  /**
   * One account's standing with a token: whether it is on chain, its balance, and whether it is on the token's
   * allow list and deny list.
   * @param {string} tokenAddress  a PLT or a CIS-2 token (as getTokenRules)
   * @param {string} [address]  the account (Base58); default: this account
   * @returns {Promise<{token: string, address: string, exists: boolean, balance: bigint,
   *   onAllowList: boolean | null, onDenyList: boolean | null}>}  `onAllowList` / `onDenyList` are null when the token
   *   keeps no such list (and for CIS-2 tokens); an account not on chain has `exists: false` and a balance of 0
   * @throws {InvalidTokenError} If there is no such PLT on this network.
   */
  async getTokenAccountStatus(tokenAddress, address) {
    const s = this._sdk;
    const who = address ?? await this.getAddress();
    const accountAddress = s.AccountAddress.fromBase58(who);
    const ref = parseTokenRef(tokenAddress);
    if (ref.kind === 'cis2') {
      const exists = await this._accountExists(accountAddress);
      const contract = await this._cis2Contract(ref);
      const balance = exists ? BigInt(await contract.balanceOf({ tokenId: ref.tokenId, address: accountAddress })) : 0n;
      return { token: String(tokenAddress).trim(), address: who, exists, balance, onAllowList: null, onDenyList: null };
    }
    return this._pltStanding(await this._pltToken(ref), who);
  }

  /** An account's standing with a PLT already read (see getTokenAccountStatus), plus its CCD balance (`ccd`). */
  async _pltStanding(tok, who) {
    const m = tok.moduleState ?? {};
    const client = await this._getClient();
    let info;
    try {
      info = await client.getAccountInfo(this._sdk.AccountAddress.fromBase58(who));
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    // The account's entry for this token (none if it never held it); its module state holds its list memberships.
    const entry = info?.accountTokens?.find((t) => t.id.value === tok.info.id.value);
    const memberships = entry?.state?.moduleState ? plt.Cbor.decode(entry.state.moduleState, 'TokenModuleAccountState') : {};
    const standing = {
      token: tok.info.id.value,
      address: who,
      exists: info !== undefined,
      balance: entry ? BigInt(entry.state.balance.value) : 0n,
      onAllowList: m.allowList === true ? memberships.allowList === true : null,
      onDenyList: m.denyList === true ? memberships.denyList === true : null,
    };
    Object.defineProperty(standing, 'ccd', { value: info ? BigInt(info.accountAmount?.microCcdAmount ?? 0n) : 0n });
    return standing;
  }

  /**
   * Check a token transfer before sending it: every reason it would be refused, for this account (the sender), the
   * recipient and the token, with nothing sent and no fee spent. A wallet can show the reasons, or disable "Send".
   *
   * For a protocol-level token (PLT): paused? the amount? this account on chain, holding enough? the recipient on
   * chain? both allowed by the token's allow list and deny list? For a CIS-2 token (no standard rules): the accounts,
   * the balance, and a dry run of the transfer, which shows whether the token's contract would refuse it. In both
   * cases: the fee, and whether the account that pays it (this one, or the sponsor) holds enough CCD.
   *
   * The rules can change between this check and the transfer (an issuer pauses the token, or changes a list): the
   * transfer then fails on chain with a reason, as transfer reports it.
   *
   * @param {object} options
   * @param {string} options.token  a PLT ("UPEU") or a CIS-2 token ("cis2:<index>:<subindex>:<tokenIdHex>")
   * @param {string} options.recipient  the recipient's address (Base58)
   * @param {number | bigint | string} options.amount  in the token's base units
   * @param {string} [options.sponsorAddress]  for a sponsored transfer: the sponsor pays the fee
   * @returns {Promise<{ok: boolean, reasons: Array<{reason: string, message: string, account?: string}>, fee: bigint | null}>}
   *   `reasons`: ConcordiumTransferErrorReason values, each with a plain message (and the account it concerns);
   *   `fee`: the fee in microCCD, when it could be worked out
   * @throws {InvalidTokenError} If there is no such PLT on this network.
   * @throws {ValueError} If the recipient (or the sponsor) is not an account address.
   */
  async checkTransfer({ token, recipient, amount, sponsorAddress } = {}) {
    const R = ConcordiumTransferErrorReason;
    const reasons = [];
    const add = (reason, message, account) => reasons.push({ reason, message, ...(account ? { account } : {}) });
    for (const [what, address] of [['recipient', recipient], ['sponsorAddress', sponsorAddress]]) {
      if (what === 'sponsorAddress' && address === undefined) continue;
      try { this._sdk.AccountAddress.fromBase58(address); } catch { throw new ValueError(`${what} must be an account address (Base58).`); }
    }
    let value = null;
    try { value = BigInt(amount); } catch { /* reported below */ }
    if (value === null || value <= 0n) add(R.INVALID_AMOUNT, 'The amount must be a whole number of the token\'s base units, above 0.');

    const sender = await this.getAddress();
    const ref = parseTokenRef(token);
    let payerCcd;            // the CCD of the account that pays the fee, when read on the way
    let canQuote = value !== null && value > 0n;
    if (ref.kind === 'plt') {
      const tok = await this._pltToken(ref);
      const m = tok.moduleState ?? {};
      const name = tok.info.id.value;
      const decimals = tokenDecimals(tok) ?? 0;
      if (m.paused === true) add(R.TOKEN_PAUSED, `${name} is paused: no transfers are possible until its issuer resumes it.`);
      const [from, to] = await Promise.all([this._pltStanding(tok, sender), this._pltStanding(tok, recipient)]);
      if (!from.exists) {
        add(R.SENDER_NOT_FOUND, 'This account is not on chain yet.', sender);
        canQuote = false;
      } else if (value !== null && value > 0n && from.balance < value) {
        add(R.INSUFFICIENT_TOKEN_BALANCE, `This account holds ${units(from.balance, decimals)} ${name}; ${units(value, decimals)} is needed.`, sender);
      }
      if (!to.exists) add(R.RECIPIENT_NOT_FOUND, 'There is no account at the recipient\'s address.', recipient);
      for (const [party, standing, address] of [['SENDER', from, sender], ['RECIPIENT', to, recipient]]) {
        if (!standing.exists) continue;
        const who = party === 'SENDER' ? 'This account' : 'The recipient';
        if (standing.onDenyList === true) add(R[`${party}_ON_DENY_LIST`], `${who} is on ${name}'s deny list.`, address);
        if (standing.onAllowList === false) add(R[`${party}_NOT_ON_ALLOW_LIST`], `${who} is not on ${name}'s allow list.`, address);
      }
      if (!sponsorAddress) payerCcd = from.exists ? from.ccd : undefined;
    } else {
      const s = this._sdk;
      const [fromExists, toExists] = await Promise.all([
        this._accountExists(s.AccountAddress.fromBase58(sender)), this._accountExists(s.AccountAddress.fromBase58(recipient))]);
      if (!fromExists) add(R.SENDER_NOT_FOUND, 'This account is not on chain yet.', sender);
      if (!toExists) add(R.RECIPIENT_NOT_FOUND, 'There is no account at the recipient\'s address.', recipient);
      canQuote = canQuote && fromExists && toExists;
      if (canQuote) {
        const contract = await this._cis2Contract(ref);
        const balance = BigInt(await contract.balanceOf({ tokenId: ref.tokenId, address: s.AccountAddress.fromBase58(sender) }));
        if (balance < value) {
          add(R.INSUFFICIENT_TOKEN_BALANCE, `This account holds ${balance} of the token (base units); ${value} is needed.`, sender);
          canQuote = false;
        } else {
          const transfer = { tokenId: ref.tokenId, tokenAmount: value, from: s.AccountAddress.fromBase58(sender), to: s.AccountAddress.fromBase58(recipient) };
          const dry = await contract.dryRun.transfer(transfer.from, transfer);
          if (dry?.tag && dry.tag !== 'success') {
            const code = dry?.reason?.rejectReason ?? dry?.returnValue;
            const why = CIS2_REFUSALS[Number(code)] ?? dry?.reason?.tag ?? 'see the node';
            add(R.CONTRACT_REFUSED, `The token's contract would refuse this transfer: ${why}.`);
            canQuote = false;
          }
        }
      }
    }

    // The fee, and whether the account that pays it holds enough CCD.
    let fee = null;
    if (canQuote && !reasons.some((r) => r.reason === R.RECIPIENT_NOT_FOUND)) {
      ({ fee } = await this.quoteTransfer({ token, recipient, amount: value }));
      const payer = sponsorAddress ?? sender;
      if (payerCcd === undefined) {
        try {
          payerCcd = await this.getBalanceForAddress(payer);
        } catch (e) {
          if (!(e instanceof AccountNotCreatedError)) throw e;
          if (sponsorAddress) add(R.SPONSOR_NOT_FOUND, 'There is no account at the sponsor\'s address.', sponsorAddress);
        }
      }
      if (payerCcd !== undefined && payerCcd < fee) {
        const who = sponsorAddress ? 'The sponsor' : 'This account';
        add(R.INSUFFICIENT_BALANCE, `${who} pays the fee of ${units(fee, 6)} CCD but holds ${units(payerCcd, 6)} CCD.`, payer);
      }
    }
    return { ok: reasons.length === 0, reasons, fee };
  }

  /** The PLT a reference names, read from the chain; InvalidTokenError if this network has none by that name. */
  async _pltToken(ref) {
    const client = await this._getClient();
    try {
      return await plt.Token.fromId(client, plt.TokenId.fromString(ref.symbol));
    } catch (e) {
      if (isNotFound(e)) throw new InvalidTokenError(`There is no protocol-level token "${ref.symbol}" on this network.`);
      throw e;
    }
  }

  /** Whether an account exists on chain (the node answers "not found" for one that does not). */
  async _accountExists(accountAddress) {
    try {
      await (await this._getClient()).getAccountInfo(accountAddress);
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  // ---- PLT (protocol-level token) ----

  async _pltBalance(ref) {
    const s = this._sdk;
    const client = await this._getClient();
    const token = await plt.Token.fromId(client, plt.TokenId.fromString(ref.symbol));
    const addr = s.AccountAddress.fromBase58(await this.getAddress());
    const bal = await plt.Token.balanceOf(token, addr);
    return bal ? BigInt(bal.value) : 0n;
  }

  async _pltTransfer(ref, recipient, amount) {
    const s = this._sdk;
    const client = await this._getClient();
    const tok = await plt.Token.fromId(client, plt.TokenId.fromString(ref.symbol));
    const sender = s.AccountAddress.fromBase58(await this.getAddress());
    const recip = s.AccountAddress.fromBase58(recipient);
    const decimals = tokenDecimals(tok);
    if (decimals == null) {
      throw new Error('transfer: could not determine PLT decimals. token.info keys = [' +
        Object.keys(tok?.info || {}).join(', ') + ']');
    }
    const amt = plt.TokenAmount.create(amount, decimals);   // base units, no scaling
    const hash = await plt.Token.transfer(
      tok, sender, { recipient: recip, amount: amt }, this._signer(),
      undefined, { autoScale: false, validate: true }
    );
    return this._awaitFinalized(hash);
  }

  async _pltQuoteTransfer(ref, recipient, amount) {
    const s = this._sdk;
    const client = await this._getClient();
    const tok = await plt.Token.fromId(client, plt.TokenId.fromString(ref.symbol));
    const decimals = tokenDecimals(tok);
    if (decimals == null) throw new Error('quoteTransfer: could not determine PLT decimals.');
    const amt = plt.TokenAmount.create(amount, decimals);
    const op = { transfer: { recipient: plt.CborAccountAddress.fromAccountAddress(s.AccountAddress.fromBase58(recipient)), amount: amt } };
    const payload = plt.createTokenUpdatePayload(plt.TokenId.fromString(ref.symbol), op);
    const energy = s.getEnergyCost(s.AccountTransactionType.TokenUpdate, payload, 1n);
    const cp = await client.getBlockChainParameters();
    const feeAmount = s.convertEnergyToMicroCcd(energy, cp?.value ?? cp);
    return { fee: BigInt(feeAmount?.microCcdAmount ?? feeAmount?.value ?? feeAmount) };
  }

  // ---- CIS-2 (smart-contract token) ----

  async _cis2Contract(ref) {
    const s = this._sdk;
    const client = await this._getClient();
    const addr = s.ContractAddress.create(ref.index, ref.subindex);
    // The main SDK re-exports CIS2Contract (export * from './pub/cis2.js'), so no
    // separate '@concordium/web-sdk/cis2' import is needed.
    return s.CIS2Contract.create(client, addr);
  }

  async _cis2Balance(ref) {
    const s = this._sdk;
    const contract = await this._cis2Contract(ref);
    const address = s.AccountAddress.fromBase58(await this.getAddress());
    const bal = await contract.balanceOf({ tokenId: ref.tokenId, address });
    return BigInt(bal);
  }

  async _cis2Transfer(ref, recipient, amount) {
    const s = this._sdk;
    const contract = await this._cis2Contract(ref);
    const from = s.AccountAddress.fromBase58(await this.getAddress());
    const to = s.AccountAddress.fromBase58(recipient);
    const transfer = { tokenId: ref.tokenId, tokenAmount: amount, from, to };
    const energy = await this._cis2Energy(contract, from, transfer);
    const hash = await contract.transfer({ senderAddress: from, energy }, transfer, this._signer());
    return this._awaitFinalized(hash);
  }

  /** Dry-run a CIS-2 transfer to size the max execution energy (+20% headroom). */
  async _cis2Energy(contract, from, transfer) {
    const s = this._sdk;
    const dry = await contract.dryRun.transfer(from, transfer);
    if (dry?.tag && dry.tag !== 'success') {
      throw new Error('CIS-2 transfer dry-run failed: ' + (dry?.reason?.tag ?? JSON.stringify(dry).slice(0, 140)));
    }
    const usedVal = BigInt(dry?.usedEnergy?.value ?? dry?.usedEnergy ?? 0n);
    const buffered = (usedVal * 12n) / 10n;
    return s.Energy.create(buffered);
  }

  async _cis2QuoteTransfer(ref, recipient, amount) {
    const s = this._sdk;
    const client = await this._getClient();
    const contract = await this._cis2Contract(ref);
    const from = s.AccountAddress.fromBase58(await this.getAddress());
    const to = s.AccountAddress.fromBase58(recipient);
    const transfer = { tokenId: ref.tokenId, tokenAmount: amount, from, to };

    // The dry-run reports only the contract EXECUTION energy — not the base
    // transaction cost (header + signature + payload size) that is also charged.
    const dry = await contract.dryRun.transfer(from, transfer);
    if (dry?.tag && dry.tag !== 'success') {
      throw new Error('CIS-2 quote dry-run failed: ' + (dry?.reason?.tag ?? 'see node'));
    }
    const cp = await client.getBlockChainParameters();

    // Build the same Update transaction (declared energy = the used energy) and
    // price it with getEnergyCost, which adds the base cost. This makes the quote
    // equal what the node actually charges (base + execution), matching the PLT
    // path. Fall back to execution-only if this SDK build lacks the helpers.
    let energy = dry.usedEnergy;
    try {
      const tx = contract.createTransfer({ energy: dry.usedEnergy }, transfer);
      energy = s.getEnergyCost(s.AccountTransactionType.Update, tx.payload, 1n);
    } catch { /* older SDK: keep execution-only estimate */ }

    const feeAmount = s.convertEnergyToMicroCcd(energy, cp?.value ?? cp);
    return { fee: BigInt(feeAmount?.microCcdAmount ?? feeAmount?.value ?? feeAmount) };
  }

  // ---- sponsored transactions ----
  //
  // Concordium-specific; beyond the standard WDK interface. Lets a token holder
  // spend WITHOUT holding CCD: a separate sponsor account co-signs and pays the
  // fee. A sponsored transaction carries TWO signatures — the account (sender)
  // and the sponsor — and EITHER may sign first. That gives FOUR signing
  // scenarios, all supported here, with signing SEPARATED from submission:
  //
  //   buildSponsorableTransfer(...)   -> unsigned signable (sender metadata + sponsor set)
  //   1. signAsAccountToBeSponsored() account signs first -> awaiting sponsor
  //   2. signAsAccountPreSponsored()  account signs after -> complete
  //   3. signAsSponsorToBeSigned()    sponsor signs first -> awaiting account
  //   4. signAsSponsorSigned()        sponsor signs after -> complete
  //   submitSponsored(...)            broadcast a fully-signed transaction
  //
  //   Order "sponsor first":  build -> (3) -> (2) -> submit
  //   Order "account first":  build -> (1) -> (4) -> submit
  //
  // The sender builds (it owns the nonce and is told the sponsor address). Each
  // sign method only ADDS a signature and returns JSON; submit finalizes + sends.

  /**
   * SENDER builds the unsigned sponsorable PLT transfer: payload + sender
   * metadata (this account, nonce, expiry) + the sponsor address. No signatures.
   * @param {{token:string, recipient:string, amount:number|bigint, sponsorAddress:string}} o
   * @returns {Promise<object>} a Transaction.JSON signable object
   */
  async buildSponsorableTransfer({ token, recipient, amount, sponsorAddress }) {
    const ref = parseTokenRef(token);
    if (ref.kind !== 'plt') {
      throw new NotImplementedError('Sponsored transfers currently target PLT tokens (the stablecoin case).');
    }
    // Checked first, with the sponsor as the payer of the fee: nothing is built for a transfer that cannot happen.
    const check = await this.checkTransfer({ token, recipient, amount, sponsorAddress });
    if (!check.ok) throw blockedTransfer(check);
    const s = this._sdk;
    const client = await this._getClient();
    const tok = await plt.Token.fromId(client, plt.TokenId.fromString(ref.symbol));
    const decimals = tokenDecimals(tok);
    if (decimals == null) throw new Error('buildSponsorableTransfer: could not determine PLT decimals.');
    const amt = plt.TokenAmount.create(BigInt(amount), decimals);
    const op = { transfer: { recipient: plt.CborAccountAddress.fromAccountAddress(s.AccountAddress.fromBase58(recipient)), amount: amt } };
    const payload = plt.createTokenUpdatePayload(plt.TokenId.fromString(ref.symbol), op);
    const sender = s.AccountAddress.fromBase58(await this.getAddress());
    const { nonce } = await client.getNextAccountNonce(sender);
    const signable = s.Transaction.tokenUpdate(payload)
      .addMetadata({ sender, nonce, expiry: s.TransactionExpiry.futureMinutes(30) })
      .addSponsor(s.AccountAddress.fromBase58(sponsorAddress))
      .build();
    return s.Transaction.toJSON(signable);
  }

  /** Scenario 1 — account signs first; result still awaits the sponsor. */
  async signAsAccountToBeSponsored(transactionJson) {
    return this._addAccountSignature(transactionJson);
  }

  /** Scenario 2 — account signs a sponsor-signed transaction; result is complete. */
  async signAsAccountPreSponsored(sponsorSignedJson) {
    return this._addAccountSignature(sponsorSignedJson);
  }

  /** Scenario 3 — sponsor signs first; result still awaits the account. */
  async signAsSponsorToBeSigned(transactionJson) {
    return this._addSponsorSignature(transactionJson);
  }

  /** Scenario 4 — sponsor signs an account-signed transaction; result is complete. */
  async signAsSponsorSigned(accountSignedJson) {
    return this._addSponsorSignature(accountSignedJson);
  }

  /**
   * Broadcast a fully-signed sponsored transaction (both signatures present).
   * @returns {Promise<{hash: string, fee: bigint}>} On success (finalized, not rejected).
   * @throws {TransactionRejectedError} If the transaction finalizes in a rejected state.
   * @throws {Error} If the node rejects the submission.
   */
  async submitSponsored(fullySignedJson) {
    const s = this._sdk;
    const client = await this._getClient();
    const signable = s.Transaction.signableFromJSON(fullySignedJson);
    const finalized = s.Transaction.finalize(signable);
    const hash = await client.sendTransaction(finalized);
    try {
      return await this._awaitFinalized(hash);
    } catch (e) {
      // The chain refused it: say why, in checkTransfer's reasons (the sender is the transaction's, not necessarily us).
      throw await this._explainRefusal(e, { sender: String(signable.header.sender.address ?? signable.header.sender) });
    }
  }

  // -- internal: add one signature (account or sponsor) to a signable JSON --
  async _addAccountSignature(json) {
    const s = this._sdk;
    const signed = await s.Transaction.sign(s.Transaction.signableFromJSON(json), this._signer());
    return s.Transaction.toJSON(signed);
  }

  async _addSponsorSignature(json) {
    const s = this._sdk;
    const sponsored = await s.Transaction.sponsor(s.Transaction.signableFromJSON(json), this._signer());
    return s.Transaction.toJSON(sponsored);
  }
}

/** Classify a token identifier string as PLT or CIS-2 (see convention above). */
export function parseTokenRef(ref) {
  const str = String(ref).trim();
  if (str.toLowerCase().startsWith('cis2:')) {
    const parts = str.split(':');            // ["cis2", index, subindex, ...idParts]
    return {
      kind: 'cis2',
      index: BigInt(parts[1]),
      subindex: BigInt(parts[2] ?? '0'),
      tokenId: parts.slice(3).join(':'),     // may be "" for single-token contracts
    };
  }
  const symbol = str.toLowerCase().startsWith('plt:') ? str.slice(4) : str;
  return { kind: 'plt', symbol };
}

/** The fee a final transaction cost, in microCCD: for a sponsored one, what the sponsor paid (the sender pays 0). */
function feePaid(summary) {
  const cost = summary?.sponsor?.cost ?? summary?.cost;
  try { return BigInt(cost?.microCcdAmount ?? cost ?? 0n); } catch { return 0n; }
}

/** An amount in base units as a decimal number for people, e.g. units(1500000n, 6) = '1.5'. */
function units(value, decimals) {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = decimals ? digits.slice(0, -decimals) : digits;
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** The node's "not found" answer (gRPC NOT_FOUND, or its message): no such account, token or transaction. */
function isNotFound(e) {
  return e?.code === 'NOT_FOUND' || e?.code === 5 || /not found/i.test(e?.message ?? '');
}

/** Best-effort lookup of a PLT's decimals from the Token instance. */
function tokenDecimals(tok) {
  return tok?.info?.decimals
    ?? tok?.info?.state?.decimals
    ?? tok?.moduleState?.decimals
    ?? tok?.info?.moduleState?.decimals;
}

/** Pull the fee (microCCD bigint) out of a finalized transaction status. */
function extractFee(status) {
  const cost = status?.summary?.cost ?? status?.cost ?? status?.summary?.energyCost;
  try { return BigInt(cost?.microCcdAmount ?? cost ?? 0n); } catch { return 0n; }
}

