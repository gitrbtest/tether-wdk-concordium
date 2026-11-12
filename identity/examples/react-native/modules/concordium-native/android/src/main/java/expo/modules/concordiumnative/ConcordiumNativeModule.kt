package expo.modules.concordiumnative

import com.concordium.sdk.crypto.CryptoJniNative
import com.concordium.sdk.crypto.NativeResolver
import com.concordium.sdk.crypto.wallet.ConcordiumHdWallet
import com.concordium.sdk.crypto.wallet.Network
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

/**
 * Concordium's cryptography, compiled for the phone (Concordium's Android SDK, `libcrypto_jni.so`), for JavaScript.
 *
 * Each function takes the same JSON text that Concordium's JavaScript SDK hands its WebAssembly, and answers the same
 * JSON text: both call the same Rust code (concordium-base). The JavaScript side (../index.js) wraps them into the
 * identity package's cryptography plug-in. AsyncFunction runs off the UI thread, so the app stays responsive while a
 * proof is made.
 *
 * Not here: checking a proof. Concordium's Android SDK has no such function (see ../index.js).
 */
class ConcordiumNativeModule : Module() {
  private val loaded by lazy { NativeResolver.loadLib(); true }

  private fun network(name: String) = if (name == "Mainnet") Network.MAINNET else Network.TESTNET

  private fun keys(seedHex: String, net: String): ConcordiumHdWallet {
    loaded
    return ConcordiumHdWallet.fromHex(seedHex, network(net))
  }

  /** The native library answers {"Ok": "<json text>"} or {"Err": …}: the JSON text, or an error the app can show. */
  private fun unwrap(answer: String): String {
    val json = JSONObject(answer)
    if (json.has("Ok")) return json.getString("Ok")
    throw CodedException("CONCORDIUM_NATIVE", json.opt("Err")?.toString() ?: answer, null)
  }

  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

  override fun definition() = ModuleDefinition {
    Name("ConcordiumNative")

    // ---- Keys from the seed (as ConcordiumHdWallet in the JavaScript SDK), as hex text ----
    AsyncFunction("getIdCredSec") { seed: String, net: String, ip: Int, id: Int ->
      hex(keys(seed, net).getIdCredSec(ip, id).rawBytes)
    }
    AsyncFunction("getPrfKey") { seed: String, net: String, ip: Int, id: Int ->
      hex(keys(seed, net).getPrfKey(ip, id).rawBytes)
    }
    AsyncFunction("getSignatureBlindingRandomness") { seed: String, net: String, ip: Int, id: Int ->
      keys(seed, net).getSignatureBlindingRandomness(ip, id)
    }
    AsyncFunction("getAttributeCommitmentRandomness") { seed: String, net: String, ip: Int, id: Int, cred: Int, attribute: Int ->
      keys(seed, net).getAttributeCommitmentRandomness(ip, id, cred, attribute)
    }
    AsyncFunction("getAccountSigningKey") { seed: String, net: String, ip: Int, id: Int, cred: Int ->
      hex(keys(seed, net).getAccountSigningKey(ip, id, cred).rawBytes)
    }
    AsyncFunction("getAccountPublicKey") { seed: String, net: String, ip: Int, id: Int, cred: Int ->
      hex(keys(seed, net).getAccountPublicKey(ip, id, cred).rawBytes)
    }
    AsyncFunction("getCredentialId") { seed: String, net: String, ip: Int, id: Int, cred: Int, commitmentKey: String ->
      keys(seed, net).getCredentialId(ip, id, cred, commitmentKey)
    }

    // ---- The heavy steps: the same JSON in and out as the JavaScript SDK's WebAssembly ----
    AsyncFunction("createIdentityRequestV1") { input: String -> loaded; unwrap(CryptoJniNative.createIdentityRequestV1(input)) }
    AsyncFunction("createIdentityRecoveryRequest") { input: String -> loaded; unwrap(CryptoJniNative.createIdentityRecoveryRequest(input)) }
    AsyncFunction("createUnsignedCredentialV1") { input: String -> loaded; unwrap(CryptoJniNative.createUnsignedCredentialV1(input)) }
    AsyncFunction("createWeb3IdProof") { input: String -> loaded; unwrap(CryptoJniNative.createWeb3IdProof(input)) }
    AsyncFunction("createPresentationV1") { input: String -> loaded; unwrap(CryptoJniNative.createPresentation(input)) }
  }
}
