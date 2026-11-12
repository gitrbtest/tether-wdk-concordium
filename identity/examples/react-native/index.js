import './polyfill'; // first: Concordium's documented React Native polyfills
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
