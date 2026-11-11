/**
 * Turning the packages' errors into messages for the user: one function for all of them, then each error made to
 * happen and handled.
 *
 * Every error the two packages throw has a name, and most have a `reason`: a short code the wallet acts on. The
 * function `whatToTellTheUser` below is the part to copy into a wallet: it goes by name and reason, as the tables in
 * chapter 10 of the integration guide do. The rest of the sample makes each error happen, without sending anything.
 *
 *   npm run example:handle-errors
 *
 *   WALLET (this sample)                                        TESTNET (provider 0, the node)
 *   ────────────────────                                        ──────────────────────────────
 *   1. gets two identities back from the provider ◄──────────── identity 334563111 (valid) and identity 0 (expired)
 *   2. makes each error happen, one at a time: verifying, keeping, accounts, proofs, transfers
 *      (every call is refused before anything is sent: nothing is written, nothing is spent)
 *   3. turns each one into a message with whatToTellTheUser
 *
 * Read-only on testnet, with the public demonstration phrase.
 */
import {
  ConcordiumIdentity,
  IdentityProviderError,
  IdentityIssuanceError,
  IdentityRecoveryError,
  IdentityStorageError,
  AccountCreationError,
  ProofError,
  CONCORDIUM_TESTNET_IDENTITY_CONFIG,
} from '@concordium/wdk-identity-concordium';
import { requestFor } from '@concordium/wdk-identity-concordium/verify';
import WalletManagerConcordium, {
  CONCORDIUM_TESTNET_CONFIG, AccountNotCreatedError, ConcordiumTransferError, TransactionRejectedError,
} from '@concordium/wdk-wallet-concordium';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';

/**
 * What to tell the user, and what the wallet does next, for an error from either package.
 * @returns {string}
 */
function whatToTellTheUser(e) {
  // Identity package
  if (e instanceof IdentityProviderError) return 'This identity provider is not available. Please choose another one.';
  if (e instanceof IdentityIssuanceError) {
    if (e.reason === 'timeout' || e.reason === 'cancelled') {
      return 'Your identity is not ready yet. We will check again later.'; // keep the saved reply; wait again later
    }
    return `The identity provider did not issue your identity${e.detail ? ` (${e.detail})` : ''}. Please start again.`;
  }
  if (e instanceof IdentityStorageError) {
    if (e.reason === 'not-yours') return 'This identity belongs to another wallet and cannot be used here.';
    return 'Your saved identity could not be read. We will get it back from your identity provider.'; // recover it
  }
  if (e instanceof AccountCreationError) {
    if (e.reason === 'identity-expired') return 'Your identity has expired. Please verify again to open new accounts.';
    if (e.reason === 'max-accounts' || e.reason === 'unknown-attribute') {
      return 'Something went wrong on our side; nothing was sent. Please contact support.'; // a mistake in the call
    }
    if (e.reason === 'rejected') return `The account could not be created: ${e.message}`;
    return 'Your account is not confirmed yet. We will check again.'; // expired, timeout, cancelled, node: try again
  }
  if (e instanceof IdentityRecoveryError) {
    if (e.reason === 'not-yours') return 'The identity provider returned an identity that is not yours. Please contact support.';
    return 'Your identity provider could not be reached. Please try again later.';
  }
  if (e instanceof ProofError) {
    if (['provider-not-accepted', 'cannot-prove', 'account-only'].includes(e.reason)) {
      return 'Your identity cannot answer this question, so nothing was shared.'; // decline the website's question
    }
    if (e.reason === 'identity-expired') return 'Your identity has expired. Please verify again.';
    if (e.reason === 'not-held') return 'Your identity is not loaded yet. Please try again in a moment.'; // import or recover it
    if (e.reason === 'anchor-mismatch') return 'This question was changed after it was asked. Nothing was shared.';
    if (e.reason === 'invalid-request' || e.reason === 'unknown-attribute') return 'This website asked an invalid question. Nothing was shared.';
    return 'The question could not be checked. Please try again.'; // anchor-not-found, node
  }
  // Wallet package
  if (e instanceof AccountNotCreatedError) return 'This account does not exist yet. Create it first.';
  if (e instanceof ConcordiumTransferError) {
    // The first reason as the headline; every reason is in e.reasons, each with a plain message.
    return `This transfer cannot be made. ${e.reasons.map((r) => r.message).join(' ')}${e.hash ? ' It was sent, so the fee was charged.' : ' Nothing was sent.'}`;
  }
  if (e?.name === 'TransactionError' && e.reason === 'INSUFFICIENT_BALANCE') {
    return `Not enough CCD: ${e.message}`; // WDK's TransactionError, for CCD transfers
  }
  if (e instanceof TransactionRejectedError) return `The transfer was refused by the chain: ${e.message} The fee was charged.`;
  return 'Something went wrong. Please try again later.'; // anything else: log e.message (it never holds a seed or key)
}

