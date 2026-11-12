/**
 * The identity provider's verification page, inside the app (a WebView), and how the app catches the provider sending
 * the browser back.
 *
 * When the person finishes, the provider sends the browser to the app's return address (RETURN_ADDRESS, the
 * redirectUri given to createIdentityRequest), with its reply after a '#', e.g.
 *   concordiumwdkexample://identity/return#code_uri=https://…
 * Browsers never send the part after '#' anywhere, so the app must read the address itself. The WebView asks the app
 * before every page it opens (onShouldStartLoadWithRequest): every address of the provider's own pages is allowed;
 * the return address is caught (its full text, '#' part included), handed to the app, and not opened.
 */
import { useRef } from 'react';
import { Modal, View, Text, Pressable, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

export default function ProviderPage({ url, returnAddress, onReturn, onCancel }) {
  const caught = useRef(false);

  const watch = (request) => {
    if (!request.url.startsWith(returnAddress)) return true; // the provider's pages: let them load
    if (!caught.current) {
      caught.current = true; // once only: some WebViews report the same address twice
      onReturn(request.url); // the full address, with the provider's reply after '#'
    }
    return false; // the app's own address: never loaded in the WebView
  };

  return (
    <Modal animationType="slide" onRequestClose={onCancel}>
      <View style={styles.bar}>
        <Text style={styles.title}>Identity provider</Text>
        <Pressable onPress={onCancel} hitSlop={12}><Text style={styles.cancel}>Cancel</Text></Pressable>
      </View>
      <WebView
        source={{ uri: url }}
        onShouldStartLoadWithRequest={watch}
        // Every address comes to `watch` first, including the app's own scheme (otherwise Android would open it
        // outside the WebView, and the app could miss the '#' part).
        originWhitelist={['https://*', 'http://*', `${returnAddress.split(':')[0]}://*`]}
        // Some pages change address without a new page load: check those too.
        onNavigationStateChange={(state) => { if (state.url?.startsWith(returnAddress)) watch(state); }}
        startInLoadingState
        incognito // nothing from the provider's pages is kept by the WebView after it closes
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingTop: 48, paddingBottom: 12, backgroundColor: '#1B2735',
  },
  title: { color: '#fff', fontSize: 16, fontWeight: '600' },
  cancel: { color: '#8fd3ff', fontSize: 16 },
});
