/**
 * A small Android wallet showing Concordium identities with @concordium/wdk-identity-concordium in React Native
 * (testnet). Not a full wallet: just the steps an identity goes through, one screen at a time.
 *
 *   1. Wallet     a seed phrase, kept in the phone's secure storage (a new one, or the public test phrase)
 *   2. Verify     pick a provider; its page opens in a WebView; the app catches the return address (ProviderPage.js)
 *   3. Identity   collected, checked, kept (secure storage); after a restart it is imported from there
 *   4. Account    created on chain from the identity (free), with its address and CCD balance
 *
 * The heavy cryptography runs in Concordium's native library (modules/concordium-native), plugged into the package.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Image, Linking, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import ProviderPage from './src/ProviderPage';
import { RETURN_ADDRESS, identityFor, personProviders, ccdBalance } from './src/concordium';
import * as store from './src/storage';

// Public demonstration phrase only (its identities are shared with everyone): never use it for anything of value.
const PUBLIC_TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

export default function App() {
  const identity = useRef(null); // the ConcordiumIdentity for this seed phrase
  const [screen, setScreen] = useState('loading'); // loading | wallet | verify | collecting | identity
  const [busy, setBusy] = useState(null);           // what is happening, while it happens
  const [error, setError] = useState(null);
  const [providers, setProviders] = useState([]);
  const [page, setPage] = useState(null);           // the provider page open in the WebView
  const [summary, setSummary] = useState(null);     // the identity's summary (no personal details)
  const [account, setAccount] = useState(null);     // { address, balance }

  /** Run a step, showing what is happening, and any error in plain words. */
  const step = async (label, work) => {
    setBusy(label);
    setError(null);
    try {
      await work();
    } catch (e) {
      console.warn(`${label} failed:`, e?.stack ?? e);
      setError(`${e?.name ?? 'Error'}${e?.reason ? ` (${e.reason})` : ''}: ${e?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  };

  // ---- Start: the seed phrase, then a waiting verification, a kept identity, or the providers ----
  const start = () => step('Opening the wallet…', async () => {
    const seedPhrase = await store.loadSeedPhrase();
    if (!seedPhrase) { setScreen('wallet'); return; }
    identity.current?.dispose();
    identity.current = await identityFor(seedPhrase);

    const pending = await store.loadPending();
    if (pending) { await collect(pending); return; } // the app was closed while the provider was verifying

    const kept = await store.loadIdentity();
    if (kept) { await showIdentity(await identity.current.importIdentity(kept)); return; }

    setProviders(await personProviders());
    setScreen('verify');
  });
  useEffect(() => { start(); return () => identity.current?.dispose(); }, []);

  // ---- 1. Wallet ----
  const newWallet = (words) => step('Keeping the seed phrase in secure storage…', async () => {
    await store.keepSeedPhrase(words);
    await start();
  });

  // ---- 2. Verify: the provider's page in a WebView ----
  const verifyWith = (provider) => step(`Preparing the request for ${provider.name}…`, async () => {
    const providerIndex = provider.index;
    const identityIndex = await identity.current.nextIdentityIndex({ providerIndex }); // the next free number
    const { issuanceUrl } = await identity.current.createIdentityRequest({ providerIndex, identityIndex, redirectUri: RETURN_ADDRESS });
    setPage({ url: issuanceUrl, providerIndex, identityIndex });
  });

  /** The WebView caught the return address: keep the provider's reply first, then collect the identity. */
  const onReturn = (callbackUrl) => {
    const { providerIndex, identityIndex } = page;
    setPage(null);
    step('Reading the provider\'s reply…', async () => {
      const { codeUri } = identity.current.parseIdentityCallback(callbackUrl); // no network call
      const pending = { codeUri, providerIndex, identityIndex };
      await store.keepPending(pending); // so a restart can carry on (kept privately: the code_uri serves the details)
      await collect(pending);
    });
  };

  // ---- 3. Identity: collected (waiting for the provider if needed), checked, kept ----
  const collect = async ({ codeUri, providerIndex, identityIndex }) => {
    setScreen('collecting');
    setBusy('Waiting for the identity provider…');
    const issued = await identity.current.waitForIdentity(codeUri, { providerIndex, identityIndex });
    await store.keepIdentity(await identity.current.exportIdentity({ providerIndex, identityIndex }));
    await store.forgetPending();
    await showIdentity(issued);
  };

  const showIdentity = async (s) => {
    setSummary(s);
    setScreen('identity');
    const [first] = await identity.current.findAccounts({ providerIndex: s.providerIndex, identityIndex: s.identityIndex });
    setAccount(first ? { address: first.address, balance: await ccdBalance(first.address) } : null);
  };

  // ---- 4. Account ----
  const createAccount = () => step('Creating the account on chain (a few seconds, free)…', async () => {
    const { providerIndex, identityIndex } = summary;
    const credNumber = await identity.current.nextCredNumber({ providerIndex, identityIndex });
    const { address } = await identity.current.createAccount({ providerIndex, identityIndex, credNumber });
    setAccount({ address, balance: await ccdBalance(address) });
  });
  const refreshBalance = () => step('Reading the balance…', async () => {
    setAccount({ ...account, balance: await ccdBalance(account.address) });
  });

  const startAgain = () => Alert.alert('Start again?', 'This deletes the seed phrase and the identity from this phone. '
    + 'On testnet only: keep a real wallet\'s seed phrase written down.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => step('Deleting…', async () => {
      identity.current?.dispose();
      identity.current = null;
      setSummary(null);
      setAccount(null);
      await store.forgetEverything();
      setScreen('wallet');
    }) },
  ]);

  // ---- Screens ----
  return (
    <View style={styles.app}>
      <StatusBar style="light" />
      <View style={styles.header}>
        {/* Concordium's official white logo (its Brand Kit), unaltered, with clear space around it. */}
        <Image source={require('./assets/concordium-logo-white.png')} style={styles.logo} resizeMode="contain"
          accessibilityLabel="Concordium" />
        <Text style={styles.sub}>Identity in a WDK wallet · example · testnet</Text>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        {screen === 'wallet' && (
          <Card title="1. Your wallet" note="A wallet starts with a seed phrase: every key comes from it. This example keeps it in the phone's secure storage (Android Keystore).">
            <Button label="Create a new wallet" onPress={() => newWallet(generateMnemonic(wordlist, 256))} />
            <Button label="Use the public test phrase" kind="quiet" onPress={() => newWallet(PUBLIC_TEST_PHRASE)} />
          </Card>
        )}

        {screen === 'verify' && (
          <Card title="2. Verify your identity" note="Choose an identity provider. Its page opens inside the app; when you finish, it sends you back here.">
            {providers.map((p) => <Button key={p.index} label={p.name} onPress={() => verifyWith(p)} />)}
          </Card>
        )}

        {screen === 'collecting' && (
          <Card title="3. Collecting your identity" note="The provider is issuing your identity. If you close the app now, it carries on here next time." />
        )}

        {screen === 'identity' && summary && (
          <>
            <Card title="3. Your identity" note="Issued to this wallet's own key (worked out from your seed phrase), so it's yours, and kept in secure storage. Your details stay in the wallet: they are not shown here, and never go on chain.">
              <Fact label="Provider" value={`number ${summary.providerIndex}`} />
              <Fact label="Valid until" value={`${summary.validTo.slice(0, 4)}-${summary.validTo.slice(4)}`} />
              <Fact label="Accounts allowed" value={`up to ${summary.maxAccounts}`} />
            </Card>
            <Card title="4. Your account" note={account ? 'On chain, created from your identity.' : 'Create an account from your identity: free, final in a few seconds.'}>
              {account ? (
                <>
                  <Fact label="Address" value={account.address} mono />
                  <Fact label="Balance" value={`${account.balance} CCD`} />
                  <Button label="Refresh the balance" kind="quiet" onPress={refreshBalance} />
                  <Button label="See it on CCDScan" kind="quiet" onPress={() => Linking.openURL(`https://testnet.ccdscan.io/?dcount=1&dentity=account&daddress=${account.address}`)} />
                </>
              ) : <Button label="Create account" onPress={createAccount} />}
            </Card>
          </>
        )}

        {busy && <View style={styles.busy}><ActivityIndicator color="#0d3a54" /><Text style={styles.busyText}>{busy}</Text></View>}
        {error && <Text style={styles.error}>{error}</Text>}
        {error && screen !== 'loading' && <Button label="Try again" kind="quiet" onPress={start} />}
        {screen !== 'wallet' && screen !== 'loading' && <Button label="Start again" kind="quiet" onPress={startAgain} />}
      </ScrollView>

      {page && (
        <ProviderPage url={page.url} returnAddress={RETURN_ADDRESS} onReturn={onReturn} onCancel={() => setPage(null)} />
      )}
    </View>
  );
}

