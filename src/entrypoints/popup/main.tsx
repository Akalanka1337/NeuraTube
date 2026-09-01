import { render } from 'preact';
import { App } from './App';
import './popup.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('popup root element missing');
}

render(<App />, root);
