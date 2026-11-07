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

import { WalletAccountReadOnly, NotImplementedError, InvalidTokenError, ValueError, TransferErrorReason } from '@tetherto/wdk-wallet';
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
});

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
   * @throws {TransactionRejectedError} If the transaction finalizes in a rejected state.
   * @throws {Error} If the node rejects the submission (e.g. verification/nonce failure).
   */
  async sendTransaction(tx) {
    const client = await this._getClient();
    const isRequest = tx && typeof tx === 'object' && 'to' in tx && 'value' in tx;
    const signed = isRequest ? await this.signTransaction(tx) : tx;

    const hash = await client.sendTransaction(signed);
    return this._awaitFinalized(hash);
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

  /** Normalized receipts are unsupported; use getTransactionReceipt. */
  async getTransaction(_hash) {
    throw new NotImplementedError('getTransaction is not supported. Use getTransactionReceipt.');
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
   * @returns {Promise<{hash: string, fee: bigint}>} On success (finalized, not rejected).
   * @throws {TransactionRejectedError} If the transfer finalizes in a rejected state.
   * @throws {Error} If token decimals/energy can't be determined, or the node rejects the submission.
   */
  async transfer({ token, recipient, amount }) {
    const ref = parseTokenRef(token);
    return ref.kind === 'cis2'
      ? this._cis2Transfer(ref, recipient, BigInt(amount))
      : this._pltTransfer(ref, recipient, BigInt(amount));
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
    const finalized = s.Transaction.finalize(s.Transaction.signableFromJSON(fullySignedJson));
    const hash = await client.sendTransaction(finalized);
    return this._awaitFinalized(hash);
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