function Card({ title, note, children }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {note && <Text style={styles.note}>{note}</Text>}
      {children}
    </View>
  );
}

function Fact({ label, value, mono }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={[styles.factValue, mono && styles.mono]} selectable>{value}</Text>
    </View>
  );
}

function Button({ label, onPress, kind }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.button, kind === 'quiet' && styles.quiet, pressed && styles.pressed]}>
      <Text style={[styles.buttonText, kind === 'quiet' && styles.quietText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: '#f4f7f9' },
  header: { backgroundColor: '#1B2735', paddingTop: 60, paddingBottom: 18, paddingHorizontal: 24 },
  // 607 x 76 pixels; the clear space Concordium asks for (the height of the "C") is kept by the padding and margin.
  logo: { width: 200, height: 25, marginBottom: 25 },
  sub: { color: '#c9d4e0', fontSize: 13 },
  body: { padding: 16, paddingBottom: 48 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: '#d4dbe0' },
  cardTitle: { fontSize: 17, fontWeight: '700', color: '#0a1a2f', marginBottom: 6 },
  note: { fontSize: 13, color: '#4b5560', marginBottom: 12, lineHeight: 18 },
  fact: { marginBottom: 10 },
  factLabel: { fontSize: 12, color: '#6a727c' },
  factValue: { fontSize: 15, color: '#22262c' },
  mono: { fontFamily: 'monospace', fontSize: 12 },
  button: { backgroundColor: '#0d3a54', borderRadius: 8, paddingVertical: 12, paddingHorizontal: 14, marginTop: 8 },
  quiet: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#0d3a54' },
  pressed: { opacity: 0.7 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600', textAlign: 'center' },
  quietText: { color: '#0d3a54' },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 12 },
  busyText: { color: '#0d3a54', fontSize: 14, flexShrink: 1 },
  error: { color: '#b00020', fontSize: 13, marginVertical: 8 },
});
