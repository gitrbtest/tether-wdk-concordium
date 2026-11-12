# React Native example: a phone wallet with a Concordium identity

A small Android app showing what a phone wallet does to give its user a Concordium identity with
`@concordium/wdk-identity-concordium`. It opens the identity provider's page inside the app (a WebView), catches the
moment the provider sends the person back, keeps the identity in the phone's secure storage, and creates an account
from it on chain. It runs on **testnet** only and is not a full wallet: it shows the identity steps, one screen at a
time.

```
THE APP                                        IDENTITY PROVIDER                  CHAIN (testnet)
───────                                        ─────────────────                  ───────────────
1 Wallet    a seed phrase, in secure storage
2 Verify    build the request from the seed
            open the provider's page ─────────► the person verifies
            in a WebView                         (testnet: test data, no documents)
            catch the return address ◄────────── sends the browser back, with
            (its reply after '#')                its reply after '#'
3 Identity  collect it, check it is issued to
            this wallet's key, keep it in
            secure storage
4 Account   build and sign the credential ─────────────────────────────────────► account created (free)
            read its balance ◄─────────────────────────────────────────────────── 0 CCD
```

Everything here costs nothing: identities on testnet are free, and so is creating an account.

## What you need

| What | Why | Where to get it |
| --- | --- | --- |
| Node.js 20 or later | runs the build tools and Metro, which serves the app's JavaScript to the phone | [nodejs.org](https://nodejs.org) |
| Java 17 (a JDK) | builds the Android app | for example [Eclipse Temurin 17](https://adoptium.net) |
| Android Studio | gives the Android SDK (the build tools) and the emulator (a phone on your computer) | [developer.android.com/studio](https://developer.android.com/studio) |
| An emulator, or an Android phone | where the app runs; Android 8.0 or later | see below |

**An emulator.** In Android Studio, open *Device Manager*, create a device (any recent Pixel with a recent Android
version is fine) and start it. Or use your own phone: turn on *Developer options* and *USB debugging*, and connect
it with a cable.

**Tell the tools where Java and the Android SDK are.** Set two environment variables, then open a new terminal.

Windows (PowerShell; change the paths to where yours are installed):

```powershell
setx JAVA_HOME "C:\Program Files\Eclipse Adoptium\jdk-17.0.19.10-hotspot"
setx ANDROID_HOME "$env:LOCALAPPDATA\Android\Sdk"
```

macOS or Linux (add these lines to `~/.zshrc` or `~/.bashrc`):

```bash
export JAVA_HOME="$(/usr/libexec/java_home -v 17)"   # macOS; on Linux, the folder your JDK 17 is in
export ANDROID_HOME="$HOME/Library/Android/sdk"       # macOS; on Linux usually $HOME/Android/Sdk
export PATH="$ANDROID_HOME/platform-tools:$PATH"
```

## Running it

From this folder (`identity/examples/react-native`), with the emulator running or the phone connected:

```bash
npm run pack-packages
```

```bash
npm install
```

```bash
npm run android
```

1. `pack-packages` packs the identity package from this repository into `./packages`, so the app installs it the
   way it would install the published package.
2. `npm install` installs the app's packages, the identity package among them. Run both again whenever the identity
   package changes.
3. `npm run android` builds the app, installs it on the emulator or phone, starts Metro and opens the app. The first
   build takes a few minutes; later ones are quicker.

**The first start is slow (a minute or more).** Concordium's JavaScript SDK carries a large file (its cryptography
compiled to plain JavaScript, about 55 MB) that Metro prepares once and the phone then loads. The emulator may say
*"System UI isn't responding"* meanwhile: tap **Wait**. Later starts are fast. If Metro stops with an out-of-memory
error, give Node more memory and run it again:

```bash
NODE_OPTIONS=--max-old-space-size=8192 npm run android
```

(Windows PowerShell: `$env:NODE_OPTIONS="--max-old-space-size=8192"; npm run android`.)

Leave the terminal open: Metro keeps serving the app while you use it. To start Metro again later without
rebuilding the app, run `npm start` and open the app on the phone.

## Using the app

1. **Your wallet.** Tap *Create a new wallet* for a new seed phrase (24 words), or *Use the public test phrase*.
   The public test phrase is the same for everyone, so its identities and accounts are shared with anyone who uses it:
   fine for trying things out, never for anything of value.
2. **Verify your identity.** Tap a provider. Its page opens inside the app. On testnet it asks for test data only
   (no real documents). When you finish, the page sends you back to the app by itself.
3. **Your identity.** The app collects the identity from the provider (this can take a moment), checks that it was
   issued to this wallet's own key, and keeps it in secure storage. If you close the app while the provider is still
   working, it carries on from there next time.
4. **Your account.** Tap *Create account*. The account appears on chain within seconds, and the app shows its address
   and balance (0 CCD), with a link to see it on [CCDScan](https://testnet.ccdscan.io). On CCDScan, the transaction
   that created it shows the event *"Deployed account with address …"*.

*Start again* deletes the seed phrase and the identity from the phone (the account stays on chain: accounts are never
deleted).

## How it works

| File | What it does |
| --- | --- |
| `App.js` | the four screens, each calling the identity package |
| `src/ProviderPage.js` | the provider's page in a WebView, and catching the return address |
| `src/storage.js` | what is kept in secure storage, and how |
| `src/concordium.js` | the identity package set up for a phone: provider list, node connection, native cryptography |
| `modules/concordium-native/` | a small native module: Concordium's Android library, plugged into the package |
| `polyfill.js` | the polyfills Concordium's SDK needs in React Native (its README, "React native") |

### The provider's page, and catching the return address

The app gives the provider a **return address** of its own (`RETURN_ADDRESS` in `src/concordium.js`):

```js
const { issuanceUrl } = await identity.createIdentityRequest({ providerIndex, identityIndex, redirectUri: RETURN_ADDRESS });
// RETURN_ADDRESS = 'concordiumwdkexample://identity/return'  (the app's own scheme, see "scheme" in app.json)
```

When the person finishes, the provider sends the browser there, with its reply after a `#`:

```
concordiumwdkexample://identity/return#code_uri=https://…
```

A browser never sends the part after `#` anywhere, so the app reads the address itself. The WebView asks the app
before it opens any page (`onShouldStartLoadWithRequest` in `src/ProviderPage.js`): the provider's own pages load as
usual; the return address is caught, handed to the app, and never loaded. The app then reads the reply with
`parseIdentityCallback` (no network call), keeps it in secure storage, and collects the identity with
`waitForIdentity`.

```js
const watch = (request) => {
  if (!request.url.startsWith(returnAddress)) return true; // the provider's pages: let them load
  onReturn(request.url);                                   // the full address, '#' part included
  return false;                                            // the app's own address: not loaded
};
```

The app's scheme is also in the WebView's `originWhitelist`, so Android does not try to open the return address
outside the WebView (where the app could miss the `#` part).

### Concordium's native cryptography

React Native has no WebAssembly, so the SDK's cryptography runs as plain JavaScript there, which is far too slow. The
app plugs in Concordium's Android library instead (`com.concordium.sdk:concordium-android-sdk`), through a small Expo
module (`modules/concordium-native`): Kotlin that calls the library, and `index.js`, which gives each step the name,
arguments and result the package expects. See the package README, *"Phones: plugging in faster cryptography"*.

```js
const identity = new ConcordiumIdentity(seedPhrase, config, { cryptography: nativeConcordiumCryptography });
```

| Step | Runs in |
| --- | --- |
| keys from the seed phrase, the identity and recovery requests, the account's credential, version 0 and version 1 proofs | Concordium's Android library |
| signing the credential, its bytes for the node, its transaction hash | JavaScript (quick anywhere) |
| checking the provider's signature on the identity | **not on the phone**: the Android library has no way to check it yet (`SIGNATURE_CHECK_UNAVAILABLE`). The chain checks it when an account is created, and so does a website when it checks a proof. The check that the identity was issued to this wallet's key still runs. |

The node connection is Concordium's gRPC-web client (`ConcordiumGRPCWebClient`), the kind that works in React Native.

### What is kept, and where

Everything is kept with `expo-secure-store`, which uses Android's Keystore: each value is encrypted with a key that
stays in the phone's secure hardware.

| Kept | Why it is secret |
| --- | --- |
| the seed phrase | every key comes from it |
| the exported identity | it holds the person's details (name, date of birth, ID number…). The identity package does **not** encrypt it: the wallet must keep it as carefully as the seed phrase |
| a provider reply still waiting | its `code_uri` serves the identity, details included, to anyone who has it. Kept only while waiting, deleted once the identity is collected |

None of these is ever written to logs or plain files. The WebView runs `incognito`, so it keeps nothing from the
provider's pages once it closes.

## Limits

- **Android only.** iOS would need the same native module written for Concordium's iOS library.
- **Testnet only.** The provider list, the node and the return address are set up for testnet.
- **Not a full wallet.** No sending, no tokens, one identity at a time, no lock screen. The other samples in
  `identity/examples` show more of the package.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| `Port 8081 is being used by another process` | another Metro is still running: close its terminal (or stop that process), then run again |
| A change to the code does not show on the phone | press **R** twice on the emulator to reload; if Metro was started with `CI=1`, it does not reload: start it again without |
| *"System UI isn't responding"* on the first start | tap **Wait**: the first load is slow (see above) |
| `SDK location not found` or `JAVA_HOME is not set` | set `ANDROID_HOME` and `JAVA_HOME` (see *What you need*) and open a new terminal |
| An error on a screen | it is also in the Metro terminal, with where it came from; tap *Try again* |