// ─── Set-up: both packages, from the public demonstration phrase ────────────────────────────────────────────────
// Public demonstration phrases only. Never use them for anything of value.
const DEMO_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_PHRASE = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'; // another wallet, for "not yours"

const identityProviders = await (await fetch('https://wallet-proxy.testnet.concordium.com/v2/ip_info')).json();
const node = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const config = { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders, node };
const identity = new ConcordiumIdentity(DEMO_PHRASE, config);
const otherWallet = new ConcordiumIdentity(OTHER_PHRASE, config);
const wallet = new WalletManagerConcordium(DEMO_PHRASE, { ...CONCORDIUM_TESTNET_CONFIG });

const VALID = { providerIndex: 0, identityIndex: 334563111 };   // valid until 2027-09; account 0 exists, holds no CCD
const EXPIRED = { providerIndex: 0, identityIndex: 0 };         // expired in 2026-02
const RECIPIENT = '4jxBvquQ3xp9LJJCnfWsq2StQXvhtmjr77sSs8PpfQhTQkNz3o'; // another testnet account

/** Run one call that should fail, and print what the wallet tells the user. */
async function scene(title, call) {
  console.log(`\n• ${title}`);
  try {
    await call();
    console.log('  (no error: this should not happen)');
    process.exitCode = 1;
  } catch (e) {
    console.log(`  ${e.name}${e.reason ? ` (${e.reason})` : ''}: ${e.message}`);
    console.log(`  → tell the user: "${whatToTellTheUser(e)}"`);
  }
}

try {
  console.log('1. Getting two identities back from the provider (read-only)');
  for (const which of [VALID, EXPIRED]) {
    const summary = await identity.recoverIdentity(which);
    console.log(`   identity ${which.identityIndex}: valid until ${summary.validTo.slice(0, 4)}-${summary.validTo.slice(4)}`);
  }
  // Guards: the account scenes below must be refused before anything is sent.
  const expired = await identity.exportIdentity(EXPIRED);
  if (!/"validTo":"2026/.test(expired)) throw new Error('Identity 0 is expected to have expired; stopping before any account call.');

  console.log('\n2. Each error, made to happen, and 3. what the wallet tells the user');

  // Verifying an identity (chapter 3)
  await scene('A provider that is not in the list', () => identity.createIdentityRequest({
    providerIndex: 99, identityIndex: 0, redirectUri: 'https://wallet.example/identity/return',
  }));
  await scene('The provider reports an error in its reply', async () => identity.parseIdentityCallback(
    'https://wallet.example/identity/return#error=The%20user%20stopped%20the%20verification.',
  ));
  await scene('Waiting for an identity, cancelled (the user closed the screen)', () => identity.waitForIdentity(
    'https://id-service.testnet.concordium.com/api/v1/identity/51cf6074722e6685934b4d06fba5baf0045d1d8130ead5ba7fac04dabff9ba3a',
    { ...VALID, signal: AbortSignal.abort() },
  ));

  // Keeping an identity (chapter 4)
  const kept = await identity.exportIdentity(VALID); // plain text with the person's details: keep it in secure storage
  await scene('The kept identity was damaged (cut short)', () => identity.importIdentity(kept.slice(0, kept.length / 2)));
  await scene("Another wallet's identity, imported here", () => otherWallet.importIdentity(kept));

  // Creating accounts (chapter 5): each refused before anything is sent
  await scene('An account number beyond what the identity allows', () => identity.createAccount({ ...VALID, credNumber: 200 }));
  await scene('A detail to reveal that the identity does not have', () => identity.createAccount({
    ...VALID, credNumber: 0, revealAttributes: ['favouriteColour'],
  }));
  await scene('An account from an expired identity', () => identity.createAccount({ ...EXPIRED, credNumber: 0 }));

  // Answering a website's question (chapter 7)
  await scene('An identity that is not loaded', () => identity.prove({
    providerIndex: 0, identityIndex: 777, credNumber: 0, ...requestFor({ providers: [0], adult: true }),
  }));
  await scene('A question the identity cannot truthfully answer ("do you live in Sweden?")', () => identity.prove({
    ...VALID, credNumber: 0, ...requestFor({ providers: [0], residentIn: ['SE'] }),
  }));
  await scene('A question to an expired identity', () => identity.prove({
    ...EXPIRED, credNumber: 0, ...requestFor({ providers: [0], adult: true }),
  }));

  // Accounts and transfers, in the wallet package (chapter 8): each refused before anything is sent
  await scene('An account that has not been created', () => wallet.getAccountByPath('0/334563111/199'));
  const account = await wallet.getAccountByPath('0/334563111/0');
  await scene('A token transfer the account cannot make', () => account.transfer({
    token: 'TN', recipient: RECIPIENT, amount: 10n ** 18n,
  }));
  await scene('A CCD transfer without enough CCD', () => account.sendTransaction({ to: RECIPIENT, value: 10n ** 15n }));
} catch (e) {
  console.error('\nFailed:', e.message);
  process.exitCode = 1;
} finally {
  identity.dispose();
  otherWallet.dispose();
  wallet.dispose();
}
