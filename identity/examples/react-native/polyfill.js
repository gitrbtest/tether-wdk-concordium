// Concordium's documented React Native polyfills (its web-sdk README, "React native"). Loaded before anything else.
import 'react-native-get-random-values';
import '@stardazed/streams-polyfill'; // streamed answers from the node over gRPC-web (e.g. the provider records)
import '@azure/core-asynciterator-polyfill';
import { polyfill as polyfillEncoding } from 'react-native-polyfill-globals/src/encoding';
import { polyfill as polyfillCrypto } from 'react-native-polyfill-globals/src/crypto';

polyfillEncoding();
polyfillCrypto();
